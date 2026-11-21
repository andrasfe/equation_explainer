/* PDF papers on the board.
 *
 * pdf.js (vendor/pdfjs) draws each page onto a canvas and lays a transparent, selectable text layer over it.
 * Every page is a "card" with id pdf:<n> whose text layer plays the part of a card body, so highlighting a
 * passage gives an anchor exactly like highlighting part of an answer (see anchors.js), and the circles,
 * connectors and side columns work unchanged. The board keeps only the file name ({file, name}); the PDF itself
 * sits in Boards/papers and is served at papers/<file>.
 */
EE.pdf = (() => {
  const { el, debounce } = EE.util;
  const abs = (p) => new URL(p, document.baseURI).href;

  // pdf.js reads text with `for await (… of readableStream)`, which this WebKit (macOS WKWebView, older WebKitGTK)
  // does not offer yet; without it no page gets its selectable text layer
  if (window.ReadableStream && !ReadableStream.prototype[Symbol.asyncIterator]) {
    ReadableStream.prototype.values = ReadableStream.prototype[Symbol.asyncIterator] = async function* values(opts) {
      const reader = this.getReader();
      let finished = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) { finished = true; return; }
          yield value;
        }
      } finally {
        if (!finished && !(opts && opts.preventCancel)) await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    };
  }

  let lib = null;
  function pdfjs() {
    if (!lib) {
      lib = import(abs('vendor/pdfjs/pdf.min.mjs')).then((m) => {
        m.GlobalWorkerOptions.workerSrc = abs('vendor/pdfjs/pdf.worker.min.mjs');
        return m;
      });
      lib.catch(() => { lib = null; });
    }
    return lib;
  }

  const docs = new Map();  // file -> Promise<{m, doc, sizes, title}>
  const texts = new Map(); // file -> Promise<string[]> (plain text per page)
  const ready = new Map(); // file -> string[] once extracted, for code that cannot wait (prompt building)

  function open(file) {
    if (!docs.has(file)) {
      const p = (async () => {
        const m = await pdfjs();
        const res = await fetch('papers/' + encodeURIComponent(file));
        if (!res.ok) throw new Error('The PDF is no longer in the boards folder (' + file + ').');
        const data = new Uint8Array(await res.arrayBuffer());
        const doc = await m.getDocument({
          data, cMapUrl: abs('vendor/pdfjs/cmaps/'), cMapPacked: true,
          standardFontDataUrl: abs('vendor/pdfjs/standard_fonts/'), enableXfa: false,
        }).promise;
        const pages = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
        const sizes = pages.map((pg) => { const v = pg.getViewport({ scale: 1 }); return { w: v.width, h: v.height }; });
        return { m, doc, sizes, title: await titleOf(doc, pages[0]) };
      })();
      p.catch(() => docs.delete(file));
      docs.set(file, p);
    }
    return docs.get(file);
  }

  /** The paper's title: the PDF's own Title when it looks like one, else the largest type near the top of page 1. */
  async function titleOf(doc, first) {
    try {
      const meta = await doc.getMetadata();
      const t = String((meta && meta.info && meta.info.Title) || '').replace(/\s+/g, ' ').trim();
      if (t.length >= 8 && !/^(untitled|microsoft word|document\d*|slide \d+)\b/i.test(t) && !/\.(docx?|tex|dvi|pdf)$/i.test(t)) return t;
    } catch (e) { /* no metadata */ }
    try {
      const v = first.getViewport({ scale: 1 });
      const items = (await first.getTextContent()).items.filter((it) => it.str && it.str.trim());
      const size = (it) => Math.hypot(it.transform[2], it.transform[3]);
      const top = items.filter((it) => it.transform[5] > v.height * 0.45 && Math.abs(it.transform[1]) < 0.01);
      const big = Math.max(0, ...top.map(size));
      if (!big) return '';
      const line = top.filter((it) => size(it) >= big * 0.92).map((it) => it.str + (it.hasEOL ? ' ' : '')).join('');
      return line.replace(/\s+/g, ' ').trim().slice(0, 160);
    } catch (e) {
      return '';
    }
  }

  /** Plain text of every page (cached); also kept for textNow(). */
  function pageTexts(file) {
    if (!texts.has(file)) {
      const p = open(file).then(async ({ doc }) => {
        const out = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const tc = await (await doc.getPage(i)).getTextContent();
          out.push(tc.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : '')).join('')
            .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
        }
        ready.set(file, out);
        return out;
      });
      p.catch(() => texts.delete(file));
      texts.set(file, p);
    }
    return texts.get(file);
  }
  const textNow = (file) => ready.get(file) || null;

  /** pdf.js puts a <br> at each line end; a space keeps the last word of a line apart from the next line's first. */
  function spaceLineEnds(layer) {
    for (const br of layer.querySelectorAll('br')) {
      let prev = br.previousElementSibling;
      while (prev && prev.lastElementChild) prev = prev.lastElementChild; // inside a tagged PDF's marked-content span
      if (prev && prev.tagName === 'SPAN' && !/[\s-]$/.test(prev.textContent)) prev.textContent += ' ';
    }
  }

  // ------------------------------------------------------------ paragraphs (for reading the paper one at a time)
  const paras = new Map(); // file -> Promise<paragraph[]>
  const HEADING = /^((\d+(\.\d+)*\.?|[IVX]+\.|[A-Z]\.)\s+[A-Z][a-z]|(abstract|introduction|background|preliminaries|related work|methods?|results|discussion|conclusions?|summary|outlook|acknowledg(e)?ments?|references|bibliography|appendix)\b)/i;
  const BACK = /^(\d+\.?\s+)?(references|bibliography)\b/i;
  const ENDS = /[.!?:]["'’”)\]]*$/;

  /** The paper split into paragraphs in reading order: [{page, start, end, text, head, back}]. start/end are offsets into
   *  the visible text of the page's text layer, so a paragraph anchors and highlights exactly like a selection; head is the
   *  section heading it falls under, back is true from the references on. A paragraph does not cross a page. */
  function paragraphs(file) {
    if (!paras.has(file)) {
      const p = open(file).then(async ({ m, doc, sizes }) => {
        const lines = [], fulls = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          const tc = await page.getTextContent();
          // the same text layer the page shows (drawn off screen), so the offsets are the ones a selection would give
          const layer = document.createElement('div');
          const tl = new m.TextLayer({ textContentSource: tc, container: layer, viewport: page.getViewport({ scale: 1 }) });
          await tl.render();
          spaceLineEnds(layer);
          lines.push(pageLines(n, tc.items.filter((it) => it.str !== undefined), tl.textDivs, layer, sizes[n - 1].h));
          fulls.push(EE.anchors.visibleText(layer));
        }
        return segment(lines, fulls);
      });
      p.catch(() => paras.delete(file));
      paras.set(file, p);
    }
    return paras.get(file);
  }

  /** The printed lines of a page: [{page, s, e, text, x0, x1, y, size}], running heads, page numbers and turned text left out. */
  function pageLines(n, items, divs, layer, height) {
    const off = new Map();
    let acc = 0;
    for (const t of EE.anchors.textNodes(layer)) {
      const r = off.get(t.parentElement);
      if (r) r[1] = acc + t.data.length; else off.set(t.parentElement, [acc, acc + t.data.length]);
      acc += t.data.length;
    }
    const full = EE.anchors.visibleText(layer);
    const lines = [];
    let cur = null;
    const flush = () => {
      if (cur && cur.s != null) {
        cur.text = full.slice(cur.s, cur.e).replace(/\s+/g, ' ').trim();
        const edge = cur.y > height * 0.93 || cur.y < height * 0.06;
        cur.margin = cur.y > height * 0.85 || cur.y < height * 0.15; // where running heads and feet sit
        if (cur.text && !(edge && cur.text.length < 90) && !/^\d{1,4}$/.test(cur.text)) lines.push(cur);
      }
      cur = null;
    };
    items.forEach((it, i) => {
      const [a, b, c, d, x, y] = it.transform;
      const size = Math.hypot(c, d) || Math.hypot(a, b) || 10;
      const turned = Math.abs(b) > 0.01 || Math.abs(c) > 0.01;
      const r = off.get(divs[i]);
      if (it.str.trim() && r && !turned) {
        if (cur && Math.abs(y - cur.y) > Math.max(size, cur.size) * 0.9 && x < cur.x1 - size) flush(); // a new line without an end-of-line mark
        if (!cur) cur = { page: n, s: null, e: null, x0: x, x1: x, y, size, text: '' };
        if (cur.s == null) cur.s = r[0];
        cur.e = r[1];
        cur.x0 = Math.min(cur.x0, x);
        cur.x1 = Math.max(cur.x1, x + (it.width || 0));
        if (size > cur.size * 1.05 && it.str.trim().length > 2) { cur.size = size; cur.y = y; }
      }
      if (it.hasEOL) flush();
    });
    flush();
    return lines;
  }

  /** Lines → paragraphs: break on a wider gap, an indented first line, a short last line, or a change of type size;
   *  headings join the paragraph they open, and scraps (a formula, a caption line) join their neighbour. */
  function segment(pages, fulls) {
    const out = [];
    let head = '', back = false;
    // a line that comes back at the top or foot of many pages (a running head, a journal footer) is not the paper's text
    const key = (l) => l.text.replace(/\d+/g, '#').toLowerCase();
    const seen = new Map();
    for (const lines of pages) for (const k of new Set(lines.filter((l) => l.margin).map(key))) seen.set(k, (seen.get(k) || 0) + 1);
    const running = (l) => l.margin && pages.length > 2 && seen.get(key(l)) >= Math.max(3, pages.length * 0.4);
    pages = pages.map((lines) => lines.filter((l) => !running(l)));
    const letters = (t) => (t.match(/[A-Za-z]/g) || []).length / Math.max(1, t.length);
    const mathy = (t) => letters(t) < 0.45 || /-{5,}/.test(t); // a formula as the PDF's text layer gives it
    for (const lines of pages) {
      if (!lines.length) continue;
      const gaps = [];
      for (let i = 1; i < lines.length; i++) {
        const g = lines[i - 1].y - lines[i].y;
        if (g > 0 && Math.abs(lines[i].size - lines[i - 1].size) < 0.5) gaps.push(g);
      }
      gaps.sort((a, b) => a - b);
      const step = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 14;
      const body = lines.map((l) => l.size).sort((a, b) => a - b)[Math.floor(lines.length / 2)];
      const blocks = [];
      let blk = null;
      lines.forEach((l, i) => {
        const p = lines[i - 1];
        let brk = !p;
        if (p) {
          const gap = p.y - l.y;
          const wide = Math.max(...blk.lines.map((x) => x.x1));
          brk = gap > step * 1.45 ||                                   // a blank line's worth of space
            gap < -p.size ||                                            // up again: the next column
            Math.abs(l.size - p.size) > Math.max(l.size, p.size) * 0.12 || // a heading, a caption, a footnote
            (l.x0 - p.x0 > l.size * 0.8 && l.x0 - p.x0 < l.size * 4 && gap > 0) || // an indented first line
            (p.x1 < wide - p.size * 2.5 && ENDS.test(p.text) && blk.lines.length > 1); // the short last line of a paragraph
          // the next column, or after a formula, mid-sentence: still the same paragraph
          if (brk && !ENDS.test(p.text) && /^[a-z(,;]/.test(l.text) && Math.abs(l.size - p.size) < 0.5) brk = false;
        }
        if (brk) { blk = { lines: [] }; blocks.push(blk); }
        blk.lines.push(l);
      });
      const text = (b) => b.lines.map((x) => x.text).join(' ');
      const isHead = (b) => {
        const t = text(b);
        return t.length < 100 && !ENDS.test(t.replace(/\.$/, '')) && !/^[a-z]/.test(t) && letters(t) > 0.6 &&
          (HEADING.test(t) || (b.lines[0].size > body * 1.08 && t.length < 70 && b.lines.length <= 2));
      };
      const merged = [];
      let pending = null; // a heading (or a formula at the top of the page) waiting for the paragraph it opens
      for (const b of blocks) {
        const t = text(b);
        if (mathy(t) && !merged.length) { if (pending) pending.lines.push(...b.lines); else pending = { lines: [...b.lines] }; continue; }
        if (isHead(b)) {
          if (pending) pending.lines.push(...b.lines); else pending = { lines: [...b.lines] };
          head = t.slice(0, 90);
          if (BACK.test(t)) back = true;
          continue;
        }
        const last = merged[merged.length - 1];
        const small = t.length < 160 || mathy(t);
        if (pending) { b.lines.unshift(...pending.lines); b.head = head; pending = null; merged.push(b); }
        else if (last && (small || (!ENDS.test(text(last)) && /^[a-z(,;]/.test(t)))) last.lines.push(...b.lines);
        else merged.push(b);
        b.head = b.head || head;
        b.back = back;
      }
      // (a heading left at the foot of a page opens the next page's first paragraph: it stays the current heading)
      for (const b of merged) {
        // a block far longer than a paragraph (segmentation found no break): cut at sentence ends, near line ends
        const chunks = [];
        let ch = [];
        let len = 0;
        for (const l of b.lines) {
          ch.push(l);
          len += l.text.length + 1;
          if (len > 1300 && ENDS.test(l.text)) { chunks.push(ch); ch = []; len = 0; }
        }
        if (ch.length) { if (chunks.length && len < 300) chunks[chunks.length - 1].push(...ch); else chunks.push(ch); }
        for (const c of chunks) {
          const s = c[0].s, e = c[c.length - 1].e;
          const page = c[0].page;
          out.push({ page, start: s, end: e, text: fulls[page - 1].slice(s, e).replace(/\s+/g, ' ').trim(), head: b.head || head, back: !!b.back });
        }
      }
    }
    return out;
  }


  document.addEventListener('pointerup', () => {
    for (const l of document.querySelectorAll('.textLayer.selecting')) l.classList.remove('selecting');
  });

  /** Mount a paper into a scrolling element. Returns {file, pages, ready, scrollToPage, refit, destroy}. */
  function mount(host, file, opts = {}) {
    const root = el('div', { class: 'pdf-doc' }, el('div', { class: 'pdf-loading chalk-dots' }, 'unrolling the paper'));
    host.append(root);
    const pages = new Map(); // "pdf:<n>" -> page element (the card)
    const st = { width: 0, info: null, dead: false, drawn: new Map(), layers: new Set() };
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) draw(Number(e.target.dataset.page));
    }, { root: host, rootMargin: '900px 0px' });
    const ro = new ResizeObserver(debounce(() => layout(), 140));

    const loaded = open(file).then((info) => {
      if (st.dead) return info;
      st.info = info;
      const kids = info.sizes.map((s, i) => {
        const n = i + 1;
        const pg = el('div', { class: 'pdf-page', 'data-card': 'pdf:' + n, 'data-page': n },
          el('div', { class: 'pdf-no', 'data-noanchor': '' }, String(n)));
        pages.set('pdf:' + n, pg);
        return pg;
      });
      root.replaceChildren(...kids);
      layout(true);
      kids.forEach((k) => io.observe(k));
      ro.observe(host);
      pageTexts(file).catch(() => {});
      if (opts.onReady) opts.onReady(info);
      return info;
    }, (err) => {
      if (!st.dead) {
        root.replaceChildren(el('div', { class: 'pdf-error' }, '⚠ Could not open the paper: ' + err.message));
        if (opts.onError) opts.onError(err);
      }
      throw err;
    });

    function layout(first = false) {
      if (!st.info || st.dead) return;
      const cs = getComputedStyle(host);
      const w = Math.floor(host.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2);
      if (w < 120 || (!first && Math.abs(w - st.width) < 2)) return;
      st.width = w;
      st.info.sizes.forEach((s, i) => {
        const pg = pages.get('pdf:' + (i + 1));
        const scale = w / s.w;
        pg.style.width = w + 'px';
        pg.style.height = Math.floor(s.h * scale) + 'px';
        pg.style.setProperty('--total-scale-factor', scale); // the text layer scales with this, no re-layout needed
      });
      // re-draw the canvases near the viewport at the new width; the others redraw when scrolled to
      const hr = host.getBoundingClientRect();
      for (const pg of pages.values()) {
        const r = pg.getBoundingClientRect();
        if (r.bottom > hr.top - 900 && r.top < hr.bottom + 900) draw(Number(pg.dataset.page));
      }
      if (opts.onLayout) opts.onLayout();
    }

    async function draw(n) {
      const info = st.info;
      const pg = pages.get('pdf:' + n);
      if (!info || !pg || st.dead || st.drawn.get(n) === st.width) return;
      const width = st.width;
      st.drawn.set(n, width);
      try {
        const page = await info.doc.getPage(n);
        const scale = width / info.sizes[n - 1].w;
        const dpr = Math.min(3, window.devicePixelRatio || 1);
        const vp = page.getViewport({ scale: scale * dpr });
        const canvas = el('canvas', { class: 'pdf-canvas' });
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        if (pg._task) pg._task.cancel();
        const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
        pg._task = task;
        await task.promise;
        pg._task = null;
        if (st.dead || st.drawn.get(n) !== width) return;
        const old = pg.querySelector('.pdf-canvas');
        if (old) old.replaceWith(canvas); else pg.prepend(canvas);
        if (!st.layers.has(n)) {
          st.layers.add(n);
          const layer = el('div', { class: 'pdf-text textLayer' });
          const tl = new info.m.TextLayer({ textContentSource: await page.getTextContent(), container: layer, viewport: page.getViewport({ scale }) });
          await tl.render();
          spaceLineEnds(layer);
          layer.append(el('div', { class: 'endOfContent' }));
          // while dragging a selection, the end-of-content block keeps it from jumping (as in Firefox's viewer)
          layer.addEventListener('pointerdown', () => layer.classList.add('selecting'));
          pg.insertBefore(layer, pg.querySelector('.pdf-no'));
          if (opts.onPage) opts.onPage(n, pg);
        }
      } catch (e) {
        if (e && e.name === 'RenderingCancelledException') return;
        st.drawn.delete(n);
        if (opts.onError) opts.onError(e);
      }
    }

    /** Scroll page n into view; `y` (0..1) is the spot on the page to bring near the top. */
    function scrollToPage(n, y = 0, smooth = true) {
      const pg = pages.get('pdf:' + n);
      if (!pg) return;
      const top = pg.offsetTop + pg.offsetHeight * y - 24;
      host.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
    }

    /** The page mostly in view (for questions about "this page"). */
    function currentPage() {
      const hr = host.getBoundingClientRect();
      let best = 1, most = -1;
      for (const pg of pages.values()) {
        const r = pg.getBoundingClientRect();
        const seen = Math.min(r.bottom, hr.bottom) - Math.max(r.top, hr.top);
        if (seen > most) { most = seen; best = Number(pg.dataset.page); }
      }
      return best;
    }

    return {
      file, pages, root, ready: loaded, scrollToPage, currentPage, refit: () => layout(),
      destroy() {
        st.dead = true;
        io.disconnect();
        ro.disconnect();
        for (const pg of pages.values()) if (pg._task) pg._task.cancel();
        root.remove();
      },
    };
  }

  return { open, mount, pageTexts, textNow, titleOf, paragraphs };
})();
