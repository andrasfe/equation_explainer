"""Streaming client for OpenAI-compatible chat completions (OpenRouter, LM Studio, custom).

Mirrors macos/Sources/EECore/LLMClient.swift. Pure stdlib: urllib does the HTTP,
the server-sent events are parsed line by line as they arrive.
"""
from __future__ import annotations

import json
import socket
import ssl
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Iterator, Optional

from .config import LLMSettings


@dataclass
class ChatDelta:
    content: str = ""
    reasoning: str = ""
    finish_reason: Optional[str] = None
    model: Optional[str] = None


class LLMError(Exception):
    """A readable error from the model server or the stream."""

    @classmethod
    def http(cls, code: int, message: str) -> "LLMError":
        return cls(f"The model server answered {code}: {message}")

    @classmethod
    def unreachable(cls, base_url: str, provider: str, reason: str) -> "LLMError":
        hint = " Is LM Studio running with its server started?" if provider == "lmstudio" else ""
        return cls(f"Could not reach {base_url}.{hint} ({reason})")


# ------------------------------------------------------------------ SSE helpers
DATA = "data"
DONE = "done"
IGNORE = "ignore"


def classify(raw: str) -> tuple[str, str]:
    """One SSE line -> (DATA, payload) | (DONE, '') | (IGNORE, '')."""
    line = raw.strip()
    if not line.startswith("data:"):  # comments (": ping"), event:, id:, blanks
        return (IGNORE, "")
    payload = line[5:].strip()
    if payload == "[DONE]":
        return (DONE, "")
    return (DATA, payload) if payload else (IGNORE, "")


def decode(payload: str) -> Optional[ChatDelta]:
    """Decode one chunk. Raises LLMError if the chunk carries an error object."""
    try:
        obj = json.loads(payload)
    except ValueError:
        return None
    if not isinstance(obj, dict):
        return None
    if "error" in obj:
        err = obj["error"]
        if isinstance(err, dict) and isinstance(err.get("message"), str):
            raise LLMError(err["message"])
        raise LLMError(str(err))
    d = ChatDelta(model=obj.get("model") if isinstance(obj.get("model"), str) else None)
    choices = obj.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        choice = choices[0]
        fr = choice.get("finish_reason")
        d.finish_reason = fr if isinstance(fr, str) else None
        delta = choice.get("delta")
        if isinstance(delta, dict):
            d.content = delta.get("content") if isinstance(delta.get("content"), str) else ""
            r = delta.get("reasoning_content")
            if not isinstance(r, str):
                r = delta.get("reasoning")
            d.reasoning = r if isinstance(r, str) else ""
    return d


def error_message(body: bytes) -> str:
    """Pull a readable message out of an error body."""
    try:
        obj = json.loads(body)
        if isinstance(obj, dict):
            e = obj.get("error")
            if isinstance(e, dict) and isinstance(e.get("message"), str):
                return e["message"]
            if isinstance(e, str):
                return e
            if isinstance(obj.get("message"), str):
                return obj["message"]
    except ValueError:
        pass
    s = body[:600].decode("utf-8", "replace")
    return s or "(empty response)"


# ------------------------------------------------------------------ client
class StreamHandle:
    """Lets another thread stop a running stream."""

    def __init__(self) -> None:
        self.cancelled = threading.Event()
        self._lock = threading.Lock()
        self._response = None

    def _attach(self, response) -> None:
        with self._lock:
            self._response = response
        if self.cancelled.is_set():
            self._close()

    def _close(self) -> None:
        with self._lock:
            r, self._response = self._response, None
        if r is not None:
            try:
                r.close()
            except Exception:  # noqa: BLE001 - closing is best effort
                pass

    def cancel(self) -> None:
        self.cancelled.set()
        self._close()


class LLMClient:
    def __init__(self, settings: LLMSettings, request_timeout: float = 900) -> None:
        self.settings = settings
        self.request_timeout = request_timeout  # local models can take a while to load

    def headers(self, accept: str = "application/json") -> dict[str, str]:
        h = {"Accept": accept, "User-Agent": "EquationExplainer/1.0"}
        if self.settings.api_key:
            h["Authorization"] = f"Bearer {self.settings.api_key}"
        if self.settings.provider == "openrouter":
            h["HTTP-Referer"] = "https://github.com/equation-explainer"
            h["X-Title"] = "Equation Explainer"
        return h

    def _get_json(self, url: str, timeout: float):
        req = urllib.request.Request(url, headers=self.headers())
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - the URL comes from .env
            return r.status, r.read()

    def resolve_model(self) -> str:
        """The configured model, or (LM Studio) the loaded one, or the first chat model on the server."""
        if self.settings.model:
            return self.settings.model
        root = self.settings.base_url
        if root.endswith("/v1"):
            root = root[:-3]
        try:
            status, data = self._get_json(root + "/api/v0/models", 5)
            if status == 200:
                llms = [m for m in json.loads(data).get("data", []) if m.get("type") in ("llm", "vlm")]
                pick = next((m for m in llms if m.get("state") == "loaded"), llms[0] if llms else None)
                if pick and isinstance(pick.get("id"), str):
                    return pick["id"]
        except Exception:  # noqa: BLE001 - not an LM Studio server; fall through
            pass
        try:
            status, data = self._get_json(self.settings.base_url + "/models", 8)
        except urllib.error.HTTPError as e:
            raise LLMError(f"Could not list models at {self.settings.base_url}: {error_message(e.read())}") from e
        except (urllib.error.URLError, OSError) as e:
            raise LLMError.unreachable(self.settings.base_url, self.settings.provider, _reason(e)) from e
        try:
            ids = [m.get("id") for m in json.loads(data).get("data", []) if isinstance(m.get("id"), str)]
        except (ValueError, AttributeError):
            ids = []
        for mid in ids:
            if "embed" not in mid.lower():
                return mid
        raise LLMError(f"No chat model available at {self.settings.base_url}. Load one in LM Studio or set LMSTUDIO_MODEL.")

    def make_request(self, model: str, messages: list[dict]) -> tuple[str, dict[str, str], bytes]:
        body: dict = {"model": model, "messages": messages, "stream": True}
        if self.settings.temperature is not None:
            body["temperature"] = self.settings.temperature
        if self.settings.max_tokens is not None:
            body["max_tokens"] = self.settings.max_tokens
        if self.settings.extra_body:
            body.update(self.settings.extra_body)
        headers = self.headers("text/event-stream")
        headers["Content-Type"] = "application/json"
        return (self.settings.base_url + "/chat/completions", headers, json.dumps(body).encode("utf-8"))

    def stream(self, messages: list[dict], handle: Optional[StreamHandle] = None) -> Iterator[ChatDelta]:
        """Yield deltas as they arrive. The first delta only carries the model name."""
        handle = handle or StreamHandle()
        model = self.resolve_model()
        yield ChatDelta(model=model)
        url, headers, body = self.make_request(model, messages)
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            response = urllib.request.urlopen(req, timeout=self.request_timeout)  # noqa: S310
        except urllib.error.HTTPError as e:
            raise LLMError.http(e.code, error_message(e.read(16_000))) from e
        except (urllib.error.URLError, OSError) as e:
            raise LLMError.unreachable(self.settings.base_url, self.settings.provider, _reason(e)) from e
        handle._attach(response)
        try:
            while True:
                if handle.cancelled.is_set():
                    return
                try:
                    raw = response.readline()
                except (OSError, ValueError):
                    if handle.cancelled.is_set():
                        return
                    raise LLMError("The connection to the model server was lost.")
                if not raw:
                    return
                kind, payload = classify(raw.decode("utf-8", "replace"))
                if kind == IGNORE:
                    continue
                if kind == DONE:
                    return
                d = decode(payload)
                if d is not None:
                    yield d
        finally:
            handle._close()


def _reason(e: Exception) -> str:
    if isinstance(e, urllib.error.URLError):
        r = e.reason
        return r.strerror if isinstance(r, OSError) and r.strerror else str(r)
    if isinstance(e, (socket.timeout, TimeoutError)):
        return "timed out"
    if isinstance(e, ssl.SSLError):
        return f"TLS error: {e}"
    return str(e)
