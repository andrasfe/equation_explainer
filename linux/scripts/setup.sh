#!/bin/bash
# Gets this machine ready to run Equation Explainer, then gets out of the way.  `make run` calls it first.
#  1. distribution packages: PyGObject, GTK 4, libadwaita, WebKitGTK 6.0, python3-venv, bubblewrap
#     (installed with apt through sudo, only when something is missing)
#  2. WebKit's web-process sandbox: bubblewrap must be able to create a user namespace. Ubuntu 24.04 forbids
#     that for unprivileged programs (kernel.apparmor_restrict_unprivileged_userns=1) unless an AppArmor profile
#     grants it. That is a security setting of your machine, so this script never changes it: it tells you
#     the one-time command and stops.
# Every step is a no-op once done, so the usual cost is a few milliseconds.
#   usage: linux/scripts/setup.sh [--check]      --check only reports (exit 0 ready, 2 not), never installs
#   EE_SKIP_SETUP=1 skips it entirely.
set -uo pipefail
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
say() { echo "[equation-explainer setup] $*"; }
PACKAGES="python3 python3-gi python3-venv gir1.2-gtk-4.0 gir1.2-adw-1 gir1.2-webkit-6.0 bubblewrap"
SYSCTL_KEY="kernel.apparmor_restrict_unprivileged_userns"

# ---- 1. packages ------------------------------------------------------------------------------------------
gi_ok() {
  python3 - <<'PY' 2>/dev/null
import gi
for name, version in (("Gtk", "4.0"), ("Adw", "1"), ("WebKit", "6.0")):
    gi.require_version(name, version)
import venv  # noqa: F401
PY
}
if ! gi_ok || ! command -v bwrap >/dev/null; then
  if command -v dpkg-query >/dev/null && command -v apt-get >/dev/null; then
    MISSING=""
    for p in $PACKAGES; do
      dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "install ok installed" || MISSING="$MISSING $p"
    done
    MISSING="${MISSING# }"
    if [ -z "$MISSING" ]; then
      say "the packages are installed but PyGObject cannot find GTK 4 / libadwaita / WebKitGTK 6.0 (is python3 the distribution's?)"
      exit 2
    fi
    say "missing packages: $MISSING"
    [ $CHECK = 1 ] && exit 2
    if [ -t 0 ] && [ -t 1 ] || sudo -n true 2>/dev/null; then
      say "installing them with apt (sudo may ask for your password)"
      sudo apt-get install -y $MISSING || { say "apt-get failed"; exit 2; }
    else
      say "not an interactive terminal, so install them yourself:  sudo apt install $MISSING"; exit 2
    fi
    gi_ok || { say "PyGObject still cannot load GTK 4 / libadwaita / WebKitGTK 6.0"; exit 2; }
  else
    say "needs PyGObject with GTK 4, libadwaita 1.5, WebKitGTK 6.0, python3-venv and bubblewrap from your distribution"
    say "(Ubuntu: $PACKAGES)"
    exit 2
  fi
fi

# ---- 2. WebKit's sandbox (bubblewrap + user namespaces) ---------------------------------------------------
if ! timeout 10 bwrap --unshare-user --ro-bind / / --proc /proc --dev /dev true >/dev/null 2>&1; then
  if [ "$(sysctl -n "$SYSCTL_KEY" 2>/dev/null || echo "")" = "1" ]; then
    say "WebKit's sandbox (bubblewrap) cannot create a user namespace: $SYSCTL_KEY=1 (Ubuntu 24.04 default)."
    say "Equation Explainer would crash as soon as the board loads. Allow it once, for good (survives reboots):"
    echo
    echo "    echo '$SYSCTL_KEY = 0' | sudo tee /etc/sysctl.d/60-equation-explainer-userns.conf && sudo sysctl -p /etc/sysctl.d/60-equation-explainer-userns.conf"
    echo
    say "(This lets unprivileged programs create user namespaces, as most other distributions already do."
    say " The alternative is an AppArmor profile for /usr/bin/bwrap that allows 'userns'.) Then run \`make run\` again."
  else
    say "bubblewrap cannot create a user namespace here and the cause is not $SYSCTL_KEY;"
    say "WebKit's web process would crash at start. Check the kernel's user-namespace settings (unprivileged_userns_clone)."
  fi
  exit 2
fi
exit 0
