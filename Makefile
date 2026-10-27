# `make run`, `make test` and `make selftest` pick the app for this OS; the mac-* and linux-* targets are explicit.
UNAME := $(shell uname -s)
.PHONY: run test selftest app dev clean env mac-app mac-run mac-test mac-selftest linux-setup linux-run linux-test linux-selftest linux-install linux-uninstall help

ifeq ($(UNAME),Darwin)
run: mac-run
test: mac-test
selftest: mac-selftest
app: mac-app
else
run: linux-run
test: linux-test
selftest: linux-selftest
app: linux-install
endif

# ---- macOS (Swift package in macos/)
mac-app:        ## build "build/Equation Explainer.app"
	macos/scripts/build_app.sh release

mac-run: env mac-app ## build and open the macOS app
	open "build/Equation Explainer.app"

mac-test:       ## Swift unit tests (config, SSE parsing, storage, python runner)
	cd macos && swift test

mac-selftest: mac-app ## drive the macOS app end to end against your configured LLM
	rm -rf /tmp/ee-selftest && mkdir -p /tmp/ee-selftest
	EE_BOARDS_DIR=/tmp/ee-selftest/boards "build/Equation Explainer.app/Contents/MacOS/EquationExplainer" --selftest /tmp/ee-selftest
	@grep -E "PASS|FAIL|ALL|SOME" /tmp/ee-selftest/log.txt

# ---- Linux (Python + GTK4 + WebKitGTK in linux/)
linux-setup:    ## install missing GTK/WebKitGTK packages (apt) and check WebKit's sandbox; no-op once done
	@test -n "$$EE_SKIP_SETUP" || linux/scripts/setup.sh

linux-run: env linux-setup ## start the Linux app from the source tree
	linux/bin/equation-explainer

linux-test:     ## Python unit tests (config, SSE parsing, streaming, storage, python runner)
	cd linux && python3 -m pytest -q tests

linux-selftest: linux-setup ## drive the Linux app end to end against your configured LLM
	rm -rf /tmp/ee-selftest && mkdir -p /tmp/ee-selftest
	EE_BOARDS_DIR=/tmp/ee-selftest/boards linux/bin/equation-explainer --selftest /tmp/ee-selftest
	@grep -E "PASS|FAIL|ALL|SOME" /tmp/ee-selftest/log.txt

linux-install:  ## add the app to this user's app grid (launcher, icon, chalk fonts)
	linux/scripts/install.sh

linux-uninstall:
	linux/scripts/install.sh --uninstall

# ---- shared
env:            ## create .env from .env.example on first run
	@test -f .env || { cp .env.example .env; echo "created .env from .env.example: put your OPENROUTER_API_KEY (or LM Studio settings) in it"; }

dev:            ## browser harness at http://127.0.0.1:5178 (same UI, Node bridge)
	node dev/devserver.mjs 5178

clean:
	rm -rf macos/.build build linux/.pytest_cache linux/*.egg-info
	find . -name __pycache__ -type d -prune -exec rm -rf {} +

help:
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*##/ -/'
