/* Small shared helpers. Everything lives under the global EE namespace. */
window.EE = window.EE || {};

EE.util = (() => {
  const uid = (prefix = '') =>
    prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  /** el('div', {class: 'x', onclick: fn, 'data-id': 1}, child, 'text', ...) */
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

  function debounce(fn, ms) {
    let t = null;
    const d = (...args) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
    d.flush = (...args) => { if (t) { clearTimeout(t); t = null; } fn(...args); };
    d.cancel = () => { clearTimeout(t); t = null; };
    return d;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function truncate(s, n) {
    s = String(s ?? '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
  }

  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  /** deterministic PRNG so hand-drawn shapes don't wiggle between redraws */
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const SYMBOLS = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ',
    pi: 'π', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ', psi: 'ψ', omega: 'ω', Omega: 'Ω', Phi: 'Φ', Psi: 'Ψ',
    Sigma: 'Σ', Delta: 'Δ', Lambda: 'Λ', hbar: 'ℏ', otimes: '⊗', oplus: '⊕', cdot: '·', times: '×', to: '→',
    mapsto: '↦', rightarrow: '→', leftarrow: '←', dagger: '†', sum: 'Σ', prod: 'Π', int: '∫', infty: '∞',
    partial: '∂', nabla: '∇', le: '≤', ge: '≥', leq: '≤', geq: '≥', neq: '≠', ne: '≠', approx: '≈', pm: '±',
    langle: '⟨', rangle: '⟩', in: '∈', forall: '∀', exists: '∃', sqrt: '√', ldots: '…', cdots: '⋯', quad: ' ', qquad: ' ',
  };
  /** Turn a LaTeX-flavoured prompt into readable plain text (for titles and lists). */
  function texToText(src) {
    let s = String(src || '');
    for (let k = 0; k < 3; k++) {
      s = s.replace(/\\ket\{([^{}]*)\}/g, '|$1⟩').replace(/\\bra\{([^{}]*)\}/g, '⟨$1|')
        .replace(/\\braket\{([^{}]*)\}/g, '⟨$1⟩')
        .replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1/$2')
        .replace(/\\sqrt\{([^{}]*)\}/g, '√$1')
        .replace(/\\(?:mathrm|mathbf|text|operatorname|mathcal|mathbb|boldsymbol|vec|hat|bar|tilde)\{([^{}]*)\}/g, '$1');
    }
    s = s.replace(/\\([A-Za-z]+)/g, (m, name) => (name in SYMBOLS ? SYMBOLS[name] : name === 'left' || name === 'right' || name === 'big' || name === 'Big' ? '' : name))
      .replace(/\\[,;!: ]/g, ' ')
      .replace(/[{}$]/g, '')
      .replace(/\^\s*([^\s])/g, '^$1')
      .replace(/-/g, '−');
    return s.replace(/−(?=[A-Za-z]{2})/g, '-').replace(/\s+/g, ' ').trim();
  }

  /** Strip markdown noise to make a short title out of a prompt. */
  function plainTitle(text, n = 64) {
    const s = texToText(String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`]/g, ''));
    return truncate(s || 'Untitled board', n);
  }

  /** KaTeX inserts zero-width spaces; hide them when showing quotes. */
  const clean = (s) => String(s || '').replace(/[\u200b\u200c\u200d\u2060]/g, '');

  const IS_MAC = /Mac/i.test(navigator.platform);
  const MODS = { '⌃': 'Ctrl', '⌘': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift' };
  const MOD_ORDER = ['Ctrl', 'Alt', 'Shift'];
  const KEYS = { '⌫': 'Backspace', '⏎': 'Enter', '↩': 'Enter', '−': '-' };
  /** Shortcut text for this platform: "⇧⌘S" stays on a Mac and reads "Ctrl+Shift+S" elsewhere. */
  function kbd(s) {
    if (IS_MAC) return s;
    return String(s ?? '').replace(/([⌃⌥⇧⌘]+)(?:\s*\+\s*)?([^\s()⌃⌥⇧⌘,.]+)?/g, (m, mods, key) => {
      const names = [...new Set([...mods].map((c) => MODS[c]))].sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
      const k = key == null ? '' : KEYS[key] || key;
      return names.join('+') + (k ? '+' + k : '');
    });
  }

  function relTime(ms) {
    const d = (Date.now() - ms) / 1000;
    if (d < 60) return 'just now';
    if (d < 3600) return Math.round(d / 60) + ' min ago';
    if (d < 86400) return Math.round(d / 3600) + ' h ago';
    return new Date(ms).toLocaleDateString();
  }

  return { uid, el, esc, debounce, sleep, truncate, hash, rng, plainTitle, texToText, clean, relTime, kbd, IS_MAC };
})();
