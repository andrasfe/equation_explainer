#!/usr/bin/env node
// Dev harness: serves shared/web in a normal browser and implements the native
// bridge over HTTP (config, chat streaming, python, board storage).
// The desktop apps (Swift on macOS, Python on Linux) do the same work natively; this exists for fast UI iteration
// and browser automation.  Usage: node dev/devserver.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'shared', 'web');
const KIT = path.join(ROOT, 'shared', 'python');
const DATA_ROOT = process.env.EE_DEV_DATA || path.join(ROOT, 'dev', 'data');
const DATA = path.join(DATA_ROOT, 'boards');
const PROFILE = path.join(DATA_ROOT, 'learner.json');
const NOTES = path.join(DATA_ROOT, 'learner-notes.json');
const PORT = Number(process.argv[2] || process.env.PORT || 5178);
// the managed Python environment of the desktop app on this platform
const DATA_HOME = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
  : (process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
const VENV_PY = path.join(process.env.EE_DATA_DIR || path.join(DATA_HOME, 'EquationExplainer'), 'pyenv', 'bin', 'python');
fs.mkdirSync(DATA, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.json': 'application/json' };

function loadEnv() {
  const file = process.env.EE_ENV_FILE || path.join(ROOT, '.env'); // same override as the app
  const vals = { ...process.env };
  if (fs.existsSync(file)) {
    for (let line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('export ')) line = line.slice(7);
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      let v = line.slice(eq + 1).trim();
      if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1); else v = v.replace(/\s+#.*$/, '');
      vals[line.slice(0, eq).trim()] = v;
    }
  }
  const get = (k) => (vals[k] || '').trim() || null;
  const endpoint = (provider) => provider === 'openrouter'
    ? { baseURL: get('OPENROUTER_BASE_URL') || 'https://openrouter.ai/api/v1', apiKey: get('OPENROUTER_API_KEY'), model: get('OPENROUTER_MODEL') || 'anthropic/claude-fable-5.1' }
    : provider === 'custom' || provider === 'openai'
      ? { baseURL: get('LLM_BASE_URL') || 'http://localhost:8080/v1', apiKey: get('LLM_API_KEY'), model: get('LLM_MODEL') }
      : { baseURL: get('LMSTUDIO_BASE_URL') || 'http://localhost:1234/v1', apiKey: get('LMSTUDIO_API_KEY'), model: get('LMSTUDIO_MODEL') };
  const provider = (get('LLM_PROVIDER') || (get('OPENROUTER_API_KEY') ? 'openrouter' : 'lmstudio')).toLowerCase();
  const cfg = { provider, envFile: fs.existsSync(file) ? file : null, problems: [],
    temperature: Number(get('LLM_TEMPERATURE') || 0.3), maxTokens: Number(get('LLM_MAX_TOKENS') || 8192), ...endpoint(provider) };
  if (provider === 'openrouter' && !cfg.apiKey) cfg.problems.push('OPENROUTER_API_KEY is not set');
  // every model the top-bar menu offers: LLM_PROVIDER's first, then the other provider's, plus *_MODELS lists
  const configured = { lmstudio: ['LMSTUDIO_BASE_URL', 'LMSTUDIO_MODEL', 'LMSTUDIO_MODELS', 'LMSTUDIO_API_KEY'].some(get),
    openrouter: !!get('OPENROUTER_API_KEY'), custom: !!get('LLM_BASE_URL') };
  const listKey = { lmstudio: 'LMSTUDIO_MODELS', openrouter: 'OPENROUTER_MODELS', custom: 'LLM_MODELS', openai: 'LLM_MODELS' };
  cfg.choices = [];
  for (const p of [provider, ...['lmstudio', 'openrouter', 'custom'].filter((x) => x !== provider && configured[x])]) {
    const ep = endpoint(p);
    const models = [ep.model];
    // named extras such as OPENROUTER_ALT_MODEL (any PREFIX_<name>_MODEL, by key), then the *_MODELS list
    const pre = listKey[p].slice(0, -7);
    const named = Object.keys(vals).filter((k) => k.startsWith(pre + '_') && k.endsWith('_MODEL') && k.length > pre.length + 7).sort().map(get);
    for (const m of [...named, ...(get(listKey[p]) || '').split(/[\s,]+/)]) if (m && !models.includes(m)) models.push(m);
    for (const m of models) cfg.choices.push({ ...cfg, ...ep, provider: p, model: m, id: `${p}|${m || ''}`, choices: undefined,
      problems: p === 'openrouter' && !ep.apiKey ? ['OPENROUTER_API_KEY is not set'] : [] });
  }
  cfg.choices[0].problems = cfg.problems;
  // level-set model: OpenRouter + openai/gpt-5.6-sol-pro unless overridden
  const lsProvider = (get('LEVELSET_PROVIDER') || 'openrouter').toLowerCase();
  const lsEp = endpoint(lsProvider);
  cfg.levelset = { provider: lsProvider, ...lsEp, model: get('LEVELSET_MODEL') || (lsProvider === 'openrouter' ? 'openai/gpt-5.6-sol-pro' : lsEp.model),
    temperature: get('LEVELSET_TEMPERATURE') ? Number(get('LEVELSET_TEMPERATURE')) : undefined,
    maxTokens: Number(get('LEVELSET_MAX_TOKENS') || 32000), problems: [],
    extra: get('LEVELSET_EXTRA_BODY') ? JSON.parse(get('LEVELSET_EXTRA_BODY')) : (lsProvider === 'openrouter' ? { response_format: { type: 'json_object' } } : {}) };
  if (lsProvider === 'openrouter' && !lsEp.apiKey) cfg.levelset.problems.push(`OPENROUTER_API_KEY is not set in .env. The level-set runs on OpenRouter (${cfg.levelset.model}).`);
  // diagram model: OpenRouter + qwen/qwen3-coder-30b-a3b-instruct unless overridden
  const dgProvider = (get('DIAGRAM_PROVIDER') || 'openrouter').toLowerCase();
  const dgEp = endpoint(dgProvider);
  cfg.diagram = { provider: dgProvider, ...dgEp, model: get('DIAGRAM_MODEL') || (dgProvider === 'openrouter' ? 'qwen/qwen3-coder-30b-a3b-instruct' : dgEp.model),
    temperature: Number(get('DIAGRAM_TEMPERATURE') || 0.2), maxTokens: Number(get('DIAGRAM_MAX_TOKENS') || 4096), problems: [],
    extra: get('DIAGRAM_EXTRA_BODY') ? JSON.parse(get('DIAGRAM_EXTRA_BODY')) : {} };
  if (dgProvider === 'openrouter' && !dgEp.apiKey) cfg.diagram.problems.push(`OPENROUTER_API_KEY is not set in .env. Diagrams are drawn on OpenRouter (${cfg.diagram.model}); set DIAGRAM_PROVIDER=lmstudio to draw them locally.`);
  return cfg;
}

async function resolveModel(cfg) {
  if (cfg.model) return cfg.model;
  const root = cfg.baseURL.replace(/\/v1\/?$/, '');
  try {
    const r = await fetch(root + '/api/v0/models');
    const d = (await r.json()).data || [];
    const llms = d.filter((m) => m.type === 'llm' || m.type === 'vlm');
    const pick = llms.find((m) => m.state === 'loaded') || llms[0];
    if (pick) return pick.id;
  } catch { /* fall through */ }
  const r = await fetch(cfg.baseURL + '/models');
  const d = (await r.json()).data || [];
  const m = d.find((x) => !/embed/i.test(x.id));
  if (!m) throw new Error('No model available at ' + cfg.baseURL);
  return m.id;
}

const readBody = (req) => new Promise((res, rej) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(b)); req.on('error', rej); });
const json = (res, obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const running = new Map();

function runPython(id, code) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eecell-'));
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(dir, 'cell.py'), code);
    const t0 = Date.now();
    const p = spawn(VENV_PY, ['-u', path.join(KIT, 'runner.py'), path.join(dir, 'cell.py'), out], {
      cwd: dir, env: { ...process.env, PYTHONPATH: KIT, MPLBACKEND: 'Agg', MATPLOTLIBRC: path.join(KIT, 'matplotlibrc'), PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.set(id, p);
    let stdout = '', stderr = '', timedOut = false;
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, 120000);
    p.on('close', (codeNum, signal) => {
      clearTimeout(timer);
      running.delete(id);
      const images = fs.readdirSync(out).filter((f) => f.endsWith('.png')).sort()
        .map((f) => 'data:image/png;base64,' + fs.readFileSync(path.join(out, f)).toString('base64'));
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ stdout, stderr, exitCode: codeNum ?? -1, ms: Date.now() - t0, timedOut, cancelled: signal === 'SIGTERM', images, interpreter: VENV_PY });
    });
  });
}

async function bridge(msg) {
  switch (msg.cmd) {
    case 'ready': return { native: false };
    case 'config': {
      const env = loadEnv();
      const c = env.choices.find((x) => x.id === msg.llm) || env.choices[0];
      let model = c.model;
      try { model = await resolveModel(c); } catch (e) { c.problems.push(e.message); }
      const ls = env.levelset, dg = env.diagram;
      const name = (p) => (p === 'openrouter' ? 'OpenRouter' : p === 'custom' || p === 'openai' ? 'Custom' : 'LM Studio');
      return { provider: name(c.provider), model, baseURL: c.baseURL, envFile: env.envFile, problems: c.problems, python: VENV_PY, packages: 'numpy sympy scipy matplotlib',
        llm: c.id, choices: env.choices.map((x) => ({ id: x.id, provider: name(x.provider), model: x.model || '', problems: x.problems })),
        levelset: { provider: name(ls.provider), model: ls.model || 'auto', problems: ls.problems },
        diagram: { provider: name(dg.provider), model: dg.model || 'auto', problems: dg.problems } };
    }
    case 'allBoards':
      return { boards: fs.readdirSync(DATA).filter((f) => f.endsWith('.json')).map((f) => fs.readFileSync(path.join(DATA, f), 'utf8')) };
    case 'loadProfile':
      return { json: fs.existsSync(PROFILE) ? fs.readFileSync(PROFILE, 'utf8') : '' };
    case 'saveProfile':
      fs.writeFileSync(PROFILE, msg.json, { mode: 0o600 });
      return { ok: true };
    case 'loadNotes':
      return { json: fs.existsSync(NOTES) ? fs.readFileSync(NOTES, 'utf8') : '' };
    case 'saveNotes':
      fs.writeFileSync(NOTES, msg.json, { mode: 0o600 });
      return { ok: true };
    case 'python': return runPython(msg.id, msg.code);
    case 'cancel': { const p = running.get(msg.id); if (p) p.kill('SIGTERM'); return { ok: true }; }
    case 'saveBoard': {
      if (!/^[\w-]+$/.test(msg.id)) throw new Error('bad id');
      fs.writeFileSync(path.join(DATA, msg.id + '.json'), msg.json);
      return { ok: true };
    }
    case 'selftest': {
      if (msg.event === 'log') console.log('[selftest]', msg.message);
      if (msg.event === 'reload') return { board: fs.readFileSync(path.join(DATA, msg.id + '.json'), 'utf8') };
      if (msg.event === 'finish') { fs.writeFileSync(path.join(DATA_ROOT, 'selftest-report.json'), msg.report); console.log('[selftest] finished'); }
      return { ok: true };
    }
    default: return { ok: true };
  }
}

async function chat(req, res) {
  const { messages, purpose, llm } = JSON.parse(await readBody(req));
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
  const send = (o) => res.write(JSON.stringify(o) + '\n');
  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());
  try {
    const env = loadEnv();
    const cfg = purpose === 'levelset' ? env.levelset : purpose === 'diagram' ? env.diagram : env.choices.find((x) => x.id === llm) || env.choices[0];
    if (cfg.problems.length) throw new Error(cfg.problems.join('; '));
    const model = await resolveModel(cfg);
    const headers = { 'content-type': 'application/json' };
    if (cfg.apiKey) headers.authorization = 'Bearer ' + cfg.apiKey;
    if (cfg.provider === 'openrouter') Object.assign(headers, { 'HTTP-Referer': 'https://github.com/equation-explainer', 'X-Title': 'Equation Explainer' });
    const r = await fetch(cfg.baseURL + '/chat/completions', {
      method: 'POST', headers, signal: ctrl.signal,
      body: JSON.stringify({ model, messages, stream: true, temperature: cfg.temperature, max_tokens: cfg.maxTokens, ...(cfg.extra || {}) }), // undefined temperature is dropped
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 500)}`);
    const dec = new TextDecoder();
    let buf = '', usedModel = model, finish = null;
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const j = JSON.parse(data);
        if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
        usedModel = j.model || usedModel;
        const ch = (j.choices || [])[0] || {};
        const d = ch.delta || {};
        if (ch.finish_reason) finish = ch.finish_reason;
        const reasoning = d.reasoning_content || d.reasoning || '';
        if (d.content || reasoning) send({ content: d.content || '', reasoning });
      }
    }
    send({ done: true, model: usedModel, finish });
  } catch (e) {
    if (e.name !== 'AbortError') send({ error: e.message });
  }
  res.end();
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/bridge') return json(res, await bridge(JSON.parse(await readBody(req))));
    if (req.method === 'POST' && url.pathname === '/chat') return chat(req, res);
    let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p === '/') p = '/index.html';
    const file = path.join(WEB, p);
    if (!file.startsWith(WEB) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}).listen(PORT, '127.0.0.1', () => console.log(`dev harness on http://127.0.0.1:${PORT}`));
