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
      const prev = br.previousElementSibling;
      if (prev && prev.tagName === 'SPAN' && !/[\s-]$/.test(prev.textContent)) prev.textContent += ' ';
    }
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

  return { open, mount, pageTexts, textNow, titleOf };
})();
