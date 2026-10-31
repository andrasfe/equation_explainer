"""Configuration: the .env file and the settings derived from it.

This mirrors macos/Sources/EECore/Config.swift so both apps read the same keys
and report the same problems.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

DEFAULT_OPENROUTER_MODEL = "anthropic/claude-fable-5.1"
DEFAULT_LEVELSET_MODEL = "openai/gpt-5.6-sol-pro"
DEFAULT_DIAGRAM_MODEL = "qwen/qwen3-coder-30b-a3b-instruct"


def parse_dotenv(text: str) -> dict[str, str]:
    """Minimal .env parser: KEY=VALUE lines, `export` prefix, quotes, inline ` #` comments."""
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        eq = line.find("=")
        if eq < 0:
            continue
        key = line[:eq].strip()
        value = line[eq + 1:].strip()
        if value and value[0] in "\"'":
            q = value[0]
            close = value.find(q, 1)
            if close != -1:
                value = value[1:close]
                if q == '"':
                    value = value.replace("\\n", "\n")
        else:
            hash_at = value.find(" #")
            if hash_at != -1:
                value = value[:hash_at].strip()
        if key:
            out[key] = value
    return out


@dataclass
class LLMSettings:
    provider: str  # openrouter | lmstudio | custom
    base_url: str
    api_key: Optional[str]
    model: Optional[str]  # None = ask the server (LM Studio: the loaded model)
    temperature: Optional[float]
    max_tokens: Optional[int]
    extra_body: Optional[dict] = None  # extra JSON merged into the request body

    @property
    def display_name(self) -> str:
        return {"openrouter": "OpenRouter", "lmstudio": "LM Studio"}.get(self.provider, "Custom")


@dataclass
class LLMChoice:
    """A model the board can explain with, picked from the top bar. Built from .env: LLM_PROVIDER's model comes first
    (the default), then the models of every other provider .env configures, plus any listed in *_MODELS."""
    id: str  # "provider|model"; an empty model means whichever model LM Studio has loaded
    settings: LLMSettings
    problems: list[str]


@dataclass
class PythonSettings:
    interpreter: Optional[str]  # explicit interpreter (PYTHON_PATH); None = managed venv
    packages: list[str]
    timeout: float


@dataclass
class AppConfig:
    llm: LLMSettings
    level_set: LLMSettings
    diagram: LLMSettings
    python: PythonSettings
    env_file: Optional[Path]
    problems: list[str] = field(default_factory=list)
    level_set_problems: list[str] = field(default_factory=list)
    diagram_problems: list[str] = field(default_factory=list)
    choices: list[LLMChoice] = field(default_factory=list)  # every model the board can switch to; the first is llm

    def choice(self, choice_id: Optional[str]) -> LLMChoice:
        """The choice with this id, or the default (LLM_PROVIDER's model) when it is unknown or .env no longer lists it."""
        return next((c for c in self.choices if c.id == choice_id), self.choices[0])


def parse_provider(raw: str) -> Optional[str]:
    r = raw.lower()
    if r == "openrouter":
        return "openrouter"
    if r in ("lmstudio", "lm_studio", "lm-studio", "local"):
        return "lmstudio"
    if r in ("custom", "openai"):
        return "custom"
    return None


def _endpoint(provider: str, get: Callable[[str], Optional[str]]) -> tuple[str, Optional[str], Optional[str]]:
    """Base URL, key and default model for a provider, from the .env values."""
    if provider == "openrouter":
        return (get("OPENROUTER_BASE_URL") or "https://openrouter.ai/api/v1", get("OPENROUTER_API_KEY"),
                get("OPENROUTER_MODEL") or DEFAULT_OPENROUTER_MODEL)
    if provider == "lmstudio":
        return (get("LMSTUDIO_BASE_URL") or "http://localhost:1234/v1", get("LMSTUDIO_API_KEY"), get("LMSTUDIO_MODEL"))
    return (get("LLM_BASE_URL") or "http://localhost:8080/v1", get("LLM_API_KEY"), get("LLM_MODEL"))


def _url(raw: str, problems: list[str]) -> str:
    base = raw.rstrip("/")
    if "://" in base:
        return base
    problems.append(f"Invalid base URL '{raw}'")
    return "http://localhost:1234/v1"


def _json_object(raw: Optional[str], key: str, problems: list[str]) -> Optional[dict]:
    if raw is None:
        return None
    try:
        obj = json.loads(raw)
    except ValueError:
        obj = None
    if not isinstance(obj, dict):
        problems.append(f"{key} is not a JSON object; ignored")
        return None
    return obj


def _float(v: Optional[str]) -> Optional[float]:
    try:
        return float(v) if v is not None else None
    except ValueError:
        return None


def _int(v: Optional[str]) -> Optional[int]:
    try:
        return int(v) if v is not None else None
    except ValueError:
        return None


def support_dir(environ: Optional[dict] = None) -> Path:
    """~/.local/share/EquationExplainer (XDG_DATA_HOME), or EE_DATA_DIR."""
    env = os.environ if environ is None else environ
    o = env.get("EE_DATA_DIR")
    if o:
        return Path(os.path.expanduser(o))
    base = env.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return Path(base) / "EquationExplainer"


def candidate_env_files(project_root: Optional[str], environ: Optional[dict] = None) -> list[Path]:
    """Where we look for .env, in order."""
    env = os.environ if environ is None else environ
    out: list[Path] = []
    p = env.get("EE_ENV_FILE")
    if p:
        out.append(Path(os.path.expanduser(p)))
    if project_root:
        out.append(Path(project_root) / ".env")
    out.append(support_dir(env) / ".env")
    out.append(Path(os.path.expanduser("~")) / ".equation_explainer.env")
    out.append(Path.cwd() / ".env")
    return out


def load(project_root: Optional[str], environ: Optional[dict] = None) -> AppConfig:
    env = dict(os.environ if environ is None else environ)
    used: Optional[Path] = None
    for path in candidate_env_files(project_root, env):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        env.update(parse_dotenv(text))
        used = path
        break
    return resolve(env, used)


def resolve(values: dict[str, str], env_file: Optional[Path]) -> AppConfig:
    problems: list[str] = []

    def get(k: str) -> Optional[str]:
        v = values.get(k)
        if v is None:
            return None
        v = v.strip()
        return v or None

    p = get("LLM_PROVIDER")
    if p is not None:
        provider = parse_provider(p)
        if provider is None:
            problems.append(f"Unknown LLM_PROVIDER '{p}', falling back to lmstudio")
            provider = "lmstudio"
    else:
        provider = "openrouter" if get("OPENROUTER_API_KEY") else "lmstudio"
    shared: list[str] = []
    extra_body = _json_object(get("LLM_EXTRA_BODY"), "LLM_EXTRA_BODY", shared)
    temperature = _float(get("LLM_TEMPERATURE"))
    max_tokens = _int(get("LLM_MAX_TOKENS"))
    # The board's model, and every other one .env names (LMSTUDIO_MODELS etc. add more per provider).
    prefix = {"lmstudio": "LMSTUDIO", "openrouter": "OPENROUTER", "custom": "LLM"}
    configured = {
        "lmstudio": any(get(k) for k in ("LMSTUDIO_BASE_URL", "LMSTUDIO_MODEL", "LMSTUDIO_MODELS", "LMSTUDIO_API_KEY")),
        "openrouter": get("OPENROUTER_API_KEY") is not None,
        "custom": get("LLM_BASE_URL") is not None,
    }
    choices: list[LLMChoice] = []
    for prov in [provider] + [x for x in ("lmstudio", "openrouter", "custom") if x != provider and configured[x]]:
        base, key, model = _endpoint(prov, get)
        pp: list[str] = []
        if prov == "openrouter" and key is None:
            pp.append("OPENROUTER_API_KEY is not set in .env")
        if prov == "custom" and get("LLM_BASE_URL") is None:
            pp.append("LLM_BASE_URL is not set for the custom provider")
        url = _url(base, pp)
        # named extras such as OPENROUTER_ALT_MODEL (any PREFIX_<name>_MODEL, by key), then the *_MODELS list
        pre = prefix[prov]
        named = [get(k) for k in sorted(values) if k.startswith(pre + "_") and k.endswith("_MODEL") and len(k) > len(pre) + 7]
        models: list[Optional[str]] = [model]
        for m in [n for n in named if n] + (get(f"{pre}_MODELS") or "").replace(",", " ").split():
            if m not in models:
                models.append(m)
        for m in models:
            s = LLMSettings(prov, url, key, m, 0.3 if temperature is None else temperature,
                            8192 if max_tokens is None else max_tokens, extra_body)
            choices.append(LLMChoice(f"{prov}|{m or ''}", s, pp + shared))
        if prov == provider:
            problems += pp
    problems += shared
    llm = choices[0].settings

    # Level-set (learner profile): OpenRouter + the sol-pro model unless overridden.
    ls_problems: list[str] = []
    ls_provider = "openrouter"
    p = get("LEVELSET_PROVIDER")
    if p is not None:
        parsed = parse_provider(p)
        if parsed is None:
            ls_problems.append(f"Unknown LEVELSET_PROVIDER '{p}', using openrouter")
        else:
            ls_provider = parsed
    ls_base, ls_key, ls_default = _endpoint(ls_provider, get)
    ls_model = get("LEVELSET_MODEL") or (DEFAULT_LEVELSET_MODEL if ls_provider == "openrouter" else ls_default)
    if ls_provider == "openrouter" and ls_key is None:
        ls_problems.append(f"OPENROUTER_API_KEY is not set in .env. The level-set runs on OpenRouter ({ls_model}).")
    ls_extra = _json_object(get("LEVELSET_EXTRA_BODY"), "LEVELSET_EXTRA_BODY", ls_problems)
    if ls_extra is None and ls_provider == "openrouter":
        ls_extra = {"response_format": {"type": "json_object"}}
    ls_max = _int(get("LEVELSET_MAX_TOKENS"))
    level_set = LLMSettings(ls_provider, _url(ls_base, ls_problems), ls_key, ls_model,
                            _float(get("LEVELSET_TEMPERATURE")), 32000 if ls_max is None else ls_max, ls_extra)

    # Diagrams: OpenRouter + the qwen coder model unless overridden.
    dg_problems: list[str] = []
    dg_provider = "openrouter"
    p = get("DIAGRAM_PROVIDER")
    if p is not None:
        parsed = parse_provider(p)
        if parsed is None:
            dg_problems.append(f"Unknown DIAGRAM_PROVIDER '{p}', using openrouter")
        else:
            dg_provider = parsed
    dg_base, dg_key, dg_default = _endpoint(dg_provider, get)
    dg_model = get("DIAGRAM_MODEL") or (DEFAULT_DIAGRAM_MODEL if dg_provider == "openrouter" else dg_default)
    if dg_provider == "openrouter" and dg_key is None:
        dg_problems.append(f"OPENROUTER_API_KEY is not set in .env. Diagrams are drawn on OpenRouter ({dg_model}); "
                           "set DIAGRAM_PROVIDER=lmstudio to draw them locally.")
    dg_temp = _float(get("DIAGRAM_TEMPERATURE"))
    dg_max = _int(get("DIAGRAM_MAX_TOKENS"))
    diagram = LLMSettings(dg_provider, _url(dg_base, dg_problems), dg_key, dg_model,
                          0.2 if dg_temp is None else dg_temp, 4096 if dg_max is None else dg_max,
                          _json_object(get("DIAGRAM_EXTRA_BODY"), "DIAGRAM_EXTRA_BODY", dg_problems))

    packages = [x for x in (get("PYTHON_PACKAGES") or "numpy sympy scipy matplotlib").replace(",", " ").split() if x]
    interpreter = get("PYTHON_PATH")
    timeout = _float(get("PYTHON_TIMEOUT"))
    python = PythonSettings(os.path.expanduser(interpreter) if interpreter else None, packages,
                            120.0 if timeout is None else timeout)

    return AppConfig(llm=llm, level_set=level_set, diagram=diagram, python=python, env_file=env_file,
                     problems=problems, level_set_problems=ls_problems, diagram_problems=dg_problems, choices=choices)
