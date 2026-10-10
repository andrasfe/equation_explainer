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
- Write the explanation directly. No stage directions or narration about chalk, the board or yourself.
- Do not include code (Python or any other language) unless the student explicitly asks for code, a script or a program. Explain with mathematics, and if numbers help, work a small example by hand.
- Finish with a single line starting with "**Key idea:**".`;

  const CODE = String.raw`

The student asked for code, so code is welcome in this answer. Use fenced \`\`\`python blocks. The student presses ▶ Execute to run them in a separate Python process with numpy, sympy, scipy, matplotlib and the helper module boardkit:
    from boardkit import *   # also gives sp, np, sqrt, pi, I, exp, Matrix, symbols, simplify, Rational
    ket('01'), ket('+'), bra('1'), I2, X, Y, Z, H, S, T, CNOT, CZ, SWAP, Rx(t), Ry(t), Rz(t), P(phi), U(theta, phi, lam)
    kron(A, B, ...), dag(A), braket(a, b), ketbra(a, b), qft(n), grover_diffusion(n), oracle(marked, n), probs(state),
    is_unitary(A), expval(op, state), density(state), ptrace(rho, keep), commutator(A, B)
    show(obj, label=r"...")   # prints LaTeX that renders on the board -- use it for every result
    show_state(state, label=r"\ket{\psi}")   # Dirac-notation form of a state vector
- Gates and states are sympy matrices: multiply with * (or @), never call them as functions unless you mean H(n) = H^{\otimes n}.
  Example:
    from boardkit import *
    psi = H * ket('0')
    show(psi, label=r"H\ket{0}")
    bell = CNOT * kron(H, I2) * ket('00')
    show_state(bell, label=r"\ket{\Phi^+}")
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

  /** Did the student explicitly ask for code? (compute mode always counts) */
  const CODE_WORDS = /\b(code|coding|python|script|program|programme|snippet|implement(ation)?|simulat(e|ion)|numpy|sympy|scipy|qiskit|cirq|jupyter|notebook|matplotlib|plot)\b/i;
  const wantsCode = (text) => CODE_WORDS.test(String(text || ''));

  // ------------------------------------------------------------------ learner model
  /** How much to recap a topic, from its 1-10 sink-in score (higher score, less recap). */
  function recapRule(score) {
    const m = Number(score) || 1;
    if (m <= 3) return 'recap the essentials before relying on it: a condensed, higher-level refresher (key definitions and the one or two equations that matter, from a fresh angle), not a re-derivation';
    if (m <= 6) return 'a brief reminder (a sentence or two) when it comes up';
    if (m <= 8) return 'mention it by name, no recap';
    return 'treat as known';
  }

  /** The system-prompt section that adapts explanations to where the student stands. */
  function learnerSection(learner) {
    if (!learner) return '';
    const { profile, items } = learner;
    const L = ['', '', 'THE STUDENT. Adapt the level of this explanation to where the student stands.',
      'After every explanation the student rates "did this sink in?" from 1 (not at all) to 10 (fully). Unrated explanations count as 1.'];
    if (profile) {
      const o = profile.overall || {};
      L.push(`Overall level: ${o.level}/10. ${o.summary || ''}`.trim());
      if (o.pitch) L.push(`How to pitch: ${o.pitch}`);
      const topics = (profile.topics || []).slice().sort((a, b) => a.mastery - b.mastery).slice(0, 30);
      if (topics.length) {
        L.push('Topic mastery from the last holistic assessment:');
        for (const t of topics) L.push(`- ${t.name}: ${t.mastery}/10, ${recapRule(t.mastery)}`);
      }
      for (const g of (profile.guidance || []).slice(0, 6)) L.push(`- ${g}`);
    } else {
      L.push('No holistic assessment yet. Pitch at a solid undergraduate level and define terms.');
    }
    if (items && items.length) {
      L.push(profile ? 'Asked since that assessment, with sink-in scores:' : 'Asked so far, with sink-in scores:');
      for (const it of items) {
        const where = it.quote ? ` (side question about "${EE.util.truncate(EE.util.clean(it.quote), 60)}")` : '';
        L.push(`- "${EE.util.truncate(EE.util.texToText(it.q), 140)}"${where}: ${it.rating}/10${it.rated ? '' : ' (unrated)'}, ${recapRule(it.rating)}`);
      }
    }
    L.push('Rule: when this explanation depends on a topic listed above, scale the recap to its score. The lower the score, the more you recap, always as a condensed higher-level refresher rather than a repeat. The higher the score, the less recap; at 9-10 assume it is known. Never mention these scores or this profile to the student.');
    return L.join('\n');
  }

  /** Every answered question across boards, with its sink-in rating (unrated = 1). */
  function evidence(boards) {
    const out = [];
    for (const b of boards) {
      const threads = Object.values(b.threads || {}).sort((x, y) => x.createdAt - y.createdAt);
      for (const t of threads) {
        t.cards.forEach((c, k) => {
          if (c.role !== 'user') return;
          const ans = t.cards.slice(k + 1).find((x) => x.role === 'assistant');
          if (!ans || ans.status === 'streaming' || ans.status === 'error' || !EE.render.splitThink(ans.text).body.trim()) return;
          out.push({
            boardId: b.id, board: b.title || 'Untitled board', cardId: c.id, answerId: ans.id,
            q: c.text, quote: k === 0 && t.anchor ? t.anchor.quote : null, side: !!t.parentId,
            rating: ans.rating != null ? ans.rating : 1, rated: ans.rating != null,
            at: Math.max(c.createdAt || 0, ans.ratedAt || 0),
            gist: EE.render.splitThink(ans.text).body.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').slice(0, 260),
          });
        });
      }
    }
    return out;
  }

  const evidenceHash = (items) => EE.util.hash(items.map((i) => `${i.cardId}:${i.rated ? i.rating : 'u'}`).join('|')).toString(36);

  const LEVELSET_SYSTEM = String.raw`You assess a student's understanding for an adaptive tutoring app (a "blackboard") covering mathematics, physics and quantum computing. You receive every question the student asked, grouped by board (one study session each), including side questions they asked about highlighted parts of explanations, and the student's own rating of each explanation: "did this sink in?" from 1 (not at all) to 10 (fully). Unrated explanations count as 1, because the student has not confirmed understanding.

Build a learner profile:
- topics: the concepts the student has worked on, granular enough to be useful (for example "partial trace", "Pauli decomposition of a density matrix", "Heisenberg XXX Hamiltonian", not "quantum computing"). Merge duplicates. At most 30.
- mastery (1-10) per topic comes from the sink-in ratings of the explanations involving it, weighted toward the most recent. Never put a topic above the ratings that support it: a topic whose explanations are all unrated stays at 1. Repeated side questions such as "how did you get this?" about the same idea indicate a gap.
- overall.level (1-10): where the student stands overall. overall.summary: two or three sentences. overall.pitch: concrete advice on vocabulary, rigor, pace and which prerequisites to recap.
- reinforce: topics worth weaving back in when they are relevant.
- guidance: up to 6 short imperative instructions for the tutor that writes the explanations.
If a previous profile is given, update it with the new evidence instead of starting over.

Respond with ONLY a JSON object, no prose and no code fences, of this shape:
{"overall":{"level":3,"summary":"...","pitch":"..."},"topics":[{"name":"...","mastery":2,"evidence":"..."}],"reinforce":["..."],"guidance":["..."]}`;

  /** Chat messages for a holistic level-set across all boards. */
  function levelSetMessages(boards, previous) {
    const items = evidence(boards);
    const byBoard = new Map();
    for (const it of items) {
      if (!byBoard.has(it.boardId)) byBoard.set(it.boardId, { title: it.board, items: [] });
      byBoard.get(it.boardId).items.push(it);
    }
    const lines = [];
    const ordered = [...byBoard.values()].sort((a, b) => a.items[0].at - b.items[0].at);
    let budget = 120000;
    for (const g of ordered) {
      lines.push(`\nBOARD "${EE.util.texToText(g.title)}" (${new Date(g.items[0].at).toISOString().slice(0, 10)})`);
      for (const it of g.items) {
        const where = it.side ? `side question${it.quote ? ` about "${EE.util.truncate(EE.util.clean(it.quote), 80)}"` : ''}` : 'question';
        const line = `- ${where}: "${EE.util.truncate(it.q, 400)}" -> sink-in ${it.rating}/10${it.rated ? '' : ' (unrated)'}\n  answer gist: ${it.gist}`;
        budget -= line.length;
        if (budget < 0) break;
        lines.push(line);
      }
    }
    const prev = previous ? JSON.stringify({ overall: previous.overall, topics: previous.topics, reinforce: previous.reinforce, guidance: previous.guidance }) : '(none)';
    const user = `Previous profile: ${prev}\n\nEvidence (${items.length} answered questions, ${items.filter((i) => i.rated).length} rated):${lines.join('\n')}\n\nReturn the JSON profile now.`;
    return { messages: [{ role: 'system', content: LEVELSET_SYSTEM }, { role: 'user', content: user }], items };
  }

  /** Make near-JSON parseable: raw newlines, trailing commas, and LaTeX backslashes that are not valid escapes. */
  function repairJson(text) {
    return text
      .replace(/[\n\r\t]/g, ' ')
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/\\(\\|u[0-9a-fA-F]{4}|["\/]|[bfnrt](?![a-zA-Z]))|\\/g, (m, ok) => (ok !== undefined ? m : '\\\\'));
  }

  /** Parse and sanity-check the level-set model's JSON. Throws on garbage. */
  function parseProfile(text) {
    const body = EE.render.splitThink(text).body;
    const a = body.indexOf('{'), b = body.lastIndexOf('}');
    if (a === -1 || b <= a) throw new Error('The level-set model did not return JSON.');
    const json = body.slice(a, b + 1);
    let raw;
    try {
      raw = JSON.parse(json);
    } catch (e) {
      raw = JSON.parse(repairJson(json)); // models love writing \rho inside JSON strings
    }
    const clamp = (n) => Math.min(10, Math.max(1, Math.round(Number(n) || 1)));
    const str = (x) => (typeof x === 'string' ? x.trim() : '');
    const topics = (Array.isArray(raw.topics) ? raw.topics : [])
      .filter((t) => t && str(t.name))
      .map((t) => ({ name: str(t.name), mastery: clamp(t.mastery), evidence: str(t.evidence) }))
      .slice(0, 30);
    const o = raw.overall || {};
    return {
      overall: { level: clamp(o.level), summary: str(o.summary), pitch: str(o.pitch) },
      topics,
      reinforce: (Array.isArray(raw.reinforce) ? raw.reinforce : []).map(str).filter(Boolean).slice(0, 12),
      guidance: (Array.isArray(raw.guidance) ? raw.guidance : []).map(str).filter(Boolean).slice(0, 6),
    };
  }

  const CONTEXT_BUDGET = 48000; // characters of conversation history sent to the model

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

  /** Messages for answering in `threadId`, stopping before `beforeCardId`.
   *  `learner` = {profile, items} adapts the level; see learnerSection(). */
  function buildMessages(board, threadId, beforeCardId, mode, learner) {
    const path = pathTo(board, threadId);
    const msgs = [];
    let lastQuestion = '';
    path.forEach((tid, i) => {
      const th = board.threads[tid];
      const nextAnchor = i < path.length - 1 ? board.threads[path[i + 1]].anchor : null;
      for (let k = 0; k < th.cards.length; k++) {
        const card = th.cards[k];
        if (tid === threadId && card.id === beforeCardId) break;
        if (tid === threadId && card.role === 'user') lastQuestion = card.text;
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
    const code = mode === 'compute' || wantsCode(lastQuestion);
    const system = SYSTEM + learnerSection(learner) + (path.length > 1 ? BRANCH : '') + (code ? CODE : '') + (mode === 'compute' ? COMPUTE : '');
    return [{ role: 'system', content: system }, ...merged];
  }

  return {
    newBoard, newThread, pathTo, children, descendants, branchesOn, findCard, countBranches,
    buildMessages, SYSTEM, wantsCode, repairJson, recapRule, learnerSection, evidence, evidenceHash, levelSetMessages, parseProfile,
  };
})();
