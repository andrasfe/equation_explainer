"""Unit tests for the Linux core: .env parsing, config, SSE, the board store and the Python runner.

These mirror macos/Tests/EECoreTests/EECoreTests.swift.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from equation_explainer import config, llm  # noqa: E402
from equation_explainer.config import PythonSettings  # noqa: E402
from equation_explainer.pyrunner import PythonRunner  # noqa: E402
from equation_explainer.store import BoardStore, BoardStoreError, summary_from, write_private  # noqa: E402

REPO = Path(__file__).resolve().parents[2]


# ------------------------------------------------------------------ .env
def test_dotenv_quotes_comments_and_export():
    env = config.parse_dotenv("""
    # comment
    export LLM_PROVIDER=openrouter
    OPENROUTER_API_KEY="sk-or-abc#notacomment"
    LMSTUDIO_MODEL=qwen # trailing comment
    EMPTY=
    SINGLE='a b'
    """)
    assert env["LLM_PROVIDER"] == "openrouter"
    assert env["OPENROUTER_API_KEY"] == "sk-or-abc#notacomment"
    assert env["LMSTUDIO_MODEL"] == "qwen"
    assert env["EMPTY"] == ""
    assert env["SINGLE"] == "a b"


# ------------------------------------------------------------------ config
def test_lmstudio_defaults():
    c = config.resolve({"LLM_PROVIDER": "lmstudio"}, None)
    assert c.llm.provider == "lmstudio"
    assert c.llm.base_url == "http://localhost:1234/v1"
    assert c.llm.model is None
    assert c.problems == []
    assert c.python.packages == ["numpy", "sympy", "scipy", "matplotlib"]
    assert c.python.timeout == 120


def test_openrouter_inferred_from_key():
    c = config.resolve({"OPENROUTER_API_KEY": "k", "OPENROUTER_MODEL": "x/y"}, None)
    assert c.llm.provider == "openrouter"
    assert c.llm.api_key == "k"
    assert c.llm.model == "x/y"
    assert c.llm.base_url == "https://openrouter.ai/api/v1"
    assert c.llm.display_name == "OpenRouter"


def test_openrouter_without_key_is_a_problem():
    c = config.resolve({"LLM_PROVIDER": "openrouter"}, None)
    assert c.llm.model == config.DEFAULT_OPENROUTER_MODEL
    assert c.problems


def test_level_set_defaults_to_openrouter_sol_pro():
    missing = config.resolve({"LLM_PROVIDER": "lmstudio"}, None)
    assert missing.level_set.provider == "openrouter"
    assert missing.level_set.model == "openai/gpt-5.6-sol-pro"
    assert missing.level_set.base_url == "https://openrouter.ai/api/v1"
    assert missing.level_set.temperature is None
    assert missing.level_set.extra_body == {"response_format": {"type": "json_object"}}
    assert len(missing.level_set_problems) == 1  # no key
    assert missing.problems == []  # main chat (LM Studio) is fine

    ok = config.resolve({"LLM_PROVIDER": "lmstudio", "OPENROUTER_API_KEY": "k", "LEVELSET_MODEL": "x/y"}, None)
    assert ok.level_set_problems == []
    assert ok.level_set.api_key == "k"
    assert ok.level_set.model == "x/y"
    assert ok.llm.provider == "lmstudio"

    local = config.resolve({"LEVELSET_PROVIDER": "lmstudio", "LMSTUDIO_MODEL": "gemma"}, None)
    assert local.level_set.provider == "lmstudio"
    assert local.level_set.model == "gemma"
    assert local.level_set_problems == []


def test_diagram_model_defaults_to_openrouter_qwen_coder():
    missing = config.resolve({"LLM_PROVIDER": "lmstudio"}, None)
    assert missing.diagram.provider == "openrouter"
    assert missing.diagram.model == "qwen/qwen3-coder-30b-a3b-instruct"
    assert missing.diagram.temperature == 0.2
    assert len(missing.diagram_problems) == 1
    assert missing.problems == []

    ok = config.resolve({"LLM_PROVIDER": "lmstudio", "OPENROUTER_API_KEY": "k", "DIAGRAM_MAX_TOKENS": "2000"}, None)
    assert ok.diagram_problems == []
    assert ok.diagram.api_key == "k"
    assert ok.diagram.max_tokens == 2000

    local = config.resolve({"DIAGRAM_PROVIDER": "lmstudio", "LMSTUDIO_MODEL": "gemma", "DIAGRAM_MODEL": "qwen-local"}, None)
    assert local.diagram.provider == "lmstudio"
    assert local.diagram.model == "qwen-local"
    assert local.diagram_problems == []


def test_model_choices_list_every_configured_model():
    c = config.resolve({"LLM_PROVIDER": "lmstudio", "LMSTUDIO_MODEL": "gemma", "OPENROUTER_API_KEY": "k",
                        "OPENROUTER_MODEL": "openai/gpt", "OPENROUTER_MODELS": "a/b, openai/gpt c/d"}, None)
    assert [x.id for x in c.choices] == ["lmstudio|gemma", "openrouter|openai/gpt", "openrouter|a/b", "openrouter|c/d"]
    assert c.choices[0].settings == c.llm  # LLM_PROVIDER's model is the default
    pick = c.choice("openrouter|a/b").settings
    assert (pick.model, pick.api_key, pick.max_tokens) == ("a/b", "k", 8192)
    assert c.choice("gone|x").id == "lmstudio|gemma"  # unknown pick falls back to the default

    # no OpenRouter key: only LM Studio, whose blank model means the loaded one
    assert [x.id for x in config.resolve({"LLM_PROVIDER": "lmstudio"}, None).choices] == ["lmstudio|"]
    # OpenRouter default; LM Studio is offered once .env mentions it
    both = config.resolve({"OPENROUTER_API_KEY": "k", "LMSTUDIO_BASE_URL": "http://box:1234/v1"}, None)
    assert [x.id for x in both.choices] == ["openrouter|anthropic/claude-fable-5.1", "lmstudio|"]
    assert both.choice("lmstudio|").settings.base_url == "http://box:1234/v1"


def test_trailing_slash_and_bad_extra_body():
    c = config.resolve({"LMSTUDIO_BASE_URL": "http://box:1234/v1/", "LLM_EXTRA_BODY": "nope"}, None)
    assert c.llm.base_url == "http://box:1234/v1"
    assert c.llm.extra_body is None
    assert len(c.problems) == 1


def test_env_file_lookup_order_and_data_dir(tmp_path, monkeypatch):
    env = {"EE_ENV_FILE": str(tmp_path / "custom.env"), "EE_DATA_DIR": str(tmp_path / "data")}
    files = config.candidate_env_files(str(tmp_path / "proj"), env)
    assert files[0] == tmp_path / "custom.env"
    assert files[1] == tmp_path / "proj" / ".env"
    assert files[2] == tmp_path / "data" / ".env"
    assert config.support_dir(env) == tmp_path / "data"
    assert config.support_dir({"XDG_DATA_HOME": "/x"}) == Path("/x/EquationExplainer")
    (tmp_path / "custom.env").write_text("LLM_PROVIDER=openrouter\nOPENROUTER_API_KEY=k\n")
    c = config.load(str(tmp_path / "proj"), env)
    assert c.env_file == tmp_path / "custom.env"
    assert c.llm.provider == "openrouter" and c.llm.api_key == "k"


# ------------------------------------------------------------------ SSE
def test_sse_classify():
    assert llm.classify(": OPENROUTER PROCESSING") == (llm.IGNORE, "")
    assert llm.classify("") == (llm.IGNORE, "")
    assert llm.classify("data: [DONE]") == (llm.DONE, "")
    assert llm.classify('data: {"a":1}') == (llm.DATA, '{"a":1}')


def test_sse_decode_content_and_reasoning():
    d = llm.decode('{"model":"m","choices":[{"delta":{"content":"Hi","reasoning_content":"hmm"},"finish_reason":null}]}')
    assert d.content == "Hi" and d.reasoning == "hmm" and d.model == "m"
    r = llm.decode('{"choices":[{"delta":{"reasoning":"or-style"},"finish_reason":"stop"}]}')
    assert r.reasoning == "or-style" and r.finish_reason == "stop"
    assert llm.decode("not json") is None


def test_sse_decode_error_throws():
    with pytest.raises(llm.LLMError):
        llm.decode('{"error":{"message":"rate limited"}}')


def test_sse_error_message():
    assert llm.error_message(b'{"error":{"message":"bad key"}}') == "bad key"
    assert llm.error_message(b'{"error":"no model"}') == "no model"
    assert llm.error_message(b"") == "(empty response)"


def test_request_body_merges_extra():
    s = config.LLMSettings("openrouter", "https://openrouter.ai/api/v1", "k", "m", 0.2, 100, {"reasoning": {"effort": "low"}})
    url, headers, body = llm.LLMClient(s).make_request("m", [{"role": "user", "content": "hi"}])
    assert url == "https://openrouter.ai/api/v1/chat/completions"
    assert headers["Authorization"] == "Bearer k"
    assert headers["X-Title"] == "Equation Explainer"
    obj = json.loads(body)
    assert obj["stream"] is True and obj["max_tokens"] == 100 and "reasoning" in obj


# ------------------------------------------------------------------ streaming against a fake server
class _Fake(BaseHTTPRequestHandler):
    chunks = [{"model": "fake-1", "choices": [{"delta": {"content": "Hel"}}]},
              {"choices": [{"delta": {"reasoning": "thinking"}}]},
              {"choices": [{"delta": {"content": "lo"}, "finish_reason": "stop"}]}]
    seen: list[dict] = []
    status = 200

    def log_message(self, *a):  # quiet
        pass

    def do_GET(self):
        if self.path.endswith("/models"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"data": [{"id": "text-embedding-x"}, {"id": "chat-model"}]}).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        _Fake.seen.append({"body": body, "auth": self.headers.get("Authorization")})
        if _Fake.status != 200:
            self.send_response(_Fake.status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"bad key"}}')
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        self.wfile.write(b": ping\n\n")
        for c in self.chunks:
            self.wfile.write(b"data: " + json.dumps(c).encode() + b"\n\n")
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")


@pytest.fixture
def fake_server():
    srv = HTTPServer(("127.0.0.1", 0), _Fake)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    _Fake.seen.clear()
    _Fake.status = 200
    yield f"http://127.0.0.1:{srv.server_port}/v1"
    srv.shutdown()


def test_stream_parses_sse_and_resolves_model(fake_server):
    s = config.LLMSettings("custom", fake_server, "secret", None, 0.1, 50, None)
    deltas = list(llm.LLMClient(s).stream([{"role": "user", "content": "hi"}]))
    assert deltas[0].model == "chat-model"  # the embedding model was skipped
    assert "".join(d.content for d in deltas) == "Hello"
    assert "".join(d.reasoning for d in deltas) == "thinking"
    assert deltas[-1].finish_reason == "stop"
    assert _Fake.seen[0]["auth"] == "Bearer secret"
    assert _Fake.seen[0]["body"]["model"] == "chat-model"


def test_stream_http_error_is_readable(fake_server):
    _Fake.status = 401
    s = config.LLMSettings("openrouter", fake_server, "k", "m", None, None, None)
    with pytest.raises(llm.LLMError) as e:
        list(llm.LLMClient(s).stream([{"role": "user", "content": "hi"}]))
    assert "401" in str(e.value) and "bad key" in str(e.value)


def test_stream_unreachable_server_is_readable():
    s = config.LLMSettings("lmstudio", "http://127.0.0.1:9/v1", None, "m", None, None, None)
    with pytest.raises(llm.LLMError) as e:
        list(llm.LLMClient(s).stream([{"role": "user", "content": "hi"}]))
    assert "Could not reach" in str(e.value) and "LM Studio" in str(e.value)


def test_stream_cancel_stops_early(fake_server):
    s = config.LLMSettings("custom", fake_server, None, "m", None, None, None)
    h = llm.StreamHandle()
    got = []
    for d in llm.LLMClient(s).stream([{"role": "user", "content": "hi"}], h):
        got.append(d)
        if d.content:
            h.cancel()
    assert len(got) == 2  # the model delta and the first content chunk, then the stream stopped


# ------------------------------------------------------------------ board store
def test_store_save_list_rename_delete(tmp_path):
    store = BoardStore(tmp_path / "Boards")
    doc = b'{"id":"b1","title":"Grover","createdAt":1000,"updatedAt":2000,"threads":{"root":{},"t1":{},"t2":{}}}'
    s = store.save("b1", doc)
    assert s.title == "Grover" and s.branch_count == 2
    assert [b.id for b in store.list()] == ["b1"]
    renamed = store.rename("b1", "QFT")
    assert summary_from(renamed).title == "QFT"
    with pytest.raises(BoardStoreError):
        store.save("../evil", b"")
    assert len(store.all_json()) == 1
    assert store.profile_path.name == "learner.json"
    assert store.profile_path.parent == tmp_path
    store.delete("b1")
    assert store.list() == []
    store.delete("b1")  # deleting twice is fine
    with pytest.raises(BoardStoreError):
        store.load("b1")


def test_private_notes_live_next_to_boards_owner_only(tmp_path):
    store = BoardStore(tmp_path / "Boards")
    assert store.notes_path == tmp_path / "learner-notes.json"
    write_private(b'{"version":1,"notes":[]}', store.notes_path)
    write_private(b'{"version":1,"notes":[{"id":"n1"}]}', store.notes_path)
    assert oct(store.notes_path.stat().st_mode & 0o777) == "0o600"
    assert "n1" in store.notes_path.read_text()
    assert not any(b.id == "learner-notes" for b in store.list()), "notes must not show up as a board"


# ------------------------------------------------------------------ python runner
@pytest.mark.skipif(not shutil.which("python3"), reason="no python3")
def test_runner_runs_cell_with_explicit_interpreter(tmp_path):
    runner = PythonRunner(tmp_path, REPO / "shared" / "python")
    settings = PythonSettings(sys.executable, [], 20)
    ok = runner.run("a", "print('$$x^2$$')\n", settings, lambda _: None)
    assert ok.exit_code == 0 and ok.stdout == "$$x^2$$\n"
    assert not (tmp_path / "runs").exists() or not any((tmp_path / "runs").iterdir())
    bad = runner.run("b", "x = 1\nraise ValueError('nope')\n", settings, lambda _: None)
    assert bad.exit_code == 1
    assert "ValueError: nope" in bad.stderr and "raise ValueError" in bad.stderr and "runner.py" not in bad.stderr
    slow = runner.run("c", "import time\ntime.sleep(30)\n", PythonSettings(sys.executable, [], 1), lambda _: None)
    assert slow.timed_out and "PYTHON_TIMEOUT" in slow.stderr
    d = ok.to_dict()
    assert d["exitCode"] == 0 and d["images"] == []


def test_runner_cancel_from_another_thread(tmp_path):
    runner = PythonRunner(tmp_path, REPO / "shared" / "python")
    settings = PythonSettings(sys.executable, [], 30)
    result = {}

    def go():
        result["r"] = runner.run("slow", "import time\nprint('start', flush=True)\ntime.sleep(20)\n", settings, lambda _: None)

    t = threading.Thread(target=go)
    t.start()
    import time
    for _ in range(100):
        if "slow" in runner._handles and runner._handles["slow"].process is not None:
            break
        time.sleep(0.05)
    runner.cancel("slow")
    t.join(10)
    assert not t.is_alive()
    assert result["r"].cancelled and result["r"].exit_code != 0


def test_runner_saves_figures_when_matplotlib_is_available(tmp_path):
    try:
        import matplotlib  # noqa: F401
    except ImportError:
        pytest.skip("no matplotlib in the test interpreter")
    runner = PythonRunner(tmp_path, REPO / "shared" / "python")
    r = runner.run("f", "import matplotlib.pyplot as plt\nplt.plot([0,1],[0,1])\n", PythonSettings(sys.executable, [], 60), lambda _: None)
    assert r.exit_code == 0, r.stderr
    assert len(r.images) == 1 and r.images[0].startswith("data:image/png;base64,")


def test_runner_base_python_exists():
    from equation_explainer.pyrunner import base_python
    assert base_python() and os.access(base_python(), os.X_OK)


# ------------------------------------------------------------------ shared assets are where the app expects them
def test_shared_assets_present():
    from equation_explainer import resources_dir
    r = resources_dir()
    assert (r / "web" / "index.html").exists()
    assert (r / "python" / "runner.py").exists() and (r / "python" / "boardkit.py").exists()
    assert (r / "web" / "fonts" / "PatrickHand-Regular.ttf").exists()


def test_setup_script_checks_without_changing_anything():
    # `make run` calls it first: --check only reports (0 ready, 2 something to do) and prints why
    import subprocess
    script = REPO / "linux" / "scripts" / "setup.sh"
    assert subprocess.run(["bash", "-n", str(script)]).returncode == 0
    r = subprocess.run([str(script), "--check"], capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=30)
    assert r.returncode in (0, 2)
    if r.returncode == 2:
        assert "[equation-explainer setup]" in r.stdout


def test_tempdir_cleanup_safety():
    # the runner must never leave run folders behind, even when the cell fails to start
    d = Path(tempfile.mkdtemp())
    runner = PythonRunner(d, REPO / "shared" / "python")
    with pytest.raises(Exception):
        runner.run("x", "print(1)", PythonSettings("/nonexistent/python", [], 5), lambda _: None)
    assert not any((d / "runs").iterdir()) if (d / "runs").exists() else True
    shutil.rmtree(d, ignore_errors=True)
