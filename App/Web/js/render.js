/* Markdown + LaTeX rendering for the board.
 *
 * Math is cut out *before* markdown runs (so `_` and `*` inside formulas are
 * never mangled), replaced by inert placeholders, and rendered with KaTeX
 * after the HTML has been sanitised.
 */
EE.render = (() => {
  const MACROS = {
    '\\expval': '\\left\\langle #1 \\right\\rangle',
    '\\ev': '\\left\\langle #1 \\right\\rangle',
    '\\op': '\\left|#1\\right\\rangle\\!\\left\\langle#2\\right|',
    '\\dyad': '\\left|#1\\right\\rangle\\!\\left\\langle#2\\right|',
    '\\mel': '\\left\\langle #1 \\middle| #2 \\middle| #3 \\right\\rangle',
    '\\abs': '\\left|#1\\right|',
    '\\norm': '\\left\\lVert#1\\right\\rVert',
    '\\Tr': '\\operatorname{Tr}',
    '\\tr': '\\operatorname{tr}',
    '\\CNOT': '\\mathrm{CNOT}',
    '\\qty': '\\left(#1\\right)',
    '\\vb': '\\mathbf{#1}',
    '\\bm': '\\boldsymbol{#1}',
    '\\dd': '\\mathrm{d}',
    '\\ii': '\\mathrm{i}',
    '\\RR': '\\mathbb{R}',
    '\\CC': '\\mathbb{C}',
    '\\NN': '\\mathbb{N}',
    '\\ZZ': '\\mathbb{Z}',
  };

  const DISPLAY_ENVS = 'equation|equation\\*|align|align\\*|aligned|gather|gather\\*|alignat|alignat\\*|multline|multline\\*|eqnarray|eqnarray\\*|split|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|matrix|cases|array';
  const ENV_RE = new RegExp('^\\\\begin\\{(' + DISPLAY_ENVS + ')\\}');

  marked.setOptions({ gfm: true, breaks: true });

  function katexHTML(tex, display) {
    try {
      return katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        strict: 'ignore',
        trust: false,
        macros: { ...MACROS },
        output: 'htmlAndMathml',
        errorColor: '#f3a5b5',
      });
    } catch (e) {
      return `<code class="tex-error">${EE.util.esc(tex)}</code>`;
    }
  }

  /** Pull math out of markdown, leaving code spans/fences untouched. */
  function extractMath(src) {
    const math = [];
    let out = '';
    let i = 0;
    const n = src.length;
    const hold = (tex, display) => {
      math.push({ tex: tex.trim(), display });
      return `EEMATH${display ? 'D' : 'I'}${math.length - 1}X`;
    };
    const atLineStart = (k) => k === 0 || src[k - 1] === '\n';

    while (i < n) {
      const c = src[i];
      // fenced code block (``` or ~~~ at the start of a line, possibly indented)
      if ((c === '`' || c === '~') && src.startsWith(c.repeat(3), i)) {
        const lineStart = src.lastIndexOf('\n', i - 1) + 1;
        if (/^[ \t]*$/.test(src.slice(lineStart, i))) {
          const m = src.slice(i).match(/^(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?(?:\n[ \t]*\1[`~]*[ \t]*(?=\n|$)|$)|$)/);
          out += m[0];
          i += m[0].length;
          continue;
        }
      }
      // inline code
      if (c === '`') {
        const run = src.slice(i).match(/^`+/)[0];
        const close = src.indexOf(run, i + run.length);
        if (close !== -1) {
          out += src.slice(i, close + run.length);
          i = close + run.length;
          continue;
        }
      }
      if (c === '\\') {
        const nx = src[i + 1];
        if (nx === '$') { out += '\\$'; i += 2; continue; }
        if (nx === '[' || nx === '(') {
          const closer = nx === '[' ? '\\]' : '\\)';
          const close = src.indexOf(closer, i + 2);
          if (close !== -1) {
            out += hold(src.slice(i + 2, close), nx === '[');
            i = close + 2;
            continue;
          }
        }
        const env = src.slice(i).match(ENV_RE);
        if (env) {
          const endTag = `\\end{${env[1]}}`;
          const close = src.indexOf(endTag, i);
          if (close !== -1) {
            out += hold(src.slice(i, close + endTag.length), true);
            i = close + endTag.length;
            continue;
          }
        }
        out += c + (nx ?? '');
        i += 2;
        continue;
      }
      if (c === '$') {
        if (src[i + 1] === '$') {
          const close = src.indexOf('$$', i + 2);
          if (close !== -1) {
            out += hold(src.slice(i + 2, close), true);
            i = close + 2;
            continue;
          }
        } else {
          // inline: opening $ followed by non-space; closing $ preceded by non-space, not followed by digit
          if (src[i + 1] && !/\s/.test(src[i + 1])) {
            let j = i + 1;
            let found = -1;
            while (j < n) {
              const cj = src[j];
              if (cj === '\\') { j += 2; continue; }
              if (cj === '\n' && src[j + 1] === '\n') break;
              if (cj === '$') {
                if (!/\s/.test(src[j - 1]) && !/\d/.test(src[j + 1] || '')) found = j;
                break;
              }
              j++;
            }
            if (found !== -1) {
              out += hold(src.slice(i + 1, found), false);
              i = found + 1;
              continue;
            }
          }
        }
      }
      out += c;
      i++;
    }
    return { text: out, math };
  }

  const PURIFY = {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select', 'button', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style'],
  };

  /** Markdown with math → sanitised HTML string. */
  function markdown(src) {
    const { text, math } = extractMath(String(src ?? ''));
    let html = marked.parse(text);
    html = DOMPurify.sanitize(html, PURIFY);
    return html.replace(/EEMATH([DI])(\d+)X/g, (m, kind, k) => {
      const item = math[Number(k)];
      return item ? katexHTML(item.tex, kind === 'D') : m;
    });
  }

  /** Render a short snippet inline (no paragraphs). */
  function inline(src) {
    const html = markdown(src).trim();
    return html.replace(/^<p>/, '').replace(/<\/p>$/, '');
  }

  /** Split <think>…</think> reasoning (Qwen/DeepSeek style) from the answer body. */
  function splitThink(text) {
    const t = String(text || '');
    const m = t.match(/^\s*<think>([\s\S]*?)(<\/think>|$)/);
    if (!m) return { think: '', body: t, thinking: false };
    return { think: m[1], body: m[2] ? t.slice(m[0].length).replace(/^\s+/, '') : '', thinking: !m[2] };
  }

  /** Program output: $$…$$ blocks become math, everything else stays monospace. */
  function stdout(text) {
    const parts = String(text || '').split(/(\$\$[\s\S]+?\$\$)/g);
    let html = '';
    for (const p of parts) {
      if (!p) continue;
      if (p.startsWith('$$') && p.endsWith('$$') && p.length > 4) {
        html += `<div class="out-math">${katexHTML(p.slice(2, -2), true)}</div>`;
      } else if (p.replace(/\n/g, '').trim()) {
        html += `<pre class="out-text">${EE.util.esc(p.replace(/^\n+|\n+$/g, ''))}</pre>`;
      }
    }
    return html;
  }

  return { markdown, inline, katexHTML, extractMath, splitThink, stdout, MACROS };
})();
