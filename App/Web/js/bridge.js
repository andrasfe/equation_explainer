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

  async function call(cmd, payload = {}) {
    if (isNative) return handler.postMessage({ cmd, ...payload });
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

  /** Start a streamed chat completion. Returns {id, cancel()}. */
  function chat(messages, handlers) {
    const id = EE.util.uid('chat');
    chats.set(id, handlers);
    if (isNative) {
      call('chat', { id, messages }).catch((e) => EE.native.error({ id, message: e.message }));
    } else {
      devChat(id, messages);
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

  async function devChat(id, messages) {
    const h = chats.get(id);
    const ctrl = new AbortController();
    h.ctrl = ctrl;
    try {
      const res = await fetch('/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages }),
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
