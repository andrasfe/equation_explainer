# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->


## Build & Test

```bash
make test            # unit tests for this OS (macOS: swift test in macos/; Linux: pytest in linux/)
make run             # macOS: build and open the .app; Linux: start the GTK app from the tree
make selftest        # end-to-end self test inside the real app against the configured LLM (/tmp/ee-selftest)
make dev             # browser harness with a Node bridge at http://127.0.0.1:5178
```

## Architecture Overview

One web UI (`shared/web`, plain JS) hosted by two native shells that implement the same JS bridge:
`macos/` (Swift package: EECore + SwiftUI/WKWebView) and `linux/` (Python package `equation_explainer`:
GTK4/libadwaita + WebKitGTK 6.0). `shared/python` is the cell runner and `boardkit`. The core in each shell
(config, streaming LLM client, board store, Python runner) is a line-for-line port of the other; keep them in sync.

## Conventions & Patterns

- `.env` keys and their problem messages are identical on both platforms; add new keys to both cores and both test suites.
- Anything the page needs from the native side goes through the bridge command switch (`handle`) in both shells.
- Shortcut labels in the UI are written for a Mac and converted with `EE.util.kbd` elsewhere.
