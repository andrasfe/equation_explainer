/* Board data model + LLM context construction.
 *
 * A board is a tree of threads. The root thread is the original conversation;
 * every other thread is a side question anchored on a highlighted span of a
 * card in its parent thread. Columns on screen = board.openPath.
 */
EE.model = (() => {
  const { uid } = EE.util;

  const SYSTEM = String.raw`You are "the Blackboard", a patient and rigorous tutor in mathematics, physics and quantum computing. You write on a chalkboard for a student who wants to understand every step.

How to write:
- Break explanations into short numbered steps. In each step show the equation (display math) and one or two sentences saying why it holds. Never skip algebra silently.
- Use Markdown. Write ALL mathematics in LaTeX: inline $...$ and display $$...$$ (never \( \) or \[ \]).
- Matrices: \begin{pmatrix} a & b \\ c & d \end{pmatrix}. Dirac notation: \ket{\psi}, \bra{\phi}, \braket{\phi|\psi}, outer products \ket{a}\bra{b}; tensor products \otimes; adjoints ^\dagger. Use only standard LaTeX commands.
- Define every symbol the first time it appears. Prefer clarity over length.
- Finish with a single line starting with "**Key idea:**".

Computation:
- When an explicit calculation would help (or is requested), include a fenced \`\`\`python block. The student presses ▶ Execute to run it in a separate Python process with numpy, sympy, scipy, matplotlib and the helper module boardkit:
    from boardkit import *   # also gives sp, np, sqrt, pi, I, exp, Matrix, symbols, simplify, Rational
    ket('01'), ket('+'), bra('1'), I2, X, Y, Z, H, S, T, CNOT, CZ, SWAP, Rx(t), Ry(t), Rz(t), P(phi), U(theta, phi, lam)
    kron(A, B, ...), dag(A), braket(a, b), ketbra(a, b), qft(n), grover_diffusion(n), oracle(marked, n), probs(state), is_unitary(A),
    expval(op, state), density(state), ptrace(rho, keep), commutator(A, B)
    show(obj, label=r"...")   # prints LaTeX that renders on the board -- use it for every result
    show_state(state, label=r"\ket{\psi}")   # Dirac-notation form of a state vector
- Gates and states are sympy matrices: multiply with * (or @), never call them as functions unless you mean H(n) = H^{\otimes n}.
  Example:
    from boardkit import *
    psi = H * ket('0')
    show(psi, label=r"H\ket{0}")
    bell = CNOT * kron(H, I2) * ket('00')
    show_state(bell, label=r"\ket{\Phi^+}")
    P = psi * dag(psi)
    show(P * P - P, label=r"P^2 - P")
    show(probs(bell), label="P")
- Every code block must be self-contained (start with the import). Prefer exact sympy arithmetic.
- Never invent the output of code. Say "Press ▶ Execute to run it."`;

  const BRANCH = String.raw`

The student highlighted part of an earlier explanation and is asking a side question about exactly that part. Zoom in: answer only the side question, deriving the highlighted piece step by step from what came before. Do not repeat the whole earlier explanation.`;

  const COMPUTE = String.raw`

COMPUTE MODE. The student wants the calculation done for them. Reply with:
1. One sentence saying what will be computed.
2. Exactly one \`\`\`python block (boardkit + sympy, exact arithmetic where possible) that performs the computation and prints every intermediate and final result with show(..., label=...).
3. A brief by-hand outline of the calculation in LaTeX (a few lines at most), then "Press ▶ Execute to run it."`;

  const CONTEXT_BUDGET = 60000; // characters of conversation history sent to the model

  function newBoard() {
    const now = Date.now();
    return {
      version: 1,
      id: uid('b'),
      title: '',
      createdAt: now,
      updatedAt: now,
      rootThreadId: 'root',
      openPath: ['root'],
      threads: { root: { id: 'root', parentId: null, anchor: null, title: null, cards: [], createdAt: now } },
    };
  }

  function newThread(board, parentId, anchor, title) {
    const t = { id: uid('t'), parentId, anchor, title, cards: [], createdAt: Date.now() };
    board.threads[t.id] = t;
    return t;
  }

  function pathTo(board, threadId) {
    const path = [];
    let t = board.threads[threadId];
    while (t) { path.unshift(t.id); t = t.parentId ? board.threads[t.parentId] : null; }
    return path;
  }

  function children(board, threadId) {
    return Object.values(board.threads)
      .filter((t) => t.parentId === threadId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  function descendants(board, threadId) {
    const out = [];
    const walk = (id) => children(board, id).forEach((c) => { out.push(c.id); walk(c.id); });
    walk(threadId);
    return out;
  }

  function branchesOn(board, cardId) {
    return Object.values(board.threads)
      .filter((t) => t.anchor && t.anchor.cardId === cardId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  function findCard(board, cardId) {
    for (const t of Object.values(board.threads)) {
      const i = t.cards.findIndex((c) => c.id === cardId);
      if (i !== -1) return { thread: t, card: t.cards[i], index: i };
    }
    return null;
  }

  function countBranches(board) { return Object.keys(board.threads).length - 1; }

  function runsSummary(card) {
    const runs = card.runs || {};
    const keys = Object.keys(runs).sort((a, b) => a - b);
    if (!keys.length) return '';
    return keys.map((k) => {
      const r = runs[k];
      let s = `\n\n[Code block ${Number(k) + 1} was executed. Output:\n\`\`\`\n${(r.stdout || '').slice(0, 4000)}\n\`\`\``;
      if (r.stderr) s += `\nErrors:\n\`\`\`\n${r.stderr.slice(0, 2000)}\n\`\`\``;
      return s + ']';
    }).join('');
  }

  function anchorPreamble(anchor) {
    let s = `Side question about this part of your explanation:\n> ${anchor.llmText.replace(/\n/g, '\n> ')}\n`;
    if (anchor.partial && anchor.partial.length) {
      for (const p of anchor.partial) {
        s += `\n(The highlight is only part of the equation $$${p.tex}$$ -- visually the selected piece reads "${p.visible}".)\n`;
      }
    }
    if (anchor.context) s += `\n(Surrounding text: "${anchor.context}")\n`;
    return s + '\n';
  }

  function cardMessage(thread, card, isFirst) {
    if (card.role === 'user') {
      const pre = isFirst && thread.anchor ? anchorPreamble(thread.anchor) : '';
      return { role: 'user', content: pre + card.text };
    }
    if (card.role === 'assistant') {
      if (card.status === 'error') return null;
      const body = EE.render.splitThink(card.text).body.trim();
      if (!body) return null;
      return { role: 'assistant', content: body + runsSummary(card) };
    }
    if (card.role === 'code') {
      const r = card.runs && card.runs[0];
      const code = (card.edits && card.edits[0]) || card.code;
      let s = `I wrote and ran this Python code:\n\`\`\`python\n${code}\n\`\`\``;
      if (r) s += `\nOutput:\n\`\`\`\n${(r.stdout || '').slice(0, 4000)}\n\`\`\`${r.stderr ? `\nErrors:\n\`\`\`\n${r.stderr.slice(0, 2000)}\n\`\`\`` : ''}`;
      return { role: 'user', content: s };
    }
    return null;
  }

  /** Messages for answering in `threadId`, stopping before `beforeCardId`. */
  function buildMessages(board, threadId, beforeCardId, mode) {
    const path = pathTo(board, threadId);
    const msgs = [];
    path.forEach((tid, i) => {
      const th = board.threads[tid];
      const nextAnchor = i < path.length - 1 ? board.threads[path[i + 1]].anchor : null;
      for (let k = 0; k < th.cards.length; k++) {
        const card = th.cards[k];
        if (tid === threadId && card.id === beforeCardId) break;
        const m = cardMessage(th, card, k === 0);
        if (m) msgs.push(m);
        if (nextAnchor && card.id === nextAnchor.cardId) break;
      }
    });
    // merge consecutive same-role messages (some chat templates require alternation)
    const merged = [];
    for (const m of msgs) {
      const last = merged[merged.length - 1];
      if (last && last.role === m.role) last.content += '\n\n' + m.content;
      else merged.push({ ...m });
    }
    // trim from the front (keeping the first message) if over budget
    let total = merged.reduce((s, m) => s + m.content.length, 0);
    while (total > CONTEXT_BUDGET && merged.length > 2) {
      total -= merged[1].content.length;
      merged.splice(1, 1);
      if (merged[1] && merged[1].role === merged[0].role) {
        merged[0].content += '\n\n' + merged[1].content;
        merged.splice(1, 1);
      }
    }
    if (merged.length && merged[0].role !== 'user') merged.unshift({ role: 'user', content: '(continuing)' });
    const system = SYSTEM + (path.length > 1 ? BRANCH : '') + (mode === 'compute' ? COMPUTE : '');
    return [{ role: 'system', content: system }, ...merged];
  }

  return {
    newBoard, newThread, pathTo, children, descendants, branchesOn, findCard, countBranches,
    buildMessages, SYSTEM,
  };
})();
