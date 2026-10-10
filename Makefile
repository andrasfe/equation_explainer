.PHONY: app run test dev selftest clean

app:            ## build "build/Equation Explainer.app"
	scripts/build_app.sh release

run: app        ## build and open the app
	open "build/Equation Explainer.app"

test:           ## Swift unit tests
	swift test

dev:            ## browser harness at http://127.0.0.1:5178 (same UI, Node bridge)
	node dev/devserver.mjs 5178

selftest: app   ## drive the real app end to end against your configured LLM
	rm -rf /tmp/ee-selftest && mkdir -p /tmp/ee-selftest
	EE_BOARDS_DIR=/tmp/ee-selftest/boards "build/Equation Explainer.app/Contents/MacOS/EquationExplainer" --selftest /tmp/ee-selftest
	@grep -E "PASS|FAIL|ALL|SOME" /tmp/ee-selftest/log.txt

clean:
	rm -rf .build build
