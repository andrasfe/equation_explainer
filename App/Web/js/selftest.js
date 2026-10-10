/* End-to-end self test. Runs inside the real app (or the dev harness) and
 * exercises the same code paths a person would: prompt → highlight → side
 * question → drill deeper → run Python → compute mode → close back to the
 * original → reload from disk → reopen a branch.
 */
EE.selfTest = async function selfTest(opts = {}) {
  const app = EE.app, S = app.S, B = EE.bridge, sleep = EE.util.sleep;
  const report = { ok: true, steps: [], startedAt: new Date().toISOString() };
  const log = (message) => { console.log('[selftest] ' + message); return B.call('selftest', { event: 'log', message }).catch(() => {}); };
  const snap = (name) => B.call('selftest', { event: 'snapshot', name }).catch((e) => log('snapshot failed: ' + e.message));
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

  await log('self test starting');
  let rootAnswer, branch1, branch2;

  await step('model configuration', async () => {
    const c = await B.call('config');
    assert(c.provider && c.model, 'no provider/model: ' + JSON.stringify(c));
    return { provider: c.provider, model: c.model, envFile: c.envFile, problems: c.problems };
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

  await step('explain an equation (root)', async () => {
    const prompt = opts.prompt || String.raw`Explain the Hadamard gate: why is $H\ket{0} = \frac{1}{\sqrt{2}}\left(\ket{0}+\ket{1}\right)$, and why is $H^2 = I$? Use the matrix form.`;
    rootAnswer = app.send('root', prompt, 'explain');
    await idle();
    await settle();
    const len = answerOk(rootAnswer);
    const katexCount = app.findCardEl(rootAnswer.id).querySelectorAll('.katex').length;
    assert(katexCount > 0, 'no rendered math in the answer');
    await snap('01-root-answer');
    return { chars: len, formulas: katexCount };
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
    app.drawOverlay();
    const loops = document.querySelectorAll('#overlay .chalk-loop').length;
    await snap('03-side-question');
    return { quote: anchor.quote.slice(0, 80), llmText: anchor.llmText.slice(0, 120), partial: anchor.partial.length, chars: len, chalkCircles: loops };
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
    const chip = document.querySelector('.branch-chip');
    assert(chip, 'no branch chip on the reloaded board');
    chip.click();
    await settle();
    assert(S.board.openPath.length === 2, 'branch did not reopen');
    await snap('08-reopened-after-reload');
    return { threads: Object.keys(S.board.threads).length };
  });

  report.finishedAt = new Date().toISOString();
  report.boardId = S.board && S.board.id;
  await log(report.ok ? 'ALL PASSED' : 'SOME STEPS FAILED');
  await B.call('selftest', { event: 'finish', report: JSON.stringify(report) }).catch(() => {});
  return report;
};
