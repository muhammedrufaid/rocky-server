/**
 * SSE framing + transport helpers for POST /api/chat Path C.
 * Contract: "Rocky AI Chat — SSE Streaming Event Contract v1"
 */

function isChatStreamingEnabled() {
  // §2 / §9 — default off; only the string "true" enables streaming.
  return process.env.CHAT_STREAMING_ENABLED === 'true';
}

function clientAcceptsSse(req) {
  // §2 — client must explicitly ask for the SSE MIME type.
  const accept = String(req.headers?.accept || '').toLowerCase();
  return accept.includes('text/event-stream');
}

function shouldUseSse(req) {
  return isChatStreamingEnabled() && clientAcceptsSse(req);
}

function isResponseOpen(res) {
  return Boolean(res) && !res.writableEnded && !res.destroyed;
}

function commitSseHeaders(res) {
  // §9
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

function writeSseEvent(res, name, data) {
  // §5 — event name, single-line JSON data, blank-line terminator.
  if (!isResponseOpen(res)) return false;
  const payload = JSON.stringify(data);
  res.write(`event: ${name}\ndata: ${payload}\n\n`);
  if (typeof res.flush === 'function') res.flush();
  return true;
}

function createSseSession(res, abortSignal) {
  let started = false;
  let metaWritten = false;

  return {
    enabled: true,
    signal: abortSignal,
    aborted: () => abortSignal.aborted,
    started: () => started,
    begin(meta) {
      // §6 — headers only after tool rounds have resolved (caller must wait).
      if (abortSignal.aborted || !isResponseOpen(res)) return;
      if (!started) {
        commitSseHeaders(res);
        started = true;
      }
      if (metaWritten) return;
      // §3 / §4 — meta once; fields must match done later.
      writeSseEvent(res, 'meta', {
        propertyCards: meta.propertyCards,
        sources: meta.sources,
        viewAllMatching: meta.viewAllMatching ?? null,
        presentation: meta.presentation ?? null,
      });
      metaWritten = true;
    },
    token(text) {
      // §4.2 — raw deltas only; never empty; never concatenated in one event.
      if (!started || abortSignal.aborted || !isResponseOpen(res)) return;
      if (typeof text !== 'string' || text === '') return;
      writeSseEvent(res, 'token', { text });
    },
    done(payload) {
      // §4.3 / §7 — exactly once, after persist.
      if (!started || abortSignal.aborted || !isResponseOpen(res)) return;
      writeSseEvent(res, 'done', payload);
    },
    error(payload) {
      // §6 — after the point of no return, cannot change HTTP status.
      if (!started || !isResponseOpen(res)) return;
      writeSseEvent(res, 'error', payload);
    },
  };
}

class ChatAbortedError extends Error {
  constructor(message = 'Client disconnected') {
    super(message);
    this.name = 'ChatAbortedError';
  }
}

function throwIfAborted(abortSignal) {
  if (abortSignal?.aborted) throw new ChatAbortedError();
}

module.exports = {
  shouldUseSse,
  isResponseOpen,
  createSseSession,
  ChatAbortedError,
  throwIfAborted,
};
