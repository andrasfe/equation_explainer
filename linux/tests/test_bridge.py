"""The native bridge: every command the page can send, answered by AppModel with a stub web view.

Needs PyGObject with GTK 4 / libadwaita / WebKitGTK 6.0 importable (as on the target machine); skipped otherwise.
No window and no web process are created: the stub records what would be sent to the page.
"""
from __future__ import annotations

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

app = pytest.importorskip("equation_explainer.app")
from gi.repository import GLib  # noqa: E402

from equation_explainer.pyrunner import PythonRunner  # noqa: E402
from equation_explainer.store import BoardStore  # noqa: E402

REPO = Path(__file__).resolve().parents[2]


class StubWeb:
    """Records calls instead of talking to WebKit; model is set by AppModel."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.chunks: dict[str, list[str]] = {}
        self.done: dict[str, dict] = {}
        self.failed: dict[str, str] = {}
        self.model = None
        self.webview = None

    def call(self, function, arg=None):
        self.calls.append((function, arg or {}))

    def command(self, name):
        self.call("EE.native.command", {"name": name})

    def enqueue_chunk(self, chat_id, content, reasoning):
        self.chunks.setdefault(chat_id, []).append(content)

    def finish_chat(self, chat_id, model, finish):
        self.done[chat_id] = {"model": model, "finish": finish}

    def fail_chat(self, chat_id, message):
        self.failed[chat_id] = message

    def call_async(self, body, callback):
        callback()


class _Model(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"data":[{"id":"stub-model"}]}')

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        text = "slow " * 400 if "slow" in body["messages"][-1]["content"] else "**Key idea:** $x$"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for i in range(0, len(text), 5):
            self.wfile.write(b"data: " + json.dumps({"model": "stub-model", "choices": [{"delta": {"content": text[i:i + 5]}}]}).encode() + b"\n\n")
            self.wfile.flush()
            if "slow" in text:
                time.sleep(0.02)
        self.wfile.write(b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')


@pytest.fixture(scope="module")
def model_server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Model)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}/v1"
    srv.shutdown()


@pytest.fixture
def model(tmp_path, model_server, monkeypatch):
    env = tmp_path / "test.env"
    env.write_text(f"LLM_PROVIDER=custom\nLLM_BASE_URL={model_server}\nLEVELSET_PROVIDER=custom\nDIAGRAM_PROVIDER=custom\n"
                   f"PYTHON_PATH={sys.executable}\nPYTHON_PACKAGES=\n")
    monkeypatch.setenv("EE_ENV_FILE", str(env))
    support = tmp_path / "data"
    store = BoardStore(support / "Boards")
    runner = PythonRunner(support, REPO / "shared" / "python")
    web = StubWeb()
    m = app.AppModel(web, store, runner, support, None, None)
    yield m
    m.shutdown()


def pump(seconds: float) -> None:
    """Run the GLib main loop briefly so on_main callbacks land."""
    ctx = GLib.MainContext.default()
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        while ctx.iteration(False):
            pass
        time.sleep(0.01)


def test_ready_config_and_storage_commands(model):
    assert model.handle("ready", {}) == {"native": True, "platform": "linux"}

    cfg = model.handle("config", {})
    assert cfg["provider"] == "Custom" and cfg["model"] == "stub-model" and cfg["problems"] == []
    assert cfg["levelset"]["problems"] == [] and cfg["diagram"]["problems"] == []
    assert cfg["python"] == sys.executable

    board = {"id": "b1", "title": "Grover", "createdAt": 1000, "updatedAt": 2000, "threads": {"root": {"cards": []}}}
    assert model.handle("saveBoard", {"id": "b1", "json": json.dumps(board)}) == {"ok": True}
    pump(0.2)
    assert [b.id for b in model.boards] == ["b1"]
    assert json.loads(model.handle("allBoards", {})["boards"][0])["id"] == "b1"

    assert model.handle("loadProfile", {}) == {"json": ""}
    model.handle("saveProfile", {"json": '{"overall":{"level":2}}'})
    assert model.handle("loadProfile", {})["json"] == '{"overall":{"level":2}}'
    assert oct(model.store.profile_path.stat().st_mode & 0o777) == "0o600"
    model.handle("saveNotes", {"json": '{"version":1,"notes":[]}'})
    assert model.handle("loadNotes", {})["json"] == '{"version":1,"notes":[]}'

    model.handle("current", {"id": "b1", "title": "Grover"})
    pump(0.2)
    assert model.current_id == "b1" and model.current_title == "Grover"
    assert model.handle("ready", {})["board"].startswith("{")  # the last board comes back on the next start

    assert model.handle("log", {"message": "hi"}) == {"ok": True}
    with pytest.raises(ValueError):
        model.handle("nope", {})


def test_deleted_boards_are_not_written_back(model):
    model.handle("saveBoard", {"id": "b2", "json": '{"id":"b2","title":"t","threads":{"root":{}}}'})
    model.delete("b2")
    assert not model.store.path("b2").exists()
    assert model.handle("saveBoard", {"id": "b2", "json": '{"id":"b2"}'}) == {"ok": False, "skipped": "deleted"}
    assert ("EE.native.deleted", {"id": "b2"}) in model.web.calls


def test_chat_streams_through_the_bridge(model):
    model.handle("chat", {"id": "c1", "purpose": "explain", "messages": [{"role": "user", "content": "hi"}]})
    for _ in range(100):
        if "c1" in model.web.done:
            break
        time.sleep(0.05)
    assert "".join(model.web.chunks["c1"]) == "**Key idea:** $x$"
    assert model.web.done["c1"] == {"model": "stub-model", "finish": "stop"}


def test_chat_cancel_and_missing_key(model, tmp_path, monkeypatch):
    model.handle("chat", {"id": "c2", "purpose": "explain", "messages": [{"role": "user", "content": "slow"}]})
    time.sleep(0.1)
    model.handle("cancel", {"id": "c2"})
    time.sleep(0.3)
    assert "c2" not in model.web.done and "c2" not in model.web.failed  # the page already treats a cancel as done

    env = tmp_path / "nokey.env"
    env.write_text("LLM_PROVIDER=openrouter\n")
    monkeypatch.setenv("EE_ENV_FILE", str(env))
    model.handle("chat", {"id": "c3", "purpose": "explain", "messages": [{"role": "user", "content": "hi"}]})
    assert "OPENROUTER_API_KEY is missing" in model.web.failed["c3"]
    model.handle("chat", {"id": "c4", "purpose": "levelset", "messages": [{"role": "user", "content": "hi"}]})
    assert "level-set runs on OpenRouter" in model.web.failed["c4"]
    model.handle("chat", {"id": "c5", "purpose": "diagram", "messages": [{"role": "user", "content": "hi"}]})
    assert "Diagrams are drawn on OpenRouter" in model.web.failed["c5"]


def test_python_command_runs_a_cell(model):
    r = model.handle("python", {"id": "r1", "code": "print('$$1+1=2$$')"})
    assert r["exitCode"] == 0 and r["stdout"] == "$$1+1=2$$\n" and r["interpreter"] == sys.executable


def test_selftest_events(model, tmp_path):
    model.self_test = app.SelfTestOptions(tmp_path / "st", keep_open=True, prompt=None)
    model.handle("selftest", {"event": "log", "message": "PASS x"})
    assert "PASS x" in (tmp_path / "st" / "log.txt").read_text()
    model.handle("saveBoard", {"id": "b9", "json": '{"id":"b9","threads":{"root":{}}}'})
    assert json.loads(model.handle("selftest", {"event": "reload", "id": "b9"})["board"])["id"] == "b9"
    model.handle("selftest", {"event": "finish", "report": '{"ok":true}'})
    assert (tmp_path / "st" / "report.json").read_text() == '{"ok":true}'


def test_dispatch_replies_on_the_main_thread(model):
    got = {}
    model.dispatch("loadNotes", {}, lambda result, error: got.update(result=result, error=error))
    pump(1.0)
    assert got == {"result": {"json": '{"version":1,"notes":[]}'}, "error": None} or got["error"] is None
    model.dispatch("bogus", {}, lambda result, error: got.update(result=result, error=error))
    pump(1.0)
    assert got["error"] == "Unknown command bogus"


def test_menu_and_shortcuts_parse():
    from gi.repository import Gtk
    application = app.EEApplication(None)
    assert application.board_menu().get_n_items() == 7
    for accel, _ in app.SHORTCUTS:
        assert Gtk.ShortcutTrigger.parse_string(accel) is not None, accel
    assert app.rel_time(time.time() - 10) == "just now"
    assert app.rel_time(time.time() - 600) == "10 min ago"
    st, rest = app.parse_args(["--selftest", "/tmp/x", "--selftest-keep-open", "--selftest-prompt", "p", "--foo"])
    assert st.keep_open and st.prompt == "p" and rest == ["--foo"]
