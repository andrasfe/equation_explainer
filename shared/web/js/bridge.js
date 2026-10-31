/* Bridge to the native side.
 *
 * In the macOS app, messages go to WKScriptMessageHandlerWithReply "ee" and
 * streamed LLM tokens come back through EE.native.chunk/done/error.
 * In a plain browser (dev harness) the same calls go over HTTP to dev/devserver.mjs.
 */
EE.native = EE.native || {};

EE.bridge = (() => {
  const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ee;
  const isNative = !!handler;
  const chats = new Map(); // id -> {onChunk, onDone, onError, ctrl}
  const replies = new Map(); // rid -> {resolve, reject}: answers a native side sends later through EE.native.reply

  async function call(cmd, payload = {}) {
    if (isNative) {
      // The Linux app acknowledges at once and answers through EE.native.reply when the work is done;
      // the answer is awaited under a key chosen here, so it cannot arrive before anyone waits for it.
      const rid = EE.util.uid('m');
      const answer = new Promise((resolve, reject) => replies.set(rid, { resolve, reject }));
      answer.catch(() => {}); // only awaited when the reply is deferred
      const r = await handler.postMessage({ cmd, ...payload, _rid: rid });
      if (r && typeof r === 'object' && r.__deferred) return answer;
      replies.delete(rid);
      return r;
    }
    const res = await fetch('/bridge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd, ...payload }),
    });
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    return res.json();
  }

  // ---- native → JS stream callbacks
  EE.native.chunk = ({ id, content, reasoning }) => {
    const h = chats.get(id);
    if (h) h.onChunk({ content: content || '', reasoning: reasoning || '' });
  };
  EE.native.done = ({ id, model, finish }) => {
    const h = chats.get(id);
    chats.delete(id);
    if (h) h.onDone({ model, finish });
  };
  EE.native.error = ({ id, message }) => {
    const h = chats.get(id);
    chats.delete(id);
    if (h) h.onError(new Error(message || 'Unknown error'));
  };
  EE.native.reply = ({ rid, result, error }) => {
    const p = replies.get(rid);
    if (!p) return;
    replies.delete(rid);
    if (error != null) p.reject(new Error(error)); else p.resolve(result === undefined ? null : result);
  };

  /** Start a streamed chat completion. Returns {id, cancel()}.
   *  opts.purpose: 'explain' (the board's model) or 'levelset' (the learner-profile model).
   *  opts.llm: id of the model picked in the top bar (explanations and summaries); empty = LLM_PROVIDER's. */
  function chat(messages, handlers, opts = {}) {
    const id = EE.util.uid('chat');
    const purpose = opts.purpose || 'explain';
    const llm = opts.llm || '';
    chats.set(id, handlers);
    if (isNative) {
      call('chat', { id, messages, purpose, llm }).catch((e) => EE.native.error({ id, message: e.message }));
    } else {
      devChat(id, messages, purpose, llm);
    }
    return {
      id,
      cancel() {
        const h = chats.get(id);
        if (!h) return;
        chats.delete(id);
        if (h.ctrl) h.ctrl.abort();
        if (isNative) call('cancel', { id }).catch(() => {});
        h.onDone({ cancelled: true });
      },
    };
  }

  async function devChat(id, messages, purpose, llm) {
    const h = chats.get(id);
    const ctrl = new AbortController();
    h.ctrl = ctrl;
    try {
      const res = await fetch('/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages, purpose, llm }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(await res.text());
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.error) return EE.native.error({ id, message: ev.error });
          if (ev.done) return EE.native.done({ id, model: ev.model, finish: ev.finish });
          EE.native.chunk({ id, content: ev.content, reasoning: ev.reasoning });
        }
      }
      EE.native.done({ id });
    } catch (e) {
      if (e.name !== 'AbortError') EE.native.error({ id, message: e.message });
    }
  }

  return { call, chat, isNative, activeChats: () => chats.size };
})();
