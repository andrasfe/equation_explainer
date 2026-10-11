/* Diagrams for circuits and architectures.
 *
 * The explanation model marks the spot where a picture helps with a line
 * "[[diagram: what to draw]]". A separate model (DIAGRAM_MODEL, OpenRouter by
 * default) turns that request into a small JSON spec, and this module lays the
 * spec out and draws it in chalk: circuits on wires (quantum or classical
 * gates), or graphs of components and how data flows between them (dagre).
 */
EE.diagram = (() => {
  const { esc, rng, hash, truncate } = EE.util;

  // ------------------------------------------------------------ markers in an answer
  const MARK = /\[\[\s*diagram\b\s*:?\s*([\s\S]*?)\s*\]\]/gi;
  const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

  /** Swap each marker for a placeholder token. While streaming, hide a marker that is not finished yet. */
  function extract(text, streaming = false) {
    const requests = [];
    let out = String(text || '').replace(MARK, (m, req) => {
      requests.push(oneLine(req));
      return `\n\nEEDIAG${requests.length - 1}X\n\n`;
    });
    if (streaming) out = out.replace(/\[\[[^\]]{0,600}$/, '');
    return { text: out, requests };
  }

  /** Rendered answer HTML with the placeholder tokens turned into empty diagram slots. */
  const slots = (html) => html.replace(/(?:<p>\s*)?EEDIAG(\d+)X(?:\s*<\/p>)?/g,
    (m, i) => `<div class="diagram" data-dg="m${i}" data-noanchor=""></div>`);

  /** An answer as text for other prompts: each marker becomes "(diagram: …)". */
  const plain = (text) => String(text || '').replace(MARK, (m, req) => `(diagram: ${oneLine(req)})`);

  // ------------------------------------------------------------ prompts
  /** Added to the explanation model's system prompt when diagrams are available. */
  const RULE = String.raw`

Diagrams: when the explanation involves a circuit (quantum gates acting on qubits, or a classical logic or reversible circuit) or an architecture (the components of a model, an algorithm or a system and how data flows between them), ask for a picture by writing [[diagram: what to draw]] on a line of its own, at the point where the picture helps. Describe it completely in one or two sentences: for a circuit, every wire with its starting state and every gate in order; for an architecture, every component and every connection. A separate tool draws it. Never draw ASCII art or write diagram code (TikZ, quantikz, Mermaid) yourself. At most two diagrams per answer, and none when no circuit or architecture is involved.`;

  const SYSTEM = String.raw`You draw diagrams for a chalkboard tutoring app about mathematics, physics, quantum computing and machine learning. You receive an explanation from the board and a request. Reply with ONE JSON object describing the diagram: no prose, no code fences, no comments.

Labels are short plain text with any mathematics in $...$ as LaTeX, for example "$R_y(\theta)$", "$\ket{0}$" or "softmax". Inside JSON strings every backslash is doubled: "$\\ket{0}$".

KIND 1: "circuit", for quantum circuits, and for reversible circuits of NOT, CNOT and Toffoli gates.
{"type":"circuit","title":"Bell state preparation",
 "wires":["$q_0$","$q_1$"],
 "init":["$\\ket{0}$","$\\ket{0}$"],
 "ops":[
  {"gate":"H","on":[0]},
  {"gate":"X","on":[1],"controls":[0]},
  {"gate":"measure","on":[0,1]}
 ]}
- wires: labels from top to bottom. init (optional): each wire's starting state. outputs (optional): a label at the right end of each wire, "" for none.
- ops run in time order. "on" lists wire indices, counted from 0.
- A one-qubit gate (H, X, Y, Z, S, T, "$S^\\dagger$", "$R_y(\\theta)$", "$P(\\phi)$", ...) that lists several wires in "on" acts on each of them.
- "controls": control wires (filled dots). "anticontrols": controls that fire on $\ket{0}$ (open dots). A controlled X is drawn as the CNOT target. A Toffoli is {"gate":"X","on":[2],"controls":[0,1]}.
- {"gate":"SWAP","on":[0,1]} swaps two wires.
- A block acting on several wires at once (an oracle "$U_f$", the diffusion operator, "QFT", "$U^{2^k}$", an adder) has "box":true and lists all of its wires in "on". It may have controls.
- {"gate":"measure","on":[0,1]} measures wires.
- {"barrier":true,"label":"..."} draws a dashed separator with an optional note, such as "repeat $\\approx \\frac{\\pi}{4}\\sqrt{N}$ times".
- "stage": a short name shared by consecutive ops, such as "oracle" or "diffusion". Each stage gets a labelled frame.
- Use the gate names and wire labels of the explanation. At most 16 wires and 60 ops. For a long repeated structure, draw one round and give the number of repetitions in a barrier label.

KIND 2: "graph", for the architecture of a model, an algorithm or a system: its components and how data flows between them. Also pipelines, block diagrams, feedback loops, and classical logic circuits (each AND, OR or XOR gate is a "round" node, and its input signals are edges into it).
{"type":"graph","title":"Transformer encoder layer","direction":"TB",
 "nodes":[
  {"id":"x","label":"input embeddings","note":"$n \\times d$","shape":"data"},
  {"id":"attn","label":"multi-head attention","group":"layer"},
  {"id":"add1","label":"$+$","shape":"circle","group":"layer"},
  {"id":"ffn","label":"feed-forward","group":"layer"},
  {"id":"add2","label":"$+$","shape":"circle","group":"layer"},
  {"id":"y","label":"output","shape":"data"}
 ],
 "edges":[
  {"from":"x","to":"attn","label":"$Q, K, V$"},
  {"from":"x","to":"add1","label":"residual","style":"dashed"},
  {"from":"attn","to":"add1"},
  {"from":"add1","to":"ffn"},
  {"from":"add1","to":"add2","style":"dashed"},
  {"from":"ffn","to":"add2"},
  {"from":"add2","to":"y"}
 ],
 "groups":[{"id":"layer","label":"encoder layer, repeated $N$ times"}]}
- shape: "box" (a component or layer; the default), "round" (an operation or step), "circle" (a small operator such as $+$, $\times$, $\otimes$ or $\sigma$), "diamond" (a decision), "data" (inputs, outputs, tensors), "store" (memory, a database, a cache), "stack" (a block repeated several times).
- note (optional): a second, smaller line under the label, such as a shape or a short formula.
- Edges point the way data flows. Their label is optional and short. "style":"dashed" marks skip connections and optional paths.
- group: a labelled frame around related nodes, such as a layer, a module or a machine. Use groups sparingly.
- direction: "TB" (top to bottom) for most diagrams, "LR" (left to right) only for short chains of up to five steps.
- Draw every component and connection the request names. To show the inside of a block that repeats, draw its parts once inside a group whose label gives the number of repeats (as in the example), not one box for the whole stack.
- 3 to 30 nodes. Keep each label to about five words; put a formula in the note.

Pick the kind that fits: wires and gates make a circuit; components and data flow make a graph. Draw what the request and the explanation describe, using their names, and add nothing that is not there.`;

  const MANUAL = 'the most useful diagram for this explanation: its circuit or its architecture if it has one; otherwise a graph of how its main ideas lead to one another.';

  /** The answer as the diagram model sees it: no code, markers spelled out, capped. */
  function forPrompt(text, cap = 9000) {
    let i = 0;
    const s = String(text || '')
      .replace(/```[\s\S]*?```/g, ' [code] ')
      .replace(MARK, (m, req) => `[diagram ${++i} goes here: ${oneLine(req)}]`)
      .replace(/\n{3,}/g, '\n\n').trim();
    return s.length > cap ? s.slice(0, cap) + ' …' : s;
  }

  /** Chat messages asking the diagram model for one diagram. `request` empty = pick the best diagram. */
  function messages({ question, quote, answer, request }) {
    const lines = [`The student asked: "${truncate(question || '', 1500)}"`];
    if (quote) lines.push(`This was a side question about this part of an earlier explanation: "${truncate(quote, 500)}"`);
    lines.push('', 'The explanation on the board (abridged):', forPrompt(answer), '', `Draw this: ${request || MANUAL}`, '',
      'Include every component, gate and connection named above. Where it describes the inside of a repeated block, draw the inside once, in a group whose label gives the number of repeats.',
      'Reply with the JSON object only.');
    return [{ role: 'system', content: SYSTEM }, { role: 'user', content: lines.join('\n') }];
  }

  // ------------------------------------------------------------ parsing the model's reply
  const str = (x) => (typeof x === 'string' ? x.trim() : typeof x === 'number' ? String(x) : '');
  const list = (x) => (Array.isArray(x) ? x : x == null || x === '' ? [] : [x]);
  const bare = (s) => str(s).replace(/\\(?:mathrm|text|operatorname)/g, '').replace(/[$\\{}\s]/g, '').toLowerCase();
  const ONE_QUBIT = /^(h|x|y|z|s|t|i|id|not|v|sx|sdg|tdg|√x|sqrtx|[st]\^?dagger|[st]†|r_?[xyz].*|p\(.*|phase.*|u[123]?\(.*|u_?3.*)$/;

  /** Parse and check the diagram model's reply. Throws an Error that says what to fix. */
  function parse(text) {
    const body = EE.render.splitThink(String(text || '')).body;
    const a = body.indexOf('{'), b = body.lastIndexOf('}');
    if (a === -1 || b <= a) throw new Error('there is no JSON object in the reply');
    const json = body.slice(a, b + 1);
    let raw;
    try {
      raw = JSON.parse(EE.model.repairJson(json)); // \theta written with one backslash would parse as a tab
    } catch (e) {
      try { raw = JSON.parse(json); } catch (e2) { throw new Error(`the JSON does not parse (${e2.message})`); }
    }
    return normalize(raw);
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the reply is not a JSON object');
    if (raw.diagram && typeof raw.diagram === 'object') raw = raw.diagram;
    const type = str(raw.type || raw.kind).toLowerCase();
    if (type === 'circuit' || (!type && (raw.ops || raw.gates))) return circuit(raw);
    if (type === 'graph' || (!type && raw.nodes)) return graph(raw);
    throw new Error('"type" must be "circuit" or "graph"');
  }

  function circuit(raw) {
    const wires = list(raw.wires || raw.qubits || raw.registers).map((w) => (w && typeof w === 'object' ? str(w.label || w.name || w.id) : str(w)));
    const init = list(raw.init || raw.initial || raw.inputs).map((w) => (w && typeof w === 'object' ? str(w.label || w.state) : str(w)));
    list(raw.wires || raw.qubits).forEach((w, i) => { if (w && typeof w === 'object' && !init[i]) init[i] = str(w.init || w.state); });
    const outputs = list(raw.outputs || raw.out).map((w) => (w && typeof w === 'object' ? str(w.label) : str(w)));
    // a stage may also be a header op ({"stage":"oracle"}) for the ops after it, or wrap its own "ops"
    const opsIn = [];
    let current = '';
    const flatten = (items, inherited) => list(items).forEach((o) => {
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        const name = str(o.stage || o.group || o.section);
        const nested = o.ops || o.gates;
        if (nested) { flatten(nested, name || inherited); return; }
        if (name && !(o.gate || o.name || o.op || o.on || o.targets || o.target || o.barrier)) { current = name; return; }
        opsIn.push({ ...o, stage: name || inherited || current, fromHeader: !name && !inherited && !!current });
      } else opsIn.push(o);
    });
    flatten(raw.ops || raw.gates || raw.operations || raw.steps, '');
    if (!opsIn.length) throw new Error('a circuit needs a non-empty "ops" list');
    if (opsIn.length > 120) throw new Error(`${opsIn.length} ops is too many; draw one round with at most 60`);
    const byLabel = new Map(wires.map((w, i) => [bare(w), i]));
    const wire = (v) => {
      if (typeof v === 'number') return v;
      const s = str(v);
      if (/^\d+$/.test(s)) return Number(s);
      return byLabel.has(bare(s)) ? byLabel.get(bare(s)) : NaN;
    };
    const ws = (v) => list(v).map(wire);
    const ops = [];
    let top = -1;
    opsIn.forEach((o, k) => {
      if (typeof o === 'string') o = { gate: o, stage: current };
      if (!o || typeof o !== 'object') throw new Error(`op ${k} is not an object`);
      const stage = str(o.stage || o.group || o.section);
      let gate = str(o.gate || o.name || o.op || o.type || o.label);
      if (o.barrier === true || /^barrier$/i.test(gate)) {
        const note = [o.label, o.note, o.text].map(str).find((s) => s && !/^barrier$/i.test(s)) || '';
        ops.push({ kind: 'barrier', label: note, on: [], controls: [], anti: [], stage });
        return;
      }
      let on = ws(o.on ?? o.targets ?? o.target ?? o.qubits ?? o.wires ?? o.qubit ?? o.wire);
      let controls = ws(o.controls ?? o.control ?? o.ctrl);
      const anti = ws(o.anticontrols ?? o.anticontrol ?? o.negcontrols ?? o.open_controls);
      const g = bare(gate);
      if (/^(cnot|cx)$/.test(g) && !controls.length && on.length === 2) { controls = [on[0]]; on = [on[1]]; }
      else if (/^(ccx|ccnot|toffoli)$/.test(g) && !controls.length && on.length === 3) { controls = on.slice(0, 2); on = [on[2]]; }
      else if (g === 'cz' && !controls.length && on.length === 2) { controls = [on[0]]; on = [on[1]]; }
      if (/^(cnot|cx|ccx|ccnot|toffoli|not)$/.test(g)) gate = 'X';
      else if (g === 'cz') gate = 'Z';
      else if (g === 'sdg') gate = '$S^\\dagger$';
      else if (g === 'tdg') gate = '$T^\\dagger$';
      else if (g === 'sx') gate = '$\\sqrt{X}$';
      if (!on.length) throw new Error(`op ${k} (${gate || 'unnamed'}) has no wires in "on"`);
      const all = [...on, ...controls, ...anti];
      if (all.some((w) => !Number.isInteger(w) || w < 0)) throw new Error(`op ${k} (${gate}) refers to a wire that does not exist`);
      top = Math.max(top, ...all);
      const base = { controls, anti, stage };
      if (/^(measure|measurement|meas|m|mz)$/.test(g)) { // a measurement at the end is not part of the last stage header
        on.forEach((w) => ops.push({ kind: 'measure', on: [w], controls: [], anti: [], stage: o.fromHeader ? '' : stage }));
        return;
      }
      if (g === 'swap') {
        if (on.length !== 2) throw new Error(`op ${k}: SWAP needs exactly two wires in "on"`);
        ops.push({ kind: 'swap', on, ...base });
        return;
      }
      const label = gate || 'U';
      if (o.box === true || (on.length > 1 && !ONE_QUBIT.test(g))) ops.push({ kind: 'gate', label, on, box: true, ...base });
      else if (controls.length || anti.length) ops.push({ kind: 'gate', label, on, ...base });
      else on.forEach((w) => ops.push({ kind: 'gate', label, on: [w], controls: [], anti: [], stage }));
    });
    const n = Math.max(wires.length, top + 1);
    if (n > 24) throw new Error(`${n} wires is too many; draw at most 16`);
    for (let i = wires.length; i < n; i++) wires.push(`$q_{${i}}$`);
    return {
      type: 'circuit', title: str(raw.title), wires,
      init: wires.map((_, i) => str(init[i])), outputs: wires.map((_, i) => str(outputs[i])), ops,
    };
  }

  const SHAPES = new Set(['box', 'round', 'circle', 'diamond', 'data', 'store', 'stack']);
  const SHAPE_ALIAS = {
    rect: 'box', rectangle: 'box', component: 'box', layer: 'box', module: 'box', block: 'box',
    process: 'round', op: 'round', operation: 'round', step: 'round', ellipse: 'round', oval: 'round', pill: 'round', function: 'round',
    operator: 'circle', sum: 'circle', junction: 'circle', decision: 'diamond', rhombus: 'diamond', condition: 'diamond',
    input: 'data', output: 'data', io: 'data', tensor: 'data', parallelogram: 'data',
    database: 'store', db: 'store', cylinder: 'store', memory: 'store', cache: 'store', storage: 'store',
    repeat: 'stack', repeated: 'stack', stacked: 'stack',
  };

  function graph(raw) {
    const nodesIn = list(raw.nodes || raw.components || raw.blocks);
    if (!nodesIn.length) throw new Error('a graph needs a non-empty "nodes" list');
    if (nodesIn.length > 80) throw new Error(`${nodesIn.length} nodes is too many; use at most 30`);
    const nodes = [], ids = new Map(), byLabel = new Map();
    nodesIn.forEach((n, i) => {
      if (typeof n === 'string') n = { id: n, label: n };
      if (!n || typeof n !== 'object') return;
      let id = str(n.id ?? n.name ?? n.key) || str(n.label) || 'n' + i;
      while (ids.has(id)) id += "'";
      const s = str(n.shape || n.kind || n.type).toLowerCase();
      const node = {
        id, label: str(n.label ?? n.name ?? n.title) || id, note: str(n.note || n.detail || n.sublabel || n.subtitle),
        shape: SHAPES.has(s) ? s : SHAPE_ALIAS[s] || 'box', group: str(n.group || n.parent || n.cluster),
      };
      ids.set(id, node);
      byLabel.set(bare(node.label), node);
      nodes.push(node);
    });
    const find = (v) => {
      const s = str(v && typeof v === 'object' ? v.id : v);
      return ids.get(s) || byLabel.get(bare(s));
    };
    const edges = [], bad = [];
    list(raw.edges || raw.links || raw.connections || raw.arrows).forEach((e) => {
      if (Array.isArray(e)) e = { from: e[0], to: e[1], label: e[2] };
      if (!e || typeof e !== 'object') return;
      const from = e.from ?? e.source ?? e.src, to = e.to ?? e.target ?? e.dst;
      const a = find(from), b = find(to);
      if (!a || !b) { bad.push(`${str(from)} -> ${str(to)}`); return; }
      edges.push({ from: a.id, to: b.id, label: str(e.label), dashed: e.dashed === true || /dash|dot/i.test(str(e.style)) });
    });
    if (bad.length && bad.length >= Math.max(2, edges.length)) throw new Error(`these edges name nodes that do not exist: ${bad.slice(0, 5).join(', ')}`);
    const groups = new Map();
    list(raw.groups || raw.clusters || raw.subgraphs).forEach((g, i) => {
      if (typeof g === 'string') g = { id: g, label: g };
      if (!g || typeof g !== 'object') return;
      const id = str(g.id ?? g.name ?? g.label) || 'g' + i;
      groups.set(id, { id, label: str(g.label ?? g.name ?? g.title), parent: str(g.parent || g.group) });
      for (const m of list(g.nodes || g.members || g.children)) { const n = find(m); if (n && !n.group) n.group = id; }
    });
    for (const n of nodes) if (n.group && !groups.has(n.group)) groups.set(n.group, { id: n.group, label: n.group, parent: '' });
    for (const g of groups.values()) {
      // no dangling parents, no cycles
      const seen = new Set([g.id]);
      for (let p = g.parent; p; p = (groups.get(p) || {}).parent) {
        if (!groups.has(p) || seen.has(p)) { g.parent = ''; break; }
        seen.add(p);
      }
    }
    // a frame with nothing in it has no size; drop it
    const used = new Set();
    for (const n of nodes) for (let p = n.group; p && !used.has(p); p = groups.get(p).parent) used.add(p);
    let dir = str(raw.direction || raw.rankdir).toUpperCase();
    if (!['LR', 'TB', 'RL', 'BT'].includes(dir)) dir = 'TB';
    if ((dir === 'LR' || dir === 'RL') && longestChain(nodes, edges) > 5) dir = 'TB'; // too wide for a column
    return {
      type: 'graph', title: str(raw.title), direction: dir,
      nodes, edges, groups: [...groups.values()].filter((g) => used.has(g.id)),
    };
  }

  /** Nodes on the longest path through the graph (cycles are cut). */
  function longestChain(nodes, edges) {
    const out = new Map(nodes.map((n) => [n.id, []]));
    for (const e of edges) out.get(e.from).push(e.to);
    const memo = new Map(), busy = new Set();
    const len = (id) => {
      if (memo.has(id)) return memo.get(id);
      if (busy.has(id)) return 0;
      busy.add(id);
      const v = 1 + Math.max(0, ...out.get(id).map(len));
      busy.delete(id);
      memo.set(id, v);
      return v;
    };
    return Math.max(0, ...nodes.map((n) => len(n.id)));
  }

  // ------------------------------------------------------------ drawing
  /** A label: plain text with $…$ math (bare LaTeX is treated as math). */
  function labelHTML(s) {
    s = String(s || '').replace(/\$\$/g, '$');
    if (!s.includes('$') && /[\\^_]/.test(s)) s = `$${s}$`;
    return s.split(/(\$[^$]+\$)/g).map((p) => (p.length > 2 && p[0] === '$' && p[p.length - 1] === '$'
      ? EE.render.katexHTML(p.slice(1, -1), false)
      : esc(p).replace(/\n/g, '<br>'))).join('');
  }

  let host = null;
  /** Lay out every label offscreen once and record its size. */
  function measureAll(items) {
    if (!host) {
      host = document.createElement('div');
      host.className = 'dg-measure';
      host.setAttribute('aria-hidden', 'true');
      document.body.append(host);
    }
    const nodes = items.map((it) => {
      const d = document.createElement('div');
      d.className = 'dg-l ' + it.cls;
      d.innerHTML = it.html;
      host.append(d);
      return d;
    });
    nodes.forEach((d, i) => {
      const r = d.getBoundingClientRect();
      items[i].w = Math.ceil(r.width);
      items[i].h = Math.ceil(r.height);
    });
    host.replaceChildren();
  }

  const f = (n) => String(Math.round(n * 10) / 10);

  /** Hand-drawn strokes: a little wobble, the same every time for the same diagram. */
  function pen(seed) {
    const rnd = rng(seed);
    const j = (a) => (rnd() - 0.5) * a;
    return {
      line(x1, y1, x2, y2, amp = 1.2) {
        const len = Math.hypot(x2 - x1, y2 - y1) || 1;
        const bow = j(Math.min(amp * 2, len / 40));
        const mx = (x1 + x2) / 2 - ((y2 - y1) / len) * bow, my = (y1 + y2) / 2 + ((x2 - x1) / len) * bow;
        return `M${f(x1 + j(0.5))},${f(y1 + j(0.5))} Q${f(mx)},${f(my)} ${f(x2 + j(0.5))},${f(y2 + j(0.5))}`;
      },
      rect(x, y, w, h, r = 5) {
        r = Math.min(r, w / 2, h / 2);
        const k = 0.7;
        return `M${f(x + r)},${f(y + j(k))} L${f(x + w - r)},${f(y + j(k))} Q${f(x + w)},${f(y)} ${f(x + w + j(k))},${f(y + r)}` +
          ` L${f(x + w + j(k))},${f(y + h - r)} Q${f(x + w)},${f(y + h)} ${f(x + w - r)},${f(y + h + j(k))}` +
          ` L${f(x + r)},${f(y + h + j(k))} Q${f(x)},${f(y + h)} ${f(x + j(k))},${f(y + h - r)}` +
          ` L${f(x + j(k))},${f(y + r)} Q${f(x)},${f(y)} ${f(x + r)},${f(y + j(k) * 0.3)} Z`;
      },
      ellipse(cx, cy, rx, ry) {
        const start = rnd() * Math.PI * 2, steps = 30;
        let d = '';
        for (let k = 0; k <= steps; k++) {
          const a = start + (Math.PI * 2 * k) / steps, q = 1 + j(0.05);
          d += `${k ? 'L' : 'M'}${f(cx + rx * q * Math.cos(a))},${f(cy + ry * q * Math.sin(a))}`;
        }
        return d + 'Z';
      },
      poly(pts) {
        return pts.map(([x, y], k) => `${k ? 'L' : 'M'}${f(x + j(0.8))},${f(y + j(0.8))}`).join('') + 'Z';
      },
    };
  }

  /** A smooth curve through dagre's edge points. */
  function smooth(pts) {
    let d = `M${f(pts[0].x)},${f(pts[0].y)}`;
    if (pts.length === 2) return d + ` L${f(pts[1].x)},${f(pts[1].y)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      d += ` C${f(p1.x + (p2.x - p0.x) / 6)},${f(p1.y + (p2.y - p0.y) / 6)} ${f(p2.x - (p3.x - p1.x) / 6)},${f(p2.y - (p3.y - p1.y) / 6)} ${f(p2.x)},${f(p2.y)}`;
    }
    return d;
  }

  function arrowHead(from, to, size = 9) {
    const a = Math.atan2(to.y - from.y, to.x - from.x);
    const p = (s) => `${f(to.x - size * Math.cos(a + s))},${f(to.y - size * Math.sin(a + s))}`;
    return `M${p(0.45)} L${f(to.x)},${f(to.y)} L${p(-0.45)}`;
  }

  /** Collects absolutely positioned labels over the SVG. */
  function labels() {
    const out = [];
    return {
      out,
      put(l, x, y, align = 'c', extra = '') {
        const left = align === 'r' ? x - l.w : align === 'l' ? x : x - l.w / 2;
        out.push(`<div class="dg-l ${l.cls}${extra ? ' ' + extra : ''}" style="left:${f(left)}px;top:${f(y - l.h / 2)}px;width:${l.w + 1}px">${l.html}</div>`);
        return { left, right: left + l.w, top: y - l.h / 2 };
      },
    };
  }

  const isNot = (o) => /^(x|not|⊕|\\oplus)$/i.test(bare(o.label));

  function drawCircuit(spec, seed) {
    const P = pen(seed);
    const n = spec.wires.length;
    const L = [];
    const lab = (html, cls) => { const it = { html, cls }; L.push(it); return it; };
    const wl = spec.wires.map((w) => lab(labelHTML(w), 'dg-wire'));
    const il = spec.init.map((w) => (w ? lab(labelHTML(w), 'dg-wire') : null));
    const ol = spec.outputs.map((w) => (w ? lab(labelHTML(w), 'dg-wire') : null));
    const ops = spec.ops.map((o) => ({
      ...o,
      lab: o.kind === 'gate' && !(isNot(o) && !o.box && (o.controls.length || o.anti.length)) ? lab(labelHTML(o.label), 'dg-gate') : null,
      note: o.kind === 'barrier' && o.label ? lab(labelHTML(o.label), 'dg-note') : null,
    }));

    // columns: each op goes to the first column free on every wire it spans; a stage starts in fresh columns
    const last = new Array(n).fill(-1);
    const colOps = [];
    const runs = [];
    let prev = null;
    for (const o of ops) {
      const stage = o.stage || '';
      if (stage !== prev) {
        const m = Math.max(...last);
        last.fill(m);
        if (stage) runs.push({ stage, c1: m + 1, c2: m + 1, lab: lab(labelHTML(stage), 'dg-stage') });
        o.fresh = prev !== null;
        prev = stage;
      }
      const wires = [...o.on, ...o.controls, ...o.anti];
      const lo = o.kind === 'barrier' ? 0 : Math.min(...wires), hi = o.kind === 'barrier' ? n - 1 : Math.max(...wires);
      const c = Math.max(...last.slice(lo, hi + 1)) + 1;
      for (let w = lo; w <= hi; w++) last[w] = c;
      if (o.kind === 'barrier') last.fill(c);
      o.col = c;
      (colOps[c] = colOps[c] || []).push(o);
      if (stage) runs[runs.length - 1].c2 = Math.max(runs[runs.length - 1].c2, c);
    }
    measureAll(L);

    const opW = (o) => (o.kind === 'barrier' ? 12 : o.kind === 'measure' ? 34 : o.kind === 'swap' ? 18 : o.lab ? Math.max(32, o.lab.w + 16) : 26);
    const nCols = colOps.length;
    const colW = [], colPad = [];
    for (let c = 0; c < nCols; c++) {
      const os = colOps[c] || [];
      colW[c] = Math.max(14, ...os.map(opW));
      colPad[c] = os.some((o) => o.fresh) ? 12 : 0;
    }
    const gateH = Math.max(30, ...ops.filter((o) => o.lab).map((o) => o.lab.h + 10));
    const ROW = Math.max(46, gateH + 16);
    const tops = [...runs.map((r) => r.lab), ...ops.filter((o) => o.note).map((o) => o.note)];
    const T = 10 + (tops.length ? Math.max(...tops.map((l) => l.h)) + 8 : 0);
    const wy = (i) => T + ROW / 2 + i * ROW;
    const H = T + n * ROW + 8;
    const wlW = Math.max(0, ...wl.map((l) => l.w));
    const ilW = Math.max(0, ...il.filter(Boolean).map((l) => l.w));
    const x0 = 10 + wlW + (ilW ? 10 + ilW : 0) + 8;
    let x = x0 + 14;
    const cx = [];
    for (let c = 0; c < nCols; c++) { x += colPad[c]; cx[c] = x + colW[c] / 2; x += colW[c] + 12; }
    const xe = x + 4;
    const olW = Math.max(0, ...ol.filter(Boolean).map((l) => l.w));
    let W = xe + (olW ? 8 + olW : 0) + 10;

    const svg = [];
    const lb = labels();
    const room = (r) => { W = Math.max(W, r.right + 8); };
    for (const r of runs) {
      const x1 = cx[r.c1] - colW[r.c1] / 2 - 7, x2 = cx[r.c2] + colW[r.c2] / 2 + 7;
      const y1 = wy(0) - ROW / 2 + 3, y2 = wy(n - 1) + ROW / 2 - 3;
      svg.push(`<path class="dg-frame" d="${P.rect(x1, y1, x2 - x1, y2 - y1, 8)}"/>`);
      room(lb.put(r.lab, x1 + 4, y1 - 3 - r.lab.h / 2, 'l'));
    }
    for (let i = 0; i < n; i++) {
      const y = wy(i);
      const m = ops.find((o) => o.kind === 'measure' && o.on[0] === i);
      const xm = m ? cx[m.col] + 8 : xe;
      svg.push(`<path class="dg-wire" d="${P.line(x0, y, xm, y, 0.8)}"/>`);
      if (m && xe > xm + 2) svg.push(`<path class="dg-wire" d="${P.line(xm, y - 2, xe, y - 2, 0.4)} ${P.line(xm, y + 2, xe, y + 2, 0.4)}"/>`);
      lb.put(wl[i], 10 + wlW, y, 'r');
      if (il[i]) lb.put(il[i], x0 - 6, y, 'r');
      if (ol[i]) lb.put(ol[i], xe + 8, y, 'l');
    }
    for (const o of ops) {
      const x = cx[o.col];
      if (o.kind === 'barrier') {
        svg.push(`<path class="dg-barrier" d="${P.line(x, wy(0) - ROW / 2 + 6, x, wy(n - 1) + ROW / 2 - 6, 0.6)}"/>`);
        if (o.note) room(lb.put(o.note, x, T - 4 - o.note.h / 2));
        continue;
      }
      const ys = [...o.on, ...o.controls, ...o.anti].map(wy);
      const yTop = Math.min(...ys), yBot = Math.max(...ys);
      if (yBot > yTop) svg.push(`<path class="dg-link" d="${P.line(x, yTop, x, yBot, 0.6)}"/>`);
      for (const w of o.controls) svg.push(`<path class="dg-dot" d="${P.ellipse(x, wy(w), 4.8, 4.8)}"/>`);
      for (const w of o.anti) svg.push(`<path class="dg-open" d="${P.ellipse(x, wy(w), 4.8, 4.8)}"/>`);
      if (o.kind === 'measure') {
        const y = wy(o.on[0]);
        svg.push(`<path class="dg-box" d="${P.rect(x - 15, y - 13, 30, 26, 4)}"/>`,
          `<path d="M${f(x - 10)},${f(y + 6)} Q${f(x)},${f(y - 9)} ${f(x + 10)},${f(y + 6)}"/>`,
          `<path d="${P.line(x, y + 6, x + 8, y - 8, 0.3)}"/>`);
      } else if (o.kind === 'swap') {
        for (const w of o.on) {
          const y = wy(w);
          svg.push(`<path d="${P.line(x - 6, y - 6, x + 6, y + 6, 0.3)} ${P.line(x - 6, y + 6, x + 6, y - 6, 0.3)}"/>`);
        }
      } else if (o.box) {
        const w = opW(o);
        const y1 = wy(Math.min(...o.on)) - gateH / 2, y2 = wy(Math.max(...o.on)) + gateH / 2;
        svg.push(`<path class="dg-box" d="${P.rect(x - w / 2, y1, w, y2 - y1, 6)}"/>`);
        lb.put(o.lab, x, (y1 + y2) / 2);
      } else if (!o.lab) {
        for (const w of o.on) {
          const y = wy(w);
          svg.push(`<path class="dg-box" d="${P.ellipse(x, y, 11, 11)}"/>`,
            `<path d="${P.line(x - 11, y, x + 11, y, 0.2)} ${P.line(x, y - 11, x, y + 11, 0.2)}"/>`);
        }
      } else {
        const w = opW(o);
        for (const t of o.on) {
          const y = wy(t);
          svg.push(`<path class="dg-box" d="${P.rect(x - w / 2, y - gateH / 2, w, gateH, 5)}"/>`);
          lb.put(o.lab, x, y);
        }
      }
    }
    W = Math.ceil(W);
    return { w: W, h: Math.ceil(H), html: svgOpen(W, H) + svg.join('') + '</svg>' + lb.out.join('') };
  }

  const svgOpen = (W, H) => `<svg class="dg-svg" xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(W)}" height="${Math.ceil(H)}" viewBox="0 0 ${Math.ceil(W)} ${Math.ceil(H)}">`;

  function nodeSize(n, l) {
    switch (n.shape) {
      case 'circle': { const d = Math.max(32, Math.max(l.w, l.h) + 14); return [d, d]; }
      case 'diamond': return [l.w * 1.5 + 28, Math.max(44, l.h * 1.7 + 18)];
      case 'data': return [l.w + 44, Math.max(36, l.h + 16)];
      case 'store': return [l.w + 28, Math.max(46, l.h + 28)];
      case 'stack': return [l.w + 34, Math.max(40, l.h + 20)];
      case 'round': return [l.w + 32, Math.max(36, l.h + 14)];
      default: return [l.w + 26, Math.max(36, l.h + 16)];
    }
  }

  function nodeShape(P, shape, x, y, w, h) {
    const cx = x + w / 2, cy = y + h / 2;
    switch (shape) {
      case 'circle': return `<path class="dg-box" d="${P.ellipse(cx, cy, w / 2, h / 2)}"/>`;
      case 'round': return `<path class="dg-box" d="${P.rect(x, y, w, h, h / 2)}"/>`;
      case 'diamond': return `<path class="dg-box dg-orange" d="${P.poly([[cx, y], [x + w, cy], [cx, y + h], [x, cy]])}"/>`;
      case 'data': return `<path class="dg-box dg-blue" d="${P.poly([[x + 12, y], [x + w, y], [x + w - 12, y + h], [x, y + h]])}"/>`;
      case 'store': {
        const r = 6;
        return `<path class="dg-box dg-green" d="M${f(x)},${f(y + r)} A${f(w / 2)},${r} 0 0 1 ${f(x + w)},${f(y + r)} L${f(x + w)},${f(y + h - r)} A${f(w / 2)},${r} 0 0 1 ${f(x)},${f(y + h - r)} Z"/>` +
          `<path class="dg-green" d="M${f(x)},${f(y + r)} A${f(w / 2)},${r} 0 0 0 ${f(x + w)},${f(y + r)}"/>`;
      }
      case 'stack':
        return `<path class="dg-box" d="${P.rect(x + 8, y - 8, w - 8, h - 2, 6)}"/><path class="dg-box" d="${P.rect(x + 4, y - 4, w - 6, h - 1, 6)}"/>` +
          `<path class="dg-box" d="${P.rect(x, y, w - 4, h, 6)}"/>`;
      default: return `<path class="dg-box" d="${P.rect(x, y, w, h, 6)}"/>`;
    }
  }

  function drawGraph(spec, seed) {
    if (!window.dagre) throw new Error('the layout library did not load');
    const P = pen(seed);
    const L = [];
    const lab = (html, cls) => { const it = { html, cls }; L.push(it); return it; };
    const nodeLab = new Map(spec.nodes.map((n) => [n.id, lab(labelHTML(n.label) + (n.note ? `<span class="dg-sub">${labelHTML(n.note)}</span>` : ''),
      n.shape === 'circle' ? 'dg-op' : 'dg-node')]));
    const edgeLab = spec.edges.map((e) => (e.label ? lab(labelHTML(e.label), 'dg-edge') : null));
    const groupLab = new Map(spec.groups.map((g) => [g.id, g.label ? lab(labelHTML(g.label), 'dg-group') : null]));
    measureAll(L);

    const grouped = spec.groups.length > 0;
    const g = new dagre.graphlib.Graph({ compound: true, multigraph: true });
    g.setGraph({ rankdir: spec.direction, nodesep: 26, ranksep: grouped ? 16 : 34, edgesep: 12, marginx: 16, marginy: grouped ? 26 : 14 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const gr of spec.groups) g.setNode('g:' + gr.id, {});
    for (const gr of spec.groups) if (gr.parent) g.setParent('g:' + gr.id, 'g:' + gr.parent);
    for (const n of spec.nodes) {
      const [w, h] = nodeSize(n, nodeLab.get(n.id));
      g.setNode('n:' + n.id, { width: w, height: h });
      if (n.group) g.setParent('n:' + n.id, 'g:' + n.group);
    }
    spec.edges.forEach((e, i) => {
      const l = edgeLab[i];
      g.setEdge('n:' + e.from, 'n:' + e.to, l ? { width: l.w + 6, height: l.h + 2, labelpos: 'c' } : {}, 'e' + i);
    });
    dagre.layout(g);

    const svg = [];
    const lb = labels();
    const gi = g.graph();
    let W = gi.width || 100, H = gi.height || 60;
    const room = (r) => { W = Math.max(W, r.right + 8); };
    const depth = (gr) => { let d = 0; for (let p = gr.parent; p; p = (spec.groups.find((x) => x.id === p) || {}).parent) d++; return d; };
    for (const gr of spec.groups.slice().sort((a, b) => depth(a) - depth(b))) {
      const d = g.node('g:' + gr.id);
      if (!d || !Number.isFinite(d.x) || !d.width) continue;
      const pad = 6 - Math.min(4, depth(gr) * 2);
      const x = d.x - d.width / 2 - pad, y = d.y - d.height / 2 - pad;
      svg.push(`<path class="dg-frame" d="${P.rect(x, y, d.width + 2 * pad, d.height + 2 * pad, 10)}"/>`);
      const l = groupLab.get(gr.id);
      if (l) room(lb.put(l, x + 12, y, 'l', 'dg-legend'));
    }
    spec.edges.forEach((e, i) => {
      const d = g.edge({ v: 'n:' + e.from, w: 'n:' + e.to, name: 'e' + i });
      const pts = d && (d.points || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
      if (!pts || pts.length < 2) return;
      // dagre ends edges on the bounding box; circles need them on the rim
      const rim = (end, ref, id) => {
        const nd = spec.nodes.find((n) => n.id === id);
        if (!nd || nd.shape !== 'circle') return;
        const c = g.node('n:' + id), r = c.width / 2;
        const a = Math.atan2(ref.y - c.y, ref.x - c.x);
        end.x = c.x + r * Math.cos(a);
        end.y = c.y + r * Math.sin(a);
      };
      rim(pts[0], pts[1], e.from);
      rim(pts[pts.length - 1], pts[pts.length - 2], e.to);
      svg.push(`<path class="dg-edge${e.dashed ? ' dg-dash' : ''}" d="${smooth(pts)}"/>`,
        `<path class="dg-edge" d="${arrowHead(pts[pts.length - 2], pts[pts.length - 1])}"/>`);
      if (edgeLab[i] && Number.isFinite(d.x)) room(lb.put(edgeLab[i], d.x, d.y, 'c', 'dg-elabel'));
    });
    for (const n of spec.nodes) {
      const d = g.node('n:' + n.id);
      if (!d || !Number.isFinite(d.x)) continue;
      svg.push(nodeShape(P, n.shape, d.x - d.width / 2, d.y - d.height / 2, d.width, d.height));
      lb.put(nodeLab.get(n.id), d.x - (n.shape === 'stack' ? 2 : 0), d.y);
    }
    W = Math.ceil(W);
    H = Math.ceil(H);
    return { w: W, h: H, html: svgOpen(W, H) + svg.join('') + '</svg>' + lb.out.join('') };
  }

  // ------------------------------------------------------------ canvases
  const cache = new Map(); // spec JSON -> {w, h, html}
  function drawn(spec) {
    const key = JSON.stringify(spec);
    let c = cache.get(key);
    if (!c) {
      const seed = hash(key);
      c = spec.type === 'circuit' ? drawCircuit(spec, seed) : drawGraph(spec, seed);
      cache.set(key, c);
      if (cache.size > 60) cache.delete(cache.keys().next().value);
    }
    return c;
  }

  /** The diagram at its natural size: an SVG with HTML labels on top. */
  function canvas(spec) {
    const c = drawn(spec);
    const node = document.createElement('div');
    node.className = 'dg-canvas';
    node.style.width = c.w + 'px';
    node.style.height = c.h + 'px';
    node.dataset.w = c.w;
    node.dataset.h = c.h;
    node.innerHTML = c.html;
    return node;
  }

  // fit a diagram to the column: a small one grows a little, a wide one shrinks (to half size, then it scrolls sideways)
  const fit = (scroll) => {
    const c = scroll.firstElementChild;
    const avail = scroll.clientWidth;
    if (!c || !avail) return;
    let z = Math.min(1.3, Math.max(0.5, (avail - 2) / Number(c.dataset.w)));
    if (z > 1) z = Math.max(1, Math.min(z, 480 / Number(c.dataset.h))); // only grow while it stays short
    if (Math.abs((Number(c.style.zoom) || 1) - z) > 0.005) c.style.zoom = z;
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
    for (const e of entries) {
      if (!e.target.isConnected) ro.unobserve(e.target);
      else fit(e.target);
    }
  }) : null;

  /** A canvas in a container that keeps it within the column. */
  function figure(spec) {
    const scroll = document.createElement('div');
    scroll.className = 'dg-scroll';
    scroll.append(canvas(spec));
    if (ro) ro.observe(scroll);
    return scroll;
  }

  return { RULE, SYSTEM, MANUAL, extract, slots, plain, forPrompt, messages, parse, normalize, labelHTML, canvas, figure, clearCache: () => cache.clear() };
})();
