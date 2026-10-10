/* Text anchors: map a DOM selection inside a rendered card to stable offsets
 * (so highlights survive re-rendering and reloads), and describe it for the LLM
 * (KaTeX glyphs are mapped back to their TeX source).
 *
 * The "visible text" of a card is the concatenation of its text nodes, skipping
 * KaTeX's hidden MathML copy and any UI chrome marked [data-noanchor].
 */
EE.anchors = (() => {
  function isSkipped(node, root) {
    for (let p = node.parentElement; p && p !== root; p = p.parentElement) {
      if (p.classList.contains('katex-mathml') || p.hasAttribute('data-noanchor')) return true;
    }
    return false;
  }

  function textNodes(root) {
    const out = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (!isSkipped(n, root)) out.push(n);
    return out;
  }

  function visibleText(root) { return textNodes(root).map((t) => t.data).join(''); }

  /** DOM point → visible-text offset. */
  function pointToOffset(root, node, offset, nodes) {
    nodes = nodes || textNodes(root);
    let acc = 0;
    if (node.nodeType === Node.TEXT_NODE) {
      for (const t of nodes) {
        if (t === node) return acc + offset;
        acc += t.data.length;
      }
      acc = 0;
    }
    // element boundary (or a skipped text node): count every visible node that starts before it
    const max = node.nodeType === Node.TEXT_NODE ? node.data.length : node.childNodes.length;
    const pt = document.createRange();
    pt.setStart(node, Math.min(offset, max));
    for (const t of nodes) {
      if (pt.comparePoint(t, 0) >= 0) return acc;
      acc += t.data.length;
    }
    return acc;
  }

  function rangeFromOffsets(root, start, end) {
    const nodes = textNodes(root);
    let acc = 0;
    let sNode = null, sOff = 0, eNode = null, eOff = 0;
    for (const t of nodes) {
      const len = t.data.length;
      if (!sNode && start < acc + len) { sNode = t; sOff = start - acc; }
      if (sNode && end <= acc + len) { eNode = t; eOff = end - acc; break; }
      acc += len;
    }
    if (!sNode || !eNode) return null;
    const r = document.createRange();
    r.setStart(sNode, Math.max(0, sOff));
    r.setEnd(eNode, Math.max(0, eOff));
    return r;
  }

  function texOf(katexEl) {
    const a = katexEl.querySelector('annotation[encoding="application/x-tex"]');
    return a ? a.textContent : katexEl.textContent;
  }

  /** Build an anchor object from a live selection range inside `root`. */
  function capture(root, range, cardId) {
    const nodes = textNodes(root);
    const start = pointToOffset(root, range.startContainer, range.startOffset, nodes);
    const end = pointToOffset(root, range.endContainer, range.endOffset, nodes);
    if (end <= start) return null;
    const full = nodes.map((t) => t.data).join('');
    const quote = full.slice(start, end);
    if (!quote.trim()) return null;

    // LLM-facing text: plain text, with any touched formula replaced by its TeX
    const based = [];
    let acc = 0;
    for (const t of nodes) { based.push({ t, base: acc }); acc += t.data.length; }
    const extent = (k) => {
      const inside = based.filter((x) => k.contains(x.t));
      if (!inside.length) return [0, 0];
      const last = inside[inside.length - 1];
      return [inside[0].base, last.base + last.t.data.length];
    };
    const parts = [];
    const partial = [];
    let lastK = null;
    let cur = null;
    for (const { t, base } of based) {
      const s = Math.max(start, base), e = Math.min(end, base + t.data.length);
      if (e <= s) continue;
      const piece = t.data.slice(s - base, e - base);
      const k = t.parentElement.closest('.katex');
      if (k && root.contains(k)) {
        if (k !== lastK) {
          lastK = k;
          const tex = texOf(k).trim();
          const display = !!k.closest('.katex-display');
          parts.push(display ? `\n$$${tex}$$\n` : `$${tex}$`);
          const [ks, ke] = extent(k);
          cur = start <= ks && end >= ke ? null : { tex, visible: '' };
          if (cur) partial.push(cur);
        }
        if (cur) cur.visible += piece;
      } else {
        lastK = null;
        cur = null;
        parts.push(piece);
      }
    }
    const llmText = parts.join('').replace(/\n{3,}/g, '\n\n').trim();
    const ctxStart = Math.max(0, start - 140), ctxEnd = Math.min(full.length, end + 140);
    const context = (ctxStart > 0 ? '…' : '') + full.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim() + (ctxEnd < full.length ? '…' : '');
    return {
      cardId,
      start,
      end,
      quote: quote.replace(/\s+/g, ' ').trim(),
      llmText,
      partial: partial.map((p) => ({ tex: p.tex, visible: EE.util.clean(p.visible).replace(/\s+/g, ' ').trim() })),
      context: partial.length || llmText.length < 400 ? context : '',
    };
  }

  /** Re-find an anchor in a (re-)rendered card. Falls back to quote search. */
  function rangeFor(root, anchor) {
    if (!root || !anchor) return null;
    const full = visibleText(root);
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    let { start, end } = anchor;
    if (end > full.length || norm(full.slice(start, end)) !== anchor.quote) {
      const idx = full.indexOf(anchor.quote);
      if (idx === -1) return null;
      start = idx;
      end = idx + anchor.quote.length;
    }
    return rangeFromOffsets(root, start, end);
  }

  return { textNodes, visibleText, pointToOffset, rangeFromOffsets, capture, rangeFor, texOf };
})();
