# Equation Explainer

A macOS blackboard for digging into mathematics and quantum algorithms with an LLM.

You write an equation or a question. The explanation is chalked onto the board step by step.
**Highlight any part of it** (a phrase, a whole equation or just a piece of one) and ask a side
question. The answer opens **to the right**, connected to what you circled. Inside that answer you can
highlight again and drill deeper. When you're done, close the side columns (`Esc`, the ✕, the
breadcrumb, or the eraser on the chalk ledge) and you're back at the original equation. Every board
is saved with all of its branches, and the circled spots stay marked so you can reopen any branch later.

## Features

- **Lateral drill-down.** Each side question is a column anchored to the exact text or formula you
  highlighted. Columns chain to any depth, with a breadcrumb and a *board map* to jump between levels.
- **Real math.** KaTeX renders LaTeX, matrices (`pmatrix`, `bmatrix`, …) and Dirac notation
  (`\ket`, `\bra`, `\braket`). The **▦ matrix** helper builds matrices with presets (I, X, Y, Z, H, S, T, CNOT).
- **It learns where you stand.**
  - Under every answer, a poll asks "did this sink in?" from 1 to 10. Unrated answers count as 1.
  - The **level-set** pass reads every question and rating across all boards and builds a learner
    profile: an overall level, plus mastery per topic. It runs on OpenRouter with
    `openai/gpt-5.6-sol-pro`, by itself whenever you start a new board, and on demand from
    **⟳ level-set** (⇧⌘L).
  - Each explanation's system prompt includes the profile plus everything asked since the last
    level-set, with its rating, so a rating counts on the very next question.
  - Recap scales with the score. 1–3 gets a condensed, higher-level refresher, 4–6 a brief reminder,
    7–8 a name-check, and 9–10 is treated as known. **level n/10** shows the profile.
- **No code unless you ask.** Answers stick to mathematics. Code appears only when your question asks
  for code, Python, a script or a plot, or when you use *compute* mode.
- **Computation.**
  - *compute* mode makes the model write a runnable Python block for your calculation.
  - *python* mode runs your own code.
  - Every Python block has **▶ Execute**. It runs in the background in a separate process with numpy,
    sympy, scipy, matplotlib and the `boardkit` helpers (gates, kets, `kron`, `qft`,
    `grover_diffusion`, `probs`, `show()`).
  - Results render as math, and figures render as images. Failed runs get **fix it ↻**.
- **Zoom.** Use ⌘= and ⌘−, or pinch. Click ⤢ on any displayed equation for a magnifying lens.
- **Chalk look.** Slate texture, a wooden frame and handwritten fonts (Chalkboard SE, Chalkduster,
  Bradley Hand, Noteworthy, Marker Felt). Switch fonts with **Aa**.

## Setup

```bash
cp .env.example .env      # then pick a provider
make run                  # builds "build/Equation Explainer.app" and opens it
```

`.env` is re-read on every request, so edits apply immediately. **Board ▸ Open .env** opens it.

| key | meaning |
| --- | --- |
| `LLM_PROVIDER` | `lmstudio` or `openrouter` (inferred from `OPENROUTER_API_KEY` if unset) |
| `LMSTUDIO_BASE_URL` / `LMSTUDIO_MODEL` | default `http://localhost:1234/v1`; a blank model means whatever LM Studio has loaded |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | default model `anthropic/claude-fable-5.1` |
| `LLM_TEMPERATURE`, `LLM_MAX_TOKENS`, `LLM_EXTRA_BODY` | generation settings (`LLM_EXTRA_BODY` is JSON merged into the request) |
| `LEVELSET_MODEL` | model for the level-set, default `openai/gpt-5.6-sol-pro` on OpenRouter (needs `OPENROUTER_API_KEY`) |
| `LEVELSET_PROVIDER`, `LEVELSET_MAX_TOKENS`, `LEVELSET_EXTRA_BODY` | where the level-set runs (`openrouter` by default, or `lmstudio`) and its request settings |
| `PYTHON_PATH` | use your own interpreter instead of the managed environment |
| `PYTHON_PACKAGES`, `PYTHON_TIMEOUT` | packages for the managed environment, and the per-run time limit in seconds |

The first ▶ Execute creates a managed virtualenv in `~/Library/Application Support/EquationExplainer/pyenv`.
This takes about a minute and happens only once. Boards are JSON files in
`~/Library/Application Support/EquationExplainer/Boards` (**Board ▸ Reveal Boards Folder**).
The learner profile sits next to that folder in `learner.json`.

## Keys

| | |
| --- | --- |
| highlight text, then pick a question | open a side question to the right |
| click a circled or underlined spot | reopen or close its side question |
| `Esc` or `⌘[` | close the rightmost side question |
| `⇧⌘⌫` | back to the original (close all) |
| `⇧⌘M` / `⌥⌘M` | board map / insert matrix |
| `⇧⌘L` | level-set now |
| `Enter` / `Shift+Enter` | write / new line (`⌘Enter` runs in python mode) |

## Development

```bash
make test       # Swift unit tests (config, SSE parsing, storage, python runner)
make dev        # same UI in a browser at http://127.0.0.1:5178 with a Node bridge
make selftest   # drives the real app end to end against your LLM and saves snapshots to /tmp/ee-selftest
```

Layout:

- `Sources/EECore` holds the testable core: `.env` and config, the streaming client, the Python runner and board storage.
- `Sources/EquationExplainer` is the SwiftUI shell, the WKWebView host and the JS bridge.
- `App/Web` is the blackboard UI in plain JS, with vendored KaTeX, marked, DOMPurify and highlight.js.
- `App/Python` holds the cell runner, `boardkit` and the matplotlib chalk style.
