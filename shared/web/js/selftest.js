/* End-to-end self test. Runs inside the real app (or the dev harness) and
 * exercises the same code paths a person would: prompt → highlight → side
 * question → drill deeper → run Python → compute mode → close back to the
 * original → reload from disk → reopen a branch → summarize the board →
 * draw a circuit diagram → read a PDF paper and ask about a highlighted passage.
 * opts.prompt replaces the first question; opts.pdf (a path) replaces the built-in one-page paper.
 */
EE.selfTest = async function selfTest(opts = {}) {
  const app = EE.app, S = app.S, B = EE.bridge, sleep = EE.util.sleep;
  const report = { ok: true, steps: [], startedAt: new Date().toISOString() };
  const log = (message) => { console.log('[selftest] ' + message); return B.call('selftest', { event: 'log', message }).catch(() => {}); };
  // a snapshot never finishes while the display sleeps; don't let that hang the run
  const snap = (name) => {
    let taken = false;
    return Promise.race([
      B.call('selftest', { event: 'snapshot', name }).catch((e) => log('snapshot failed: ' + e.message)).finally(() => { taken = true; }),
      sleep(15000).then(() => (taken ? null : log(`snapshot ${name} skipped (no frame in 15 s; is the display asleep?)`))),
    ]);
  };
  const waitFor = async (pred, ms, what) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return; await sleep(250); }
    throw new Error('timed out waiting for ' + what);
  };
  const idle = () => waitFor(() => S.streams.size === 0 && S.running.size === 0, 15 * 60 * 1000, 'the model / python to finish');
  const settle = () => sleep(600);
  const lastCard = (tid) => { const t = S.board.threads[tid]; return t.cards[t.cards.length - 1]; };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  async function step(name, fn) {
    const t0 = Date.now();
    try {
      const detail = await fn();
      report.steps.push({ name, ok: true, ms: Date.now() - t0, detail: detail || null });
      await log(`PASS ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)${detail ? ' ' + JSON.stringify(detail) : ''}`);
    } catch (e) {
      report.ok = false;
      report.steps.push({ name, ok: false, ms: Date.now() - t0, error: e.message });
      await log(`FAIL ${name}: ${e.message}`);
    }
  }
  function answerOk(card) {
    assert(card && card.role === 'assistant', 'no assistant card');
    assert(card.status === 'done', `answer status is ${card.status}: ${card.error || ''}`);
    const body = EE.render.splitThink(card.text).body;
    assert(body.length > 120, 'answer too short: ' + body.length);
    return body.length;
  }
  /** Select a range in a card exactly like a mouse drag would, then fire mouseup. */
  async function selectAndOpenPopover(cardId, pick) {
    const ce = app.findCardEl(cardId);
    assert(ce, 'card not on screen');
    const body = ce.querySelector('.card-body');
    const range = pick(body);
    assert(range, 'nothing suitable to select');
    range.startContainer.parentElement.scrollIntoView({ block: 'center' });
    await sleep(150);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const r = range.getBoundingClientRect();
    body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: r.right - 1, clientY: r.bottom - 1 }));
    await waitFor(() => !app.dom.popover.hidden, 3000, 'the side-question popover');
    return S.pending.anchor;
  }
  const pickEquation = (body) => {
    const displays = [...body.querySelectorAll('.katex-display')];
    const d = displays[1] || displays[0];
    if (!d) return pickPhrase(body);
    const r = document.createRange();
    r.selectNodeContents(d.querySelector('.katex-html') || d);
    return r;
  };
  const pickPhrase = (body) => {
    const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.parentElement.closest('.katex, pre, code, [data-noanchor], .anchor-quote')) continue;
      const m = n.data.match(/[A-Za-z][^.!?\n]{24,90}/);
      if (m) {
        const r = document.createRange();
        r.setStart(n, m.index);
        r.setEnd(n, m.index + Math.min(m[0].length, 60));
        return r;
      }
    }
    return null;
  };

  /** A one-page PDF built here (Helvetica, not embedded), so the test needs no fixture file. */
  function tinyPdf() {
    const esc = (t) => t.replace(/[\\()]/g, (m) => '\\' + m);
    const body = ['Phase kickback is the step that makes most quantum algorithms work.',
      'When a controlled-U acts on a control in superposition and a target in an eigenstate of U,',
      'the eigenvalue of the target becomes a relative phase on the control register.',
      'Hence the target is left unchanged while the control picks up the phase e^(2 pi i phi).'];
    const content = 'BT /F1 22 Tf 72 700 Td (Phase kickback in one page) Tj ET BT /F1 12 Tf 72 660 Td 18 TL ' +
      body.map((l) => `(${esc(l)}) '`).join(' ') + ' ET';
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
    let out = '%PDF-1.4\n';
    const offs = [];
    objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
      `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return btoa(out);
  }

  await log('self test starting');
  let rootAnswer, branch1, branch2;
  // record every prompt the app sends, to check what the models are told
  const sent = [];
  const origChat = B.chat;
  B.chat = (messages, handlers, o) => { sent.push({ purpose: (o && o.purpose) || 'explain', messages }); return origChat(messages, handlers, o); };
  const lastSystem = () => { const x = sent.filter((m) => m.purpose === 'explain').pop(); return x ? x.messages[0].content : ''; };

  await step('model configuration', async () => {
    const c = await B.call('config');
    assert(c.provider && c.model, 'no provider/model: ' + JSON.stringify(c));
    return { provider: c.provider, model: c.model, envFile: c.envFile, problems: c.problems, levelset: c.levelset };
  });

  await step('source picker: sources match .env, models list, text size follows the slider', async () => {
    if (!B.isNative) return { skipped: 'harness' };
    const src = await B.call('llmSources');
    assert(src.current && (src.sources || []).length === 3, 'sources: ' + JSON.stringify(src));
    const names = { openrouter: 'OpenRouter', lmstudio: 'LM Studio', custom: 'Custom' };
    const dflt = (S.config.choices || [])[0] || S.config;
    assert(names[src.current.provider] === dflt.provider, `picker says ${src.current.provider}, config says ${dflt.provider}`);
    const { models } = await B.call('listModels', { provider: src.current.provider });
    assert(Array.isArray(models) && models.length > 0, 'no models listed');
    if (dflt.model) assert(models.includes(dflt.model), `${dflt.model} not in the ${models.length} listed models`);
    const z = (await B.call('zoom', { level: 1.25 })).zoom;
    assert(Math.abs(z - 1.25) < 0.01, 'zoom level: ' + z);
    await sleep(300);
    await snap('01b-text-size-125');
    assert((await B.call('zoom', { dir: 'reset' })).zoom === 1, 'zoom reset');
    const esc = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    EE.native.command({ name: 'font' });
    await sleep(300);
    assert(document.querySelector('#dropdown .pop-slider'), 'the Aa panel did not open');
    await snap('01c-font-panel');
    esc();
    EE.native.command({ name: 'source' });
    await waitFor(() => document.querySelectorAll('#dropdown .pop-src').length === 3, 10000, 'the source panel');
    await waitFor(() => /listed|reachable/.test(document.querySelector('#dropdown .pop-src.on .hint').textContent), 30000, 'the model list');
    await snap('01d-source-panel');
    esc();
    assert(document.getElementById('dropdown').hidden, 'Escape did not close the panel');
    return { provider: src.current.provider, models: models.length };
  });

  await step('matrix helper inserts LaTeX', async () => {
    app.newBoard();
    app.openMatrix('root');
    await settle();
    [...document.querySelectorAll('.mx-presets .chip')].find((b) => b.textContent === 'H').click();
    [...document.querySelectorAll('.modal-actions .chalk-btn')].find((b) => /board/.test(b.textContent)).click();
    const ta = app.cols.get('root').composer.ta;
    assert(/\\begin\{pmatrix\}/.test(ta.value), 'composer did not receive the matrix');
    const v = ta.value;
    ta.value = '';
    ta.dispatchEvent(new Event('input'));
    return { inserted: v.slice(0, 60) };
  });

  await step('a new board level-sets the earlier boards (unrated = 1)', async () => {
    const { items } = app.evidenceState();
    if (!items.length) return { note: 'no earlier boards to assess' };
    await waitFor(() => S.ls.running || S.profile || S.ls.error, 10000, 'the level-set to start');
    await waitFor(() => !S.ls.running, 15 * 60 * 1000, 'the level-set to finish');
    assert(!S.ls.error, 'level-set failed: ' + S.ls.error);
    const p = S.profile;
    assert(p && p.topics.length > 0, 'no profile topics');
    const rated = items.filter((i) => i.rated).length;
    if (!rated) assert(p.topics.every((t) => t.mastery <= 2), 'unrated topics must stay at 1: ' + p.topics.map((t) => t.name + ':' + t.mastery).join(', '));
    app.toggleLearner(true);
    await settle();
    await snap('00-level-set-profile');
    app.toggleLearner(false);
    return { level: p.overall.level, topics: p.topics.length, questions: p.meta.questions, rated: p.meta.rated, model: p.meta.model, sample: p.topics.slice(0, 4).map((t) => `${t.name}:${t.mastery}`) };
  });

  await step('explain an equation (root)', async () => {
    const prompt = opts.prompt || String.raw`Explain the Hadamard gate: why is $H\ket{0} = \frac{1}{\sqrt{2}}\left(\ket{0}+\ket{1}\right)$, and why is $H^2 = I$? Use the matrix form.`;
    rootAnswer = app.send('root', prompt, 'explain');
    await idle();
    await settle();
    const len = answerOk(rootAnswer);
    const katexCount = app.findCardEl(rootAnswer.id).querySelectorAll('.katex').length;
    assert(katexCount > 0, 'no rendered math in the answer');
    const sys = lastSystem();
    assert(sys.includes('THE STUDENT'), 'the system prompt has no learner section');
    assert(sys.includes('Do not include code') && !sys.includes('boardkit'), 'code should be off unless asked');
    assert(!/```/.test(rootAnswer.text), 'the explanation contains code although none was asked for');
    await snap('01-root-answer');
    return { chars: len, formulas: katexCount, systemChars: sys.length };
  });

  await step('sink-in poll records a rating', async () => {
    const ce = app.findCardEl(rootAnswer.id);
    const btn = ce.querySelector('.card-poll .poll-n[data-n="3"]');
    assert(btn, 'no poll under the answer');
    btn.scrollIntoView({ block: 'center' });
    await settle();
    btn.click();
    await settle();
    assert(rootAnswer.rating === 3, 'rating not stored');
    assert(ce.querySelector('.poll-n.on') && ce.querySelector('.poll-n.on').dataset.n === '3', 'poll does not show the rating');
    await snap('01b-poll');
    return { rating: rootAnswer.rating, note: ce.querySelector('.poll-note').textContent };
  });

  const NOTE = 'Self-test note: whenever a matrix product appears, work out one entry by hand.';
  await step('a private note becomes a direction in the prompt', async () => {
    const before = S.notes.length;
    document.getElementById('btn-level').click();
    await settle();
    assert(!app.dom.learner.hidden, 'the where-you-stand panel did not open');
    const staleBefore = app.evidenceState().hash;
    app.dom.noteInput.value = NOTE;
    document.getElementById('note-save').click();
    await waitFor(() => S.notes.length === before + 1 && app.dom.noteInput.value === '', 5000, 'the note to be saved and the box cleared');
    const stored = JSON.parse((await B.call('loadNotes')).json).notes;
    assert(stored.some((n) => n.text === NOTE), 'the note was not saved to disk');
    assert([...app.dom.noteList.querySelectorAll('.note-text')].some((x) => x.textContent === NOTE), 'the note is not listed');
    const preview = app.dom.learnerPrompt.textContent;
    assert(preview.includes("THE STUDENT'S OWN DIRECTIONS") && preview.includes(NOTE), 'the prompt preview does not show the note');
    assert(app.evidenceState().hash !== staleBefore, 'a new note must make the profile stale');
    document.getElementById('learner-prompt').open = true;
    await settle();
    await snap('01c-learner-panel');
    app.toggleLearner(false);
    return { notes: S.notes.length, previewChars: preview.length };
  });

  await step('highlight an equation and ask a side question', async () => {
    const anchor = await selectAndOpenPopover(rootAnswer.id, pickEquation);
    await snap('02-popover');
    [...document.querySelectorAll('#pop-chips .chip')].find((b) => /How did you get/.test(b.textContent)).click();
    assert(S.board.openPath.length === 2, 'branch column did not open');
    branch1 = S.board.threads[S.board.openPath[1]];
    await idle();
    await settle();
    const len = answerOk(lastCard(branch1.id));
    const ratedLine = (lastSystem().split('\n').find((l) => l.includes(': 3/10,')) || '');
    assert(ratedLine, 'the rating of the previous answer did not reach the next prompt');
    assert(lastSystem().includes(NOTE), 'the private note did not reach the next prompt');
    app.drawOverlay();
    const loops = document.querySelectorAll('#overlay .chalk-loop').length;
    await snap('03-side-question');
    return { quote: anchor.quote.slice(0, 80), partial: anchor.partial.length, chars: len, chalkCircles: loops, ratedLine: ratedLine.slice(0, 160) };
  });

  await step('drill down further from the side question', async () => {
    const anchor = await selectAndOpenPopover(lastCard(branch1.id).id, pickPhrase);
    app.dom.popInput.value = 'Why does that follow? Show the algebra.';
    document.getElementById('pop-ask').click();
    assert(S.board.openPath.length === 3, 'third column did not open');
    branch2 = S.board.threads[S.board.openPath[2]];
    await idle();
    await settle();
    const len = answerOk(lastCard(branch2.id));
    await snap('04-drill-down');
    return { quote: anchor.quote.slice(0, 80), chars: len, columns: document.querySelectorAll('.column').length };
  });

  await step('run python in the background', async () => {
    const code = [
      'from boardkit import *',
      "show(H * ket('0'), label=r'H\\ket{0}')",
      "show(H * H, label='H^2')",
      "show_state(CNOT * kron(H, I2) * ket('00'), label=r'\\ket{\\Phi^+}')",
      "print('probabilities:', probs(CNOT * kron(H, I2) * ket('00')))",
    ].join('\n');
    const card = app.send(branch2.id, code, 'python');
    await idle();
    await settle();
    const run = card.runs && card.runs[0];
    assert(run, 'no run result');
    assert(run.exitCode === 0, 'python failed: ' + run.stderr);
    assert(/\$\$/.test(run.stdout), 'no LaTeX output');
    await snap('05-python');
    return { ms: run.ms, stdout: run.stdout.slice(0, 160) };
  });

  await step('compute mode writes code, Execute runs it', async () => {
    app.openThread('root');
    const card = app.send('root', String.raw`Compute $(H\otimes H)\,\mathrm{CNOT}\,(H\otimes H)$ and check whether it equals the CNOT with control and target swapped.`, 'compute');
    await idle();
    await settle();
    answerOk(card);
    assert(lastSystem().includes('boardkit'), 'compute mode should switch code on');
    const ce = app.findCardEl(card.id);
    const btn = ce.querySelector('.btn-run');
    assert(btn, 'the compute answer contains no runnable python block');
    btn.click();
    await sleep(300);
    await idle();
    await settle();
    const run = card.runs && card.runs[0];
    assert(run, 'execute produced no result');
    app.findCardEl(card.id).querySelector('.code-out').scrollIntoView({ block: 'center' });
    await settle();
    await snap('06-compute');
    return { exit: run.exitCode, stdout: (run.stdout || '').slice(0, 200), stderr: (run.stderr || '').slice(0, 200) };
  });

  await step('close side questions, back to the original', async () => {
    app.openThread(branch2.id);
    await settle();
    app.closeLast();
    assert(S.board.openPath.length === 2, 'closeLast did not close one level');
    app.closeAll();
    await settle();
    assert(S.board.openPath.length === 1 && document.querySelectorAll('.column').length === 1, 'still showing branches');
    app.cols.get('root').body.scrollTop = 0;
    await settle();
    await snap('07-back-to-original');
    return { threads: Object.keys(S.board.threads).length };
  });

  await step('reload the board from disk, branches intact', async () => {
    const id = S.board.id;
    const before = JSON.stringify(Object.keys(S.board.threads).sort());
    await sleep(1200); // let the debounced save land
    const r = await B.call('selftest', { event: 'reload', id });
    assert(r && r.board, 'no saved board on disk');
    EE.native.openBoard({ json: r.board });
    await settle();
    const after = JSON.stringify(Object.keys(S.board.threads).sort());
    assert(before === after, 'threads differ after reload');
    const reRoot = S.board.threads.root.cards.find((c) => c.id === rootAnswer.id);
    assert(reRoot && reRoot.rating === 3, 'the rating did not survive the reload');
    const chip = document.querySelector('.branch-chip');
    assert(chip, 'no branch chip on the reloaded board');
    chip.click();
    await settle();
    assert(S.board.openPath.length === 2, 'branch did not reopen');
    await snap('08-reopened-after-reload');
    return { threads: Object.keys(S.board.threads).length };
  });

  await step('board summary: covers every side question, links back, is saved, regenerates', async () => {
    const summaryDone = () => waitFor(() => !(S.sums.get(S.board.id) || {}).running, 15 * 60 * 1000, 'the summary');
    const button = (re) => [...document.querySelectorAll('#summary-content .chalk-btn')].find((b) => re.test(b.textContent));
    app.closeAll();
    document.getElementById('btn-summary').click();
    assert(S.summaryOpen && !app.dom.summary.hidden, 'the summary drawer did not open');
    const go = button(/write the summary/);
    assert(go && !go.disabled, 'no "write the summary" button');
    go.click();
    await sleep(300);
    const asked = sent.filter((m) => m.purpose === 'summary').pop();
    assert(asked, 'no summary request was sent');
    for (const t of [branch1, branch2]) assert(asked.messages[1].content.includes(t.title), 'the summary prompt lacks the side question: ' + t.title);
    assert(asked.messages[0].content.includes(NOTE), 'the summary prompt lacks the private notes');
    await summaryDone();
    const failed = S.sums.get(S.board.id);
    assert(!failed, 'summary failed: ' + (failed && failed.error));
    const sum = S.board.summary;
    assert(sum && sum.text.length > 200, 'no summary saved on the board');
    assert(sum.sides >= 2, 'the summary does not cover both side questions');
    const links = [...document.querySelectorAll('#summary-content .sum-link')];
    const toDeep = links.find((l) => l.dataset.thread === branch2.id);
    assert(toDeep, 'no link to the deepest side question');
    toDeep.click();
    await settle();
    assert(S.board.openPath[S.board.openPath.length - 1] === branch2.id, 'the link did not open the side question');
    await snap('09a-summary');
    await sleep(1200); // let the save land
    const r = await B.call('selftest', { event: 'reload', id: S.board.id });
    assert(r && r.board && JSON.parse(r.board).summary && JSON.parse(r.board).summary.text === sum.text, 'the summary was not saved with the board');
    button(/regenerate/).click();
    await sleep(300);
    assert(S.board.summary === sum, 'regenerating dropped the saved summary before the new one was ready');
    await summaryDone();
    assert(!S.sums.get(S.board.id), 'regenerate failed: ' + (S.sums.get(S.board.id) || {}).error);
    assert(S.board.summary !== sum && S.board.summary.createdAt > sum.createdAt, 'regenerate did not replace the summary');
    app.toggleSummary(false);
    app.closeAll();
    return { chars: sum.text.length, links: links.length, model: sum.model, regenerated: S.board.summary.text.length };
  });

  await step('lessons learned: pops up, distils every board, is saved, updates only for new questions', async () => {
    const lessonsDone = () => waitFor(() => !(S.lj && S.lj.running), 15 * 60 * 1000, 'the lessons notebook');
    const boards = () => [...new Map([...S.library, [S.board.id, S.board]]).values()];
    const before = sent.length;
    document.getElementById('btn-lessons').click();
    assert(app.lessonsShown(), 'the lessons pop-up did not open');
    await sleep(300);
    const asked = sent.slice(before).find((m) => m.purpose === 'summary');
    assert(asked, 'no lessons request was sent although nothing had been read yet');
    assert(/lessons learned/.test(asked.messages[0].content), 'the request is not the lessons prompt');
    assert(asked.messages[0].content.includes(NOTE), 'the lessons prompt lacks the private notes');
    await lessonsDone();
    assert(!S.lj, 'the notebook failed: ' + (S.lj && S.lj.error));
    const l = S.lessons;
    assert(l && l.text.length > 200, 'no notebook written');
    assert(!EE.model.newLessonItems(boards(), l).length, 'the notebook did not read every answered question');
    assert(document.querySelector('.lessons-body h3'), 'the notebook is not grouped by topic');
    await snap('09b-lessons');
    const r = await B.call('loadLessons');
    assert(r && r.json && JSON.parse(r.json).text === l.text, 'the notebook was not saved');
    app.toggleLessons(false);
    const n = sent.length;
    app.toggleLessons(true);
    await sleep(500);
    assert(sent.length === n && !S.lj, 'reopening with no new questions asked the model again');
    app.toggleLessons(false);
    return { chars: l.text.length, questions: l.seen.length, model: l.model };
  });

  await step('diagrams: a circuit answer gets its circuit drawn, ◇ adds one, both are saved', async () => {
    if (!app.diagramsOn()) return { skipped: ((S.config.diagram || {}).problems || ['no diagram model'])[0] };
    const dgIdle = () => waitFor(() => S.dgJobs.size === 0, 5 * 60 * 1000, 'the diagram model');
    app.closeAll();
    const card = app.send('root', String.raw`Draw the quantum circuit that prepares the Bell state $\ket{\Phi^+}$ from $\ket{00}$, and explain what each gate does.`, 'explain');
    await idle();
    answerOk(card);
    assert(lastSystem().includes('[[diagram:'), 'the explanation prompt does not offer diagrams');
    assert(/\[\[\s*diagram/i.test(card.text), 'the answer did not ask for a diagram');
    await dgIdle();
    const d = (card.diagrams || {}).m0;
    assert(d && d.spec, 'no diagram was drawn: ' + ((d && d.error) || 'nothing came back'));
    assert(d.spec.type === 'circuit', 'expected a circuit, got ' + d.spec.type);
    const ops = d.spec.ops.map((o) => (o.controls.length ? 'C' : '') + (o.kind === 'gate' ? EE.util.texToText(o.label) : o.kind));
    assert(ops.includes('H') && ops.includes('CX'), 'the circuit lacks H or the CNOT: ' + ops.join(' '));
    const asked = sent.filter((m) => m.purpose === 'diagram').pop();
    assert(asked && asked.messages[1].content.includes('Bell'), 'the diagram model was not given the question');
    const ce = app.findCardEl(card.id);
    const fig = ce.querySelector('.diagram[data-dg="m0"] .dg-canvas svg');
    assert(fig && fig.querySelectorAll('path').length > 5, 'the circuit is not on the board');
    fig.closest('.diagram').scrollIntoView({ block: 'center' });
    await settle();
    await snap('10-diagram');
    ce.querySelector('[data-act="diagram"]').click();
    await sleep(300);
    await dgIdle();
    const x = card.diagrams.x1;
    assert(x && x.spec, 'the ◇ diagram failed: ' + ((x && x.error) || 'nothing came back'));
    await sleep(1200); // let the save land
    const r = await B.call('selftest', { event: 'reload', id: S.board.id });
    const disk = JSON.parse(r.board);
    const dc = Object.values(disk.threads).flatMap((t) => t.cards).find((c) => c.id === card.id);
    assert(dc && dc.diagrams && JSON.stringify(dc.diagrams.m0.spec) === JSON.stringify(d.spec) && dc.diagrams.x1.spec, 'the diagrams were not saved with the board');
    return { model: d.model, circuit: ops.join(' '), extra: x.spec.type, wires: d.spec.wires.length };
  });

  await step('paper: open a PDF, highlight a passage, ask about it, reopen it from disk', async () => {
    app.closeAll();
    const r = opts.pdf ? await B.call('importPdf', { path: opts.pdf }) : await B.call('importPdf', { data: tinyPdf(), name: 'selftest-kickback.pdf' });
    assert(r && r.file, 'the PDF was not imported: ' + JSON.stringify(r));
    const board = app.openPaper(r);
    assert(board && board.pdf && board.pdf.file === r.file, 'no board for the paper');
    await waitFor(() => document.querySelector('.pdf-page[data-page="1"] .textLayer span'), 60000, 'the paper to render');
    await waitFor(() => board.pdf.titled && board.pdf.pages, 10000, 'the paper title and page count');
    const canvas = document.querySelector('.pdf-page[data-page="1"] .pdf-canvas');
    assert(canvas && canvas.width > 100, 'page 1 was not drawn');
    await settle();
    await snap('11-paper');
    // highlight one printed line of page 1, the way a mouse drag would
    const layer = document.querySelector('.pdf-page[data-page="1"] .pdf-text');
    const span = [...layer.querySelectorAll('span')].find((x) => x.textContent.trim().length >= 40) ||
      [...layer.querySelectorAll('span')].find((x) => x.textContent.trim().length >= 12);
    assert(span, 'no line of text on page 1');
    span.scrollIntoView({ block: 'center' });
    await sleep(200);
    const range = document.createRange();
    range.selectNodeContents(span);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const rr = range.getBoundingClientRect();
    layer.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: rr.right - 1, clientY: rr.bottom - 1 }));
    await waitFor(() => !app.dom.popover.hidden, 3000, 'the side-question popover');
    const anchor = S.pending.anchor;
    assert(anchor.cardId === 'pdf:1', 'the anchor is not on page 1: ' + anchor.cardId);
    const chip = [...document.querySelectorAll('#pop-chips .chip')].find((b) => /passage/.test(b.textContent));
    assert(chip, 'the popover does not offer the paper questions');
    const before = Object.keys(board.threads).length;
    chip.click();
    await sleep(300);
    const tid = board.openPath[1];
    assert(Object.keys(board.threads).length === before + 1 && board.threads[tid].anchor.cardId === 'pdf:1', 'no side question on the passage');
    await idle();
    const len = answerOk(lastCard(tid));
    const sys = lastSystem();
    const asked = sent.filter((m) => m.purpose === 'explain').pop().messages;
    assert(sys.includes('THE PAPER') && sys.includes('--- page 1 of'), 'the prompt does not carry the paper');
    assert(/highlighted a passage of the paper/.test(sys), 'the prompt does not say the question is about a passage');
    assert(asked.some((m) => m.role === 'user' && m.content.includes('passage of the paper (page 1)')), 'the passage is not in the question');
    await waitFor(() => document.querySelector('#overlay .chalk-loop'), 5000, 'the chalk circle around the passage');
    await settle();
    await snap('12-paper-question');
    await sleep(1200); // let the save land
    const disk = JSON.parse((await B.call('selftest', { event: 'reload', id: board.id })).board);
    assert(disk.pdf && disk.pdf.file === r.file && disk.threads[tid] && disk.threads[tid].anchor.cardId === 'pdf:1', 'the paper board was not saved');
    const served = await fetch('papers/' + r.file);
    assert(served.ok, 'the PDF is not served from the boards folder');
    return { file: r.file, title: board.title, pages: board.pdf.pages, quote: anchor.quote.slice(0, 60), answer: len, systemChars: sys.length };
  });

  await step('level-set button folds new ratings into the profile', async () => {
    const before = S.profile && S.profile.meta ? S.profile.meta.updatedAt : 0;
    document.getElementById('btn-levelset').click();
    await sleep(300);
    assert(S.ls.running || S.ls.error, 'the level-set did not start');
    await waitFor(() => !S.ls.running, 15 * 60 * 1000, 'the level-set to finish');
    assert(!S.ls.error, 'level-set failed: ' + S.ls.error);
    const p = S.profile;
    assert(p.meta.updatedAt > before, 'profile not updated');
    assert(p.meta.rated >= 1, 'the new rating was not counted');
    const lsPrompt = sent.filter((m) => m.purpose === 'levelset').pop().messages[1].content;
    assert(lsPrompt.includes(NOTE), 'the level-set did not read the private notes');
    assert(p.meta.notes >= 1, 'the profile does not record the notes it read');
    await settle();
    await snap('09-profile-after-ratings');
    app.toggleLearner(false);
    return { level: p.overall.level, topics: p.topics.length, rated: p.meta.rated, top: p.topics.slice().sort((a, b) => b.mastery - a.mastery).slice(0, 3).map((t) => `${t.name}:${t.mastery}`) };
  });

  B.chat = origChat;
  report.finishedAt = new Date().toISOString();
  report.boardId = S.board && S.board.id;
  await log(report.ok ? 'ALL PASSED' : 'SOME STEPS FAILED');
  await B.call('selftest', { event: 'finish', report: JSON.stringify(report) }).catch(() => {});
  return report;
};
