"""One JSON file per board, plus the learner profile and the student's notes next to the folder.

Mirrors macos/Sources/EECore/BoardStore.swift.
"""
from __future__ import annotations

import json
import os
import shutil
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class BoardSummary:
    id: str
    title: str
    created_at: float  # seconds since the epoch
    updated_at: float
    branch_count: int


class BoardStoreError(Exception):
    pass


def valid_id(board_id: str) -> bool:
    return 0 < len(board_id) < 100 and all(c.isalnum() or c in "-_" for c in board_id)


def summary_from(data: bytes) -> Optional[BoardSummary]:
    try:
        obj = json.loads(data)
    except ValueError:
        return None
    if not isinstance(obj, dict) or not isinstance(obj.get("id"), str):
        return None

    def ms(k: str) -> float:
        v = obj.get(k)
        return (v if isinstance(v, (int, float)) else 0) / 1000

    threads = obj.get("threads")
    n = len(threads) if isinstance(threads, dict) else 1
    title = obj.get("title") if isinstance(obj.get("title"), str) and obj.get("title") else "Untitled board"
    return BoardSummary(obj["id"], title, ms("createdAt"), ms("updatedAt"), max(0, n - 1))


def write_private(data: bytes, path: Path) -> None:
    """Write a personal file atomically, readable by the owner only."""
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    os.chmod(path, 0o600)


def _trash(path: Path) -> bool:
    """Move a file to the desktop's trash (recoverable). False if no trash is available."""
    try:
        import gi  # noqa: F401
        gi.require_version("Gio", "2.0")
        from gi.repository import Gio
        return bool(Gio.File.new_for_path(str(path)).trash(None))
    except Exception:  # noqa: BLE001 - no GLib, or no trash for this mount
        return False


class BoardStore:
    def __init__(self, directory: Path) -> None:
        self.dir = Path(directory)
        self._lock = threading.RLock()
        self.dir.mkdir(parents=True, exist_ok=True)

    def path(self, board_id: str) -> Path:
        if not valid_id(board_id):
            raise BoardStoreError(f"Invalid board id '{board_id}'")
        return self.dir / f"{board_id}.json"

    @property
    def profile_path(self) -> Path:
        """The learner profile lives next to the Boards folder."""
        return self.dir.parent / "learner.json"

    @property
    def notes_path(self) -> Path:
        """The student's own notes: next to the Boards folder, never in the repo."""
        return self.dir.parent / "learner-notes.json"

    def _files(self) -> list[Path]:
        try:
            return [p for p in self.dir.iterdir() if p.suffix == ".json" and p.is_file()]
        except OSError:
            return []

    def list(self) -> list[BoardSummary]:
        with self._lock:
            out = []
            for p in self._files():
                try:
                    s = summary_from(p.read_bytes())
                except OSError:
                    s = None
                if s:
                    out.append(s)
        return sorted(out, key=lambda s: s.updated_at, reverse=True)

    def all_json(self) -> list[str]:
        """Every board's raw JSON (for the learner model, which looks across all boards)."""
        with self._lock:
            out = []
            for p in self._files():
                try:
                    out.append(p.read_text(encoding="utf-8"))
                except OSError:
                    pass
            return out

    def load(self, board_id: str) -> bytes:
        with self._lock:
            p = self.path(board_id)
            if not p.exists():
                raise BoardStoreError(f"Board '{board_id}' not found")
            return p.read_bytes()

    def save(self, board_id: str, data: bytes) -> Optional[BoardSummary]:
        with self._lock:
            p = self.path(board_id)
            tmp = p.with_name(p.name + ".tmp")
            tmp.write_bytes(data)
            os.replace(tmp, p)
            return summary_from(data)

    def delete(self, board_id: str) -> None:
        """Move the board file to the trash when the desktop has one, else remove it."""
        with self._lock:
            p = self.path(board_id)
            if not p.exists():
                return
            if not _trash(p):
                p.unlink()

    def rename(self, board_id: str, title: str) -> bytes:
        """Rewrite the title inside the JSON and return the updated document."""
        with self._lock:
            obj = json.loads(self.load(board_id))
            if not isinstance(obj, dict):
                raise BoardStoreError(f"Board '{board_id}' not found")
            obj["title"] = title
            obj["updatedAt"] = time.time() * 1000
            out = json.dumps(obj).encode("utf-8")
            self.save(board_id, out)
            return out

    def copy_from(self, other: Path) -> int:
        """Import board files from another folder (used by the self test). Returns the count."""
        n = 0
        for p in Path(other).glob("*.json"):
            shutil.copy2(p, self.dir / p.name)
            n += 1
        return n
