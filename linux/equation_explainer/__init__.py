"""Equation Explainer for Linux: a GTK4 / WebKitGTK shell around the shared blackboard UI."""
from __future__ import annotations

from pathlib import Path

__version__ = "1.0"

#: The repository root when running from the source tree (linux/equation_explainer/__init__.py -> ../..).
REPO_ROOT = Path(__file__).resolve().parents[2]


def resources_dir() -> Path:
    """The folder holding web/ and python/ (the shared assets).

    EE_RESOURCES overrides it; otherwise the source tree's shared/ folder, else the system install.
    """
    import os
    o = os.environ.get("EE_RESOURCES")
    if o:
        return Path(os.path.expanduser(o))
    tree = REPO_ROOT / "shared"
    if (tree / "web" / "index.html").exists():
        return tree
    return Path("/usr/share/equation-explainer")
