"""Runs board cells in fresh Python processes, inside a managed virtualenv.

Mirrors macos/Sources/EECore/PythonRunner.swift (and Process.swift).
"""
from __future__ import annotations

import base64
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from .config import PythonSettings

Progress = Callable[[str], None]
OUTPUT_CAP = 2_000_000


@dataclass
class PythonRunResult:
    stdout: str
    stderr: str
    exit_code: int
    ms: int
    timed_out: bool
    cancelled: bool
    images: list[str] = field(default_factory=list)  # data: URIs
    interpreter: str = ""

    def to_dict(self) -> dict:
        return {"stdout": self.stdout, "stderr": self.stderr, "exitCode": self.exit_code, "ms": self.ms,
                "timedOut": self.timed_out, "cancelled": self.cancelled, "images": self.images,
                "interpreter": self.interpreter}


class PythonError(Exception):
    @classmethod
    def no_base_python(cls) -> "PythonError":
        return cls("No python3 found. Install Python (e.g. `sudo apt install python3 python3-venv`) or set PYTHON_PATH in .env.")

    @classmethod
    def setup_failed(cls, message: str) -> "PythonError":
        return cls(f"Setting up the Python environment failed:\n{message}")


class ProcessHandle:
    """A launched child process that can be cancelled from another thread."""

    def __init__(self) -> None:
        self.process: Optional[subprocess.Popen] = None
        self.timed_out = False
        self.cancelled = False
        self._lock = threading.Lock()

    def _stop(self) -> None:
        p = self.process
        if p is None or p.poll() is not None:
            return
        try:
            p.terminate()
        except OSError:
            return

        def hard_kill() -> None:
            if p.poll() is None:
                try:
                    p.kill()
                except OSError:
                    pass

        threading.Timer(2.0, hard_kill).start()

    def cancel(self) -> None:
        with self._lock:
            self.cancelled = True
        self._stop()

    def time_out(self) -> None:
        with self._lock:
            self.timed_out = True
        self._stop()


@dataclass
class ProcessOutput:
    stdout: bytes
    stderr: bytes
    status: int
    timed_out: bool
    cancelled: bool


def run_process(exe: str, args: list[str], env: Optional[dict] = None, cwd: Optional[Path] = None,
                timeout: float = 0, output_cap: int = OUTPUT_CAP, handle: Optional[ProcessHandle] = None) -> ProcessOutput:
    """Run a process to completion, capturing (capped) output."""
    handle = handle or ProcessHandle()
    p = subprocess.Popen([exe, *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         env=env, cwd=str(cwd) if cwd else None, start_new_session=True)
    handle.process = p
    if handle.cancelled:
        handle._stop()
    chunks: dict[str, list[bytes]] = {"out": [], "err": []}
    truncated = {"out": False, "err": False}

    def pump(name: str, stream) -> None:
        size = 0
        for data in iter(lambda: stream.read1(65536), b""):
            if size >= output_cap:
                truncated[name] = True
                continue  # keep draining so the child never blocks on a full pipe
            room = output_cap - size
            chunks[name].append(data[:room])
            size += min(len(data), room)
            if len(data) > room:
                truncated[name] = True
        stream.close()

    threads = [threading.Thread(target=pump, args=("out", p.stdout), daemon=True),
               threading.Thread(target=pump, args=("err", p.stderr), daemon=True)]
    for t in threads:
        t.start()
    timer = None
    if timeout > 0:
        timer = threading.Timer(timeout, handle.time_out)
        timer.start()
    status = p.wait()
    if timer:
        timer.cancel()
    for t in threads:
        t.join()
    stdout = b"".join(chunks["out"])
    if truncated["out"]:
        stdout += b"\n[output truncated]\n"
    return ProcessOutput(stdout, b"".join(chunks["err"]), status, handle.timed_out, handle.cancelled)


def base_python() -> Optional[str]:
    """A system interpreter to build the managed venv from."""
    for c in ([sys.executable] if sys.executable else []) + ["/usr/bin/python3", "/usr/local/bin/python3", shutil.which("python3") or ""]:
        if c and os.access(c, os.X_OK):
            return c
    return None


class PythonRunner:
    def __init__(self, support_dir: Path, kit_dir: Path) -> None:
        self.support_dir = Path(support_dir)
        self.kit_dir = Path(kit_dir).resolve()  # folder with runner.py, boardkit.py, matplotlibrc (absolute: cells run elsewhere)
        self._handles: dict[str, ProcessHandle] = {}
        self._lock = threading.Lock()
        self._setup_lock = threading.Lock()

    @property
    def venv_dir(self) -> Path:
        return self.support_dir / "pyenv"

    @property
    def venv_python(self) -> Path:
        return self.venv_dir / "bin" / "python"

    @property
    def marker(self) -> Path:
        return self.venv_dir / ".ee-packages"

    def interpreter(self, settings: PythonSettings, progress: Progress) -> Path:
        """The interpreter to use, creating/updating the managed venv when needed."""
        if settings.interpreter:
            return Path(settings.interpreter)
        want = " ".join(sorted(settings.packages))
        with self._setup_lock:  # one setup at a time; a second caller finds it ready
            if os.access(self.venv_python, os.X_OK):
                try:
                    if self.marker.read_text(encoding="utf-8") == want:
                        return self.venv_python
                except OSError:
                    pass
            self.venv_dir.parent.mkdir(parents=True, exist_ok=True)
            if not os.access(self.venv_python, os.X_OK):
                base = base_python()
                if not base:
                    raise PythonError.no_base_python()
                progress("Creating a Python environment for the board (one time)…")
                r = run_process(base, ["-m", "venv", str(self.venv_dir)], timeout=300)
                if r.status != 0:
                    raise PythonError.setup_failed(r.stderr.decode("utf-8", "replace"))
            if settings.packages:
                progress(f"Installing {', '.join(settings.packages)} (one time, about a minute)…")
                r = run_process(str(self.venv_python), ["-m", "pip", "install", "--disable-pip-version-check", "-q", *settings.packages],
                                timeout=1200)
                if r.status != 0:
                    raise PythonError.setup_failed(r.stderr.decode("utf-8", "replace"))
            self.marker.write_text(want, encoding="utf-8")
            progress("Python environment ready.")
            return self.venv_python

    def run(self, run_id: str, code: str, settings: PythonSettings, progress: Progress) -> PythonRunResult:
        python = self.interpreter(settings, progress)
        run_dir = self.support_dir / "runs" / uuid.uuid4().hex
        out_dir = run_dir / "out"
        out_dir.mkdir(parents=True, exist_ok=True)
        try:
            cell = run_dir / "cell.py"
            cell.write_text(code, encoding="utf-8")
            env = dict(os.environ)
            existing = env.get("PYTHONPATH")
            env["PYTHONPATH"] = str(self.kit_dir) + (":" + existing if existing else "")
            env["MPLBACKEND"] = "Agg"
            env["MATPLOTLIBRC"] = str(self.kit_dir / "matplotlibrc")
            env["PYTHONIOENCODING"] = "utf-8"
            env["PYTHONUNBUFFERED"] = "1"
            env["PYTHONDONTWRITEBYTECODE"] = "1"
            env["MPLCONFIGDIR"] = str(self.support_dir / "mplconfig")
            handle = ProcessHandle()
            with self._lock:
                self._handles[run_id] = handle
            started = time.monotonic()
            try:
                r = run_process(str(python), ["-u", str(self.kit_dir / "runner.py"), str(cell), str(out_dir)],
                                env=env, cwd=run_dir, timeout=settings.timeout, handle=handle)
            finally:
                with self._lock:
                    self._handles.pop(run_id, None)
            images = []
            for name in sorted(p.name for p in out_dir.glob("*.png"))[:8]:
                data = (out_dir / name).read_bytes()
                if len(data) < 6_000_000:
                    images.append("data:image/png;base64," + base64.b64encode(data).decode("ascii"))
            stderr = r.stderr.decode("utf-8", "replace")
            if r.timed_out:
                stderr += f"\n[stopped: exceeded PYTHON_TIMEOUT of {int(settings.timeout)} s]"
            return PythonRunResult(r.stdout.decode("utf-8", "replace"), stderr, r.status,
                                   int((time.monotonic() - started) * 1000), r.timed_out, r.cancelled, images, str(python))
        finally:
            shutil.rmtree(run_dir, ignore_errors=True)

    def cancel(self, run_id: str) -> None:
        with self._lock:
            h = self._handles.get(run_id)
        if h:
            h.cancel()
