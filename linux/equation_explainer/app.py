"""The GTK4 / libadwaita shell: a window with the board list and a WebKitGTK view of the shared UI,
plus the JS <-> Python bridge (the same commands and callbacks as the macOS app).
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("Adw", "1")
gi.require_version("WebKit", "6.0")
gi.require_version("JavaScriptCore", "6.0")
from gi.repository import Adw, Gdk, Gio, GLib, Gtk, JavaScriptCore, WebKit  # noqa: E402

from . import REPO_ROOT, __version__, resources_dir  # noqa: E402
from .config import AppConfig, LLMSettings, load as load_config, support_dir  # noqa: E402
from .llm import LLMClient, LLMError, StreamHandle  # noqa: E402
from .pyrunner import PythonRunner  # noqa: E402
from .store import BoardStore, BoardSummary, write_private  # noqa: E402

APP_ID = "dev.equationexplainer.app"
SCHEME = "ee-app"
START_URL = f"{SCHEME}://board/index.html"
MIME = {"html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
        "png": "image/png", "svg": "image/svg+xml", "woff2": "font/woff2", "woff": "font/woff", "ttf": "font/ttf",
        "json": "application/json", "txt": "text/plain; charset=utf-8"}
DEBUG = bool(os.environ.get("EE_DEBUG"))


def log(msg: str) -> None:
    sys.stderr.write(f"[equation-explainer] {msg}\n")
    sys.stderr.flush()


def on_main(fn: Callable, *args) -> None:
    """Run fn(*args) on the GTK main loop (safe from any thread)."""
    def once() -> bool:
        try:
            fn(*args)
        except Exception:  # noqa: BLE001 - never let a callback kill the main loop
            log("error on the main thread:\n" + traceback.format_exc())
        return False
    GLib.idle_add(once)


@dataclass
class SelfTestOptions:
    out_dir: Path
    keep_open: bool
    prompt: Optional[str]


# ====================================================================== web view + bridge
class WebController:
    """Owns the WebKit view, serves the UI from ee-app://board/ and relays bridge messages."""

    def __init__(self, web_root: Path, data_dir: Path) -> None:
        self.web_root = web_root.resolve()
        self.model: Optional[AppModel] = None
        self._pending: dict[str, list[str]] = {}
        self._order: list[str] = []
        self._flush_scheduled = False
        self._lock = threading.Lock()

        check_web_sandbox()
        ctx = WebKit.WebContext.get_default()
        ctx.register_uri_scheme(SCHEME, self._serve)
        sec = ctx.get_security_manager()
        sec.register_uri_scheme_as_secure(SCHEME)
        sec.register_uri_scheme_as_cors_enabled(SCHEME)

        session = WebKit.NetworkSession.new(str(data_dir / "webkit" / "data"), str(data_dir / "webkit" / "cache"))
        ucm = WebKit.UserContentManager()
        ucm.register_script_message_handler_with_reply("ee", None)
        ucm.connect("script-message-with-reply-received::ee", self._on_message)

        settings = WebKit.Settings()
        settings.set_enable_developer_extras(True)
        settings.set_zoom_text_only(False)
        settings.set_enable_write_console_messages_to_stdout(DEBUG)
        settings.set_javascript_can_access_clipboard(True)

        self.webview = WebKit.WebView(web_context=ctx, network_session=session, user_content_manager=ucm, settings=settings)
        self.webview.set_vexpand(True)
        self.webview.set_hexpand(True)
        bg = Gdk.RGBA()
        bg.parse("#26190f")
        self.webview.set_background_color(bg)
        self.webview.connect("decide-policy", self._decide_policy)
        self.webview.connect("create", self._on_create)
        self.webview.connect("web-process-terminated", lambda *_: (log("web content process terminated; reloading"), self.load()))

    def load(self) -> None:
        self.webview.load_uri(START_URL)

    # ---- serving the bundled UI
    def _serve(self, request: WebKit.URISchemeRequest) -> None:
        path = request.get_path() or "/"
        if path in ("", "/"):
            path = "/index.html"
        file = (self.web_root / path.lstrip("/")).resolve()
        try:
            if not str(file).startswith(str(self.web_root) + os.sep):
                raise FileNotFoundError(path)
            data = file.read_bytes()
        except (OSError, FileNotFoundError):
            request.finish_error(GLib.Error(f"not found: {path}", "g-io-error-quark", int(Gio.IOErrorEnum.NOT_FOUND)))
            return
        mime = MIME.get(file.suffix.lstrip(".").lower(), "application/octet-stream")
        stream = Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(data))
        response = WebKit.URISchemeResponse.new(stream, len(data))
        response.set_content_type(mime)
        response.set_status(200, None)
        request.finish_with_response(response)

    # ---- JS -> Python
    def _on_message(self, ucm, value: JavaScriptCore.Value, reply: WebKit.ScriptMessageReply) -> bool:
        try:
            body = json.loads(value.to_json(0))
            cmd = body["cmd"]
            assert isinstance(cmd, str)
        except Exception:  # noqa: BLE001
            reply.return_error_message("Malformed message")
            return True
        model = self.model
        if model is None:
            reply.return_error_message("App is shutting down")
            return True

        def done(result: Any, error: Optional[str]) -> None:
            # back on the main thread; `value` keeps the JS context alive until we reply
            try:
                if error is not None:
                    reply.return_error_message(error)
                else:
                    ctx = value.get_context()
                    reply.return_value(JavaScriptCore.Value.new_from_json(ctx, json.dumps(result if result is not None else None)))
            except Exception:  # noqa: BLE001
                log("could not reply to the page:\n" + traceback.format_exc())

        model.dispatch(cmd, body, done)
        return True

    # ---- Python -> JS
    def call(self, function: str, arg: Optional[dict] = None) -> None:
        """Call a page function with one JSON argument (main thread only)."""
        script = f"{function}({json.dumps(arg or {})})"

        def finished(view, result, _data=None) -> None:
            try:
                view.evaluate_javascript_finish(result)
            except GLib.Error as e:
                log(f"JS call {function} failed: {e.message}")

        self.webview.evaluate_javascript(script, -1, None, None, None, finished, None)

    def call_async(self, body: str, callback: Callable[[], None]) -> None:
        """Run an async function body in the page; callback when its promise settles."""
        def finished(view, result, _data=None) -> None:
            try:
                view.call_async_javascript_function_finish(result)
            except GLib.Error as e:
                log(f"async JS failed: {e.message}")
            callback()

        self.webview.call_async_javascript_function(body, -1, None, None, None, None, finished, None)

    def command(self, name: str) -> None:
        self.call("EE.native.command", {"name": name})

    def enqueue_chunk(self, chat_id: str, content: str, reasoning: str) -> None:
        """Tokens arrive fast from worker threads; batch them into ~30 ms frames (any thread)."""
        with self._lock:
            if chat_id not in self._pending:
                self._order.append(chat_id)
                self._pending[chat_id] = ["", ""]
            self._pending[chat_id][0] += content
            self._pending[chat_id][1] += reasoning
            if self._flush_scheduled:
                return
            self._flush_scheduled = True
        GLib.timeout_add(30, self._flush)

    def _flush(self) -> bool:
        with self._lock:
            self._flush_scheduled = False
            batch = [(i, self._pending[i]) for i in self._order]
            self._pending.clear()
            self._order.clear()
        for chat_id, (content, reasoning) in batch:
            self.call("EE.native.chunk", {"id": chat_id, "content": content, "reasoning": reasoning})
        return False

    def finish_chat(self, chat_id: str, model: Optional[str], finish: Optional[str]) -> None:
        on_main(lambda: (self._flush(), self.call("EE.native.done", {"id": chat_id, "model": model or "", "finish": finish or ""})))

    def fail_chat(self, chat_id: str, message: str) -> None:
        on_main(lambda: (self._flush(), self.call("EE.native.error", {"id": chat_id, "message": message})))

    def snapshot_png(self, callback: Callable[[Optional[bytes], Optional[str]], None]) -> None:
        def finished(view, result, _data=None) -> None:
            try:
                texture = view.get_snapshot_finish(result)
                callback(texture.save_to_png_bytes().get_data(), None)
            except GLib.Error as e:
                callback(None, e.message)

        self.webview.get_snapshot(WebKit.SnapshotRegion.VISIBLE, WebKit.SnapshotOptions.NONE, None, finished, None)

    # ---- navigation: keep the board in-app, send links to the browser
    def _decide_policy(self, view, decision, decision_type) -> bool:
        if decision_type not in (WebKit.PolicyDecisionType.NAVIGATION_ACTION, WebKit.PolicyDecisionType.NEW_WINDOW_ACTION):
            return False
        uri = decision.get_navigation_action().get_request().get_uri() or ""
        scheme = uri.split(":", 1)[0].lower()
        if scheme in (SCHEME, "about") and decision_type == WebKit.PolicyDecisionType.NAVIGATION_ACTION:
            decision.use()
        else:
            if scheme in ("http", "https", "mailto"):
                open_external(uri)
            decision.ignore()
        return True

    def _on_create(self, view, action):
        uri = action.get_request().get_uri() or ""
        if uri.split(":", 1)[0].lower() in ("http", "https"):
            open_external(uri)
        return None


SANDBOX_HELP = """WebKit cannot start its web-process sandbox on this machine: bubblewrap (bwrap) is not allowed to
create a user namespace, so the board would crash the moment it loads. This happens on Ubuntu 24.04 when
kernel.apparmor_restrict_unprivileged_userns=1 and no AppArmor profile grants bwrap user namespaces.
Fix it system-wide (one of):
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0     (and persist it in /etc/sysctl.d/)
  or install an AppArmor profile for /usr/bin/bwrap that allows userns
Then start Equation Explainer again. (WebKitGTK also documents an environment switch to run without its
sandbox; set it yourself if you accept that for a page that only talks to the model server.)"""


def bwrap_works() -> bool:
    """Can bubblewrap (WebKit's web-process sandbox) create a user namespace here?"""
    import shutil
    import subprocess
    bwrap = shutil.which("bwrap")
    if not bwrap:
        return False
    try:
        r = subprocess.run([bwrap, "--unshare-user", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "true"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def check_web_sandbox() -> None:
    """Stop with a readable message instead of WebKit's abort when its sandbox cannot start."""
    if os.environ.get("EE_SKIP_SANDBOX_CHECK") or bwrap_works():
        return
    if any(k.startswith("WEBKIT_") and "SANDBOX" in k for k in os.environ):
        return  # the user chose how WebKit should handle it
    log(SANDBOX_HELP)
    sys.exit(2)


def open_external(uri: str) -> None:
    try:
        Gio.AppInfo.launch_default_for_uri(uri, None)
    except GLib.Error as e:
        log(f"could not open {uri}: {e.message}")


# ====================================================================== the model: state + bridge commands
class AppModel:
    def __init__(self, web: WebController, store: BoardStore, runner: PythonRunner, support: Path,
                 project_root: Optional[str], self_test: Optional[SelfTestOptions]) -> None:
        self.web = web
        self.store = store
        self.runner = runner
        self.support = support
        self.project_root = project_root
        self.self_test = self_test
        self.window: Optional[MainWindow] = None
        self.boards: list[BoardSummary] = store.list()
        self.current_id: Optional[str] = None
        self.current_title = "Equation Explainer"
        self._chats: dict[str, StreamHandle] = {}
        self._deleted: set[str] = set()
        self._pool = ThreadPoolExecutor(max_workers=12, thread_name_prefix="bridge")
        self._state_path = support / "state.json"
        web.model = self

    @property
    def config(self) -> AppConfig:
        return load_config(self.project_root)

    # ---- small persistent state (the last board)
    def _state(self) -> dict:
        try:
            return json.loads(self._state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _set_state(self, key: str, value: Any) -> None:
        s = self._state()
        s[key] = value
        try:
            self._state_path.parent.mkdir(parents=True, exist_ok=True)
            self._state_path.write_text(json.dumps(s), encoding="utf-8")
        except OSError as e:
            log(f"could not write state: {e}")

    # ---- sidebar actions (main thread)
    def open(self, board_id: str) -> None:
        if board_id == self.current_id:
            return
        try:
            data = self.store.load(board_id)
            self.web.call("EE.native.openBoard", {"json": data.decode("utf-8")})
        except Exception as e:  # noqa: BLE001
            log(f"open board failed: {e}")
            self.refresh_boards()

    def new_board(self) -> None:
        self.web.call("EE.native.newBoard")

    def refresh_boards(self) -> None:
        self.boards = self.store.list()
        if self.window:
            self.window.show_boards()

    def rename(self, board_id: str, title: str) -> None:
        t = title.strip()
        if not t:
            return
        try:
            self.store.rename(board_id, t)
        except Exception as e:  # noqa: BLE001
            log(f"rename failed: {e}")
            return
        self.web.call("EE.native.renamed", {"id": board_id, "title": t})
        if board_id == self.current_id:
            self.current_title = t
            if self.window:
                self.window.set_board_title(t)
        self.refresh_boards()

    def delete(self, board_id: str) -> None:
        self._deleted.add(board_id)
        try:
            self.store.delete(board_id)
        except Exception as e:  # noqa: BLE001
            log(f"delete failed: {e}")
        self.web.call("EE.native.deleted", {"id": board_id})
        self.refresh_boards()

    def env_target(self) -> Path:
        cfg = self.config
        if cfg.env_file:
            return cfg.env_file
        # No .env yet: create one next to the project (or in the data folder) from the example.
        target = Path(self.project_root) / ".env" if self.project_root else self.support / ".env"
        example = Path(self.project_root) / ".env.example" if self.project_root else None
        text = "LLM_PROVIDER=lmstudio\nLMSTUDIO_BASE_URL=http://localhost:1234/v1\n"
        if example and example.exists():
            text = example.read_text(encoding="utf-8")
        try:
            target.write_text(text, encoding="utf-8")
        except OSError as e:
            log(f"could not create {target}: {e}")
        return target

    def open_env(self) -> None:
        launch_file(self.env_target(), self.window)

    def reveal_boards_folder(self) -> None:
        launch_file(self.store.dir, self.window)

    def reveal(self, board_id: str) -> None:
        try:
            Gtk.FileLauncher.new(Gio.File.new_for_path(str(self.store.path(board_id)))).open_containing_folder(self.window, None, None)
        except Exception as e:  # noqa: BLE001
            log(f"reveal failed: {e}")

    def zoom(self, direction: str) -> float:
        v = self.web.webview
        z = v.get_zoom_level()
        if direction == "in":
            z = min(3.0, z + 0.1)
        elif direction == "out":
            z = max(0.5, z - 0.1)
        else:
            z = 1.0
        v.set_zoom_level(z)
        self.web.command("zoomChanged")
        return z

    def flush_then(self, callback: Callable[[], None], timeout: float = 1.5) -> None:
        """Ask the page to write every board it holds, then call back (never later than the timeout)."""
        done = {"v": False}

        def finish() -> None:
            if not done["v"]:
                done["v"] = True
                callback()

        self.web.call_async("await EE.native.flush();", finish)
        GLib.timeout_add(int(timeout * 1000), lambda: (finish(), False)[1])

    def shutdown(self) -> None:
        for h in list(self._chats.values()):
            h.cancel()
        self._pool.shutdown(wait=False, cancel_futures=True)

    # ---- bridge
    def dispatch(self, cmd: str, body: dict, done: Callable[[Any, Optional[str]], None]) -> None:
        """Run a bridge command on a worker thread; reply on the main thread."""
        def work() -> None:
            try:
                result = self.handle(cmd, body)
                on_main(done, result, None)
            except Exception as e:  # noqa: BLE001
                if DEBUG:
                    log(f"{cmd} failed:\n{traceback.format_exc()}")
                on_main(done, None, str(e) or e.__class__.__name__)

        try:
            self._pool.submit(work)
        except RuntimeError:
            done(None, "App is shutting down")

    def _on_main_wait(self, fn: Callable[[], Any], timeout: float = 30) -> Any:
        """Run fn on the main thread from a worker and wait for its result."""
        ev = threading.Event()
        box: dict[str, Any] = {}

        def run() -> None:
            try:
                box["r"] = fn()
            except Exception as e:  # noqa: BLE001
                box["e"] = e
            ev.set()

        on_main(run)
        if not ev.wait(timeout):
            raise TimeoutError("the main thread did not answer")
        if "e" in box:
            raise box["e"]
        return box.get("r")

    def handle(self, cmd: str, body: dict) -> Any:  # noqa: C901 - one switch, like the Swift version
        def s(k: str) -> str:
            v = body.get(k)
            return v if isinstance(v, str) else ""

        if cmd == "ready":
            reply: dict[str, Any] = {"native": True, "platform": "linux"}
            if self.self_test is None:
                last = self._state().get("lastBoardId")
                if isinstance(last, str):
                    try:
                        reply["board"] = self.store.load(last).decode("utf-8")
                    except Exception:  # noqa: BLE001
                        pass
            else:
                st = self.self_test
                GLib.timeout_add(1000, lambda: (self.web.call("EE.selfTest", {"prompt": st.prompt} if st.prompt else {}), False)[1])
            return reply

        if cmd == "config":
            cfg = self.config
            problems = list(cfg.problems)
            model = cfg.llm.model or "auto"
            if cfg.llm.provider != "openrouter" or cfg.llm.api_key is not None:
                try:
                    model = LLMClient(cfg.llm).resolve_model()
                except Exception as e:  # noqa: BLE001
                    problems.append(str(e))
            python = cfg.python.interpreter or str(self.runner.venv_python)
            return {"provider": cfg.llm.display_name, "model": model, "baseURL": cfg.llm.base_url,
                    "envFile": str(cfg.env_file) if cfg.env_file else "", "problems": problems, "python": python,
                    "packages": " ".join(cfg.python.packages),
                    "levelset": {"provider": cfg.level_set.display_name, "model": cfg.level_set.model or "auto",
                                 "problems": cfg.level_set_problems},
                    "diagram": {"provider": cfg.diagram.display_name, "model": cfg.diagram.model or "auto",
                                "problems": cfg.diagram_problems}}

        if cmd == "chat":
            raw = body.get("messages") or []
            messages = [{"role": m.get("role") if isinstance(m.get("role"), str) else "user",
                         "content": m.get("content") if isinstance(m.get("content"), str) else ""}
                        for m in raw if isinstance(m, dict)]
            self.start_chat(s("id"), messages, s("purpose"))
            return {"ok": True}

        if cmd == "allBoards":
            return {"boards": self.store.all_json()}

        if cmd == "loadProfile":
            return {"json": read_text_or_empty(self.store.profile_path)}

        if cmd == "saveProfile":
            write_private(s("json").encode("utf-8"), self.store.profile_path)
            return {"ok": True}

        if cmd == "loadNotes":
            return {"json": read_text_or_empty(self.store.notes_path)}

        if cmd == "saveNotes":
            write_private(s("json").encode("utf-8"), self.store.notes_path)
            return {"ok": True}

        if cmd == "cancel":
            h = self._chats.pop(s("id"), None)
            if h:
                h.cancel()
            self.runner.cancel(s("id"))
            return {"ok": True}

        if cmd == "python":
            settings = self.config.python
            result = self.runner.run(s("id"), s("code"), settings,
                                     lambda text: on_main(self.web.call, "EE.native.pyStatus", {"text": text}))
            return result.to_dict()

        if cmd == "saveBoard":
            board_id = s("id")
            if board_id in self._deleted:
                return {"ok": False, "skipped": "deleted"}
            summary = self.store.save(board_id, s("json").encode("utf-8"))
            if summary:
                on_main(self.upsert, summary)
            return {"ok": True}

        if cmd == "current":
            board_id, title = s("id"), s("title")

            def apply() -> None:
                self.current_id = board_id
                self.current_title = title or "New board"
                for b in self.boards:
                    if b.id == board_id and title:
                        b.title = title
                if self.window:
                    self.window.set_board_title(self.current_title)
                    self.window.select(board_id if any(b.id == board_id for b in self.boards) else None)
                if self.self_test is None:
                    self._set_state("lastBoardId", board_id)

            on_main(apply)
            return {"ok": True}

        if cmd == "zoom":
            return {"zoom": self._on_main_wait(lambda: self.zoom(s("dir") or "reset"))}

        if cmd == "copy":
            text = s("text")
            self._on_main_wait(lambda: Gdk.Display.get_default().get_clipboard().set(text))
            return {"ok": True}

        if cmd == "openEnv":
            on_main(self.open_env)
            return {"ok": True}

        if cmd == "log":
            log("[board] " + s("message"))
            return {"ok": True}

        if cmd == "selftest":
            return self.handle_self_test(body)

        raise ValueError(f"Unknown command {cmd}")

    def upsert(self, summary: BoardSummary) -> None:
        for i, b in enumerate(self.boards):
            if b.id == summary.id:
                self.boards[i] = summary
                break
        else:
            self.boards.append(summary)
        self.boards.sort(key=lambda b: b.updated_at, reverse=True)
        if summary.id == self.current_id:
            self.current_title = summary.title
        if self.window:
            self.window.show_boards()
            if summary.id == self.current_id:
                self.window.set_board_title(summary.title)
                self.window.select(summary.id)

    # ---- chat streaming
    def start_chat(self, chat_id: str, messages: list[dict], purpose: str) -> None:
        cfg = self.config
        # each purpose has its own model: explanations (and summaries), the level-set, diagrams
        if purpose == "levelset":
            settings, problems = cfg.level_set, cfg.level_set_problems
        elif purpose == "diagram":
            settings, problems = cfg.diagram, cfg.diagram_problems
        else:
            settings = cfg.llm
            problems = ([f"OPENROUTER_API_KEY is missing. Add it to {cfg.env_file or '.env'} or set LLM_PROVIDER=lmstudio."]
                        if cfg.llm.provider == "openrouter" and cfg.llm.api_key is None else [])
        if problems:
            self.web.fail_chat(chat_id, problems[0])
            return
        client = LLMClient(settings)
        handle = StreamHandle()
        self._chats[chat_id] = handle

        def run() -> None:
            model: Optional[str] = None
            finish: Optional[str] = None
            try:
                for d in client.stream(messages, handle):
                    if handle.cancelled.is_set():
                        break
                    if d.model:
                        model = d.model
                    if d.finish_reason:
                        finish = d.finish_reason
                    if d.content or d.reasoning:
                        self.web.enqueue_chunk(chat_id, d.content, d.reasoning)
                if not handle.cancelled.is_set():
                    self.web.finish_chat(chat_id, model, finish)
            except Exception as e:  # noqa: BLE001
                if not handle.cancelled.is_set():
                    self.web.fail_chat(chat_id, describe(e, settings))
            finally:
                self._chats.pop(chat_id, None)

        threading.Thread(target=run, name=f"chat-{chat_id}", daemon=True).start()

    # ---- self test
    def handle_self_test(self, body: dict) -> Any:
        event = body.get("event") if isinstance(body.get("event"), str) else ""
        out = self.self_test.out_dir if self.self_test else Path(GLib.get_tmp_dir()) / "ee-selftest"
        out.mkdir(parents=True, exist_ok=True)
        if event == "log":
            line = f"{datetime.now(timezone.utc).isoformat()} {body.get('message', '')}\n"
            with open(out / "log.txt", "a", encoding="utf-8") as fh:
                fh.write(line)
            sys.stderr.write("[selftest] " + line)
            sys.stderr.flush()
            return {"ok": True}
        if event == "snapshot":
            name = "".join(c for c in str(body.get("name") or "snap") if c.isalnum() or c in "-_")
            time.sleep(0.25)
            box: dict[str, Any] = {}
            ev = threading.Event()

            def got(png: Optional[bytes], err: Optional[str]) -> None:
                box["png"], box["err"] = png, err
                ev.set()

            on_main(self.web.snapshot_png, got)
            if not ev.wait(20) or box.get("err"):
                raise RuntimeError(box.get("err") or "snapshot timed out")
            (out / f"{name}.png").write_bytes(box["png"])
            return {"ok": True}
        if event == "reload":
            return {"board": self.store.load(str(body.get("id") or "")).decode("utf-8")}
        if event == "finish":
            (out / "report.json").write_text(str(body.get("report") or "{}"), encoding="utf-8")
            if self.self_test and not self.self_test.keep_open:
                GLib.timeout_add(1000, lambda: (self.window.close() if self.window else None, False)[1])
            return {"ok": True}
        return {"ok": True}


def describe(error: Exception, settings: LLMSettings) -> str:
    if isinstance(error, LLMError):
        return str(error)
    return str(error) or error.__class__.__name__


def read_text_or_empty(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def launch_file(path: Path, window: Optional[Gtk.Window]) -> None:
    def done(launcher, result, _data=None) -> None:
        try:
            launcher.launch_finish(result)
        except GLib.Error as e:
            log(f"could not open {path}: {e.message}")

    Gtk.FileLauncher.new(Gio.File.new_for_path(str(path))).launch(window, None, done, None)


def rel_time(ts: float) -> str:
    d = time.time() - ts
    if d < 60:
        return "just now"
    if d < 3600:
        return f"{round(d / 60)} min ago"
    if d < 86400:
        return f"{round(d / 3600)} h ago"
    return datetime.fromtimestamp(ts).strftime("%x")


# ====================================================================== the window
CSS = """
.ee-sidebar { background-color: #1f2823; }
.ee-sidebar list { background: transparent; }
.ee-sidebar row { padding: 6px 10px; border-radius: 8px; margin: 1px 6px; }
.ee-sidebar row:selected { background-color: rgba(246, 224, 138, 0.16); }
.ee-board-title { font-size: 14px; }
.ee-board-meta { font-size: 11px; opacity: 0.65; }
.ee-side-count { color: #f6e08a; opacity: 0.85; }
.ee-empty { opacity: 0.6; font-style: italic; padding: 12px; }
"""

SHORTCUTS = [  # (accelerator, app action)
    ("<Control>n", "new-board"), ("<Control>bracketleft", "close-last"), ("<Control><Shift>BackSpace", "close-all"),
    ("<Control><Shift>m", "map"), ("<Control><Shift>s", "summary"), ("<Control><Alt>m", "matrix"), ("<Control>l", "focus"),
    ("<Control><Shift>l", "levelset"), ("<Control><Alt>l", "profile"), ("<Control>equal", "zoom-in"), ("<Control>plus", "zoom-in"),
    ("<Control>minus", "zoom-out"), ("<Control>0", "zoom-reset"), ("<Control>q", "quit"), ("<Control>w", "quit"),
]


class BoardRow(Gtk.ListBoxRow):
    def __init__(self, board: BoardSummary) -> None:
        super().__init__()
        self.board_id = board.id
        self.board = board
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        self.title = Gtk.Label(xalign=0, wrap=True, lines=2, ellipsize=3)  # Pango.EllipsizeMode.END
        self.title.add_css_class("ee-board-title")
        self.meta = Gtk.Label(xalign=0, use_markup=True)
        self.meta.add_css_class("ee-board-meta")
        box.append(self.title)
        box.append(self.meta)
        self.set_child(box)
        self.update(board)

    def update(self, board: BoardSummary) -> None:
        self.board = board
        self.title.set_text(board.title)
        n = board.branch_count
        meta = GLib.markup_escape_text(rel_time(board.updated_at))
        if n:
            meta += f' · <span class="ee-side-count">{n} side question{"" if n == 1 else "s"}</span>'
            meta = meta.replace('<span class="ee-side-count">', '<span foreground="#f6e08a">')
        self.meta.set_markup(meta)


class MainWindow(Adw.ApplicationWindow):
    def __init__(self, app: "EEApplication", model: AppModel) -> None:
        super().__init__(application=app, title="Equation Explainer", default_width=1480, default_height=940)
        self.model = model
        self._rows: dict[str, BoardRow] = {}
        self._selecting = False
        self._closing = False
        self.set_size_request(960, 620)
        model.window = self

        provider = Gtk.CssProvider()
        provider.load_from_string(CSS)
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

        # ---- sidebar
        self.search = Gtk.SearchEntry(placeholder_text="Search boards")
        self.search.connect("search-changed", lambda *_: self.listbox.invalidate_filter())
        self.listbox = Gtk.ListBox()
        self.listbox.set_selection_mode(Gtk.SelectionMode.SINGLE)
        self.listbox.add_css_class("navigation-sidebar")
        self.listbox.set_filter_func(self._filter)
        self.listbox.connect("row-selected", self._on_row_selected)
        self.empty = Gtk.Label(label="Nothing written yet.", xalign=0)
        self.empty.add_css_class("ee-empty")
        scroller = Gtk.ScrolledWindow(vexpand=True, hscrollbar_policy=Gtk.PolicyType.NEVER)
        lists = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        lists.append(self.empty)
        lists.append(self.listbox)
        scroller.set_child(lists)
        side = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        side.add_css_class("ee-sidebar")
        search_box = Gtk.Box(margin_start=8, margin_end=8, margin_top=6, margin_bottom=6)
        self.search.set_hexpand(True)
        search_box.append(self.search)
        side.append(search_box)
        side.append(scroller)
        side_header = Adw.HeaderBar()
        side_header.set_title_widget(Adw.WindowTitle(title="Boards"))
        new_btn = Gtk.Button(icon_name="list-add-symbolic", tooltip_text="New board (Ctrl+N)")
        new_btn.connect("clicked", lambda *_: model.new_board())
        side_header.pack_start(new_btn)
        side_view = Adw.ToolbarView()
        side_view.add_top_bar(side_header)
        side_view.set_content(side)

        # ---- content
        self.title_widget = Adw.WindowTitle(title="Equation Explainer")
        header = Adw.HeaderBar()
        header.set_title_widget(self.title_widget)
        toggle = Gtk.ToggleButton(icon_name="sidebar-show-symbolic", tooltip_text="Show or hide the board list")
        toggle.set_active(True)
        header.pack_start(toggle)
        menu_btn = Gtk.MenuButton(icon_name="open-menu-symbolic", tooltip_text="Board menu")
        menu_btn.set_menu_model(app.board_menu())
        header.pack_end(menu_btn)
        content = Adw.ToolbarView()
        content.add_top_bar(header)
        content.set_content(model.web.webview)

        split = Adw.OverlaySplitView()
        split.set_sidebar(side_view)
        split.set_content(content)
        split.set_min_sidebar_width(200)
        split.set_max_sidebar_width(380)
        split.set_sidebar_width_fraction(0.18)
        toggle.bind_property("active", split, "show-sidebar", 0)
        self.set_content(split)

        # ---- shortcuts: handled before the web view sees the keys
        sc = Gtk.ShortcutController()
        sc.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        for accel, action in SHORTCUTS:
            trigger = Gtk.ShortcutTrigger.parse_string(accel)
            if trigger is not None:
                sc.add_shortcut(Gtk.Shortcut.new(trigger, Gtk.NamedAction.new(f"app.{action}")))
        self.add_controller(sc)

        # ---- per-board actions (context menu)
        for name, fn in (("rename-board", self._rename_dialog), ("reveal-board", model.reveal), ("trash-board", self._trash_dialog)):
            act = Gio.SimpleAction.new(name, GLib.VariantType.new("s"))
            act.connect("activate", lambda a, v, fn=fn: fn(v.get_string()))
            self.add_action(act)

        self.connect("close-request", self._on_close_request)
        self.show_boards()
        GLib.timeout_add_seconds(60, self._refresh_times)

    # ---- board list
    def show_boards(self) -> None:
        boards = self.model.boards
        wanted = {b.id for b in boards}
        for bid in list(self._rows):
            if bid not in wanted:
                self.listbox.remove(self._rows.pop(bid))
        for i, b in enumerate(boards):
            row = self._rows.get(b.id)
            if row is None:
                row = BoardRow(b)
                self._attach_context_menu(row)
                self._rows[b.id] = row
                self.listbox.insert(row, i)
            else:
                row.update(b)
                if row.get_index() != i:
                    self.listbox.remove(row)
                    self.listbox.insert(row, i)
        self.empty.set_visible(not boards)
        self.listbox.invalidate_filter()

    def _refresh_times(self) -> bool:
        for row in self._rows.values():
            row.update(row.board)
        return True

    def _filter(self, row: Gtk.ListBoxRow) -> bool:
        q = self.search.get_text().strip().lower()
        return not q or q in row.board.title.lower()

    def select(self, board_id: Optional[str]) -> None:
        self._selecting = True
        try:
            row = self._rows.get(board_id) if board_id else None
            if row is None:
                self.listbox.unselect_all()
            elif self.listbox.get_selected_row() is not row:
                self.listbox.select_row(row)
        finally:
            self._selecting = False

    def _on_row_selected(self, listbox, row) -> None:
        if self._selecting or row is None:
            return
        self.model.open(row.board_id)

    def set_board_title(self, title: str) -> None:
        self.title_widget.set_title(title or "Equation Explainer")
        self.set_title(f"{title} — Equation Explainer" if title else "Equation Explainer")

    def _attach_context_menu(self, row: BoardRow) -> None:
        gesture = Gtk.GestureClick(button=3)

        def pressed(g, n, x, y) -> None:
            menu = Gio.Menu()
            for label, action in (("Rename…", "win.rename-board"), ("Show in Files", "win.reveal-board")):
                item = Gio.MenuItem.new(label, None)
                item.set_action_and_target_value(action, GLib.Variant("s", row.board_id))
                menu.append_item(item)
            section = Gio.Menu()
            item = Gio.MenuItem.new("Move to Trash…", None)
            item.set_action_and_target_value("win.trash-board", GLib.Variant("s", row.board_id))
            section.append_item(item)
            menu.append_section(None, section)
            pop = Gtk.PopoverMenu.new_from_model(menu)
            pop.set_parent(row)
            pop.set_has_arrow(False)
            pop.set_pointing_to(Gdk.Rectangle(x=int(x), y=int(y), width=1, height=1))
            pop.connect("closed", lambda p: GLib.idle_add(lambda: (p.unparent(), False)[1]))
            pop.popup()

        gesture.connect("pressed", pressed)
        row.add_controller(gesture)

    def _rename_dialog(self, board_id: str) -> None:
        row = self._rows.get(board_id)
        if not row:
            return
        dialog = Adw.AlertDialog(heading="Rename board")
        entry = Gtk.Entry(text=row.board.title, activates_default=True)
        dialog.set_extra_child(entry)
        dialog.add_response("cancel", "Cancel")
        dialog.add_response("rename", "Rename")
        dialog.set_response_appearance("rename", Adw.ResponseAppearance.SUGGESTED)
        dialog.set_default_response("rename")
        dialog.set_close_response("cancel")
        dialog.connect("response", lambda d, r: self.model.rename(board_id, entry.get_text()) if r == "rename" else None)
        dialog.present(self)
        entry.grab_focus()

    def _trash_dialog(self, board_id: str) -> None:
        row = self._rows.get(board_id)
        if not row:
            return
        dialog = Adw.AlertDialog(heading=f"Move “{row.board.title}” to the trash?",
                                 body="The board and all of its side questions go to the trash. You can restore the file from there.")
        dialog.add_response("cancel", "Keep it")
        dialog.add_response("trash", "Move to Trash")
        dialog.set_response_appearance("trash", Adw.ResponseAppearance.DESTRUCTIVE)
        dialog.set_default_response("cancel")
        dialog.set_close_response("cancel")
        dialog.connect("response", lambda d, r: self.model.delete(board_id) if r == "trash" else None)
        dialog.present(self)

    # ---- quitting: give the page a moment to write half-streamed answers
    def _on_close_request(self, *_) -> bool:
        if self._closing:
            return False
        self._closing = True
        self.model.flush_then(self._finish_close)
        return True

    def _finish_close(self) -> None:
        self.model.shutdown()
        self.destroy()


# ====================================================================== the application
class EEApplication(Adw.Application):
    def __init__(self, self_test: Optional[SelfTestOptions]) -> None:
        flags = Gio.ApplicationFlags.NON_UNIQUE if self_test else Gio.ApplicationFlags.DEFAULT_FLAGS
        super().__init__(application_id=APP_ID, flags=flags)
        self.self_test = self_test
        self.model: Optional[AppModel] = None
        self.window: Optional[MainWindow] = None

    def board_menu(self) -> Gio.Menu:
        menu = Gio.Menu()
        sections = [
            [("New Board", "new-board")],
            [("Close Side Question", "close-last"), ("Back to the Original", "close-all"), ("Board Map", "map"), ("Board Summary", "summary")],
            [("Insert Matrix…", "matrix"), ("Write on the Board", "focus")],
            [("Level-Set Now", "levelset"), ("Where I Stand & My Notes", "profile")],
            [("Model & Runtime…", "config"), ("Open .env", "open-env"), ("Reveal Boards Folder", "reveal-boards")],
            [("Zoom In", "zoom-in"), ("Zoom Out", "zoom-out"), ("Actual Size", "zoom-reset")],
            [("Quit", "quit")],
        ]
        for items in sections:
            section = Gio.Menu()
            for label, action in items:
                section.append(label, f"app.{action}")
            menu.append_section(None, section)
        return menu

    def do_startup(self) -> None:
        Adw.Application.do_startup(self)
        Adw.StyleManager.get_default().set_color_scheme(Adw.ColorScheme.FORCE_DARK)
        icons = Path(__file__).resolve().parent.parent / "data" / "icons"
        if icons.exists():
            Gtk.IconTheme.get_for_display(Gdk.Display.get_default()).add_search_path(str(icons))

        def act(name: str, fn: Callable[[], None]) -> None:
            a = Gio.SimpleAction.new(name, None)
            a.connect("activate", lambda *_: fn())
            self.add_action(a)

        m = lambda: self.model  # noqa: E731
        cmd = lambda name: (lambda: m() and m().web.command(name))  # noqa: E731
        act("new-board", lambda: m() and m().new_board())
        for name, page in (("close-last", "closeLast"), ("close-all", "closeAll"), ("map", "toggleMap"), ("summary", "summary"),
                           ("matrix", "insertMatrix"), ("focus", "focus"), ("levelset", "levelset"), ("profile", "profile"),
                           ("config", "config")):
            act(name, cmd(page))
        act("open-env", lambda: m() and m().open_env())
        act("reveal-boards", lambda: m() and m().reveal_boards_folder())
        act("zoom-in", lambda: m() and m().zoom("in"))
        act("zoom-out", lambda: m() and m().zoom("out"))
        act("zoom-reset", lambda: m() and m().zoom("reset"))
        act("quit", lambda: self.window.close() if self.window else self.quit())
        accels: dict[str, list[str]] = {}
        for accel, action in SHORTCUTS:
            accels.setdefault(action, []).append(accel)
        for action, keys in accels.items():
            self.set_accels_for_action(f"app.{action}", keys)

    def do_activate(self) -> None:
        if self.window:
            self.window.present()
            return
        resources = resources_dir()
        support = support_dir()
        support.mkdir(parents=True, exist_ok=True)
        boards_env = os.environ.get("EE_BOARDS_DIR")
        boards_dir = Path(os.path.expanduser(boards_env)) if boards_env else support / "Boards"
        store = BoardStore(boards_dir)
        runner = PythonRunner(support, resources / "python")
        web = WebController(resources / "web", support)
        project_root = str(REPO_ROOT) if (REPO_ROOT / ".env.example").exists() else None
        self.model = AppModel(web, store, runner, support, project_root, self.self_test)
        self.window = MainWindow(self, self.model)
        self.window.set_icon_name("equation-explainer")
        self.window.present()
        web.load()


def parse_args(argv: list[str]) -> tuple[Optional[SelfTestOptions], list[str]]:
    """Our own flags; everything else goes to GTK."""
    rest: list[str] = []
    out_dir = None
    keep_open = False
    prompt = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--selftest" and i + 1 < len(argv):
            out_dir = Path(os.path.expanduser(argv[i + 1]))
            i += 2
            continue
        if a == "--selftest-keep-open":
            keep_open = True
        elif a == "--selftest-prompt" and i + 1 < len(argv):
            prompt = argv[i + 1]
            i += 2
            continue
        elif a in ("--version", "-V"):
            print(f"Equation Explainer {__version__}")
            sys.exit(0)
        elif a in ("--help", "-h"):
            print("usage: equation-explainer [--selftest DIR [--selftest-keep-open] [--selftest-prompt TEXT]]\n"
                  "Environment: EE_ENV_FILE, EE_DATA_DIR, EE_BOARDS_DIR, EE_RESOURCES, EE_DEBUG")
            sys.exit(0)
        else:
            rest.append(a)
        i += 1
    self_test = None
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)
        self_test = SelfTestOptions(out_dir, keep_open, prompt)
    return self_test, rest


def main(argv: Optional[list[str]] = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    GLib.set_prgname("equation-explainer")
    GLib.set_application_name("Equation Explainer")
    self_test, rest = parse_args(argv)
    app = EEApplication(self_test)
    return app.run([sys.argv[0], *rest])
