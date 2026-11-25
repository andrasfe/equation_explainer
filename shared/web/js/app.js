/* The blackboard controller: state, actions, rendering. */
(() => {
  const { uid, el, esc, debounce, truncate, plainTitle, rng, hash, clean, kbd, IS_MAC } = EE.util;
  const R = EE.render, M = EE.model, A = EE.anchors, B = EE.bridge, DG = EE.diagram, P = EE.pdf;
  const BODY = '.card-body, .pdf-text';              // where an anchor can live: an answer, or a page of a paper
  const isPaperCard = (id) => /^pdf(:|$)/.test(id || '');

  const S = (EE.state = {
    board: null,
    cache: new Map(),   // boardId -> board (keeps streaming boards alive while you switch)
    streams: new Map(), // cardId -> {cancel, boardId}
    running: new Map(), // `${cardId}:${idx}` -> runId
    ver: new Map(),     // cardId -> render version
    drafts: new Map(),  // threadId -> composer text
    modes: new Map(),   // threadId -> explain | compute | python
    pending: null,      // {anchor, range} captured from the current selection
    outlineOpen: false,
    config: null,
    llm: '',            // model picked in the top bar ("provider|model"); '' = LLM_PROVIDER's
    localLlm: '',       // the LM Studio model picked while on a confidential board (they never use S.llm)
    library: new Map(), // boardId -> every saved board (the learner model looks across all of them)
    profile: null,      // learner profile from the last level-set
    notes: [],          // the student's own directions [{id, text, createdAt, updatedAt}]; private, never in git
    learnerOpen: false,
    editingNote: null,
    ls: { running: false, error: null }, // level-set state
    summaryOpen: false,
    sums: new Map(),    // boardId -> summary being written {running, text, reasoning, error, refs, cancel}
    dgJobs: new Map(),  // `${cardId}:${key}` -> diagram being drawn {boardId, cancel}
    paperLook: 'chalk', // how a PDF paper is shown: 'chalk' (inverted onto the slate) or 'paper'
    recaps: new Map(),  // boardId -> recap being written {running, text, reasoning, error, refs, model, cancel}
    ljobs: new Map(),   // boardId -> lessons learned being written {running, text, reasoning, error, done, total, batch, rewrite, cancel}
  });

  const dom = {};
  const cols = new Map(); // threadId -> column record
  // chalk fonts to cycle with Aa: the macOS system faces, or the OFL faces vendored in shared/web/fonts
  const FONTS = IS_MAC
    ? ['Chalkboard SE', 'Chalkduster', 'Bradley Hand', 'Noteworthy', 'Marker Felt']
    : ['Patrick Hand', 'Architects Daughter', 'Gloria Hallelujah', 'Shadows Into Light', 'Gochi Hand', 'Fredericka the Great'];
  const DEFAULT_FONT = FONTS[0];
  const EXAMPLES = [
    { text: String.raw`Explain Grover's diffusion operator $D = 2\ket{s}\bra{s} - I$ and why it amplifies the marked state.`, mode: 'explain' },
    { text: String.raw`Explain the quantum Fourier transform $\ket{j} \mapsto \frac{1}{\sqrt{N}}\sum_{k=0}^{N-1} e^{2\pi i jk/N}\ket{k}$`, mode: 'explain' },
    { text: String.raw`Compute $(H\otimes H)\,\mathrm{CNOT}\,(H\otimes H)$ and show it equals CNOT with control and target swapped.`, mode: 'compute' },
    { text: String.raw`Explain phase kickback: why does $U\ket{u} = e^{2\pi i\varphi}\ket{u}$ put the phase on the control qubit?`, mode: 'explain' },
    { text: String.raw`Why is $e^{i\pi} + 1 = 0$?`, mode: 'explain' },
  ];
  const PAPER_CHIPS = [
    { q: 'Explain this passage step by step.', mode: 'explain' },
    { q: 'What does this notation mean?', mode: 'explain' },
    { q: 'Why is this true?', mode: 'explain' },
    { q: 'Give a concrete numerical example.', mode: 'explain' },
    { q: 'How does this fit into the rest of the paper?', mode: 'explain' },
    { q: '¶ Read on from here, passage by passage', read: true },
  ];
  const CHIPS = [
    { q: 'How did you get to this?', mode: 'explain' },
    { q: 'Why is this true?', mode: 'explain' },
    { q: 'Explain this more simply.', mode: 'explain' },
    { q: 'Give a concrete numerical example.', mode: 'explain' },
    { q: 'Compute this explicitly.', mode: 'compute' },
  ];

  const touch = (card) => S.ver.set(card.id, (S.ver.get(card.id) || 0) + 1);
  const elOf = (n) => (n && n.nodeType === Node.TEXT_NODE ? n.parentElement : n);

  // ------------------------------------------------------------ persistence
  const savers = new Map();
  const savedSnaps = new Map(); // boardId -> what is on disk, so unchanged boards are never re-dated
  const isEmpty = (b) => !b.pdf && Object.values(b.threads).every((t) => t.cards.length === 0);
  function snapsOf(b) {
    const { updatedAt, openPath, ...content } = b; // eslint-disable-line no-unused-vars
    return { content: JSON.stringify(content), nav: JSON.stringify(openPath) };
  }

  async function saveNow(board) {
    if (!board || isEmpty(board)) return;
    const snap = snapsOf(board);
    const prev = savedSnaps.get(board.id);
    if (prev && prev.content === snap.content && prev.nav === snap.nav) return; // nothing changed
    if (!prev || prev.content !== snap.content) board.updatedAt = Date.now(); // opening/closing branches is not an edit
    savedSnaps.set(board.id, snap);
    S.library.set(board.id, board);
    try {
      await B.call('saveBoard', { id: board.id, title: board.title || '', json: JSON.stringify(board) });
    } catch (e) {
      savedSnaps.delete(board.id);
      toast('Could not save: ' + e.message, 'error');
    }
  }
  function save(board = S.board, soon = false) {
    if (!board) return;
    let d = savers.get(board.id);
    // pass the board on every call: a board reopened from disk is a new object with the same id
    if (!d) { d = debounce((b) => saveNow(b), 900); savers.set(board.id, d); }
    if (soon) d(board); else d.flush(board);
  }

  // ------------------------------------------------------------ board lifecycle
  function setBoard(board, fromDisk = false) {
    if (S.board && S.board !== board) save(S.board);
    if (fromDisk && !isEmpty(board)) savedSnaps.set(board.id, snapsOf(board));
    S.board = board;
    S.cache.set(board.id, board);
    if (!isEmpty(board)) S.library.set(board.id, board);
    for (const t of Object.values(board.threads)) {
      for (const c of t.cards) {
        if (c.status === 'streaming' && !S.streams.has(c.id)) { c.status = 'stopped'; touch(c); }
      }
    }
    board.openPath = (board.openPath || ['root']).filter((id) => board.threads[id]);
    if (!board.openPath.length || board.openPath[0] !== 'root') board.openPath = ['root'];
    cols.forEach((c) => { if (c.pdf) c.pdf.destroy(); c.root.remove(); });
    cols.clear();
    hidePopover();
    render();
    B.call('current', { id: board.id, title: board.title || '' }).catch(() => {});
    requestAnimationFrame(() => revealColumn(board.openPath[board.openPath.length - 1], false));
  }

  function newBoard() {
    setBoard(M.newBoard());
    focusComposer('root');
    maybeAutoLevelSet();
  }

  function ensureTitle(board, text, isCode) {
    if (board.title) return;
    board.title = isCode ? 'Python: ' + plainTitle(text, 48) : plainTitle(text);
    B.call('current', { id: board.id, title: board.title }).catch(() => {});
  }

  // ------------------------------------------------------------ actions
  function send(threadId, text, mode = 'explain') {
    const board = S.board;
    const thread = board.threads[threadId];
    if (!thread || !text.trim()) return null;
    if (mode === 'python') {
      const card = { id: uid('c'), role: 'code', code: text.replace(/\s+$/, ''), runs: {}, createdAt: Date.now() };
      thread.cards.push(card);
      ensureTitle(board, text, true);
      save(board);
      render();
      scrollColumnToBottom(threadId, true);
      runCode(card.id, 0, board);
      return card;
    }
    thread.cards.push({ id: uid('c'), role: 'user', text: text.trim(), mode, createdAt: Date.now() });
    ensureTitle(board, text);
    return ask(board, threadId, mode);
  }

  function ask(board, threadId, mode) {
    const card = { id: uid('c'), role: 'assistant', text: '', reasoning: '', status: 'streaming', mode, createdAt: Date.now() };
    board.threads[threadId].cards.push(card);
    save(board);
    if (board === S.board) { render(); scrollColumnToBottom(threadId, true); }
    stream(board, threadId, card, mode);
    return card;
  }

  // ------------------------------------------------------------ confidential boards: LM Studio (local) only
  const isConfidential = (b) => !!(b && b.confidential);
  /** Options for B.chat on a board's behalf. A confidential board asks with local: true, which the native side
   *  sends to an LM Studio model or not at all; its own pick (S.localLlm) is kept apart from the everyday one. */
  function llmOpts(board, purpose) {
    return isConfidential(board) ? { purpose, llm: S.localLlm, local: true } : { purpose, llm: S.llm };
  }
  /** Boards whose questions may go into another board's prompts or the level-set: never a confidential one. */
  const shareable = (boards) => boards.filter((b) => !isConfidential(b));

  function toggleConfidential(force) {
    const b = S.board;
    if (!b) return;
    const on = typeof force === 'boolean' ? force : !isConfidential(b);
    if (on === isConfidential(b)) return;
    if (on) {
      b.confidential = true;
      // whatever this board still has on its way to another model stops here
      for (const [cardId, st] of S.streams) if (st.boardId === b.id) cancelCard(cardId);
      for (const m of [S.sums, S.ljobs, S.recaps]) { const j = m.get(b.id); if (j && j.running && j.cancel) j.cancel(); }
      for (const j of S.dgJobs.values()) if (j.boardId === b.id && j.cancel) j.cancel();
    } else delete b.confidential;
    save(b);
    render();
    refreshConfig().then(() => {
      const c = S.config || {};
      toast(on ? `Confidential: this board only talks to LM Studio (${c.model || 'the loaded model'}). It stays out of the level-set and other boards.`
        : 'No longer confidential: this board uses the model picked at the top right.');
    });
    updateLevelChip();
    B.call('current', { id: b.id, title: b.title || '' }).catch(() => {});
  }

  function renderConfidential() {
    const on = isConfidential(S.board);
    document.body.classList.toggle('confidential', on);
    dom.lockBtn.classList.toggle('on', on);
    dom.lockBtn.textContent = on ? '🔒 local only' : '🔓';
    dom.lockBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    dom.lockBtn.title = kbd(on
      ? 'Confidential: only LM Studio (local) answers on this board, and it stays out of the level-set and other boards. Click to allow every model (⌥⌘P)'
      : 'Mark this board confidential: only LM Studio (local) may answer, never OpenRouter (⌥⌘P)');
    // the model menu follows the board: LM Studio models only on a confidential one
    if (S.config && !!S.config.local !== on && !S.configLoading) refreshConfig();
  }

  /** Profile + everything asked since it was made (all boards), so each rating counts right away.
   *  A confidential board's questions only go into its own prompts, which stay on LM Studio. */
  function learnerContext(board, answerCardId) {
    const boards = new Map([...S.library].filter(([, b]) => isConfidential(board) || !isConfidential(b)));
    boards.set(board.id, board);
    const since = S.profile && S.profile.meta ? S.profile.meta.updatedAt : 0;
    const items = M.evidence([...boards.values()])
      .filter((it) => it.answerId !== answerCardId && it.at > since)
      .sort((a, b) => b.at - a.at)
      .slice(0, 30);
    return { profile: S.profile, items, notes: S.notes };
  }

  /** What the prompts need to know about the board's paper: its title and the text of every page. */
  function paperOf(board) {
    if (!board.pdf) return null;
    return { title: EE.util.texToText(board.title) || board.pdf.name, name: board.pdf.name, pages: P.textNow(board.pdf.file) || [] };
  }

  const noText = new Set(); // papers whose text could not be extracted: ask without it
  function stream(board, threadId, card, mode) {
    // a paper's text is extracted when it opens; a question asked in the first instant waits for it
    if (board.pdf && !P.textNow(board.pdf.file) && !noText.has(board.pdf.file)) {
      const go = () => { if (card.status === 'streaming' && !S.streams.has(card.id)) stream(board, threadId, card, mode); };
      P.pageTexts(board.pdf.file).then(go, () => { noText.add(board.pdf.file); go(); });
      return;
    }
    const messages = M.buildMessages(board, threadId, card.id, mode, learnerContext(board, card.id), { diagrams: diagramsOn(), paper: paperOf(board) });
    const h = B.chat(messages, {
      onChunk({ content, reasoning }) {
        card.text += content;
        if (reasoning) card.reasoning = (card.reasoning || '') + reasoning;
        touch(card);
        if (board === S.board) scheduleRender();
        save(board, true);
      },
      onDone({ model, cancelled }) {
        S.streams.delete(card.id);
        card.status = cancelled ? 'stopped' : 'done';
        if (model) card.model = model;
        if (!cancelled && !R.splitThink(card.text).body.trim()) {
          card.status = 'error';
          card.error = card.reasoning || R.splitThink(card.text).think
            ? 'The model only produced scratch work (it may have hit the token limit). Try ↻ Redo or raise LLM_MAX_TOKENS.'
            : 'The model returned an empty answer.';
        }
        touch(card);
        save(board);
        if (board === S.board) render();
        updateLevelChip();
        if (card.status === 'done' && diagramsOn()) autoDiagrams(board, card);
      },
      onError(err) {
        S.streams.delete(card.id);
        card.status = 'error';
        card.error = err.message;
        touch(card);
        save(board);
        if (board === S.board) render();
      },
    }, llmOpts(board, 'explain'));
    S.streams.set(card.id, { ...h, boardId: board.id });
  }

  function cancelCard(cardId) {
    const s = S.streams.get(cardId);
    if (s) s.cancel();
  }

  function askAbout(anchor, question, mode = 'explain') {
    const board = S.board;
    const found = isPaperCard(anchor.cardId) ? (board.pdf ? { thread: board.threads.root } : null) : M.findCard(board, anchor.cardId);
    if (!found || !question.trim()) return null;
    const th = M.newThread(board, found.thread.id, anchor, question.trim());
    th.cards.push({ id: uid('c'), role: 'user', text: question.trim(), mode, createdAt: Date.now() });
    board.openPath = M.pathTo(board, th.id);
    hidePopover();
    getSelection().removeAllRanges();
    ask(board, th.id, mode);
    requestAnimationFrame(() => revealColumn(th.id));
    return th;
  }

  function openThread(id) {
    const b = S.board;
    if (!b.threads[id]) return;
    b.openPath = M.pathTo(b, id);
    save(b, true);
    render();
    requestAnimationFrame(() => { revealColumn(id); revealPaperAnchor(b.threads[b.openPath[1]]); });
  }

  function closeThread(id) {
    const b = S.board;
    const i = b.openPath.indexOf(id);
    if (i <= 0) return;
    b.openPath = b.openPath.slice(0, i);
    save(b, true);
    render();
    requestAnimationFrame(() => revealColumn(b.openPath[b.openPath.length - 1]));
  }

  const toggleThread = (id) => (S.board.openPath.includes(id) ? closeThread(id) : openThread(id));
  function closeLast() {
    const p = S.board.openPath;
    if (p.length > 1) closeThread(p[p.length - 1]);
  }
  function closeAll() {
    S.board.openPath = ['root'];
    save(S.board, true);
    render();
    dom.board.scrollTo({ left: 0, behavior: 'smooth' });
  }

  function removeThreads(board, ids) {
    for (const tid of ids) {
      const t = board.threads[tid];
      if (!t) continue;
      t.cards.forEach((c) => cancelCard(c.id));
      delete board.threads[tid];
    }
    board.openPath = board.openPath.filter((t) => board.threads[t]);
  }

  async function deleteThread(id) {
    const b = S.board;
    const ids = [id, ...M.descendants(b, id)];
    const ok = await confirmDialog(
      ids.length > 1 ? `Erase this side question and the ${ids.length - 1} deeper one(s) under it?` : 'Erase this side question?',
      'Erase');
    if (!ok) return;
    removeThreads(b, ids);
    save(b);
    render();
  }

  async function eraseCard(cardId) {
    const b = S.board;
    const f = M.findCard(b, cardId);
    if (!f) return;
    const branchIds = M.branchesOn(b, cardId).flatMap((t) => [t.id, ...M.descendants(b, t.id)]);
    const ok = await confirmDialog(
      branchIds.length ? `Erase this from the board, together with ${branchIds.length} side question(s) attached to it?` : 'Erase this from the board?',
      'Erase');
    if (!ok) return;
    cancelCard(cardId);
    cancelDiagrams(cardId);
    removeThreads(b, branchIds);
    f.thread.cards.splice(f.index, 1);
    save(b);
    render();
  }

  function regenerate(cardId) {
    const b = S.board;
    const f = M.findCard(b, cardId);
    if (!f || f.card.role !== 'assistant') return;
    cancelCard(cardId);
    cancelDiagrams(cardId);
    Object.assign(f.card, { text: '', reasoning: '', status: 'streaming', error: null, runs: {}, edits: {}, diagrams: {} });
    touch(f.card);
    render();
    stream(b, f.thread.id, f.card, f.card.mode);
  }

  // ------------------------------------------------------------ diagrams
  /** Diagrams are drawn by the model that writes the text (the one picked in the top bar), so they are on once it is set up. */
  const diagramsOn = () => !!(S.config && !(S.config.problems || []).length);
  const dgKey = (cardId, key) => cardId + ':' + key;

  /** Draw every diagram the finished answer asked for. */
  function autoDiagrams(board, card) {
    const { requests } = DG.extract(R.splitThink(card.text).body);
    requests.slice(0, 3).forEach((req, i) => {
      const e = (card.diagrams || {})['m' + i];
      if (!e || (!e.spec && !e.error && !e.dismissed)) drawDiagram(board, card, 'm' + i);
    });
  }

  /** What the diagram model needs: the question, the highlighted quote of a side question, the answer, the request. */
  function diagramMessages(board, card, request) {
    const f = M.findCard(board, card.id);
    const before = f ? f.thread.cards.slice(0, f.index) : [];
    const q = before.slice().reverse().find((c) => c.role === 'user');
    return DG.messages({
      question: q ? q.text : '', quote: f && f.thread.anchor ? f.thread.anchor.llmText : '',
      answer: R.splitThink(card.text).body, request,
    });
  }

  /** Ask the diagram model for diagram `key` of an answer: 'm<i>' for the i-th marker, 'x<n>' for one asked with ◇. */
  function drawDiagram(board, card, key) {
    const id = dgKey(card.id, key);
    if (S.dgJobs.has(id)) return;
    let request = '';
    if (key[0] === 'm') {
      request = DG.extract(R.splitThink(card.text).body).requests[Number(key.slice(1))];
      if (request == null) return;
    }
    const all = card.diagrams || (card.diagrams = {});
    const entry = all[key] || (all[key] = { createdAt: Date.now() });
    Object.assign(entry, { request, error: null });
    delete entry.dismissed;
    const job = { boardId: board.id, cancel: null };
    S.dgJobs.set(id, job);
    const refresh = () => { touch(card); if (board === S.board) render(); };
    const finish = () => {
      S.dgJobs.delete(id);
      if (key[0] === 'x' && !entry.spec && !entry.error) delete all[key]; // stopped before anything was drawn
      save(board);
      refresh();
    };
    const attempt = (messages, retry) => {
      let text = '';
      const h = B.chat(messages, {
        onChunk({ content }) { text += content; },
        onDone({ model, cancelled }) {
          if (cancelled) { finish(); return; }
          try {
            Object.assign(entry, { spec: DG.parse(text), model: model || entry.model || null, drawnAt: Date.now(), error: null });
          } catch (e) {
            if (!retry) {
              // one more go, with the reason it could not be drawn
              attempt([...messages, { role: 'assistant', content: text },
                { role: 'user', content: `That cannot be drawn: ${e.message}. Reply with the corrected JSON object only.` }], true);
              return;
            }
            entry.error = `The diagram model's reply could not be drawn: ${e.message}.`;
          }
          finish();
        },
        onError(err) { entry.error = err.message; finish(); },
      }, llmOpts(board, 'diagram'));
      job.cancel = h.cancel;
    };
    refresh();
    attempt(diagramMessages(board, card, request), false);
  }

  /** ◇ on an answer: one more diagram, chosen by the diagram model, under the answer. */
  function addDiagram(board, card) {
    const n = Math.max(0, ...Object.keys(card.diagrams || {}).filter((k) => k[0] === 'x').map((k) => Number(k.slice(1)) || 0));
    drawDiagram(board, card, 'x' + (n + 1));
  }

  function cancelDiagrams(cardId) {
    for (const [id, job] of [...S.dgJobs]) if (id.startsWith(cardId + ':') && job.cancel) job.cancel();
  }

  function eraseDiagram(cardId, key) {
    const f = M.findCard(S.board, cardId);
    const all = f && f.card.diagrams;
    if (!all || !all[key]) return;
    if (key[0] === 'm') all[key] = { request: all[key].request, dismissed: true, createdAt: all[key].createdAt };
    else delete all[key];
    touch(f.card);
    save(S.board);
    render();
  }

  function zoomDiagram(cardId, key) {
    const f = M.findCard(S.board, cardId);
    const e = f && (f.card.diagrams || {})[key];
    if (!e || !e.spec) return;
    const c = DG.canvas(e.spec);
    const z = Math.max(1, Math.min(2.4, (window.innerWidth * 0.86) / Number(c.dataset.w), (window.innerHeight * 0.68) / Number(c.dataset.h)));
    c.style.zoom = z;
    let close;
    close = modal(el('div', {},
      e.spec.title ? el('h2', { class: 'chalk-title modal-title', html: DG.labelHTML(e.spec.title) }) : null,
      el('div', { class: 'dg-modal-stage' }, c),
      el('div', { class: 'modal-actions' }, e.model ? el('span', { class: 'model-tag' }, e.model) : null,
        el('span', { class: 'spacer' }), el('button', { class: 'chalk-btn primary', onclick: () => close() }, 'close'))), 'modal-diagram');
  }

  let fontsPending = false;
  /** Put each diagram (or its progress, or its error) into its slot; ◇ diagrams go under the answer. */
  function fillDiagrams(body, card, requests) {
    const all = card.diagrams || {};
    const extra = Object.keys(all).filter((k) => k[0] === 'x')
      .concat([...S.dgJobs.keys()].filter((id) => id.startsWith(card.id + ':x')).map((id) => id.slice(card.id.length + 1)));
    for (const key of [...new Set(extra)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))) {
      body.append(el('div', { class: 'diagram', 'data-dg': key, 'data-noanchor': '' }));
    }
    let drew = false;
    for (const slot of body.querySelectorAll('.diagram[data-dg]')) {
      const key = slot.dataset.dg;
      const request = key[0] === 'm' ? requests[Number(key.slice(1))] || '' : '';
      let view = null;
      try { view = diagramView(card, key, request); } catch (e) {
        view = el('div', { class: 'dg-pending' }, el('span', { class: 'err' }, '⚠ This diagram could not be drawn: ' + e.message),
          el('button', { class: 'link-btn', 'data-act': 'dg-redraw', 'data-key': key }, '↻ redraw'));
      }
      if (view) { slot.replaceChildren(view); drew = drew || !!view.querySelector('.dg-canvas'); } else slot.remove();
    }
    // labels were measured with fallback fonts if the math fonts were still loading: measure again once they are in
    if (drew && document.fonts && document.fonts.status !== 'loaded' && !fontsPending) {
      fontsPending = true;
      document.fonts.ready.then(() => {
        fontsPending = false;
        DG.clearCache();
        for (const t of Object.values((S.board || { threads: {} }).threads)) for (const c of t.cards) if (c.diagrams) touch(c);
        scheduleRender();
      });
    }
  }

  function diagramView(card, key, request) {
    const e = (card.diagrams || {})[key];
    const job = S.dgJobs.has(dgKey(card.id, key));
    const btn = (act, label, title) => el('button', { class: act === 'dg-stop' || label.length > 2 ? 'link-btn' : 'icon-btn', 'data-act': act, 'data-key': key, title }, label);
    const req = (text) => el('span', { class: 'dg-req', html: R.inline(truncate(text, 180)) });
    if (e && e.dismissed && !job) return null;
    if (e && e.spec) {
      return el('figure', { class: 'dg-fig' + (job ? ' is-redrawing' : '') },
        DG.figure(e.spec),
        el('figcaption', { class: 'dg-cap' },
          el('span', { class: 'dg-title', html: e.spec.title ? DG.labelHTML(e.spec.title) : '' }),
          el('span', { class: 'spacer' }),
          job ? el('span', { class: 'chalk-dots' }, 'redrawing') : null,
          job ? btn('dg-stop', '■ stop') : null,
          job ? null : btn('dg-zoom', '⤢', 'Enlarge'),
          job ? null : btn('dg-redraw', '↻', 'Redraw this diagram'),
          job ? null : btn('dg-erase', '✕', 'Erase this diagram'),
          e.model ? el('span', { class: 'model-tag' }, e.model) : null),
        e.error && !job ? el('div', { class: 'dg-note err' }, '⚠ Redrawing failed, so this is the earlier drawing. ' + e.error) : null);
    }
    const box = el('div', { class: 'dg-pending' });
    if (job) box.append(el('span', { class: 'chalk-dots' }, 'drawing a diagram'), request ? req(request) : null, btn('dg-stop', '■ stop'));
    else if (e && e.error) box.append(el('span', { class: 'err' }, '⚠ ' + e.error), btn('dg-redraw', '↻ try again'));
    else if (card.status === 'streaming') box.append(el('span', { class: 'muted' }, '◇ a diagram goes here:'), req(request));
    else box.append(el('span', { class: 'muted' }, '◇'), req(request || 'a diagram'), btn('dg-redraw', 'draw it'));
    return box;
  }

  // ------------------------------------------------------------ python
  function codeBlocksOf(card) {
    if (card.role === 'code') return [card.code];
    const div = document.createElement('div');
    div.innerHTML = R.markdown(R.splitThink(card.text).body);
    return [...div.querySelectorAll('pre > code')].filter((c) => isRunnable(c, card)).map((c) => c.textContent);
  }
  function isRunnable(code, card) {
    if (card.role === 'code') return true;
    const lang = ((code.className.match(/language-([\w+-]+)/) || [])[1] || '').toLowerCase();
    if (/^(python|py|python3|sage|ipython)$/.test(lang)) return true;
    return !lang && /(^|\n)\s*(import |from \w+ import|print\(|show\()/.test(code.textContent);
  }
  function codeFor(card, idx) {
    if (card.edits && card.edits[idx] != null) return card.edits[idx];
    return codeBlocksOf(card)[idx];
  }

  async function runCode(cardId, idx, board = S.board) {
    const f = M.findCard(board, cardId);
    if (!f) return null;
    const card = f.card;
    const key = cardId + ':' + idx;
    if (S.running.has(key)) return null;
    const code = codeFor(card, idx);
    if (code == null) return null;
    const runId = uid('run');
    S.running.set(key, runId);
    touch(card);
    if (board === S.board) render();
    let result;
    try {
      result = await B.call('python', { id: runId, code });
    } catch (e) {
      result = { stdout: '', stderr: String(e.message || e), exitCode: -1, ms: 0, images: [] };
    }
    S.running.delete(key);
    card.runs = card.runs || {};
    card.runs[idx] = { ...result, at: Date.now() };
    touch(card);
    save(board);
    if (board === S.board) render();
    return result;
  }

  function fixRun(cardId, idx) {
    const f = M.findCard(S.board, cardId);
    const r = f && f.card.runs && f.card.runs[idx];
    if (!r) return;
    const which = f.card.role === 'code' ? 'My code' : `Code block ${idx + 1}`;
    send(f.thread.id, `${which} failed when executed:\n\n\`\`\`\n${(r.stderr || '').slice(-2500)}\n\`\`\`\n\nPlease write a corrected, self-contained python block. Use only numpy, sympy and the documented boardkit API.`, 'compute');
  }

  function explainRun(cardId, idx) {
    const ce = findCardEl(cardId);
    const out = ce && ce.querySelector(`.code-block[data-idx="${idx}"] .code-out`);
    const body = ce && ce.querySelector('.card-body');
    if (!out || !body) return;
    const r = document.createRange();
    r.selectNodeContents(out);
    const anchor = A.capture(body, r, cardId);
    if (anchor) askAbout(anchor, 'Explain this result step by step: what does each line of the output mean?');
  }

  // ------------------------------------------------------------ rendering
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function render() {
    const b = S.board;
    if (!b) return;
    renderCrumbs();
    renderConfidential();
    const path = b.openPath;
    for (const [tid, c] of cols) {
      if (!path.includes(tid) || !b.threads[tid]) { c.root.remove(); cols.delete(tid); }
    }
    path.forEach((tid, i) => {
      let c = cols.get(tid);
      if (!c) { c = buildColumn(tid, i); cols.set(tid, c); }
      const at = dom.columns.children[i];
      if (at !== c.root) dom.columns.insertBefore(c.root, at || null);
      updateColumn(c, b.threads[tid], i);
    });
    applyHighlights();
    scheduleOverlay();
    renderOutline();
    renderSummary();
    renderLessons();
    renderRecap();
    document.body.classList.toggle('has-branches', path.length > 1);
  }

  function buildColumn(threadId, i) {
    const root = el('section', { class: 'column' + (i === 0 ? ' col-root' : ' col-branch'), 'data-thread': threadId });
    const head = el('header', { class: 'col-head' });
    const body = el('div', { class: 'col-body' });
    const list = el('div', { class: 'cards' });
    body.append(list);
    const composer = i === 0 && S.board.pdf ? buildPaperBar() : buildComposer(threadId, i === 0);
    root.append(head, body, composer.root);
    body.addEventListener('scroll', scheduleOverlay, { passive: true });
    return { id: threadId, root, head, body, list, composer, cards: new Map(), headSig: '', tag: null, hero: null };
  }

  function updateColumn(c, thread, i) {
    const b = S.board;
    const kids = M.descendants(b, thread.id).length;
    const sig = JSON.stringify([i, b.title, thread.title, thread.anchor && thread.anchor.quote, kids, M.countBranches(b), b.pdf && b.pdf.pages, S.paperLook]);
    if (sig !== c.headSig) {
      c.headSig = sig;
      c.head.replaceChildren();
      if (i === 0 && b.pdf) {
        const n = M.countBranches(b);
        const meta = [b.pdf.pages ? `${b.pdf.pages} page${b.pdf.pages > 1 ? 's' : ''}` : '', n ? `${n} side question${n > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
        c.head.append(
          el('span', { class: 'paper-mark', title: b.pdf.name }, '▤'),
          el('button', { class: 'col-title chalk-title', 'data-act': 'rename-board', title: `Rename board (${b.pdf.name})` }, EE.util.texToText(b.title) || b.pdf.name),
          el('span', { class: 'spacer' }),
          el('span', { class: 'col-meta' }, meta),
          el('button', { class: 'icon-btn paper-read', 'data-act': 'reader-start', title: kbd('Read the paper with me, a passage (a few paragraphs that belong together) at a time (⇧⌘P)') }, '¶ read'),
          el('button', { class: 'icon-btn paper-look', 'data-act': 'paper-look', title: S.paperLook === 'chalk' ? 'Show the paper as printed, black on white' : 'Chalk it onto the slate' },
            S.paperLook === 'chalk' ? '☐ paper' : '▨ chalk'));
        c.tag = null;
      } else if (i === 0) {
        const n = M.countBranches(b);
        c.head.append(
          el('button', { class: 'col-title chalk-title', 'data-act': 'rename-board', title: 'Rename board' }, EE.util.texToText(b.title) || 'A fresh board'),
          el('span', { class: 'col-meta' }, n ? `${n} side question${n > 1 ? 's' : ''}` : ''));
        c.tag = null;
      } else {
        c.tag = el('div', { class: 'branch-tag', title: thread.anchor ? clean(thread.anchor.quote) : '' },
          el('span', { class: 'tag-arrow' }, isReadThread(thread) ? '¶ ' + (thread.anchor.para + 1) : '↳'),
          el('span', { class: 'tag-quote' }, '“' + truncate(clean(thread.anchor ? thread.anchor.quote : ''), 60) + '”'));
        c.head.append(
          c.tag,
          el('span', { class: 'spacer' }),
          el('span', { class: 'col-meta' }, kids ? `${kids} deeper` : ''),
          el('button', { class: 'icon-btn', 'data-act': 'delete-thread', 'data-thread': thread.id, title: 'Erase this side question' }, '⌫'),
          el('button', { class: 'icon-btn close-btn', 'data-act': 'close-thread', 'data-thread': thread.id, title: 'Close (Esc) — back to the previous level' }, '✕'));
      }
    }

    if (i === 0 && b.pdf) mountPaper(c, b);
    // hero for an empty board
    if (i === 0 && thread.cards.length === 0 && !b.pdf) {
      if (!c.hero) { c.hero = buildHero(); c.body.prepend(c.hero); }
      c.root.classList.add('is-empty');
    } else if (c.hero) {
      c.hero.remove();
      c.hero = null;
      c.root.classList.remove('is-empty');
    }

    const nearBottom = c.body.scrollHeight - c.body.scrollTop - c.body.clientHeight < 90;
    const want = new Set(thread.cards.map((x) => x.id));
    for (const [id, ce] of c.cards) if (!want.has(id)) { ce.remove(); c.cards.delete(id); }
    let prev = null;
    let streaming = false;
    thread.cards.forEach((card, k) => {
      let ce = c.cards.get(card.id);
      if (!ce) { ce = buildCard(card); c.cards.set(card.id, ce); }
      const expected = prev ? prev.nextSibling : c.list.firstChild;
      if (ce !== expected) c.list.insertBefore(ce, expected);
      const v = S.ver.get(card.id) || 0;
      if (ce._v !== v) {
        const now = performance.now();
        if (card.status === 'streaming' && ce._t && now - ce._t < 90) {
          setTimeout(scheduleRender, 95);
        } else {
          renderCard(ce, card, thread, k);
          ce._v = v;
          ce._t = now;
        }
      }
      updateChips(ce, card);
      updatePoll(ce, card);
      if (card.status === 'streaming') streaming = true;
      prev = ce;
    });
    if (streaming && nearBottom) c.body.scrollTop = c.body.scrollHeight;
    c.composer.sync();
  }

  function buildHero() {
    return el('div', { class: 'hero' },
      el('h1', { class: 'chalk-title' }, 'What shall we work out today?'),
      el('p', { class: 'hero-sub' },
        'Write an equation, a matrix or a question. Then highlight any part of the answer to ask a side question. It opens to the right, and you can keep drilling down.'),
      el('p', { class: 'hero-paper' },
        el('button', { class: 'example paper-open', 'data-act': 'open-pdf', title: kbd('Open a PDF paper (⌘O)') }, '▤ read a paper'),
        el('span', { class: 'muted' }, 'Open a PDF (or drop one on the board) and highlight any passage of it to ask about it.')),
      el('div', { class: 'examples' },
        EXAMPLES.map((ex, i) => el('button', { class: 'example', 'data-act': 'example', 'data-idx': i },
          el('span', { class: 'ex-mode' }, ex.mode === 'compute' ? 'compute' : 'explain'),
          el('span', { html: R.inline(ex.text) })))));
  }

  function buildCard(card) {
    return el('article', { class: `card card-${card.role}`, 'data-card': card.id },
      el('details', { class: 'scratch', hidden: true, 'data-noanchor': '' },
        el('summary', {}, 'scratch work'), el('div', { class: 'scratch-body' })),
      el('div', { class: 'card-body' }),
      el('div', { class: 'card-status', 'data-noanchor': '' }),
      el('div', { class: 'card-poll', 'data-noanchor': '' }),
      el('div', { class: 'card-branches', 'data-noanchor': '' }),
      el('div', { class: 'card-tools', 'data-noanchor': '' }));
  }

  function renderCard(ce, card, thread, k) {
    ce.className = `card card-${card.role}` + (card.status === 'streaming' ? ' is-streaming' : '') + (card.status === 'error' ? ' is-error' : '');
    const body = ce.querySelector('.card-body');
    const scratch = ce.querySelector('.scratch');
    const status = ce.querySelector('.card-status');
    const tools = ce.querySelector('.card-tools');
    status.replaceChildren();
    tools.replaceChildren();

    if (card.role === 'user') {
      let html = '';
      if (k === 0 && thread.anchor && isPaperCard(thread.anchor.cardId)) {
        const pg = M.pageOf(thread.anchor.cardId);
        html += `<blockquote class="anchor-quote paper-quote"><span class="paper-page">${pg ? 'p. ' + M.pagesLabel(thread.anchor) : 'the paper'}</span> ${pg ? esc(thread.anchor.quote) : esc(thread.anchor.llmText)}</blockquote>`;
      } else if (k === 0 && thread.anchor) html += `<blockquote class="anchor-quote">${R.markdown(thread.anchor.llmText)}</blockquote>`;
      html += `<div class="q-text">${R.markdown(card.text)}</div>`;
      body.innerHTML = html;
      if (card.mode === 'compute') status.append(el('span', { class: 'badge' }, 'compute'));
      tools.append(toolBtn('erase-card', '⌫', 'Erase from the board'));
    } else if (card.role === 'assistant') {
      const { think, body: text, thinking } = R.splitThink(card.text);
      const reasoning = ((card.reasoning || '') + think).trim();
      scratch.hidden = !reasoning;
      if (reasoning) scratch.querySelector('.scratch-body').textContent = reasoning;
      const dg = DG.extract(text, card.status === 'streaming');
      body.innerHTML = text ? DG.slots(R.markdown(dg.text)) : '';
      decorate(body, card);
      fillDiagrams(body, card, dg.requests);
      if (card.status === 'streaming') {
        status.append(
          el('span', { class: 'chalk-dots' }, thinking || (!text && reasoning) ? 'thinking' : text ? 'writing' : 'picking up the chalk'),
          el('button', { class: 'link-btn', 'data-act': 'stop' }, '■ stop'));
      } else if (card.status === 'error') {
        status.append(el('span', { class: 'err' }, '⚠ ' + (card.error || 'Something went wrong')),
          el('button', { class: 'link-btn', 'data-act': 'regenerate' }, '↻ try again'));
      } else if (card.status === 'stopped') {
        status.append(el('span', { class: 'muted' }, '(stopped)'), el('button', { class: 'link-btn', 'data-act': 'regenerate' }, '↻ redo'));
      }
      if (card.status !== 'streaming') {
        tools.append(toolBtn('regenerate', '↻', 'Rewrite this answer'), toolBtn('diagram', '◇', 'Draw a diagram of this answer: its circuit or architecture'),
          toolBtn('copy-card', '⎘', 'Copy as Markdown'), toolBtn('erase-card', '⌫', 'Erase from the board'));
        if (card.model) tools.append(el('span', { class: 'model-tag' }, card.model));
      }
    } else if (card.role === 'code') {
      const code = el('code', { class: 'language-python' });
      code.textContent = card.code;
      body.replaceChildren(el('pre', {}, code));
      decorate(body, card);
      tools.append(toolBtn('erase-card', '⌫', 'Erase from the board'));
    }
    body.querySelectorAll('.katex-display').forEach((d) => {
      d.append(el('button', { class: 'lens-btn', 'data-act': 'lens', 'data-noanchor': '', title: 'Zoom into this equation' }, '⤢'));
    });
    ce._chips = null;
  }

  const toolBtn = (act, label, title) => el('button', { class: 'tool-btn', 'data-act': act, title }, label);

  function decorate(body, card) {
    let idx = 0;
    body.querySelectorAll('pre > code').forEach((code) => {
      const pre = code.parentElement;
      const runnable = isRunnable(code, card);
      const wrap = el('div', { class: 'code-block' + (runnable ? ' runnable' : '') });
      pre.replaceWith(wrap);
      if (!runnable) {
        wrap.append(pre);
        try { window.hljs && hljs.highlightElement(code); } catch (e) { /* plain is fine */ }
        return;
      }
      const i = idx++;
      wrap.dataset.idx = i;
      const edited = card.edits && card.edits[i] != null;
      if (edited) code.textContent = card.edits[i];
      code.classList.add('language-python');
      try { window.hljs && hljs.highlightElement(code); } catch (e) { /* plain is fine */ }
      const running = S.running.has(card.id + ':' + i);
      wrap.append(
        el('div', { class: 'code-head', 'data-noanchor': '' },
          el('span', { class: 'code-lang' }, 'python' + (edited ? ' · edited' : '')),
          el('span', { class: 'spacer' }),
          running
            ? el('button', { class: 'btn-stop', 'data-act': 'stop-run', 'data-idx': i }, '■ Stop')
            : el('button', { class: 'btn-run', 'data-act': 'run', 'data-idx': i, title: kbd('Run in the background (⌘⏎ while editing)') }, '▶ Execute'),
          el('button', { class: 'icon-btn', 'data-act': 'edit-code', 'data-idx': i, title: 'Edit code' }, '✎'),
          el('button', { class: 'icon-btn', 'data-act': 'copy-code', 'data-idx': i, title: 'Copy code' }, '⎘')),
        pre);
      const run = card.runs && card.runs[i];
      if (running) {
        wrap.append(el('div', { class: 'code-out running', 'data-noanchor': '' }, el('span', { class: 'chalk-dots' }, 'running in the background')));
      } else if (run) {
        wrap.append(renderRun(run, i));
      }
    });
  }

  function renderRun(run, i) {
    const failed = run.exitCode !== 0;
    const out = el('div', { class: 'code-out' + (failed ? ' failed' : '') });
    const meta = `${((run.ms || 0) / 1000).toFixed(2)} s` + (failed ? ` · exit ${run.exitCode}` : '') + (run.timedOut ? ' · timed out' : '') + (run.cancelled ? ' · stopped' : '');
    out.append(el('div', { class: 'out-head', 'data-noanchor': '' },
      el('span', { class: 'out-label' }, '⇒ result'),
      el('span', { class: 'out-meta' }, meta),
      el('span', { class: 'spacer' }),
      failed && !run.cancelled ? el('button', { class: 'link-btn fix', 'data-act': 'fix-run', 'data-idx': i, title: 'Send the error back and ask for corrected code' }, 'fix it ↻') : null,
      el('button', { class: 'link-btn', 'data-act': 'explain-run', 'data-idx': i }, 'explain this result ↳'),
      el('button', { class: 'icon-btn', 'data-act': 'clear-run', 'data-idx': i, title: 'Wipe the output' }, '✕')));
    if (run.stdout) out.append(el('div', { class: 'out-body', html: R.stdout(run.stdout) }));
    if (run.stderr) out.append(el('pre', { class: 'out-err', text: run.stderr }));
    (run.images || []).forEach((src) => {
      const img = el('img', { class: 'out-img', src, alt: 'figure' });
      img.addEventListener('load', scheduleOverlay);
      out.append(img);
    });
    if (!run.stdout && !run.stderr && !(run.images || []).length) {
      out.append(el('div', { class: 'out-empty' }, '(no output, use show(...) or print(...))'));
    }
    return out;
  }

  function updateChips(ce, card) {
    const b = S.board;
    const branches = M.branchesOn(b, card.id);
    const sig = branches.map((t) => t.id + (b.openPath.includes(t.id) ? '*' : '') + M.descendants(b, t.id).length).join(',');
    if (ce._chips === sig) return;
    ce._chips = sig;
    const box = ce.querySelector('.card-branches');
    box.replaceChildren(...branches.map((t) => {
      const open = b.openPath.includes(t.id);
      const deeper = M.descendants(b, t.id).length;
      return el('button', { class: 'branch-chip' + (open ? ' open' : ''), 'data-act': 'toggle-branch', 'data-thread': t.id, title: open ? 'Close this side question' : 'Open this side question' },
        el('span', { class: 'chip-arrow' }, open ? '↤' : '↳'),
        el('span', { class: 'chip-quote' }, '“' + truncate(clean(t.anchor.quote), 34) + '”'),
        el('span', { class: 'chip-q' }, truncate(t.title, 44)),
        deeper ? el('span', { class: 'chip-deeper' }, `+${deeper}`) : null);
    }));
  }

  const POLL_NOTE = (r) => (r == null ? 'unrated, counts as 1' : r <= 3 ? 'noted: will be reinforced' : r <= 6 ? 'noted: brief reminders' : r <= 8 ? 'noted' : 'noted: treated as known');

  /** "did this sink in?" 1-10 under every finished answer. */
  function updatePoll(ce, card) {
    const box = ce.querySelector('.card-poll');
    if (!box) return;
    const show = card.role === 'assistant' && (card.status === 'done' || card.status === 'stopped') && !!R.splitThink(card.text).body.trim();
    const sig = show ? String(card.rating == null ? 'u' : card.rating) : '';
    if (ce._poll === sig) return;
    ce._poll = sig;
    if (!show) { box.replaceChildren(); return; }
    const r = card.rating == null ? null : card.rating;
    box.replaceChildren(
      el('span', { class: 'poll-q' }, 'did this sink in?'),
      el('span', { class: 'poll-scale', role: 'radiogroup', 'aria-label': 'did this sink in, 1 to 10' },
        Array.from({ length: 10 }, (_, i) => i + 1).map((n) =>
          el('button', {
            class: 'poll-n ' + (n <= 3 ? 'lo' : n <= 6 ? 'mid' : 'hi') + (r === n ? ' on' : ''),
            'data-act': 'rate', 'data-n': n, role: 'radio', 'aria-checked': r === n ? 'true' : 'false',
            title: n === 1 ? '1: did not sink in' : n === 10 ? '10: fully sank in' : String(n),
          }, String(n)))),
      el('span', { class: 'poll-note' + (r == null ? ' unrated' : '') }, POLL_NOTE(r)));
  }

  function findCardEl(cardId) {
    for (const c of cols.values()) if (c.cards.has(cardId)) return c.cards.get(cardId);
    return null;
  }

  // ------------------------------------------------------------ composer
  function buildComposer(threadId, isRoot) {
    const ta = el('textarea', { rows: 1, spellcheck: 'false', 'aria-label': 'Write on the board' });
    const preview = el('div', { class: 'composer-preview', hidden: true });
    const modeBtns = ['explain', 'compute', 'python'].map((m) =>
      el('button', { class: 'mode', 'data-mode': m, title: {
        explain: 'Explain step by step',
        compute: 'Have the calculation done (writes runnable Python)',
        python: 'Write Python yourself and run it',
      }[m] }, m));
    const send = el('button', { class: 'send-btn', title: 'Write it on the board' }, 'write ↵');
    const matrix = el('button', { class: 'tool-btn', title: kbd('Insert a matrix (⌥⌘M)') }, '▦ matrix');
    const hint = el('span', { class: 'hint' });
    const nav = el('div', { class: 'reader-row reader-nav', hidden: true });
    const root = el('div', { class: 'composer' + (isRoot ? ' composer-root' : '') },
      nav, preview, ta, el('div', { class: 'composer-bar' }, el('div', { class: 'modes' }, modeBtns), matrix, hint, el('span', { class: 'spacer' }), send));

    const mode = () => S.modes.get(threadId) || 'explain';
    const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 260) + 'px'; };
    const updatePreview = debounce(() => {
      const v = ta.value;
      if (mode() !== 'python' && /[$\\]/.test(v)) {
        preview.innerHTML = R.markdown(v);
        preview.hidden = false;
      } else preview.hidden = true;
      scheduleOverlay();
    }, 140);
    function sync() {
      const m = mode();
      modeBtns.forEach((bt) => bt.classList.toggle('on', bt.dataset.mode === m));
      root.classList.toggle('is-python', m === 'python');
      ta.placeholder = m === 'python'
        ? "from boardkit import *\nshow(kron(H, H) * ket('00'), label=r'(H\\otimes H)\\ket{00}')"
        : m === 'compute'
          ? 'Type a matrix or an expression to compute, e.g. (H⊗H)·CNOT·(H⊗H)'
          : isRoot ? 'Write an equation or a question…'
            : isReadThread(S.board.threads[threadId]) ? 'Ask about this passage…' : 'Follow up on this side question…';
      readerNav(nav, threadId);
      hint.textContent = m === 'python' ? kbd('⌘ + enter runs it') : 'enter writes · shift + enter for a new line';
    }
    function submit() {
      const text = ta.value;
      if (!text.trim()) return;
      ta.value = '';
      S.drafts.delete(threadId);
      autosize();
      preview.hidden = true;
      send_(threadId, text, mode());
    }
    ta.value = S.drafts.get(threadId) || '';
    ta.addEventListener('input', () => { S.drafts.set(threadId, ta.value); autosize(); updatePreview(); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); return; }
      if (e.key === 'Enter' && !e.shiftKey && mode() !== 'python' && !e.isComposing) { e.preventDefault(); submit(); return; }
      if (e.key === 'Tab' && mode() === 'python') {
        e.preventDefault();
        const s = ta.selectionStart;
        ta.setRangeText('    ', s, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
      }
    });
    modeBtns.forEach((bt) => bt.addEventListener('click', () => {
      S.modes.set(threadId, bt.dataset.mode);
      sync();
      updatePreview();
      ta.focus();
    }));
    send.addEventListener('click', submit);
    matrix.addEventListener('click', () => openMatrix(threadId));
    sync();
    requestAnimationFrame(autosize);
    return {
      root, ta, sync,
      insert(text) {
        const s = ta.selectionStart ?? ta.value.length;
        ta.setRangeText(text, s, ta.selectionEnd ?? s, 'end');
        ta.dispatchEvent(new Event('input'));
        ta.focus();
      },
    };
  }
  const send_ = (tid, text, mode) => send(tid, text, mode);

  function focusComposer(threadId) {
    const c = cols.get(threadId || S.board.openPath[S.board.openPath.length - 1]);
    if (c) c.composer.ta.focus();
  }

  // ------------------------------------------------------------ chrome: crumbs, outline
  function renderCrumbs() {
    const b = S.board;
    const items = [];
    b.openPath.forEach((id, i) => {
      if (i) items.push(el('span', { class: 'crumb-sep' }, '›'));
      const t = b.threads[id];
      items.push(el('button', { class: 'crumb' + (i === b.openPath.length - 1 ? ' current' : ''), 'data-act': 'crumb', 'data-idx': i, title: i ? t.title : b.title },
        i === 0 ? truncate(EE.util.texToText(b.title) || 'A fresh board', 36) : truncate(t.title, 30)));
    });
    dom.crumbs.replaceChildren(...items);
    dom.backBtn.disabled = b.openPath.length < 2;
  }

  function toggleOutline(force) {
    S.outlineOpen = typeof force === 'boolean' ? force : !S.outlineOpen;
    if (S.outlineOpen && S.learnerOpen) toggleLearner(false);
    if (S.outlineOpen && S.summaryOpen) toggleSummary(false);
    renderOutline();
  }

  function renderOutline() {
    dom.outline.hidden = !S.outlineOpen;
    dom.mapBtn.classList.toggle('on', S.outlineOpen);
    if (!S.outlineOpen) return;
    const b = S.board;
    const node = (t, depth) => {
      const kids = M.children(b, t.id);
      const label = depth === 0 ? EE.util.texToText(b.title) || 'A fresh board' : t.title;
      const li = el('li', {},
        el('button', { class: 'map-node' + (b.openPath.includes(t.id) ? ' on' : ''), 'data-act': 'map-open', 'data-thread': t.id },
          depth ? el('span', { class: 'map-quote' }, '“' + truncate(clean(t.anchor.quote), 26) + '” ') : null,
          el('span', {}, truncate(label, 54))));
      if (kids.length) li.append(el('ul', {}, kids.map((k) => node(k, depth + 1))));
      return li;
    };
    dom.outlineTree.replaceChildren(el('ul', { class: 'map-tree' }, node(b.threads.root, 0)));
  }

  // ------------------------------------------------------------ highlights + chalk overlay
  function applyHighlights() {
    if (!(window.CSS && CSS.highlights && window.Highlight)) return;
    const b = S.board;
    const idle = [], active = [], read = [];
    for (const c of cols.values()) {
      for (const [cardId, ce] of anchorables(c)) {
        const body = ce.querySelector(BODY);
        if (!body) continue;
        for (const { t, a } of M.piecesOn(b, cardId)) {
          const r = A.rangeFor(body, a);
          if (r) (b.openPath.includes(t.id) ? active : t.anchor.para != null ? read : idle).push(r);
        }
      }
    }
    CSS.highlights.set('ee-anchor', new Highlight(...idle));
    CSS.highlights.set('ee-anchor-active', new Highlight(...active));
    CSS.highlights.set('ee-read', new Highlight(...read));
  }

  /** Elements that can hold anchors in a column: its cards, plus the pages of a paper. */
  const anchorables = (c) => (c.pdf ? [...c.cards, ...c.pdf.pages] : c.cards);
  const anchorEl = (c, cardId) => c.cards.get(cardId) || (c.pdf && c.pdf.pages.get(cardId)) || null;

  let overlayQueued = false;
  function scheduleOverlay() {
    if (overlayQueued) return;
    overlayQueued = true;
    requestAnimationFrame(drawOverlay);
  }

  function roughLoop(cx, cy, rx, ry, seed) {
    const rnd = rng(seed);
    let d = '';
    for (let pass = 0; pass < 2; pass++) {
      const start = rnd() * Math.PI * 2;
      const sweep = Math.PI * 2 + 0.25 + rnd() * 0.35;
      const pts = [];
      const steps = 30;
      for (let k = 0; k <= steps; k++) {
        const a = start + (sweep * k) / steps;
        const j = 1 + (rnd() - 0.5) * 0.07 + (pass ? 0.03 : 0);
        pts.push([cx + rx * j * Math.cos(a), cy + ry * j * Math.sin(a)]);
      }
      d += `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
      for (let k = 1; k < pts.length - 1; k++) {
        const mx = (pts[k][0] + pts[k + 1][0]) / 2, my = (pts[k][1] + pts[k + 1][1]) / 2;
        d += `Q${pts[k][0].toFixed(1)},${pts[k][1].toFixed(1)} ${mx.toFixed(1)},${my.toFixed(1)}`;
      }
    }
    return d;
  }

  /** A chalk bracket down the left margin of a passage (the one being read). */
  function roughBracket(x, top, bot, seed) {
    const rnd = rng(seed ^ 0x51ed27);
    const j = () => (rnd() - 0.5) * 2.2;
    const f = (n) => n.toFixed(1);
    let d = '';
    for (let pass = 0; pass < 2; pass++) {
      const o = pass * 1.4;
      d += `M${f(x + 7 + j())},${f(top + j())} Q${f(x + o)},${f(top + o)} ${f(x + o + j())},${f(top + 9)}` +
        ` L${f(x + o + j())},${f(bot - 9)} Q${f(x + o)},${f(bot - o)} ${f(x + 7 + j())},${f(bot + j())}`;
    }
    return d;
  }

  /** Elbow connector: out of the circle, along the gutter between columns, into the branch tag. */
  function roughConnector(sx, sy, gx, tx, ty, seed) {
    const rnd = rng(seed ^ 0x9e3779b9);
    const j = () => (rnd() - 0.5) * 3;
    const r = Math.min(22, Math.abs(ty - sy) / 2, Math.max(4, (gx - sx) / 2));
    const dir = ty < sy ? -1 : 1;
    const f = (n) => n.toFixed(1);
    let d = `M${f(sx)},${f(sy)} L${f(gx - r)},${f(sy + j())}`;
    if (Math.abs(ty - sy) > 2 * r + 2) {
      d += ` Q${f(gx)},${f(sy)} ${f(gx + j())},${f(sy + dir * r)} L${f(gx + j())},${f(ty - dir * r)} Q${f(gx)},${f(ty)} ${f(gx + r)},${f(ty)}`;
    } else {
      d += ` L${f(gx + r)},${f(ty)}`;
    }
    d += ` L${f(tx)},${f(ty)}`;
    const head = `M${f(tx - 10)},${f(ty - 6)} L${f(tx)},${f(ty)} L${f(tx - 10)},${f(ty + 6)}`;
    return { line: d, head };
  }

  function drawOverlay() {
    overlayQueued = false;
    const b = S.board;
    if (!b) return;
    const st = dom.stage.getBoundingClientRect();
    const W = Math.max(dom.stage.scrollWidth, dom.stage.clientWidth);
    const H = dom.stage.clientHeight;
    dom.overlay.setAttribute('width', W);
    dom.overlay.setAttribute('height', H);
    dom.overlay.setAttribute('viewBox', `0 0 ${W} ${H}`);
    let svg = '';
    for (let i = 1; i < b.openPath.length; i++) {
      const t = b.threads[b.openPath[i]];
      if (!t || !t.anchor) continue;
      const pc = cols.get(b.openPath[i - 1]);
      const cc = cols.get(t.id);
      if (!pc || !cc || !cc.tag) continue;
      const tr = cc.tag.getBoundingClientRect();
      const tx = tr.left - st.left - 8;
      const ty = tr.top + tr.height / 2 - st.top;
      const vis = pc.body.getBoundingClientRect();
      const seed = hash(t.id);
      const clipId = 'clip' + i;
      svg += `<clipPath id="${clipId}"><rect x="${vis.left - st.left - 14}" y="${vis.top - st.top}" width="${vis.width + 28}" height="${vis.height}"/></clipPath>`;
      // each piece of the anchor (a passage has one per page, and per run of text); the link starts at the first in view
      const boxes = M.pieces(t.anchor).map((a) => {
        const ce = anchorEl(pc, a.cardId);
        const range = ce && A.rangeFor(ce.querySelector(BODY), a);
        return range ? [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1) : [];
      }).filter((rs) => rs.length);
      const inView = (rs) => Math.max(...rs.map((r) => r.bottom)) > vis.top && Math.min(...rs.map((r) => r.top)) < vis.bottom;
      if (t.anchor.para != null) {
        for (const rs of boxes.slice(1).filter(inView)) {
          const l = Math.min(...rs.map((r) => r.left)), top = Math.min(...rs.map((r) => r.top)), bot = Math.max(...rs.map((r) => r.bottom));
          svg += `<g clip-path="url(#${clipId})"><path class="chalk-loop" d="${roughBracket(l - st.left - 7, top - st.top - 3, bot - st.top + 3, seed + 1)}"/></g>`;
        }
      }
      const rects = boxes.find(inView) || boxes[0] || [];
      let sx, sy, dashed = false;
      if (rects.length) {
        const l = Math.min(...rects.map((r) => r.left)), r = Math.max(...rects.map((r) => r.right));
        const top = Math.min(...rects.map((r) => r.top)), bot = Math.max(...rects.map((r) => r.bottom));
        const cx = (l + r) / 2 - st.left, cy = (top + bot) / 2 - st.top;
        const rx = (r - l) / 2 + 10, ry = (bot - top) / 2 + 8;
        const visible = bot > vis.top && top < vis.bottom;
        if (visible && t.anchor.para != null) {
          svg += `<g clip-path="url(#${clipId})"><path class="chalk-loop" d="${roughBracket(l - st.left - 7, top - st.top - 3, bot - st.top + 3, seed)}"/></g>`;
          sx = r - st.left + 6;
          sy = Math.min(Math.max(cy, vis.top - st.top + 6), vis.bottom - st.top - 6);
        } else if (visible) {
          svg += `<g clip-path="url(#${clipId})"><path class="chalk-loop" d="${roughLoop(cx, cy, rx, ry, seed)}"/></g>`;
          sx = cx + rx;
          sy = Math.min(Math.max(cy, vis.top - st.top + 6), vis.bottom - st.top - 6);
        } else {
          dashed = true;
          sx = vis.right - st.left - 4;
          sy = (bot <= vis.top ? vis.top + 14 : vis.bottom - 14) - st.top;
        }
      } else {
        dashed = true;
        sx = vis.right - st.left - 4;
        sy = vis.top - st.top + 40;
      }
      const gx = cc.root.getBoundingClientRect().left - st.left - 15; // the dashed gutter line
      const { line, head } = roughConnector(sx, Math.max(sy, 4), gx, tx, ty, seed);
      svg += `<path class="chalk-link${dashed ? ' dashed' : ''}" d="${line}"/><path class="chalk-link" d="${head}"/>`;
    }
    dom.overlay.innerHTML = svg;
  }

  // ------------------------------------------------------------ scrolling
  function revealColumn(threadId, smooth = true) {
    const c = cols.get(threadId);
    if (!c) return;
    const cr = c.root.getBoundingClientRect();
    const br = dom.board.getBoundingClientRect();
    const behavior = smooth ? 'smooth' : 'auto';
    if (cr.right + 20 > br.right) dom.board.scrollBy({ left: cr.right + 20 - br.right, behavior });
    else if (cr.left < br.left) dom.board.scrollBy({ left: cr.left - br.left - 20, behavior });
    setTimeout(scheduleOverlay, 400);
  }
  function scrollColumnToBottom(threadId, smooth) {
    const c = cols.get(threadId);
    if (c) requestAnimationFrame(() => c.body.scrollTo({ top: c.body.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }));
  }

  // ------------------------------------------------------------ selection popover
  function showPopover(anchor, range) {
    S.pending = { anchor, range };
    const chips = isPaperCard(anchor.cardId) ? PAPER_CHIPS : CHIPS;
    if (dom.popChips._set !== chips) {
      dom.popChips._set = chips;
      dom.popChips.replaceChildren(...chips.map((c) => el('button', { class: 'chip' + (c.mode === 'compute' ? ' compute' : '') + (c.read ? ' read' : ''),
        onclick: () => (c.read ? readFrom(S.pending && S.pending.anchor) : submitPopover(c.q, c.mode)) }, c.q)));
    }
    if (window.CSS && CSS.highlights && window.Highlight) CSS.highlights.set('ee-pending', new Highlight(range));
    dom.popQuote.textContent = '“' + truncate(clean(anchor.quote), 140) + '”';
    dom.popInput.value = '';
    dom.popover.hidden = false;
    const rect = range.getBoundingClientRect();
    const pw = dom.popover.offsetWidth, ph = dom.popover.offsetHeight;
    let left = Math.min(Math.max(12, rect.left + rect.width / 2 - pw / 2), innerWidth - pw - 12);
    let top = rect.bottom + 12;
    if (top + ph > innerHeight - 12) top = Math.max(12, rect.top - ph - 12);
    dom.popover.style.left = left + 'px';
    dom.popover.style.top = top + 'px';
    setTimeout(() => dom.popInput.focus({ preventScroll: true }), 0);
  }
  function hidePopover() {
    if (dom.popover) dom.popover.hidden = true;
    S.pending = null;
    if (window.CSS && CSS.highlights) CSS.highlights.delete('ee-pending');
  }
  function submitPopover(question, mode = 'explain') {
    if (!S.pending || !question.trim()) return;
    askAbout(S.pending.anchor, question, mode);
  }

  function selectionToAnchor() {
    const sel = getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0).cloneRange();
    const sb = elOf(range.startContainer) && elOf(range.startContainer).closest(BODY);
    if (!sb) return null;
    const eb = elOf(range.endContainer) && elOf(range.endContainer).closest(BODY);
    if (eb !== sb) range.setEnd(sb, sb.childNodes.length); // e.g. triple-click spilling past the card (or the page)
    const cardId = sb.closest('[data-card]').dataset.card;
    const anchor = A.capture(sb, range, cardId);
    return anchor ? { anchor, range } : null;
  }

  function anchorAtPoint(x, y) {
    const pos = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
    if (!pos) return null;
    const body = elOf(pos.startContainer) && elOf(pos.startContainer).closest(BODY);
    if (!body) return null;
    const cardId = body.closest('[data-card]').dataset.card;
    // a passage highlighted inside the one being read wins over it
    const ps = M.piecesOn(S.board, cardId).sort((x, y) => (x.t.anchor.para != null) - (y.t.anchor.para != null));
    for (const { t, a } of ps) {
      const r = A.rangeFor(body, a);
      if (r && r.isPointInRange(pos.startContainer, pos.startOffset)) return t.id;
    }
    return null;
  }

  // ------------------------------------------------------------ dialogs
  function modal(content, cls = '') {
    const card = el('div', { class: 'modal-card ' + cls }, content);
    dom.modal.replaceChildren(card);
    dom.modal.hidden = false;
    const close = () => { dom.modal.hidden = true; dom.modal.replaceChildren(); };
    dom.modal.onclick = (e) => { if (e.target === dom.modal) close(); };
    return close;
  }
  const modalOpen = () => !dom.modal.hidden;

  function confirmDialog(message, okLabel = 'OK') {
    return new Promise((resolve) => {
      let close;
      const done = (v) => { close(); resolve(v); };
      const ok = el('button', { class: 'chalk-btn danger', onclick: () => done(true) }, okLabel);
      close = modal(el('div', {},
        el('p', { class: 'modal-msg' }, message),
        el('div', { class: 'modal-actions' }, el('button', { class: 'chalk-btn', onclick: () => done(false) }, 'Keep it'), ok)));
      ok.focus();
    });
  }

  function promptDialog(message, value, okLabel = 'OK') {
    return new Promise((resolve) => {
      let close;
      const input = el('input', { class: 'chalk-input', value: value || '' });
      const done = (v) => { close(); resolve(v); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value); });
      close = modal(el('div', {},
        el('p', { class: 'modal-msg' }, message), input,
        el('div', { class: 'modal-actions' }, el('button', { class: 'chalk-btn', onclick: () => done(null) }, 'Cancel'),
          el('button', { class: 'chalk-btn primary', onclick: () => done(input.value) }, okLabel))));
      setTimeout(() => { input.focus(); input.select(); }, 0);
    });
  }

  const MATRIX_PRESETS = {
    I: [['1', '0'], ['0', '1']],
    X: [['0', '1'], ['1', '0']],
    Y: [['0', '-i'], ['i', '0']],
    Z: [['1', '0'], ['0', '-1']],
    H: [['\\tfrac{1}{\\sqrt{2}}', '\\tfrac{1}{\\sqrt{2}}'], ['\\tfrac{1}{\\sqrt{2}}', '-\\tfrac{1}{\\sqrt{2}}']],
    S: [['1', '0'], ['0', 'i']],
    T: [['1', '0'], ['0', 'e^{i\\pi/4}']],
    CNOT: [['1', '0', '0', '0'], ['0', '1', '0', '0'], ['0', '0', '0', '1'], ['0', '0', '1', '0']],
  };

  function openMatrix(threadId) {
    threadId = threadId || S.board.openPath[S.board.openPath.length - 1];
    let rows = 2, colsN = 2;
    let cells = [['1', '0'], ['0', '1']];
    const name = el('input', { class: 'chalk-input mx-name', placeholder: 'name (optional), e.g. U', value: '' });
    const kind = el('select', { class: 'chalk-input mx-kind' },
      ['pmatrix', 'bmatrix', 'vmatrix'].map((k) => el('option', { value: k }, { pmatrix: '( )', bmatrix: '[ ]', vmatrix: '| | det' }[k])));
    const grid = el('div', { class: 'mx-grid' });
    const preview = el('div', { class: 'mx-preview' });
    const rowsIn = el('input', { type: 'number', min: 1, max: 8, value: rows, class: 'chalk-input mx-dim' });
    const colsIn = el('input', { type: 'number', min: 1, max: 8, value: colsN, class: 'chalk-input mx-dim' });
    const tex = () => {
      const body = cells.map((r) => r.map((x) => x.trim() || '0').join(' & ')).join(' \\\\ ');
      const m = `\\begin{${kind.value}} ${body} \\end{${kind.value}}`;
      return name.value.trim() ? `${name.value.trim()} = ${m}` : m;
    };
    const refresh = () => { preview.innerHTML = R.katexHTML(tex(), true); };
    const build = () => {
      cells = Array.from({ length: rows }, (_, r) => Array.from({ length: colsN }, (_, c) => (cells[r] && cells[r][c]) || '0'));
      grid.style.gridTemplateColumns = `repeat(${colsN}, minmax(54px, 1fr))`;
      grid.replaceChildren(...cells.flatMap((row, r) => row.map((v, c) => {
        const inp = el('input', { class: 'chalk-input mx-cell', value: v });
        inp.addEventListener('input', () => { cells[r][c] = inp.value; refresh(); });
        return inp;
      })));
      refresh();
    };
    const setDims = () => {
      rows = Math.min(8, Math.max(1, Number(rowsIn.value) || 1));
      colsN = Math.min(8, Math.max(1, Number(colsIn.value) || 1));
      build();
    };
    rowsIn.addEventListener('input', setDims);
    colsIn.addEventListener('input', setDims);
    name.addEventListener('input', refresh);
    kind.addEventListener('change', refresh);
    const presets = el('div', { class: 'mx-presets' }, Object.keys(MATRIX_PRESETS).map((k) =>
      el('button', { class: 'chip', onclick: () => {
        cells = MATRIX_PRESETS[k].map((r) => r.slice());
        rows = cells.length; colsN = cells[0].length;
        rowsIn.value = rows; colsIn.value = colsN;
        if (!name.value.trim()) name.value = k === 'I' ? 'I' : k;
        build();
      } }, k)));
    let close;
    const insert = () => {
      const c = cols.get(threadId);
      if (c) c.composer.insert(`$$${tex()}$$`);
      close();
    };
    close = modal(el('div', {},
      el('h2', { class: 'chalk-title modal-title' }, 'Write a matrix'),
      el('div', { class: 'mx-row' }, rowsIn, el('span', {}, '×'), colsIn, kind, name),
      presets, grid, preview,
      el('div', { class: 'modal-actions' },
        el('button', { class: 'chalk-btn', onclick: () => close() }, 'Cancel'),
        el('button', { class: 'chalk-btn primary', onclick: insert }, 'Put it on the board'))), 'modal-wide');
    build();
  }

  function openLens(displayEl) {
    const k = displayEl.querySelector('.katex');
    if (!k) return;
    const tex = A.texOf(k);
    let scale = 2.2;
    const math = el('div', { class: 'lens-math', html: R.katexHTML(tex, true) });
    const apply = () => { math.style.fontSize = scale + 'em'; };
    let close;
    const ask = () => {
      close();
      const body = displayEl.closest('.card-body');
      const r = document.createRange();
      r.selectNodeContents(displayEl);
      const anchor = A.capture(body, r, body.closest('.card').dataset.card);
      if (anchor) showPopover(anchor, r);
    };
    close = modal(el('div', {},
      el('div', { class: 'lens-stage' }, math),
      el('div', { class: 'modal-actions' },
        el('button', { class: 'chalk-btn', onclick: () => { scale = Math.max(1, scale - 0.4); apply(); } }, '−'),
        el('button', { class: 'chalk-btn', onclick: () => { scale = Math.min(6, scale + 0.4); apply(); } }, '+'),
        el('span', { class: 'spacer' }),
        el('button', { class: 'chalk-btn primary', onclick: ask }, 'ask about this equation ↳'),
        el('button', { class: 'chalk-btn', onclick: () => close() }, 'close'))), 'modal-lens');
    apply();
  }

  async function showConfig() {
    await refreshConfig();
    const c = S.config || {};
    const row = (k, v) => el('div', { class: 'cfg-row' }, el('span', { class: 'cfg-k' }, k), el('span', { class: 'cfg-v' }, v || '–'));
    let close;
    close = modal(el('div', {},
      el('h2', { class: 'chalk-title modal-title' }, 'Model & runtime'),
      row('provider', c.provider), row('model', c.model), row('endpoint', c.baseURL), row('.env file', c.envFile || 'not found, using defaults'),
      row('python', c.python), row('packages', c.packages),
      row('diagrams', 'drawn by the same model'),
      (c.problems || []).length ? el('div', { class: 'cfg-problems' }, c.problems.map((p) => el('div', {}, '⚠ ' + p))) : null,
      el('p', { class: 'muted small' }, 'Edit the .env file and click refresh. Keys: LLM_PROVIDER (openrouter | lmstudio), OPENROUTER_API_KEY, OPENROUTER_MODEL, LMSTUDIO_BASE_URL, LMSTUDIO_MODEL. The menu at the top right switches between every model .env names; add more with OPENROUTER_MODELS or LMSTUDIO_MODELS (comma-separated).'),
      el('div', { class: 'modal-actions' },
        B.isNative ? el('button', { class: 'chalk-btn', onclick: () => B.call('openEnv').catch((e) => toast(e.message, 'error')) }, 'open .env') : null,
        el('button', { class: 'chalk-btn', onclick: async () => { close(); await showConfig(); } }, 'refresh'),
        el('button', { class: 'chalk-btn primary', onclick: () => close() }, 'close'))));
  }

  async function refreshConfig() {
    const lsProblems = (c) => (c && c.levelset && c.levelset.problems) || [];
    const before = lsProblems(S.config);
    const local = isConfidential(S.board);
    try {
      S.configLoading = true;
      S.config = await B.call('config', local ? { llm: S.localLlm, local } : { llm: S.llm });
    } catch (e) {
      S.config = { problems: [e.message], local };
    } finally {
      S.configLoading = false;
    }
    const c = S.config;
    // a level-set warning that came from .env goes away once .env is fixed
    if (S.ls.error && before.includes(S.ls.error) && !lsProblems(c).includes(S.ls.error)) S.ls.error = null;
    const bad = (c.problems || []).length > 0;
    dom.status.classList.toggle('bad', bad);
    dom.status.title = (c.local ? 'Confidential board: LM Studio only\n' : '') + (bad ? c.problems.join('\n') : `${c.provider} · ${c.model}\n${c.baseURL}`);
    dom.status.classList.toggle('local', !!c.local);
    renderModelMenu(c);
    // the board may have changed sides while this was loading
    if (local !== isConfidential(S.board)) refreshConfig();
  }

  /** The top-right menu: every model .env names; the picked one answers new questions and summaries.
   *  On a confidential board only the LM Studio models (or LM Studio's loaded model, when .env names none). */
  function renderModelMenu(c) {
    const short = (m) => truncate(m.replace(/^[^/]+\//, ''), 30); // drop the "org/" prefix
    const label = (ch) => (c.local ? '🔒 ' : '') + `${ch.provider} · ${ch.model ? short(ch.model) : 'loaded model'}`;
    let choices = c.choices || [];
    if (c.local) {
      choices = choices.filter((ch) => ch.id.startsWith('lmstudio|'));
      if (!choices.some((ch) => ch.id === c.llm)) choices = [{ id: c.llm, provider: c.provider, model: '' }, ...choices];
    }
    const opts = choices.length
      ? choices.map((ch) => el('option', { value: ch.id, title: `${ch.provider} · ${ch.model || 'whichever model is loaded'}` }, label(ch)))
      : [el('option', { value: '' }, c.provider ? `${c.provider} · ${truncate(c.model || 'auto', 28)}` : 'no model')];
    if (B.isNative) opts.push(el('option', { value: MORE_MODELS }, 'more models…'));
    dom.modelSelect.replaceChildren(...opts);
    dom.modelSelect.value = c.llm || '';
    // LM Studio's loaded model, resolved for this request, shows in the label when .env leaves it blank
    const cur = choices.find((ch) => ch.id === c.llm);
    if (cur && !cur.model && c.model && c.model !== 'auto') dom.modelSelect.selectedOptions[0].textContent = (c.local ? '🔒 ' : '') + `${cur.provider} · ${short(c.model)}`;
  }

  const MORE_MODELS = '__more__';
  function onModelMenu() {
    const id = dom.modelSelect.value;
    if (id !== MORE_MODELS) { pickModel(id); return; }
    dom.modelSelect.value = (S.config && S.config.llm) || '';
    openSourcePanel();
  }

  async function pickModel(id) {
    const local = isConfidential(S.board);
    if (local) S.localLlm = id; else S.llm = id;
    try { localStorage.setItem(local ? 'ee.llm.local' : 'ee.llm', id); } catch (e) { /* storage may be unavailable */ }
    await refreshConfig();
    const c = S.config || {};
    toast(local ? `New questions on confidential boards go to ${c.provider} · ${c.model}.` : `New questions go to ${c.provider} · ${c.model}.`);
    if (S.summaryOpen) renderSummary(true);
    renderRecap(true);
  }

  let toastTimer = null;
  function toast(text, kind = '') {
    dom.toast.textContent = text;
    dom.toast.className = 'toast ' + kind;
    dom.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { dom.toast.hidden = true; }, kind === 'error' ? 6000 : 3500);
  }

  // ------------------------------------------------------------ fonts & text size (the Aa panel)
  const ZOOM = { min: 0.6, max: 2, step: 0.05 };
  function setFont(name) {
    document.documentElement.style.setProperty('--font-hand', `"${name}", "Chalkboard SE", "Patrick Hand", cursive`);
    try { localStorage.setItem('ee.font', name); } catch (e) { /* storage may be unavailable */ }
    dom.fontBtn.title = 'Chalk font: ' + name;
    scheduleOverlay();
  }
  function currentFont() {
    let cur = DEFAULT_FONT;
    try { cur = localStorage.getItem('ee.font') || cur; } catch (e) { /* ignore */ }
    return FONTS.includes(cur) ? cur : DEFAULT_FONT;
  }
  function rememberZoom(z) { try { localStorage.setItem('ee.zoom', String(z)); } catch (e) { /* ignore */ } }
  function savedZoom() {
    try { const z = Number(localStorage.getItem('ee.zoom')); return z >= ZOOM.min && z <= ZOOM.max ? z : 1; } catch (e) { return 1; }
  }
  /** zoom('in' | 'out' | 'reset') or zoom(null, level): the native page zoom, or body zoom in the harness. */
  async function zoom(dir, level) {
    let z;
    if (B.isNative) {
      const r = await B.call('zoom', level != null ? { level } : { dir }).catch(() => null);
      z = r && typeof r.zoom === 'number' ? r.zoom : savedZoom();
    } else {
      z = level != null ? level : dir === 'reset' ? 1 : Number(document.body.style.zoom || 1) + (dir === 'in' ? 0.1 : -0.1);
      z = Math.round(Math.min(ZOOM.max, Math.max(ZOOM.min, z)) * 100) / 100;
      document.body.style.zoom = z;
    }
    rememberZoom(z);
    setTimeout(scheduleOverlay, 60);
    return z;
  }

  // one dropdown panel at a time, under a top-bar button; clicking the button again closes it
  let dropdownAnchor = null, dropdownClose = null;
  function closeDropdown(anchor) {
    const same = dropdownAnchor === anchor;
    if (dropdownClose) dropdownClose();
    return same;
  }
  function dropdown(anchor, content) {
    const box = dom.dropdown;
    box.replaceChildren(content);
    box.hidden = false;
    const r = anchor.getBoundingClientRect();
    box.style.top = `${r.bottom + 6}px`;
    box.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    const onDown = (e) => { if (!box.contains(e.target) && !anchor.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const close = () => {
      if (dropdownClose !== close) return;
      box.hidden = true; box.replaceChildren();
      anchor.classList.remove('on');
      dropdownAnchor = null; dropdownClose = null;
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    anchor.classList.add('on');
    dropdownAnchor = anchor; dropdownClose = close;
    return close;
  }

  function openFontPanel() {
    if (closeDropdown(dom.fontBtn)) return;
    const cur = currentFont();
    const faces = el('div', { class: 'pop-faces' }, FONTS.map((f) => el('button', {
      class: 'pop-face' + (f === cur ? ' on' : ''), style: `font-family: "${f}", cursive`, title: f,
      onclick: (e) => { setFont(f); [...faces.children].forEach((b) => b.classList.toggle('on', b === e.currentTarget)); },
    }, f)));
    const value = el('span', { class: 'pop-value' });
    const slider = el('input', { type: 'range', class: 'pop-slider', min: ZOOM.min, max: ZOOM.max, step: ZOOM.step, value: savedZoom(), 'aria-label': 'Text size' });
    const show = (z) => { value.textContent = Math.round(z * 100) + '%'; };
    show(Number(slider.value));
    let pending = null;
    slider.addEventListener('input', () => {
      show(Number(slider.value));
      clearTimeout(pending);
      pending = setTimeout(() => zoom(null, Number(slider.value)), 40);
    });
    const nudge = (dir) => async () => { const z = await zoom(dir); slider.value = z; show(z); };
    dropdown(dom.fontBtn, el('div', {},
      el('div', { class: 'pop-title' }, 'chalk'), faces,
      el('div', { class: 'pop-title' }, 'text size'),
      el('div', { class: 'pop-row' },
        el('button', { class: 'top-btn', title: kbd('Smaller (⌘−)'), onclick: nudge('out') }, '−'),
        slider,
        el('button', { class: 'top-btn', title: kbd('Larger (⌘=)'), onclick: nudge('in') }, '+'),
        value),
      el('div', { class: 'pop-actions' }, el('button', { class: 'linkish', title: kbd('⌘0'), onclick: nudge('reset') }, 'actual size'))));
  }

  // the model source for explanations: pick a source and model, saved to .env (level-set and diagrams keep theirs)
  async function openSourcePanel() {
    if (closeDropdown(dom.status)) return;
    let data;
    try { data = await B.call('llmSources'); } catch (e) { showConfig(); return; } // the harness has no picker
    let chosen = (data.current || {}).provider;
    const rows = new Map();
    const render = () => rows.forEach((r, p) => { r.row.classList.toggle('on', p === chosen); r.radio.checked = p === chosen; r.modelRow.hidden = p !== chosen; });
    const loadModels = async (p) => {
      const r = rows.get(p);
      if (!r || r.loaded) return;
      r.loaded = true;
      r.hint.textContent = 'listing…';
      try {
        const { models } = await B.call('listModels', { provider: p });
        r.list.replaceChildren(...models.map((m) => el('option', { value: m })));
        r.hint.textContent = models.length ? `${models.length} listed` : 'none listed';
      } catch (e) {
        r.hint.textContent = 'not reachable';
        r.hint.title = e.message;
      }
    };
    for (const src of data.sources || []) {
      const radio = el('input', { type: 'radio', name: 'llm-source', value: src.provider });
      const list = el('datalist', { id: 'models-' + src.provider });
      const input = el('input', {
        type: 'text', list: list.id, value: src.model || '', spellcheck: 'false', autocomplete: 'off',
        placeholder: src.defaultModel || (src.provider === 'lmstudio' ? 'the loaded model' : 'model id'),
      });
      const hint = el('span', { class: 'hint' });
      const tag = src.provider === 'openrouter' && !src.hasKey ? 'no API key in .env'
        : src.provider === 'custom' && !src.configured ? 'LLM_BASE_URL not set' : '';
      const modelRow = el('div', { class: 'pop-src-model', hidden: true }, input, list, hint);
      const row = el('label', { class: 'pop-src' }, radio,
        el('div', { class: 'pop-src-body' },
          el('div', { class: 'pop-src-name' }, src.name, tag ? el('span', { class: 'tag' }, tag) : null),
          el('div', { class: 'pop-src-url' }, src.baseURL),
          modelRow));
      radio.addEventListener('change', () => { chosen = src.provider; render(); loadModels(src.provider); });
      rows.set(src.provider, { row, radio, modelRow, input, list, hint, loaded: false });
    }
    let close;
    const apply = async () => {
      const r = rows.get(chosen);
      try {
        await B.call('setLLM', { provider: chosen, model: r ? r.input.value.trim() : '' });
        close();
        await pickModel('');  // the menu's default is now what .env says
      } catch (e) {
        toast(e.message, 'error');
      }
    };
    rows.forEach((r) => r.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); }));
    close = dropdown(dom.status, el('div', {},
      el('div', { class: 'pop-title' }, 'model source for explanations and summaries'),
      [...rows.values()].map((r) => r.row),
      el('div', { class: 'pop-actions' },
        el('button', { class: 'linkish', onclick: () => { close(); showConfig(); } }, 'details'),
        B.isNative ? el('button', { class: 'linkish', onclick: () => B.call('openEnv').catch((e) => toast(e.message, 'error')) }, 'open .env') : null,
        el('span', { class: 'spacer' }),
        el('button', { class: 'chalk-btn primary', onclick: apply }, 'use')),
      el('p', { class: 'pop-note' }, `Saved to ${data.envFile || '.env'} as the default; API keys and endpoints are edited there. ` +
        'The menu keeps every model .env names for quick switching.')));
    render();
    if (chosen) loadModels(chosen);
  }

  // ------------------------------------------------------------ learner model: level-set + profile
  function allBoards() {
    const m = new Map(S.library);
    if (S.board && !isEmpty(S.board)) m.set(S.board.id, S.board);
    return [...m.values()];
  }

  function evidenceState() {
    const items = M.evidence(shareable(allBoards()));
    const hash = M.evidenceHash(items, S.notes);
    const stale = !!items.length && (!S.profile || !S.profile.meta || S.profile.meta.hash !== hash);
    return { items, hash, stale };
  }

  async function maybeAutoLevelSet() {
    await refreshConfig(); // .env may have changed since launch (a key added, say)
    const problems = (S.config && S.config.levelset && S.config.levelset.problems) || [];
    if (problems.length) { S.ls.error = problems[0]; updateLevelChip(); return; }
    if (!S.ls.running) S.ls.error = null;
    updateLevelChip();
    levelSet({ force: false });
  }

  /** Holistic reassessment across every board, on the level-set model (OpenRouter by default). */
  function levelSet({ force = false, open = false } = {}) {
    if (S.ls.running) { if (open) showProfile(); return; }
    const { messages, items } = M.levelSetMessages(shareable(allBoards()), S.profile, S.notes);
    if (!items.length) { if (open) showProfile(); return; }
    const hash = M.evidenceHash(items, S.notes);
    const notesRead = S.notes.length;
    if (!force && S.profile && S.profile.meta && S.profile.meta.hash === hash) return;
    S.ls = { running: true, error: null, startedAt: Date.now(), open };
    updateLevelChip();
    refreshConfig().then(updateLevelChip);
    if (open) showProfile();
    let text = '';
    const fail = (msg) => {
      S.ls = { running: false, error: msg };
      updateLevelChip();
      toast('Level-set failed: ' + msg, 'error');
      if (open || profileOpen()) showProfile();
    };
    B.chat(messages, {
      onChunk({ content }) { text += content; },
      async onDone({ model, cancelled }) {
        if (cancelled) { S.ls = { running: false, error: null }; updateLevelChip(); return; }
        let p;
        try { p = M.parseProfile(text); } catch (e) { fail(e.message); return; }
        p.meta = {
          updatedAt: Date.now(), model: model || '', hash, questions: items.length,
          rated: items.filter((i) => i.rated).length, boards: new Set(items.map((i) => i.boardId)).size, notes: notesRead,
        };
        try { await B.call('saveProfile', { json: JSON.stringify(p, null, 2) }); } catch (e) { fail('could not save the profile: ' + e.message); return; }
        S.profile = p;
        S.ls = { running: false, error: null };
        updateLevelChip();
        toast(`Level-set: overall ${p.overall.level}/10 across ${p.topics.length} topics. Explanations will adapt.`);
        if (open || profileOpen()) showProfile();
      },
      onError(err) { fail(err.message); },
    }, { purpose: 'levelset' });
  }

  function updateLevelChip() {
    if (!dom.levelBtn) return;
    const p = S.profile;
    const { stale } = evidenceState();
    dom.levelBtn.textContent = p ? `level ${p.overall.level}/10` : 'level ?';
    dom.levelBtn.classList.toggle('stale', stale && !S.ls.running);
    dom.levelBtn.title = (p ? `Where you stand (assessed ${EE.util.relTime(p.meta.updatedAt)})` : 'No assessment yet') +
      (stale ? '\nNew questions, ratings or notes since then' : '') + (S.ls.error ? '\n⚠ ' + S.ls.error : '');
    dom.levelsetBtn.disabled = S.ls.running;
    dom.levelsetBtn.replaceChildren(S.ls.running ? el('span', { class: 'chalk-dots' }, 'assessing') : '⟳ level-set');
    if (S.learnerOpen) renderLearner();
    updateLessonsBtn();
    updateRecapBtn();
  }

  const profileOpen = () => S.learnerOpen;
  const showProfile = () => toggleLearner(true);

  /** The "where you stand" drawer: profile, the student's private notes, and what the model is told. */
  function toggleLearner(force) {
    S.learnerOpen = typeof force === 'boolean' ? force : !S.learnerOpen;
    if (S.learnerOpen && S.outlineOpen) toggleOutline(false);
    if (S.learnerOpen && S.summaryOpen) toggleSummary(false);
    dom.learner.hidden = !S.learnerOpen;
    document.body.classList.toggle('learner-open', S.learnerOpen);
    dom.levelBtn.classList.toggle('on', S.learnerOpen);
    if (S.learnerOpen) {
      renderLearner();
      refreshConfig().then(updateLevelChip);
    }
    if (S.board) requestAnimationFrame(() => revealColumn(S.board.openPath[S.board.openPath.length - 1], false));
  }

  function renderLearner() {
    const p = S.profile;
    const cfg = (S.config && S.config.levelset) || {};
    const { items, stale } = evidenceState();
    const rated = items.filter((i) => i.rated).length;
    const tone = (m) => (m <= 3 ? 'lo' : m <= 6 ? 'mid' : 'hi');
    const bar = (m) => el('span', { class: 'mbar' }, el('span', { class: 'mfill ' + tone(m), style: `width:${m * 10}%` }));
    const recapTag = (m) => (m <= 3 ? 'recap' : m <= 6 ? 'reminder' : m <= 8 ? 'name only' : 'known');
    const body = [];
    if (p) {
      body.push(el('div', { class: 'lvl-row' }, el('span', { class: 'lvl-big chalk-title' }, `${p.overall.level}/10`), bar(p.overall.level)));
      if (p.overall.summary) body.push(el('p', { class: 'lvl-summary' }, p.overall.summary));
      if (p.overall.pitch) body.push(el('p', { class: 'muted small' }, 'Tutoring needs, how explanations are pitched: ' + p.overall.pitch));
      if (p.topics.length) {
        body.push(el('div', { class: 'topic-list' }, p.topics.slice().sort((a, b) => a.mastery - b.mastery).map((t) =>
          el('div', { class: 'topic-row', title: t.evidence || '' },
            el('span', { class: 'topic-name' }, t.name), bar(t.mastery),
            el('span', { class: 'topic-score' }, `${t.mastery}/10`),
            el('span', { class: 'topic-recap ' + tone(t.mastery) }, recapTag(t.mastery))))));
      }
      if (p.reinforce.length) body.push(el('p', { class: 'small' }, el('span', { class: 'muted' }, 'reinforce when relevant: '), p.reinforce.join(' · ')));
      body.push(el('p', { class: 'muted small' },
        `Assessed ${EE.util.relTime(p.meta.updatedAt)}${p.meta.model ? ' by ' + p.meta.model : ''} from ${p.meta.questions} questions on ${p.meta.boards} board${p.meta.boards === 1 ? '' : 's'} (${p.meta.rated} rated, unrated ones count as 1).`));
      if (stale) body.push(el('p', { class: 'small warn' }, 'New questions, ratings or notes since then. They already shape new explanations; a level-set folds them into the profile.'));
    } else {
      body.push(el('p', { class: 'small' }, items.length
        ? `No assessment yet. ${items.length} earlier question${items.length === 1 ? '' : 's'} (${rated} rated; unrated ones count as 1) will be assessed.`
        : 'No assessment yet. Ask a few questions and rate how well each answer sank in.'));
    }
    if (S.ls.running) body.push(el('p', { class: 'small' }, el('span', { class: 'chalk-dots' }, `assessing with ${cfg.model || 'the level-set model'}`)));
    const problems = [S.ls.error, ...(cfg.problems || [])].filter((x, i, a) => x && a.indexOf(x) === i);
    if (problems.length) body.push(el('div', { class: 'cfg-problems' }, problems.map((x) => el('div', {}, '⚠ ' + x))));
    body.push(el('p', { class: 'muted small' }, `Level-set model: ${cfg.provider || 'OpenRouter'} · ${cfg.model || 'openai/gpt-5.6-sol-pro'} (LEVELSET_MODEL in .env). It runs on its own whenever you start a new board.`));
    const run = el('button', { class: 'chalk-btn primary small', onclick: () => levelSet({ force: true, open: true }) }, S.ls.running ? 'assessing…' : 'level-set now');
    if (S.ls.running || !items.length) run.disabled = true;
    body.push(el('div', { class: 'modal-actions' }, run));
    dom.learnerProfile.replaceChildren(...body);

    const notes = S.notes.slice().sort((a, b) => b.createdAt - a.createdAt);
    dom.noteList.replaceChildren(...(notes.length ? notes.map((n) => el('div', { class: 'note' + (S.editingNote === n.id ? ' editing' : ''), 'data-note': n.id },
      el('div', { class: 'note-text' }, n.text),
      el('div', { class: 'note-meta' },
        el('span', {}, new Date(n.createdAt).toLocaleDateString() + (n.updatedAt > n.createdAt + 1000 ? ' · edited' : '')),
        el('button', { class: 'link-btn', onclick: () => editNote(n.id) }, 'edit'),
        el('button', { class: 'link-btn danger', onclick: () => removeNote(n.id) }, 'remove'))))
      : [el('p', { class: 'muted small' }, 'No notes yet.')]));

    const ctx = learnerContext(S.board || M.newBoard(), null);
    dom.learnerPrompt.textContent = M.learnerSection(ctx).trim();
    dom.learnerBase.textContent = M.SYSTEM;
  }

  // ------------------------------------------------------------ the student's private notes
  async function saveNotes() {
    try {
      await B.call('saveNotes', { json: JSON.stringify({ version: 1, notes: S.notes }, null, 2) });
      return true;
    } catch (e) {
      toast('Could not save your notes: ' + e.message, 'error');
      return false;
    }
  }

  async function submitNote() {
    const text = dom.noteInput.value.trim();
    if (!text) { dom.noteInput.focus(); return; }
    const now = Date.now();
    const n = S.editingNote && S.notes.find((x) => x.id === S.editingNote);
    if (n) { n.text = text; n.updatedAt = now; } else S.notes.push({ id: uid('n'), text, createdAt: now, updatedAt: now });
    if (!(await saveNotes())) return;
    toast(n ? 'Note updated. The next explanation follows it.' : 'Noted. The next explanation follows it.');
    resetNoteInput();
    updateLevelChip();
  }

  function editNote(id) {
    const n = S.notes.find((x) => x.id === id);
    if (!n) return;
    S.editingNote = id;
    dom.noteInput.value = n.text;
    dom.noteSave.textContent = 'save note';
    dom.noteCancel.hidden = false;
    renderLearner();
    dom.noteInput.focus();
  }

  function resetNoteInput() {
    S.editingNote = null;
    dom.noteInput.value = '';
    dom.noteSave.textContent = 'add note';
    dom.noteCancel.hidden = true;
    if (S.learnerOpen) renderLearner();
  }

  async function removeNote(id) {
    const n = S.notes.find((x) => x.id === id);
    if (!n || !(await confirmDialog(`Remove this note? “${truncate(n.text, 160)}”`, 'Remove'))) return;
    S.notes = S.notes.filter((x) => x.id !== id);
    if (S.editingNote === id) resetNoteInput();
    await saveNotes();
    updateLevelChip();
  }

  // ------------------------------------------------------------ board summary
  const hasAnswer = (board) => Object.values(board.threads).some((t) => t.cards.some((c) =>
    c.role === 'assistant' && c.status !== 'streaming' && c.status !== 'error' && R.splitThink(c.text).body.trim()));

  /** The saved summary against the board as it is now: how many questions it has not seen yet. */
  function summaryState(board) {
    const qs = M.boardQuestions(board).list;
    const sum = board.summary;
    const seen = new Set(sum ? Object.values(sum.refs || {}).map((r) => r.cardId) : []);
    return { questions: qs.length, sides: qs.filter((q) => q.side).length, fresh: sum ? qs.filter((q) => !seen.has(q.cardId)).length : 0 };
  }

  /** A high-level recap of the whole board (main question, follow-ups, every side question), saved with it. */
  function writeSummary(board = S.board) {
    const busy = board && S.sums.get(board.id);
    if (!board || (busy && busy.running) || !hasAnswer(board)) return;
    const { messages, refs, questions, sides } = M.summaryMessages(board, S.notes, paperOf(board));
    const job = { running: true, text: '', reasoning: '', error: null, refs, cancel: null };
    S.sums.set(board.id, job);
    renderSummary(true);
    const h = B.chat(messages, {
      onChunk({ content, reasoning }) {
        job.text += content;
        if (reasoning) job.reasoning += reasoning;
        if (board === S.board) scheduleSummary();
      },
      onDone({ model, cancelled }) {
        job.running = false;
        const text = R.splitThink(job.text).body.trim();
        if (cancelled) {
          S.sums.delete(board.id); // the saved summary, if any, stays
        } else if (!text) {
          job.error = job.reasoning || R.splitThink(job.text).think
            ? 'The model only produced scratch work (it may have hit the token limit). Try again or raise LLM_MAX_TOKENS.'
            : 'The model returned an empty summary.';
        } else {
          board.summary = { text, refs, questions, sides, model: model || '', createdAt: Date.now() };
          S.sums.delete(board.id);
          save(board);
          if (board === S.board) toast('Summary saved with the board.');
        }
        if (board === S.board) renderSummary(true);
      },
      onError(err) {
        job.running = false;
        job.error = err.message;
        if (board === S.board) renderSummary(true);
      },
    }, llmOpts(board, 'summary'));
    job.cancel = h.cancel;
  }

  let summaryQueued = false;
  function scheduleSummary() {
    if (summaryQueued) return;
    summaryQueued = true;
    setTimeout(() => { summaryQueued = false; renderSummary(true); }, 120);
  }

  function toggleSummary(force) {
    S.summaryOpen = typeof force === 'boolean' ? force : !S.summaryOpen;
    if (S.summaryOpen && S.outlineOpen) toggleOutline(false);
    if (S.summaryOpen && S.learnerOpen) toggleLearner(false);
    dom.summary.hidden = !S.summaryOpen;
    document.body.classList.toggle('summary-open', S.summaryOpen);
    renderSummary(true);
    if (S.board) requestAnimationFrame(() => revealColumn(S.board.openPath[S.board.openPath.length - 1], false));
  }

  /** The summary's Markdown with its #Q links turned into jumps to those questions on the board. */
  function summaryBody(text, refs, done) {
    const b = S.board;
    const div = el('div', { class: 'card-body summary-body' });
    // a bare tag the model left in the text, like [Q3] or (Q1, Q5), still links
    div.innerHTML = R.markdown(text.replace(/[[(]\s*(Q\d+(?:\s*(?:,|;|and|&)\s*Q\d+)*)\s*[\])](?!\()/gi,
      (m, tags) => (tags.match(/Q\d+/gi).some((t) => refs && refs[t.toUpperCase()]) ? tags.match(/Q\d+/gi).map((t) => `[↗](#${t})`).join(' ') : m)));
    const live = (ref) => ref && b.threads[ref.threadId] && M.findCard(b, ref.cardId);
    const link = (ref, label) => {
      const f = live(ref);
      return el('button', { class: 'sum-link', 'data-act': 'summary-link', 'data-thread': ref.threadId, 'data-qcard': ref.cardId,
        title: 'Open: ' + truncate(EE.util.texToText(f.card.text), 120) }, label);
    };
    const linked = new Set();
    div.querySelectorAll('a[href]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/^#(Q\d+)$/i);
      if (!m) return;
      const tag = m[1].toUpperCase();
      const ref = refs && refs[tag];
      if (!live(ref)) { a.replaceWith(el('span', { class: 'sum-gone', title: 'Erased from the board' }, a.textContent)); return; }
      linked.add(tag);
      const to = link(ref, '');
      if (a.textContent === '↗') { // name the question the bare tag pointed at
        const f = live(ref);
        to.classList.add('sum-ref');
        to.textContent = '↳ ' + truncate(EE.util.texToText(ref.side ? b.threads[ref.threadId].title || f.card.text : f.card.text), 34);
      } else to.append(...a.childNodes);
      a.replaceWith(to);
    });
    // every side question stays one click away, even if the model forgot to link it
    const missing = done ? Object.entries(refs || {}).filter(([tag, r]) => r.side && !linked.has(tag) && live(r)) : [];
    if (missing.length) {
      div.append(el('p', { class: 'sum-also' }, el('span', { class: 'muted' }, 'also explored: '),
        missing.flatMap(([, r], i) => [i ? ' · ' : null, link(r, truncate(b.threads[r.threadId].title || 'side question', 48))])));
    }
    return div;
  }

  let summarySig = '';
  function renderSummary(force = false) {
    const b = S.board;
    if (!b || !dom.summary) return;
    const job = S.sums.get(b.id);
    const sum = b.summary;
    const st = summaryState(b);
    const ready = hasAnswer(b);
    dom.summaryBtn.classList.toggle('on', S.summaryOpen);
    dom.summaryBtn.classList.toggle('stale', !!sum && st.fresh > 0);
    dom.summaryBtn.title = (sum ? `Summary of this board (written ${EE.util.relTime(sum.createdAt)})` : 'Summarize this board: the main question and every side question') +
      (sum && st.fresh ? `\n${st.fresh} question${st.fresh === 1 ? '' : 's'} asked since` : '') + kbd(' (⇧⌘S)');
    if (!S.summaryOpen) return;
    const sig = JSON.stringify([b.id, sum && sum.createdAt, job && [job.running, job.text.length, job.reasoning.length, job.error], st, ready, S.config && S.config.model]);
    if (!force && sig === summarySig) return;
    summarySig = sig;

    const cfg = S.config || {};
    const out = [];
    const btn = (label, onclick, cls = '') => el('button', { class: 'chalk-btn small ' + cls, onclick }, label);
    if (job && job.running) {
      const text = R.splitThink(job.text).body;
      out.push(el('div', { class: 'sum-meta' },
        el('span', { class: 'chalk-dots' }, text ? 'writing the summary' : job.reasoning || job.text ? 'thinking' : 'reading the board'),
        el('button', { class: 'link-btn', onclick: () => job.cancel && job.cancel() }, '■ stop')));
      if (sum) out.push(el('p', { class: 'muted small' }, 'The saved summary stays until this one is finished.'));
      if (text) out.push(summaryBody(text, job.refs, false));
    } else {
      if (job && job.error) {
        out.push(el('div', { class: 'cfg-problems' }, el('div', {}, '⚠ ' + job.error)),
          el('div', { class: 'modal-actions' }, btn('↻ try again', () => writeSummary(b), 'primary')));
      }
      if (sum) {
        out.push(el('p', { class: 'muted small sum-meta' },
          `Written ${EE.util.relTime(sum.createdAt)}${sum.model ? ' by ' + sum.model : ''}. Covers ${plural(sum.questions, 'question')}` +
          (sum.sides ? `, ${sum.sides} of them side questions.` : '.')));
        if (st.fresh) out.push(el('p', { class: 'small warn' }, `${plural(st.fresh, 'question')} asked since. Regenerate to fold ${st.fresh === 1 ? 'it' : 'them'} in.`));
        out.push(summaryBody(sum.text, sum.refs, true));
        out.push(el('div', { class: 'modal-actions' },
          btn('⎘ copy', () => copyText(sum.text.replace(/\[([^\]]*)\]\(#Q\d+\)/gi, '$1').replace(/\[Q\d+\]/gi, ''))),
          btn('↻ regenerate', () => writeSummary(b), st.fresh ? 'primary' : '')));
      } else if (!job) {
        out.push(el('p', { class: 'small' }, ready
          ? `A short, high-level recap of this board to reinforce what you learned: the main question, its follow-ups and ${st.sides ? `all ${plural(st.sides, 'side question')}` : 'any side questions'}, with links back to each. It is saved with the board, and you can regenerate it any time.`
          : 'Nothing to summarize yet. Ask a question first; the summary covers the main question, its follow-ups and every side question.'));
        const go = btn('write the summary', () => writeSummary(b), 'primary');
        if (!ready) go.disabled = true;
        out.push(el('div', { class: 'modal-actions' }, go));
      }
    }
    out.push(el('p', { class: 'muted small' }, `Written by the board's model: ${cfg.provider || '…'} · ${cfg.model || 'auto'}. Your notes in the "where you stand" panel apply here too.`));
    dom.summaryContent.replaceChildren(...out);
  }

  /** Follow a summary link: open the question's column and bring the question into view. */
  function jumpToQuestion(threadId, cardId) {
    const b = S.board;
    if (!b.threads[threadId]) return;
    b.openPath = M.pathTo(b, threadId);
    save(b, true);
    render();
    requestAnimationFrame(() => {
      revealColumn(threadId);
      revealPaperAnchor(b.threads[b.openPath[1]]);
      const c = cols.get(threadId);
      const ce = c && c.cards.get(cardId);
      if (!ce) return;
      const top = ce.getBoundingClientRect().top - c.body.getBoundingClientRect().top + c.body.scrollTop - 14;
      c.body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      ce.classList.remove('flash');
      void ce.offsetWidth; // restart the animation
      ce.classList.add('flash');
      setTimeout(() => ce.classList.remove('flash'), 1900);
      setTimeout(scheduleOverlay, 450);
    });
  }

  // ------------------------------------------------------------ lessons learned (the theory of this board's session)
  const EMPTY_LESSONS = { text: '', seen: [] };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  /** Answered questions on this board that its lessons have not read yet. */
  const freshLessons = (b = S.board) => (b ? M.newLessonItems(b, b.lessons) : []);

  /**
   * Fold the questions answered on this board since its lessons were last written into them, one batch per
   * request, saving the board after each batch. Nothing new, nothing sent. `rewrite` starts over from every question.
   */
  function updateLessons(board = S.board, { rewrite = false } = {}) {
    const busy = board && S.ljobs.get(board.id);
    if (!board || (busy && busy.running)) return;
    let current = rewrite ? EMPTY_LESSONS : board.lessons || EMPTY_LESSONS;
    let todo = M.newLessonItems(board, current);
    if (!todo.length) return;
    const job = { running: true, text: '', reasoning: '', error: null, cancel: null, done: 0, total: todo.length, batch: 0, rewrite };
    S.ljobs.set(board.id, job);
    const shown = () => { if (board === S.board) renderLessons(true); };
    const stop = (error) => {
      job.running = false;
      job.error = error;
      if (!error && S.ljobs.get(board.id) === job) S.ljobs.delete(board.id);
      shown();
    };
    const step = () => {
      const batch = M.lessonBatch(todo);
      Object.assign(job, { text: '', reasoning: '', batch: batch.length });
      shown();
      const h = B.chat(M.lessonsMessages(current.text, batch, S.notes, paperOf(board)), {
        onChunk({ content, reasoning }) {
          job.text += content;
          if (reasoning) job.reasoning += reasoning;
          if (board === S.board) scheduleLessons();
        },
        onDone({ model, cancelled }) {
          if (cancelled) { stop(null); return; }
          const text = R.splitThink(job.text).body.trim();
          if (!text) {
            stop(job.reasoning || R.splitThink(job.text).think
              ? 'The model only produced scratch work (it may have hit the token limit). Try again or raise LLM_MAX_TOKENS.'
              : 'The model returned nothing.');
            return;
          }
          // an update is all the lessons again; far shorter than before means some were lost on the way
          if (current.text.length > 1500 && text.length < current.text.length * 0.5) {
            stop('The model returned far fewer lessons than you had, so the ones you had are kept. Try again, or pick a stronger model.');
            return;
          }
          const seen = new Set(current.seen);
          for (const it of batch) seen.add(it.key);
          board.lessons = current = { text, seen: [...seen], model: model || '', updatedAt: Date.now() };
          save(board);
          job.done += batch.length;
          todo = todo.slice(batch.length);
          if (todo.length) { step(); return; }
          stop(null);
          if (board === S.board && !lessonsShown()) toast('Lessons learned saved with the board.');
        },
        onError(err) { stop(err.message); },
      }, llmOpts(board, 'summary'));
      job.cancel = h.cancel;
    };
    step();
  }

  let lessonsQueued = false;
  function scheduleLessons() {
    if (lessonsQueued) return;
    lessonsQueued = true;
    setTimeout(() => { lessonsQueued = false; renderLessons(true); }, 150);
  }

  let lessonsView = null;
  const lessonsShown = () => !!lessonsView && !dom.modal.hidden && dom.modal.contains(lessonsView);

  /** This board's lessons pop up; they are brought up to date first, but only when new questions came up since. */
  function toggleLessons(force) {
    const open = typeof force === 'boolean' ? force : !lessonsShown();
    if (!open) {
      if (lessonsShown()) { dom.modal.hidden = true; dom.modal.replaceChildren(); }
      lessonsView = null;
      return;
    }
    if (lessonsShown() || !S.board) return;
    lessonsView = el('div', { class: 'lessons' });
    const close = modal(el('div', {},
      el('div', { class: 'lessons-head' },
        el('h2', { class: 'modal-title chalk-title' }, 'lessons learned'),
        el('button', { class: 'icon-btn', title: 'Close (Esc)', onclick: () => close() }, '✕')),
      lessonsView), 'modal-lessons');
    const job = S.ljobs.get(S.board.id);
    if (!(job && job.running) && freshLessons().length) updateLessons();
    renderLessons(true);
  }

  function updateLessonsBtn() {
    const b = S.board;
    if (!dom.lessonsBtn || !b) return;
    const fresh = freshLessons().length;
    const l = b.lessons;
    const job = S.ljobs.get(b.id);
    const running = !!(job && job.running);
    dom.lessonsBtn.classList.toggle('stale', !!l && fresh > 0 && !running);
    dom.lessonsBtn.replaceChildren(running ? el('span', { class: 'chalk-dots' }, 'learning') : '✎ lessons');
    dom.lessonsBtn.title = (l ? `Lessons learned on this board (updated ${EE.util.relTime(l.updatedAt)})`
      : 'Lessons learned on this board: the theory its answers taught') +
      (fresh && l ? `\n${plural(fresh, 'new question')} to fold in` : '') + kbd(' (⇧⌘K)');
  }

  let lessonsSig = '';
  function renderLessons(force = false) {
    updateLessonsBtn();
    if (!lessonsShown()) return;
    const b = S.board;
    const l = b.lessons;
    const job = S.ljobs.get(b.id);
    const fresh = freshLessons();
    const sig = JSON.stringify([b.id, l && l.updatedAt, job && [job.running, job.text.length, job.reasoning.length, job.error, job.done], fresh.length]);
    if (!force && sig === lessonsSig) return;
    lessonsSig = sig;

    const cfg = S.config || {};
    const btn = (label, onclick, cls = '') => el('button', { class: 'chalk-btn small ' + cls, onclick }, label);
    const body = (text) => { const d = el('div', { class: 'card-body lessons-body' }); d.innerHTML = R.markdown(text); return d; };
    const out = [el('p', { class: 'lessons-board' }, EE.util.texToText(b.title) || 'Untitled board')];
    if (job && job.running) {
      const text = R.splitThink(job.text).body;
      const left = job.total - job.done;
      const what = job.rewrite && !job.done ? `rewriting the lessons from ${plural(job.total, 'question')}`
        : `folding in ${plural(left, 'new question')}` + (left > job.batch ? ` (${job.batch} at a time)` : '');
      out.push(el('div', { class: 'sum-meta' },
        el('span', { class: 'chalk-dots' }, what),
        el('button', { class: 'link-btn', onclick: () => job.cancel && job.cancel() }, '■ stop')));
      if (text) out.push(body(text));
      else if (l && l.text) out.push(el('p', { class: 'muted small' }, 'The lessons so far, until the update is ready:'), body(l.text));
    } else {
      if (job && job.error) {
        out.push(el('div', { class: 'cfg-problems' }, el('div', {}, '⚠ ' + job.error)),
          el('div', { class: 'modal-actions' }, btn('↻ try again', () => updateLessons(b, { rewrite: job.rewrite }), 'primary')));
      }
      if (l && l.text) {
        out.push(el('p', { class: 'muted small sum-meta' },
          `From ${plural(l.seen.length, 'question')} on this board, updated ${EE.util.relTime(l.updatedAt)}${l.model ? ' by ' + l.model : ''}.` +
          (fresh.length ? ` ${plural(fresh.length, 'new question')} not in them yet.` : ' They update themselves when you have asked new questions here.')));
        out.push(body(l.text));
        out.push(el('div', { class: 'modal-actions' },
          fresh.length ? btn(`fold in ${plural(fresh.length, 'new question')}`, () => updateLessons(b), 'primary') : null,
          btn('⎘ copy', () => copyText(l.text)),
          btn('↻ rewrite from scratch', () => updateLessons(b, { rewrite: true }))));
      } else if (!job && fresh.length) {
        out.push(el('p', { class: 'small' }, `The theory this board's ${plural(fresh.length, 'answer')} taught, grouped by topic.`),
          el('div', { class: 'modal-actions' }, btn('write the lessons', () => updateLessons(b), 'primary')));
      } else if (!job) {
        out.push(el('p', { class: 'small' }, 'Nothing learned on this board yet. Ask a question: the theory its answer teaches is collected here, grouped by topic, and it grows as you ask more.'));
      }
    }
    out.push(el('p', { class: 'muted small' }, `Written by the board's model: ${cfg.provider || '…'} · ${cfg.model || 'auto'}. Saved with the board. Your notes in the "where you stand" panel apply here too.`));
    lessonsView.replaceChildren(...out);
  }

  // ------------------------------------------------------------ recap (a detailed write-up of this board, on demand)
  /** The saved recap against the board as it is now: how many questions it has not seen yet. */
  function recapState(board) {
    const qs = M.boardQuestions(board).list;
    const rc = board.recap;
    const seen = new Set(rc ? Object.values(rc.refs || {}).map((r) => r.cardId) : []);
    return { questions: qs.length, fresh: rc ? qs.filter((q) => !seen.has(q.cardId)).length : 0 };
  }

  /** Write (or rewrite) the board's recap with the model picked in the top bar; the old one stays until it is done. */
  function writeRecap(board = S.board) {
    const busy = board && S.recaps.get(board.id);
    if (!board || (busy && busy.running) || !hasAnswer(board)) return;
    const { messages, refs, questions, sides } = M.recapMessages(board, S.notes, paperOf(board), S.profile);
    const cfg = S.config || {};
    const job = { running: true, text: '', reasoning: '', error: null, refs, cancel: null, model: cfg.model || '' };
    S.recaps.set(board.id, job);
    const shown = () => { if (board === S.board) renderRecap(true); else updateRecapBtn(); };
    shown();
    const h = B.chat(messages, {
      onChunk({ content, reasoning }) {
        job.text += content;
        if (reasoning) job.reasoning += reasoning;
        if (board === S.board) scheduleRecap();
      },
      onDone({ model, cancelled }) {
        job.running = false;
        const text = R.splitThink(job.text).body.trim();
        if (cancelled) {
          S.recaps.delete(board.id); // the saved recap, if any, stays
        } else if (!text) {
          job.error = job.reasoning || R.splitThink(job.text).think
            ? 'The model only produced scratch work (it may have hit the token limit). Try again or raise LLM_MAX_TOKENS.'
            : 'The model returned an empty recap.';
        } else {
          board.recap = { text, refs, questions, sides, model: model || job.model, createdAt: Date.now() };
          S.recaps.delete(board.id);
          save(board);
          if (board === S.board && !recapShown()) toast('Recap saved with the board.');
        }
        shown();
      },
      onError(err) {
        job.running = false;
        job.error = err.message;
        shown();
      },
    }, llmOpts(board, 'summary'));
    job.cancel = h.cancel;
  }

  let recapQueued = false;
  function scheduleRecap() {
    if (recapQueued) return;
    recapQueued = true;
    setTimeout(() => { recapQueued = false; renderRecap(true); }, 150);
  }

  let recapView = null;
  const recapShown = () => !!recapView && !dom.modal.hidden && dom.modal.contains(recapView);

  /** The recap pops up: the saved one as it is, or, the first time, a new one is written. Rewritten only on request. */
  function toggleRecap(force) {
    const open = typeof force === 'boolean' ? force : !recapShown();
    if (!open) {
      if (recapShown()) { dom.modal.hidden = true; dom.modal.replaceChildren(); }
      recapView = null;
      return;
    }
    if (recapShown() || !S.board) return;
    recapView = el('div', { class: 'recap' });
    const close = modal(el('div', {},
      el('div', { class: 'lessons-head' },
        el('h2', { class: 'modal-title chalk-title' }, 'recap'),
        el('button', { class: 'icon-btn', title: 'Close (Esc)', onclick: () => close() }, '✕')),
      recapView), 'modal-lessons modal-recap');
    const b = S.board;
    if (!b.recap && !S.recaps.get(b.id) && hasAnswer(b)) writeRecap(b);
    renderRecap(true);
  }

  function updateRecapBtn() {
    const b = S.board;
    if (!dom.recapBtn || !b) return;
    const rc = b.recap;
    const job = S.recaps.get(b.id);
    const running = !!(job && job.running);
    const { fresh } = recapState(b);
    dom.recapBtn.classList.toggle('stale', !!rc && fresh > 0 && !running);
    dom.recapBtn.replaceChildren(running ? el('span', { class: 'chalk-dots' }, 'writing') : '❡ recap');
    dom.recapBtn.title = (rc ? `Recap of this board (written ${EE.util.relTime(rc.createdAt)})`
      : 'Recap: a detailed write-up of everything this board taught you, with extra care where it was unclear') +
      (rc && fresh ? `\n${plural(fresh, 'question')} asked since` : '') + kbd(' (⇧⌘R)');
  }

  let recapSig = '';
  function renderRecap(force = false) {
    updateRecapBtn();
    if (!recapShown()) return;
    const b = S.board;
    const rc = b.recap;
    const job = S.recaps.get(b.id);
    const st = recapState(b);
    const cfg = S.config || {};
    const sig = JSON.stringify([b.id, rc && rc.createdAt, job && [job.running, job.text.length, job.reasoning.length, job.error], st, hasAnswer(b), cfg.model]);
    if (!force && sig === recapSig) return;
    recapSig = sig;

    const btn = (label, onclick, cls = '') => el('button', { class: 'chalk-btn small ' + cls, onclick }, label);
    const body = (text, refs, done) => {
      const d = summaryBody(text, refs, done);
      d.classList.add('recap-body');
      // the points that did not sink in stand out, whether the model quoted them or not
      for (const st of d.querySelectorAll('p > strong:first-child')) {
        if (/^where it got tricky/i.test(st.textContent) && !st.parentElement.closest('blockquote')) st.parentElement.classList.add('tricky');
      }
      return d;
    };
    const now = `${cfg.provider || '…'} · ${cfg.model || 'auto'}`;
    const out = [el('p', { class: 'lessons-board' }, EE.util.texToText(b.title) || 'Untitled board')];
    if (job && job.running) {
      const text = R.splitThink(job.text).body;
      out.push(el('div', { class: 'sum-meta' },
        el('span', { class: 'chalk-dots' }, text ? `writing the recap with ${job.model || 'the model'}` : job.reasoning || job.text ? 'thinking it through' : 'reading the board'),
        el('button', { class: 'link-btn', onclick: () => job.cancel && job.cancel() }, '■ stop')));
      if (rc) out.push(el('p', { class: 'muted small' }, 'The saved recap stays until this one is finished.'));
      if (text) out.push(body(text, job.refs, false));
    } else {
      if (job && job.error) {
        out.push(el('div', { class: 'cfg-problems' }, el('div', {}, '⚠ ' + job.error)),
          el('div', { class: 'modal-actions' }, btn('↻ try again', () => writeRecap(b), 'primary')));
      }
      if (rc) {
        out.push(el('p', { class: 'muted small sum-meta' },
          `Written ${EE.util.relTime(rc.createdAt)}${rc.model ? ' by ' + rc.model : ''}, from ${plural(rc.questions, 'question')}.`));
        if (st.fresh) out.push(el('p', { class: 'small warn' }, `${plural(st.fresh, 'question')} asked since. Regenerate to work ${st.fresh === 1 ? 'it' : 'them'} in.`));
        out.push(body(rc.text, rc.refs, true));
        out.push(el('div', { class: 'modal-actions' },
          btn('⎘ copy', () => copyText(rc.text.replace(/\[([^\]]*)\]\(#Q\d+\)/gi, '$1').replace(/\[Q\d+\]/gi, ''))),
          btn(`↻ regenerate with ${cfg.model || 'the selected model'}`, () => writeRecap(b), st.fresh ? 'primary' : '')));
      } else if (!job) {
        const ready = hasAnswer(b);
        out.push(el('p', { class: 'small' }, ready
          ? 'A detailed write-up of everything this board taught you, explaining again, step by step, whatever did not sink in. It is saved with the board.'
          : 'Nothing to recap yet. Ask a question first; the recap covers the main question, its follow-ups and every side question.'));
        const go = btn('write the recap', () => writeRecap(b), 'primary');
        if (!ready) go.disabled = true;
        out.push(el('div', { class: 'modal-actions' }, go));
      }
    }
    out.push(el('p', { class: 'muted small' }, `Regenerating uses the model picked in the top bar: ${now}. Your notes in the "where you stand" panel apply here too.`));
    recapView.replaceChildren(...out);
  }

  // ------------------------------------------------------------ papers (a PDF in the first column)
  /** Show the board's paper in its first column (once; re-renders keep the same viewer). */
  function mountPaper(c, b) {
    if (c.pdf && c.pdf.file === b.pdf.file) return;
    if (c.pdf) c.pdf.destroy();
    c.root.classList.add('col-paper');
    c.list.hidden = true;
    c.pdf = P.mount(c.body, b.pdf.file, {
      onReady(info) {
        let changed = false;
        if (b.pdf.pages !== info.doc.numPages) { b.pdf.pages = info.doc.numPages; changed = true; }
        if (!b.pdf.titled) {
          // the title printed on the paper beats the file name, until the board is renamed
          b.pdf.titled = true;
          if (info.title) b.title = info.title;
          changed = true;
          if (b === S.board) B.call('current', { id: b.id, title: b.title || '' }).catch(() => {});
        }
        if (changed) { save(b); if (b === S.board) render(); }
        if (b === S.board) requestAnimationFrame(() => revealPaperAnchor(b.threads[b.openPath[1]], false));
      },
      onPage() { if (b === S.board) { applyHighlights(); scheduleOverlay(); } },
      onLayout() { scheduleOverlay(); },
      onError(e) { if (b === S.board) toast('The paper did not render fully: ' + e.message, 'error'); },
    });
  }

  /** Scroll the paper so the passage a side question is about is in view (if it is not already). */
  function revealPaperAnchor(t, smooth = true, retry = true) {
    if (!t || !t.anchor || !isPaperCard(t.anchor.cardId)) return;
    const c = cols.get('root');
    const n = M.pageOf(t.anchor.cardId);
    if (!c || !c.pdf || !n) return;
    const pg = c.pdf.pages.get('pdf:' + n);
    if (!pg) return;
    const body = pg.querySelector('.pdf-text');
    const r = body && A.rangeFor(body, M.pieces(t.anchor)[0]);
    const box = r && r.getBoundingClientRect();
    const hr = c.body.getBoundingClientRect();
    if (box && box.height) {
      const para = t.anchor.para != null;
      if (box.top < hr.top + 10 || box.bottom > hr.bottom - 10) {
        c.body.scrollBy({ top: box.top - hr.top - (para ? Math.min(60, hr.height / 6) : hr.height / 3), behavior: smooth ? 'smooth' : 'auto' });
      }
    } else {
      c.pdf.scrollToPage(n, 0, smooth);
      if (retry) setTimeout(() => revealPaperAnchor(t, smooth, false), 700); // its text layer appears once drawn
    }
    setTimeout(scheduleOverlay, 450);
  }

  /** The bar under a paper: questions about the paper as a whole open a side column like a highlight does. */
  function buildPaperBar() {
    const input = el('input', { class: 'chalk-input paper-ask', placeholder: 'Ask about the whole paper…', autocomplete: 'off', spellcheck: 'false' });
    const go = el('button', { class: 'send-btn', title: 'Ask in a new column to the right' }, 'ask ↳');
    const reading = el('div', { class: 'reader-row' });
    const root = el('div', { class: 'composer paper-bar' },
      reading,
      el('div', { class: 'paper-hint' }, 'Highlight any passage to ask about it, or ask about the whole paper:'),
      el('div', { class: 'paper-row' }, input, go));
    const submit = () => {
      const q = input.value.trim();
      const b = S.board;
      if (!q || !b.pdf) return;
      input.value = '';
      const c = cols.get('root');
      askAbout({ cardId: 'pdf', start: 0, end: 0, quote: 'the whole paper', llmText: `the paper "${paperOf(b).title}"`,
        partial: [], context: '', page: c && c.pdf ? c.pdf.currentPage() : 1 }, q);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } });
    go.addEventListener('click', submit);
    return { root, ta: input, sync() { readerRow(reading); }, insert(text) { input.value += text; input.focus(); } };
  }

  // ------------------------------------------------------------ reading the paper passage by passage
  // The unit is a passage: a few paragraphs that belong together (EE.pdf.passages). Each one read is a side question
  // anchored on it (anchor.para = its index, anchor.unit = 'passage'; boards read before kept single paragraphs), so it
  // is marked on the paper, saved with the board, and part of the summary, the lessons and the recap like any other
  // side question. board.reader = {at, n, unit} remembers where the reading is.
  const READ_Q = 'Walk me through this passage.';
  const isReadThread = (t) => !!(t && t.parentId === 'root' && t.anchor && t.anchor.para != null);
  let readerLoading = null; // file whose passages are being found

  /** The thread that reads passage i (by its text, should the passages have been found differently before). */
  function readerThread(board, p, i) {
    const ts = Object.values(board.threads).filter(isReadThread);
    return ts.find((t) => t.anchor.para === i && t.anchor.quote === p.text)
      || ts.find((t) => t.anchor.cardId === 'pdf:' + p.page && t.anchor.quote === p.text) || null;
  }

  /** Go to passage i: open it if it has been read, else read it (the model explains it in a column to the right). */
  async function readPara(i) {
    const b = S.board;
    if (!b || !b.pdf || readerLoading) return null;
    let ps;
    readerLoading = b.pdf.file;
    render();
    try {
      ps = await P.passages(b.pdf.file);
    } catch (e) {
      toast('Could not find the passages of this paper: ' + e.message, 'error');
      return null;
    } finally {
      readerLoading = null;
      if (b === S.board) render();
    }
    if (b !== S.board) return null;
    if (!ps.length) { toast('There is no text in this paper to read (is it a scan?).', 'error'); return null; }
    if (i >= ps.length) { toast('That was the last passage of the paper.'); return null; }
    i = Math.max(0, i);
    const p = ps[i];
    b.reader = { at: i, n: ps.length, unit: 'passage', skip: skipList(b, ps) };
    let t = readerThread(b, p, i);
    if (t) {
      Object.assign(t.anchor, { para: i, of: ps.length, unit: 'passage' });
      openThread(t.id);
      return t;
    }
    const prev = ps[i - 1];
    const before = prev ? (prev.text.length > 700 ? '…' + prev.text.slice(-700) : prev.text) : '';
    const anchor = { cardId: 'pdf:' + p.page, start: p.start, end: p.end, quote: p.text, llmText: p.text, partial: [], context: '',
      page: p.page, para: i, of: ps.length, unit: 'passage', paras: p.to - p.from + 1, head: p.head || '', before };
    // one piece per page and per run of text, so each page highlights its part; quote and llmText are the whole passage
    anchor.parts = p.parts.map((x) => ({ cardId: 'pdf:' + x.page, start: x.start, end: x.end, quote: x.text }));
    t = M.newThread(b, 'root', anchor, `Passage ${i + 1}`);
    t.cards.push({ id: uid('c'), role: 'user', text: READ_Q, mode: 'explain', createdAt: Date.now() });
    b.openPath = ['root', t.id];
    hidePopover();
    getSelection().removeAllRanges();
    ask(b, t.id, 'explain');
    requestAnimationFrame(() => { revealColumn(t.id); revealPaperAnchor(t); });
    return t;
  }

  /** Where the reading is, as a passage index. A board read paragraph by paragraph before picks up at the passage
   *  holding the paragraph it had got to. */
  async function readerAt(b) {
    const r = b.reader;
    if (!r) return null;
    if (r.unit === 'passage') return r.at;
    try {
      const qs = await P.passages(b.pdf.file);
      const k = qs.findIndex((q) => q.from <= r.at && r.at <= q.to);
      return k < 0 ? 0 : k;
    } catch (e) { return 0; }
  }

  /** Start (or pick up) the reading: where it was left, else at the first passage past the title and authors. */
  async function readerStart() {
    const b = S.board;
    if (!b) return;
    if (!b.pdf) { toast(kbd('Open a PDF paper first (⌘O); the reader goes through it a passage at a time.')); return; }
    if (b.reader) { readPara(await readerAt(b)); return; }
    let ps = [];
    try { ps = await P.passages(b.pdf.file); } catch (e) { /* readPara reports it */ }
    const skip = new Set(skipList(b, ps));
    const keys = sectionKeys(ps);
    readPara(Math.max(0, ps.findIndex((p, k) => !skip.has(keys[k]))));
  }

  /** The next (d = 1) or previous (d = -1) passage, from the one open on the right or where the reading is. */
  async function readerStep(d) {
    const b = S.board;
    if (!b || !b.pdf) return;
    const open = b.threads[b.openPath[1]];
    if (!b.reader && !isReadThread(open)) { readerStart(); return; }
    // (a paragraph read before passages were the unit: go on from the passage that holds it)
    const at = isReadThread(open) && open.anchor.unit === 'passage' ? open.anchor.para : await readerAt(b) ?? 0;
    let ps;
    try { ps = await P.passages(b.pdf.file); } catch (e) { readPara(at + d); return; }
    // sections marked to skip are passed over
    const skip = new Set(skipList(b, ps));
    const keys = sectionKeys(ps);
    let j = at + d;
    while (j >= 0 && j < ps.length && skip.has(keys[j])) j += d;
    if (j < 0) { toast(at + d < 0 ? 'This is the first passage.' : 'There is nothing before this but sections you skip.'); return; }
    if (j >= ps.length) { toast(at + d >= ps.length ? 'That was the last passage of the paper.' : 'The rest of the paper is in sections you skip.'); return; }
    readPara(j);
  }

  // ------------------------------------------------------------ skipping sections
  // A section is the run of passages under one heading. board.reader.skip lists the ones to pass over (by heading):
  // the title block, acknowledgements and references to begin with, and any the student already knows or finds trivial.
  const TRIVIAL = /^(\d+\.?\s+)?(acknowledg(e)?ments?|references|bibliography|funding|author contributions|competing interests|data availability)\b/i;
  const FRONT = '(title and authors)';
  const sectionKey = (q) => (q.front ? FRONT : /^[^\n]{0,60}?\b(Abstract|ABSTRACT)[.:—-]?\s+[A-Z]/.test(q.text) ? 'Abstract' : q.head || '(before the first heading)');
  // a theorem, a proof, a lemma … is part of the section it is in
  const PART = /^[\s.]*(theorem|lemma|proof|corollary|definition|proposition|remark|example|claim|conjecture)\b/i;
  /** The sections of the paper: [{key, from, to}] (passage indexes, inclusive). */
  function sectionsOf(ps) {
    const out = [];
    ps.forEach((q, i) => {
      const last = out[out.length - 1];
      const k = last && !q.front && PART.test(q.head || '') ? last.key : sectionKey(q);
      if (last && last.key === k) last.to = i; else out.push({ key: k, from: i, to: i });
    });
    return out;
  }
  /** The section each passage is in, by index. */
  const sectionKeys = (ps) => sectionsOf(ps).flatMap((x) => Array(x.to - x.from + 1).fill(x.key));
  const skipList = (b, ps) => (b.reader && Array.isArray(b.reader.skip) ? b.reader.skip
    : sectionsOf(ps).map((x) => x.key).filter((k) => k === FRONT || TRIVIAL.test(k)));
  function setSkip(b, ps, key, on) {
    const skip = new Set(skipList(b, ps));
    if (on) skip.add(key); else skip.delete(key);
    b.reader = { ...(b.reader || { at: 0, n: ps.length, unit: 'passage' }), skip: [...skip] };
    save(b);
    render();
  }

  /** "Skip this section": mark the section of the passage being read and go on to the next one not skipped. */
  async function readerSkip() {
    const b = S.board;
    if (!b || !b.pdf) return;
    let ps;
    try { ps = await P.passages(b.pdf.file); } catch (e) { toast('Could not find the passages of this paper: ' + e.message, 'error'); return; }
    const open = b.threads[b.openPath[1]];
    const at = isReadThread(open) && open.anchor.unit === 'passage' ? open.anchor.para : (await readerAt(b)) ?? 0;
    const sec = sectionsOf(ps).find((x) => x.from <= at && at <= x.to);
    if (!sec) return;
    setSkip(b, ps, sec.key, true);
    const skip = new Set(skipList(b, ps));
    const keys = sectionKeys(ps);
    let j = sec.to + 1;
    while (j < ps.length && skip.has(keys[j])) j++;
    toast(`Skipping "${truncate(sec.key, 60)}". Untick it under ¶ sections to read it after all.`);
    if (j < ps.length) readPara(j);
  }

  /** The list of sections: tick the ones to skip, or jump to one. */
  async function showSections() {
    const b = S.board;
    if (!b || !b.pdf) return;
    let ps;
    try { ps = await P.passages(b.pdf.file); } catch (e) { toast('Could not find the passages of this paper: ' + e.message, 'error'); return; }
    const read = new Set(Object.values(b.threads).filter((t) => isReadThread(t) && t.anchor.unit === 'passage' && t.cards.length > 1).map((t) => t.anchor.para));
    const at = b.reader && b.reader.unit === 'passage' ? b.reader.at : -1;
    let close;
    const rows = sectionsOf(ps).map((sec) => {
      const n = sec.to - sec.from + 1;
      let done = 0;
      for (let i = sec.from; i <= sec.to; i++) if (read.has(i)) done++;
      const box = el('input', { type: 'checkbox' });
      box.checked = skipList(b, ps).includes(sec.key);
      const row = el('div', { class: 'section-row' + (box.checked ? ' skipped' : '') + (at >= sec.from && at <= sec.to ? ' here' : '') },
        el('label', { class: 'section-skip', title: 'Skip this section when reading on' }, box, el('span', { class: 'small muted' }, 'skip')),
        el('span', { class: 'section-name' }, sec.key),
        el('span', { class: 'section-meta small muted' }, `${n} passage${n === 1 ? '' : 's'} · p. ${ps[sec.from].page}${done ? ` · ${done === n ? 'read' : `${done} read`}` : ''}`),
        el('button', { class: 'chalk-btn small', title: 'Read from the start of this section', onclick: () => { close(); readPara(sec.from); } }, 'read →'));
      box.addEventListener('change', () => { setSkip(b, ps, sec.key, box.checked); row.classList.toggle('skipped', box.checked); });
      return row;
    });
    close = modal(el('div', {},
      el('h2', { class: 'chalk-title modal-title' }, 'sections'),
      el('p', { class: 'muted small' }, 'Tick what you already know or find trivial: next and previous pass over it. A passage you open yourself is read all the same.'),
      el('div', { class: 'sections-list' }, rows),
      el('div', { class: 'modal-actions' }, el('button', { class: 'chalk-btn primary', onclick: () => close() }, 'done'))), 'sections-modal');
  }

  /** "Read on from here" on a highlighted passage: the passage it is in. */
  async function readFrom(anchor) {
    const b = S.board;
    const n = anchor && M.pageOf(anchor.cardId);
    if (!b || !b.pdf || !n) return;
    hidePopover();
    let ps;
    try { ps = await P.passages(b.pdf.file); } catch (e) { toast('Could not find the passages of this paper: ' + e.message, 'error'); return; }
    let i = ps.findIndex((p) => p.parts.some((x) => x.page === n && anchor.start < x.end && anchor.end > x.start));
    if (i < 0) i = ps.findIndex((p) => p.page >= n);
    if (i < 0) { toast('No passage found there.'); return; }
    readPara(i);
  }

  /** The reading controls under the paper. */
  function readerRow(row) {
    const b = S.board;
    if (!b || !b.pdf) { row.hidden = true; return; }
    const r = b.reader;
    const sig = JSON.stringify([r, readerLoading === b.pdf.file]);
    if (row._sig === sig) return;
    row._sig = sig;
    row.hidden = false;
    if (readerLoading === b.pdf.file) { row.replaceChildren(el('span', { class: 'chalk-dots muted' }, 'finding the passages')); return; }
    if (!r) {
      row.replaceChildren(el('button', { class: 'chalk-btn small primary', 'data-act': 'reader-start', title: kbd('⇧⌘P') }, '¶ read it with me, passage by passage'));
      return;
    }
    row.replaceChildren(
      el('button', { class: 'link-btn reader-pos', 'data-act': 'reader-open', title: 'Back to the passage you are on' }, `¶ ${r.at + 1} of ${r.n}`),
      el('button', { class: 'link-btn', 'data-act': 'reader-sections', title: 'The sections of the paper: skip the ones you know, or jump to one' },
        `sections${r.skip && r.skip.length ? ` (${r.skip.length} skipped)` : ''}`),
      el('span', { class: 'spacer' }),
      el('button', { class: 'chalk-btn small', 'data-act': 'reader-prev', title: kbd('Previous passage (⌥⌘[)') }, '←'),
      el('button', { class: 'chalk-btn small primary', 'data-act': 'reader-next', title: kbd('Next passage (⌥⌘])') }, 'next ¶ →'),
      el('button', { class: 'icon-btn', 'data-act': 'reader-stop', title: 'Stop reading (the passages read so far stay on the board)' }, '✕'));
  }

  /** Under a passage being read: where it is, and the way on. */
  function readerNav(nav, threadId) {
    const b = S.board;
    const t = b && b.threads[threadId];
    if (!isReadThread(t)) { nav.hidden = true; return; }
    const i = t.anchor.para;
    const n = (b.reader && b.reader.n) || t.anchor.of || 0;
    const busy = t.cards.some((c) => c.status === 'streaming');
    const sig = JSON.stringify([i, n, busy, !!readerLoading]);
    nav.hidden = false;
    if (nav._sig === sig) return;
    nav._sig = sig;
    const last = n && i >= n - 1;
    nav.replaceChildren(
      el('span', { class: 'reader-pos muted' }, `¶ ${i + 1}${n ? ` of ${n}` : ''} · p. ${M.pagesLabel(t.anchor) || t.anchor.page}`),
      el('span', { class: 'spacer' }),
      t.anchor.unit === 'passage' ? el('button', { class: 'chalk-btn small', 'data-act': 'reader-skip', title: `Skip the rest of "${t.anchor.head || 'this section'}": you know it, or it is trivial` }, 'skip section ⤼') : null,
      el('button', { class: 'chalk-btn small', 'data-act': 'reader-prev', title: kbd('Previous passage (⌥⌘[)'), disabled: i === 0 || undefined }, '← previous'),
      el('button', { class: 'chalk-btn small' + (busy ? '' : ' primary'), 'data-act': 'reader-next', title: kbd('Next passage (⌥⌘])'), disabled: last || undefined },
        last ? 'last passage' : 'next passage →'));
  }

  /** Pick a PDF: the native open panel in the apps, a file input in the browser harness. */
  async function openPdf() {
    if (B.isNative) {
      try {
        const r = await B.call('importPdf');
        if (r && r.file) openPaper(r);
      } catch (e) {
        toast('Could not open the PDF: ' + e.message, 'error');
      }
      return;
    }
    const input = el('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true });
    input.addEventListener('change', () => { if (input.files && input.files[0]) importPaperFile(input.files[0]); input.remove(); });
    document.body.append(input);
    input.click();
  }

  /** A PDF handed over by the page itself (dropped, or picked in the browser): its bytes go to the native side. */
  async function importPaperFile(f) {
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      const r = await B.call('importPdf', { data: btoa(bin), name: f.name || 'paper.pdf' });
      if (r && r.file) openPaper(r);
    } catch (e) {
      toast('Could not open the PDF: ' + e.message, 'error');
    }
  }

  /** Open a paper that is in the boards folder: on the board that already has it, or on a fresh board. */
  function openPaper({ file, name }) {
    const known = [...S.cache.values(), ...S.library.values()].filter((x) => x.pdf && x.pdf.file === file)
      .sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0))[0];
    if (known) {
      const live = S.cache.get(known.id);
      if (live !== S.board) setBoard(live || known, !live);
      toast('This paper already has a board, so that one is open again.');
      return S.board;
    }
    const b = S.board && isEmpty(S.board) ? S.board : M.newBoard();
    b.pdf = { file, name: name || 'paper.pdf', titled: false };
    b.title = (name || 'paper').replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim();
    setBoard(b);
    save(b);
    return b;
  }

  function setPaperLook(look) {
    S.paperLook = look;
    try { localStorage.setItem('ee.paperLook', look); } catch (e) { /* ignore */ }
    document.body.classList.toggle('paper-printed', look === 'paper');
    render();
  }

  // ------------------------------------------------------------ events
  function onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const ce = btn.closest('.card');
    const cardId = ce && ce.dataset.card;
    const idx = Number(btn.dataset.idx);
    const b = S.board;
    switch (act) {
      case 'example': {
        const ex = EXAMPLES[idx];
        send('root', ex.text, ex.mode);
        break;
      }
      case 'toggle-branch': toggleThread(btn.dataset.thread); break;
      case 'close-thread': closeThread(btn.dataset.thread); break;
      case 'delete-thread': deleteThread(btn.dataset.thread); break;
      case 'map-open': openThread(btn.dataset.thread); break;
      case 'crumb': {
        b.openPath = b.openPath.slice(0, idx + 1);
        save(b, true);
        render();
        requestAnimationFrame(() => revealColumn(b.openPath[idx]));
        break;
      }
      case 'stop': cancelCard(cardId); break;
      case 'regenerate': regenerate(cardId); break;
      case 'erase-card': eraseCard(cardId); break;
      case 'copy-card': {
        const f = M.findCard(b, cardId);
        if (f) copyText(DG.plain(R.splitThink(f.card.text).body));
        break;
      }
      case 'run': runCode(cardId, idx); break;
      case 'stop-run': {
        const runId = S.running.get(cardId + ':' + idx);
        if (runId) B.call('cancel', { id: runId }).catch(() => {});
        break;
      }
      case 'copy-code': {
        const f = M.findCard(b, cardId);
        if (f) copyText(codeFor(f.card, idx) || '');
        break;
      }
      case 'edit-code': editCode(ce, cardId, idx); break;
      case 'clear-run': {
        const f = M.findCard(b, cardId);
        if (f && f.card.runs) { delete f.card.runs[idx]; touch(f.card); save(b); render(); }
        break;
      }
      case 'rate': {
        const f = M.findCard(b, cardId);
        if (!f) break;
        f.card.rating = Number(btn.dataset.n);
        f.card.ratedAt = Date.now();
        save(b);
        render();
        updateLevelChip();
        break;
      }
      case 'explain-run': explainRun(cardId, idx); break;
      case 'fix-run': fixRun(cardId, idx); break;
      case 'lens': openLens(btn.closest('.katex-display')); break;
      case 'rename-board': renameBoard(); break;
      case 'open-pdf': openPdf(); break;
      case 'reader-start': readerStart(); break;
      case 'reader-next': readerStep(1); break;
      case 'reader-prev': readerStep(-1); break;
      case 'reader-skip': readerSkip(); break;
      case 'reader-sections': showSections(); break;
      case 'reader-open': readPara(b.reader ? b.reader.at : 0); break;
      case 'reader-stop': if (b.reader) { delete b.reader; save(b); render(); } break;
      case 'paper-look': setPaperLook(S.paperLook === 'chalk' ? 'paper' : 'chalk'); break;
      case 'summary-link':
        if (!dom.modal.hidden) { dom.modal.hidden = true; dom.modal.replaceChildren(); } // a link in the recap
        jumpToQuestion(btn.dataset.thread, btn.dataset.qcard);
        break;
      case 'diagram': { const f = M.findCard(b, cardId); if (f) addDiagram(b, f.card); break; }
      case 'dg-redraw': { const f = M.findCard(b, cardId); if (f) drawDiagram(b, f.card, btn.dataset.key); break; }
      case 'dg-stop': { const j = S.dgJobs.get(dgKey(cardId, btn.dataset.key)); if (j && j.cancel) j.cancel(); break; }
      case 'dg-erase': eraseDiagram(cardId, btn.dataset.key); break;
      case 'dg-zoom': zoomDiagram(cardId, btn.dataset.key); break;
      default: break;
    }
  }

  async function renameBoard() {
    const b = S.board;
    const t = await promptDialog('Name this board', b.title || '', 'Rename');
    if (t == null || !t.trim()) return;
    b.title = t.trim();
    save(b);
    B.call('current', { id: b.id, title: b.title }).catch(() => {});
    render();
  }

  function editCode(ce, cardId, idx) {
    const f = M.findCard(S.board, cardId);
    if (!f) return;
    const wrap = ce.querySelector(`.code-block[data-idx="${idx}"]`);
    const pre = wrap && wrap.querySelector('pre');
    if (!pre || wrap.querySelector('textarea')) return;
    const ta = el('textarea', { class: 'code-edit', spellcheck: 'false' });
    ta.value = codeFor(f.card, idx) || '';
    const finish = (saveIt, runIt) => {
      if (saveIt) {
        f.card.edits = f.card.edits || {};
        f.card.edits[idx] = ta.value;
        if (f.card.role === 'code') { f.card.code = ta.value; delete f.card.edits[idx]; }
        save(S.board);
      }
      touch(f.card);
      render();
      if (runIt) runCode(cardId, idx);
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true, true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false, false); }
      if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('    ', ta.selectionStart, ta.selectionEnd, 'end'); }
    });
    const bar = el('div', { class: 'edit-bar', 'data-noanchor': '' },
      el('button', { class: 'chalk-btn primary small', onclick: () => finish(true, true) }, '▶ save & run'),
      el('button', { class: 'chalk-btn small', onclick: () => finish(true, false) }, 'save'),
      el('button', { class: 'chalk-btn small', onclick: () => finish(false, false) }, 'cancel'));
    pre.replaceWith(ta);
    ta.after(bar);
    ta.style.height = Math.min(480, Math.max(120, ta.scrollHeight + 8)) + 'px';
    ta.focus();
  }

  function copyText(text) {
    const p = B.isNative || !navigator.clipboard ? B.call('copy', { text }) : navigator.clipboard.writeText(text);
    Promise.resolve(p).then(() => toast('Copied'), () => toast('Copy failed', 'error'));
  }

  function wire() {
    const $ = (id) => document.getElementById(id);
    Object.assign(dom, {
      board: $('board'), stage: $('stage'), columns: $('columns'), overlay: $('overlay'),
      crumbs: $('crumbs'), backBtn: $('btn-back'), mapBtn: $('btn-map'), fontBtn: $('btn-font'),
      outline: $('outline'), outlineTree: $('outline-tree'), popover: $('popover'), popQuote: $('pop-quote'),
      popInput: $('pop-input'), popChips: $('pop-chips'), modal: $('modal'), toast: $('toast'),
      dropdown: $('dropdown'), status: $('status'), modelSelect: $('model-select'), configBtn: $('btn-config'), levelBtn: $('btn-level'), levelsetBtn: $('btn-levelset'),
      learner: $('learner'), learnerProfile: $('learner-profile'), noteList: $('note-list'), noteInput: $('note-input'),
      noteSave: $('note-save'), noteCancel: $('note-cancel'), learnerPrompt: $('learner-prompt-text'), learnerBase: $('learner-base-text'),
      summary: $('summary'), summaryContent: $('summary-content'), summaryBtn: $('btn-summary'), lessonsBtn: $('btn-lessons'), recapBtn: $('btn-recap'),
      lockBtn: $('btn-lock'),
    });
    // shortcut hints in the static markup are written for a Mac; reword them for this platform
    if (!IS_MAC) {
      document.querySelectorAll('[title]').forEach((n) => { n.title = kbd(n.title); });
      document.querySelectorAll('.note-actions .small').forEach((n) => { n.textContent = kbd(n.textContent); });
    }
    document.addEventListener('click', onClick);
    dom.backBtn.addEventListener('click', closeAll);
    $('ledge-eraser').addEventListener('click', closeAll);
    dom.mapBtn.addEventListener('click', () => toggleOutline());
    $('outline-close').addEventListener('click', () => toggleOutline(false));
    dom.fontBtn.addEventListener('click', openFontPanel);
    dom.configBtn.addEventListener('click', showConfig);
    dom.modelSelect.addEventListener('change', onModelMenu);
    dom.lockBtn.addEventListener('click', () => toggleConfidential());
    dom.levelBtn.addEventListener('click', () => toggleLearner());
    $('learner-close').addEventListener('click', () => toggleLearner(false));
    dom.summaryBtn.addEventListener('click', () => toggleSummary());
    $('summary-close').addEventListener('click', () => toggleSummary(false));
    dom.lessonsBtn.addEventListener('click', () => toggleLessons());
    dom.recapBtn.addEventListener('click', () => toggleRecap());
    dom.noteSave.addEventListener('click', submitNote);
    dom.noteCancel.addEventListener('click', resetNoteInput);
    dom.noteInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); submitNote(); }
    });
    const promptBox = $('learner-prompt');
    try { promptBox.open = localStorage.getItem('ee.promptOpen') === '1'; } catch (e) { /* ignore */ }
    promptBox.addEventListener('toggle', () => { try { localStorage.setItem('ee.promptOpen', promptBox.open ? '1' : '0'); } catch (e) { /* ignore */ } });
    dom.levelsetBtn.addEventListener('click', () => levelSet({ force: true, open: true }));
    $('btn-new').addEventListener('click', newBoard);
    $('btn-pdf').addEventListener('click', openPdf);
    // drop a PDF anywhere on the board to read it
    document.addEventListener('dragover', (e) => {
      if (e.dataTransfer && [...e.dataTransfer.items].some((it) => it.kind === 'file')) { e.preventDefault(); document.body.classList.add('dropping'); }
    });
    document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
    document.addEventListener('drop', (e) => {
      document.body.classList.remove('dropping');
      const f = e.dataTransfer && [...e.dataTransfer.files].find((x) => x.type === 'application/pdf' || /\.pdf$/i.test(x.name));
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      if (f) importPaperFile(f); else toast('Only PDF files can be opened on the board.', 'error');
    });
    try { S.paperLook = localStorage.getItem('ee.paperLook') === 'paper' ? 'paper' : 'chalk'; } catch (e) { /* ignore */ }
    document.body.classList.toggle('paper-printed', S.paperLook === 'paper');

    $('pop-ask').addEventListener('click', () => submitPopover(dom.popInput.value));
    dom.popInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submitPopover(dom.popInput.value); }
    });

    dom.columns.addEventListener('mouseup', (e) => {
      if (e.button !== 0 || e.target.closest('button, textarea, input, select, .composer, summary')) return;
      setTimeout(() => {
        const sel = getSelection();
        if (sel && !sel.isCollapsed) {
          const got = selectionToAnchor();
          if (got) showPopover(got.anchor, got.range);
          return;
        }
        const tid = anchorAtPoint(e.clientX, e.clientY);
        if (tid) toggleThread(tid);
      }, 0);
    });
    document.addEventListener('mousedown', (e) => {
      if (!dom.popover.hidden && !e.target.closest('#popover')) hidePopover();
    });
    dom.board.addEventListener('scroll', () => { if (!dom.popover.hidden) hidePopover(); }, { passive: true });
    window.addEventListener('resize', scheduleOverlay);

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (modalOpen()) { dom.modal.hidden = true; dom.modal.replaceChildren(); return; }
      if (!dom.popover.hidden) { hidePopover(); return; }
      const a = document.activeElement;
      if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT') && a.value) { a.blur(); return; }
      if (S.learnerOpen) { toggleLearner(false); return; }
      if (S.summaryOpen) { toggleSummary(false); return; }
      if (S.outlineOpen) { toggleOutline(false); return; }
      closeLast();
    });

    let font = DEFAULT_FONT;
    try { font = localStorage.getItem('ee.font') || font; } catch (e) { /* ignore */ }
    if (!FONTS.includes(font)) font = DEFAULT_FONT; // a face from another platform
    try { S.llm = localStorage.getItem('ee.llm') || ''; S.localLlm = localStorage.getItem('ee.llm.local') || ''; } catch (e) { /* ignore */ }
    setFont(font);
    if (savedZoom() !== 1) zoom(null, savedZoom());
    if (document.fonts) document.fonts.ready.then(scheduleOverlay);
  }

  // ------------------------------------------------------------ native hooks
  Object.assign(EE.native, {
    openBoard({ json }) {
      try {
        const b = JSON.parse(json);
        const cached = S.cache.get(b.id);
        // a board still being written to (an answer, its summary, its lessons or a diagram) stays the same object
        const live = cached && ([...S.streams.values(), ...S.dgJobs.values()].some((s) => s.boardId === b.id) || !!(S.sums.get(b.id) || {}).running
          || !!(S.ljobs.get(b.id) || {}).running || !!(S.recaps.get(b.id) || {}).running);
        setBoard(live ? cached : b, !live);
        updateLevelChip();
      } catch (e) {
        toast('Could not open board: ' + e.message, 'error');
      }
    },
    newBoard() { newBoard(); },
    command({ name }) {
      const cmds = {
        closeLast, closeAll, toggleMap: () => toggleOutline(), insertMatrix: () => openMatrix(),
        focus: () => focusComposer(), zoomChanged: () => setTimeout(scheduleOverlay, 50), config: showConfig,
        source: openSourcePanel, font: openFontPanel,
        levelset: () => levelSet({ force: true, open: true }), profile: () => toggleLearner(), summary: () => toggleSummary(),
        lessons: () => toggleLessons(), recap: () => toggleRecap(), openPdf,
        reader: readerStart, readerNext: () => readerStep(1), readerPrev: () => readerStep(-1),
        confidential: () => toggleConfidential(),
      };
      if (cmds[name]) cmds[name]();
    },
    zoomChanged({ zoom: z }) {  // a native shortcut (⌘= / ⌘−) changed the page zoom
      if (typeof z === 'number') rememberZoom(z);
      setTimeout(scheduleOverlay, 50);
    },
    renamed({ id, title }) {
      const b = S.cache.get(id);
      if (b) { b.title = title; if (b === S.board) render(); }
    },
    deleted({ id }) {
      const job = S.sums.get(id);
      if (job && job.cancel) job.cancel(); // never write a summary back into a deleted board
      S.sums.delete(id);
      const lj = S.ljobs.get(id);
      if (lj && lj.cancel) lj.cancel(); // nor its lessons
      S.ljobs.delete(id);
      const rj = S.recaps.get(id);
      if (rj && rj.cancel) rj.cancel(); // nor its recap
      S.recaps.delete(id);
      for (const d of [...S.dgJobs.values()]) if (d.boardId === id && d.cancel) d.cancel();
      S.cache.delete(id);
      S.library.delete(id);
      savedSnaps.delete(id);
      updateLevelChip();
      if (S.board && S.board.id === id) newBoard();
    },
    pyStatus({ text }) { toast(text); },
    async flush() {
      for (const b of S.cache.values()) await saveNow(b);
      return true;
    },
  });

  async function boot() {
    wire();
    let init = {};
    try { init = (await B.call('ready')) || {}; } catch (e) { /* dev server may be down */ }
    try {
      const r = await B.call('allBoards');
      for (const j of (r && r.boards) || []) {
        try { const b = JSON.parse(j); S.library.set(b.id, b); savedSnaps.set(b.id, snapsOf(b)); } catch (e) { /* skip a corrupt file */ }
      }
    } catch (e) { /* no library: the learner model starts empty */ }
    try {
      const r = await B.call('loadProfile');
      if (r && r.json) S.profile = JSON.parse(r.json);
    } catch (e) { /* no profile yet */ }
    try {
      const r = await B.call('loadNotes');
      const notes = r && r.json ? JSON.parse(r.json).notes : [];
      if (Array.isArray(notes)) S.notes = notes.filter((n) => n && typeof n.text === 'string' && n.text.trim());
    } catch (e) { /* no notes yet */ }
    if (init.board) {
      try { setBoard(JSON.parse(init.board), true); } catch (e) { newBoard(); }
    } else newBoard();
    await refreshConfig();
    updateLevelChip();
  }

  EE.app = {
    S, cols, dom, send, askAbout, openThread, closeThread, closeAll, closeLast, runCode, newBoard, setBoard,
    selectionToAnchor, showPopover, hidePopover, submitPopover, render, refreshConfig, toggleOutline, openMatrix,
    drawOverlay, findCardEl, levelSet, showProfile, toggleLearner, learnerContext, evidenceState, submitNote, removeNote,
    toggleSummary, writeSummary, summaryState, toggleLessons, updateLessons, lessonsShown, toggleRecap, writeRecap, recapShown, recapState, jumpToQuestion, drawDiagram, addDiagram, diagramsOn,
    openPaper, importPaperFile, paperOf, revealPaperAnchor, readPara, readerStep, readerStart, readFrom,
    toggleConfidential, llmOpts, readerSkip, showSections,
  };
  document.addEventListener('DOMContentLoaded', boot);
})();
