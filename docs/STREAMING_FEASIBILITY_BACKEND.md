# Chat streaming — backend feasibility (rocky-server)

**Status:** investigation only. No `.js` files were changed.

**Scope of this document:** `POST /api/chat` on rocky-server (`src/ai/chat.controller.js`, `src/ai/chat.routes.js`, plus the `/api` mount in `src/index.js`). This is the backend half only.

**Frontend is out of scope here.** Matching work is required in the rocky-reference app (`ChatBot.tsx` and `app/api/chat/route.ts`). That is a separate task. Shipping backend SSE without those client changes would break the current “await one JSON body” contract.

---

## 1. Current architecture (non-streaming, confirmed)

### 1.1 OpenAI call — `stream` is not passed

`runModelLoop` lives in `src/ai/chat.controller.js` (starts at line 1351).

The only `openai.chat.completions.create(...)` call is inside the `for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1)` loop:

```1387:1398:src/ai/chat.controller.js
    const completion = await openai.chat.completions.create({
      model,
      messages,
      tools: TOOL_DEFINITIONS,
      tool_choice: forceContentAnswer ? 'none' : 'auto',
      max_completion_tokens: contentOnlyReply
        ? CONTENT_REPLY_MAX_TOKENS
        : hasToolResults
          ? REPLY_MAX_TOKENS
          : TOOL_MAX_TOKENS,
      reasoning_effort: reasoningEffort,
    });
```

Confirmed:

- There is **no** `stream: true` (and no `stream` key at all).
- OpenAI Chat Completions default is `stream: false`, so this awaits a **fully buffered** `ChatCompletion` object.
- The handler then reads `completion.choices[0].message` as a complete assistant message (`content` and/or `tool_calls`).
- Repo-wide: no `stream: true`, no SSE, no `text/event-stream`, no `res.write` (reconfirmed for this task).

The client is always created by `getOpenAI()` in the same file (`new OpenAI({ apiKey })`). No streaming-related SDK options are set there.

### 1.2 How the single JSON response is assembled

There are **three** success response shapes. All of them end in `res.status(200).json(...)`. None stream.

#### Path A — Slot clarification (no LLM)

`chat()` may return early via `clarificationResponse` (`src/ai/chat.controller.js`) when `resolvePendingSlots` returns `{ type: 'clarify' }` or `bedroomClarifyIfNeeded` returns a gate.

`clarificationResponse`:

1. Pushes user + assistant messages onto `conversation.messages`.
2. Caps history with `slice(-MAX_STORED_MESSAGES)` (`MAX_STORED_MESSAGES = 40`).
3. Sets `conversation.userProfile = profile`.
4. **`await conversation.save()`** (Mongo persist happens **before** the HTTP body is sent).
5. Sends JSON:

```json
{
  "reply": "<string>",
  "leadCaptured": <bool>,
  "propertyCards": [],
  "sources": [],
  "suggestedCta": null,
  "viewAllMatching": null,
  "requiresClarification": true,
  "options": [...],
  "select": "single"
}
```

(`select` is `PURPOSE_SELECT` from `chat.tools.js`. Empty card/source/CTA fields come from `emptyClarificationPayload()`.)

This path never calls OpenAI. Streaming tokens from the model does not apply. The reply text is server-authored (sell/PM/bedroom/purpose chips).

#### Path B — Forced listing search (usually no LLM)

When `canSearchNow` is true, `chat()` calls `runForcedPropertySearch` → `executeTool('search_properties', ...)`. It then:

1. Builds `forcedReply` from the tool/template (`foundListingsReply`, purpose/bedroom/empty-result copy, or `FRIENDLY_CHAT_ERROR`).
2. Pushes user + assistant messages, slices to 40, assigns `conversation.userProfile = forced.profile`.
3. **`await conversation.save()`**.
4. Builds `payload`:

| Field | Source |
|---|---|
| `reply` | `forcedReply` |
| `propertyCards` | `forced.propertyCards` (may be `[]`) |
| `sources` | `forced.sources` (listing search returns `[]`) |
| `suggestedCta` | `null` if `forced.options` exist; else `pickSuggestedCta(...)` |
| `viewAllMatching` | `forced.viewAllMatching` |
| `requiresClarification` / `options` / `select` | only if `forced.options` (purpose, bedrooms, empty-results chips) |

5. `return res.status(200).json(payload)`.

Again: no OpenAI completion, so nothing to stream from the model unless the product later chooses to SSE-wrap the already-known template string.

#### Path C — LLM tool loop (the path streaming would target)

```1728:1769:src/ai/chat.controller.js
    const history = toOpenAIHistory(conversation.messages || []);

    const result = await runModelLoop({ ... });

    const reply = String(result.reply || '').trim() || FRIENDLY_CHAT_ERROR;
    const suggestedCta = result.options ? null : pickSuggestedCta({ ... });

    conversation.messages.push({ role: 'user', content: message, ... });
    conversation.messages.push({ role: 'assistant', content: reply, ... });
    conversation.messages = conversation.messages.slice(-MAX_STORED_MESSAGES);
    conversation.userProfile = result.profile;
    await conversation.save();

    const payload = { reply, propertyCards, sources, suggestedCta, viewAllMatching };
    // + requiresClarification / options / select if result.options
    return res.status(200).json(payload);
```

`runModelLoop` return object (varies by exit):

| Field | When set |
|---|---|
| `reply` | Final assistant `msg.content`, or `synthesizeContentReply(...)`, or `FRIENDLY_CHAT_ERROR`, or a **server** clarification string (purpose / bedrooms / empty results) |
| `propertyCards` | Accumulated across tool rounds, `uniqueBy(..., id)` |
| `sources` | Accumulated across `search_content` (and any other tool that returns sources), `uniqueBy(..., url \|\| title)` |
| `leadCaptured` | OR of `capture_lead` results |
| `profile` | Merged `userProfile` after tool `profilePatch`es |
| `viewAllMatching` | From a successful `search_properties` |
| `requiresClarification` / `options` / `select` | Early-return after a listing tool round that needs chips |

`pickSuggestedCta` is applied **in `chat()`**, not inside `runModelLoop`. It uses `conversation.messages.length` **before** this turn’s two messages are pushed.

`leadCaptured` from `runModelLoop` is **not** currently copied onto the JSON payload in Path C (only Path A sets `leadCaptured` on the body). Streaming design should not assume the client already receives that flag on LLM turns.

#### Error path

`chat()` `catch` always uses `res.status(isValidation ? 200 : 500).json({ success, reply, message, propertyCards: [], sources: [] })`. That is only valid if headers have **not** already been sent.

### 1.3 Persistence vs send order (all success paths)

| Path | Persist | Then send |
|---|---|---|
| `clarificationResponse` | `conversation.save()` | `res.status(200).json(body)` |
| Forced listing | `conversation.save()` | `res.status(200).json(payload)` |
| `runModelLoop` | `conversation.save()` | `res.status(200).json(payload)` |

Mongo is written **after the full reply string exists**, **before** the client receives bytes. For streaming, persist must move to **after the stream finishes** (full `reply` known), still **once**, not per token.

Stored messages are `{ role, content, createdAt }` only. Tool calls are not persisted. History sent next turn is `toOpenAIHistory` → last `HISTORY_TURNS * 2` (20) user/assistant strings.

### 1.4 Middleware chain for `POST /api/chat`

Exact order for a chat POST:

1. **Global CORS** — `src/index.js` `app.use(cors({ origin: true, credentials: true, ... }))`
2. **`express.text`** — XML/plain (does not consume JSON)
3. **`express.json()`** — parses the chat body (required before `validateChat`)
4. **`express.urlencoded`**
5. **`requireApiKey`** — `src/middleware/apiKeyMiddleware.js`, mounted as `app.use('/api', requireApiKey)` in `src/index.js`. Header `x-api-key` or `Authorization: Bearer <API_SECRET_KEY>`.
6. **Router mount** — `app.use('/api/chat', chatRoutes)`
7. **`restrictChatOrigin`** — `src/ai/chat.routes.js` `router.use(...)`. Missing `Origin` is allowed; disallowed origin → 403 JSON.
8. **`chatCors`** — tighter allowlist (`CHAT_ALLOWED_ORIGINS` or the three defaults), `credentials: true`, methods `POST, OPTIONS`.
9. **`validateChat`** — `sessionId`, `message` (max `CHAT_MESSAGE_MAX_LENGTH` or 2000), optional `intent` enum.
10. **`chatLimiter`** — `express-rate-limit`, window `CHAT_RATE_LIMIT_WINDOW_MS` or 60s, max `CHAT_RATE_LIMIT_MAX` or 20, key `chat-session:${sessionId}` (always present after validation).
11. **`chat`** — `src/ai/chat.controller.js`.

Streaming would **not** replace steps 1–10. Those run before the handler. A streaming response starts **inside `chat`** (or a new helper it calls), after validation and the rate-limit increment.

`chat.routes.js` does not set `Content-Type` today. JSON content type is set by `res.json()`.

There is **no** chat-specific HTTP timeout, `keepAliveTimeout`, or `res.flushHeaders` in this repo. Zapier/Sheets `AbortSignal.timeout(15000)` is unrelated.

---

## 2. Tool-calling loop vs streaming

### 2.1 How `MAX_TOOL_ROUNDS` works today

Constant: `MAX_TOOL_ROUNDS = 4` at the top of `src/ai/chat.controller.js`.

Each round:

1. Optionally set `tool_choice: 'none'` when `forceContentAnswer` is true (content search already returned chunks, no listing cards — stops the model from calling `search_content` until the loop is exhausted).
2. **Await** a full completion.
3. Push the assistant `msg` onto the in-memory `messages` array (this is the OpenAI transcript for **this HTTP request only**; it is not saved to Mongo).
4. If `msg.tool_calls` is missing/empty:
   - Treat `msg.content` as the user-visible reply (trim; fallback `synthesizeContentReply` / `FRIENDLY_CHAT_ERROR`).
   - **Return immediately** with cards/sources/profile accumulated so far.
5. If there are tool calls: for **each** call, `JSON.parse` of **complete** `call.function.arguments`, then `await executeTool(name, args, ...)`.
6. Push `{ role: 'tool', tool_call_id, content: JSON.stringify(result.modelPayload) }`.
7. After **all** tools in the round: if listing search needs purpose / bedrooms / empty-results chips and there are no cards, **return immediately** with a **server-written** `reply` + `options` — **without** another model round.
8. Otherwise start the next round (model sees tool results).
9. If 4 rounds finish without a content-only assistant message: `synthesizeContentReply` or a “could not finish” string.

Repeat-`search_content` short-circuit: if chunks already exist, the server does **not** re-run the tool; it injects a canned tool message telling the model to answer now.

`executeTool` (`src/ai/chat.tools.js`) names: `search_properties`, `search_content`, `capture_lead`. Unknown name → error payload.

### 2.2 Why streaming complicates tool calls

With `stream: true`, `choices[0].delta` arrives incrementally:

- `delta.tool_calls[]` fragments keyed by `index` (and eventually `id`)
- `function.arguments` is a **growing JSON string**, not a complete object until the stream ends for that call
- `delta.content` may be empty on tool-only rounds
- `finish_reason` (`stop` vs `tool_calls`) is only reliable at the end of that completion stream

Today the loop **requires** a complete `msg.tool_calls[].function.arguments` string before `JSON.parse` and `executeTool`. A streaming implementation **must accumulate deltas into one assistant message** before executing tools. Executing a tool on a partial arguments string would throw or run with `{}` (the current parse `catch` already maps invalid JSON to `{}` — dangerous if you parse too early).

OpenAI’s current Chat Completions behavior is typically **either** `tool_calls` **or** visible `content` on a given assistant message, not a mix the UI should render. If content deltas were forwarded to the client and later `tool_calls` appeared, the UI would flash leftover text. Safer to **buffer until `finish_reason` is known** for that round.

### 2.3 Can tools stream mid-turn?

| Tool | What it actually returns | Partial output useful to the visitor? |
|---|---|---|
| `search_content` | Embed query + `$vectorSearch`; `modelPayload.chunks` + ranked `sources` | No token stream. Work is one embedding call + one aggregation. Client might get a **status** event (“searching site…”) but not RAG text. Chunks are truncated server-side (420 chars) and must not be dumped to the UI. |
| `search_properties` | Mongo listing query; cards, totals, optional chip `options` | Cards are a **batch**. Streaming individual listings mid-query is not how `fetchPropertyCards` works. Could emit a status event, then one `propertyCards` event when the query returns. |
| `capture_lead` | `Lead.create` or validation error | Binary success/fail. Nothing to stream. |

**Recommendation:** do **not** stream tool internals. Stream **only the final assistant text** after the tool loop has either:

- produced a content-only model message (`!toolCalls.length`), or
- decided the reply is a **server template** (clarification / forced listing / synthesize fallback).

Optional non-text SSE events (not token streams): `status`, `propertyCards`, `sources`, `options`, `done`. Those are discrete JSON frames after the relevant tool round, not OpenAI deltas.

Many turns never enter `runModelLoop` at all (Path A / Path B). A uniform client protocol would still need a way to deliver those as either:

- keep `application/json` for non-LLM turns (client must branch), or
- wrap them in a single SSE `done` event with the same payload fields (uniform, but still not “token streaming”).

---

## 3. Proposed change list (do not implement yet)

Each item is a **proposal**. No code was written.

### 3.1 `src/ai/chat.controller.js`

| # | Touch point | Proposed change |
|---|---|---|
| 1 | New helper, e.g. `accumulateCompletionStream(stream)` (new function in this file) | Iterate OpenAI stream chunks; merge `delta.content` and `delta.tool_calls` by index into one `{ content, tool_calls, finish_reason, usage }` message. Required before `executeTool`. |
| 2 | `runModelLoop` — `openai.chat.completions.create` block (~1387–1398) | Add `stream: true` **only on rounds where the user-visible reply is expected**, *or* stream every round but **do not** `res.write` until `finish_reason !== 'tool_calls'`. Lowest-risk first version: keep `stream: false` for `tool_choice: 'auto'` rounds; set `stream: true` when `forceContentAnswer` is true (`tool_choice: 'none'`). First round often needs tools, so it stays buffered. |
| 3 | `runModelLoop` — `msg = completion.choices[0].message` (~1400–1416) | If streamed, `msg` comes from the accumulator, not `completion.choices[0].message`. Logging of `usage` / `finish_reason` must read stream final chunk (`usage` is often on the last event when `stream_options: { include_usage: true }` — that option is **not** set today and would be a new field on `create`). |
| 4 | `runModelLoop` — content return (~1417–1432) | Instead of returning `{ reply }` to `chat()` which then `res.json`s, this exit must either (a) return the full string as today and let `chat()` stream it (poor UX — still waits for tools + full text), or (b) accept an `onTextDelta` / `res` callback and write SSE `token` events **while** the last completion streams. (b) is the actual product value. |
| 5 | `runModelLoop` — tool `for` loop (~1435–1570) | Unchanged semantically: still parse **complete** arguments, `await executeTool`, merge cards/sources/profile. Must not run until the streamed tool_calls are fully accumulated. |
| 6 | `runModelLoop` — clarification early returns (~1572–1612) | Still server strings + `options`. If the connection is already SSE, emit one `reply`/`options` event rather than `res.json`. If headers not sent yet, may keep JSON. Mixing JSON and SSE on the same route is a client-contract decision (see §3.5). |
| 7 | `runModelLoop` — max-round fallback (~1615–1629) | `synthesizeContentReply` is instantaneous; if SSE already started, send as one `reply` event (or token-split — unnecessary). |
| 8 | `synthesizeContentReply` | No streaming need; leftover when the model returns empty `content` after RAG. |
| 9 | `chat` — Path C after `runModelLoop` (~1728–1769) | Split: (i) run tool rounds with ability to start SSE before the **last** completion; (ii) accumulate full `reply`; (iii) `pickSuggestedCta`; (iv) **then** `conversation.save()`; (v) SSE `done` event with `propertyCards`, `sources`, `suggestedCta`, `viewAllMatching`, `options`; (vi) `res.end()`. **Do not** `save()` per token. |
| 10 | `chat` — `catch` (~1770–1780) | If `res.headersSent`, cannot `res.status().json`. Must write an SSE `error` event and `end()`, or destroy the socket. |
| 11 | `clarificationResponse` / forced-search `res.json` (~1235–1253, ~1697–1725) | Decide: leave as JSON (client dual-mode) or emit the same SSE `done` envelope for protocol uniformity. Not an OpenAI stream either way. |
| 12 | `getOpenAI` | Optional: reuse one client; not required for streaming. Abort via `AbortController` if the client disconnects (`req.on('close')`) so OpenAI tokens stop. **Not present today.** |

`src/ai/chat.tools.js` does not need changes for a first streaming slice unless you add SSE status events from inside `executeTool` (not recommended; keep tools return-valued and let `chat`/`runModelLoop` emit events).

### 3.2 Response object, headers, `res.write`

Headers belong in **`chat.controller.js`** (or a tiny helper it calls), **not** as blanket middleware in `chat.routes.js`. Routes still serve JSON 400/403 from `validateChat` / `restrictChatOrigin`, and the limiter’s JSON 429.

When committing to SSE (Path C last completion, or a unified SSE protocol):

```
res.status(200);
res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
res.setHeader('Cache-Control', 'no-cache, no-transform');
res.setHeader('Connection', 'keep-alive');
res.setHeader('X-Accel-Buffering', 'no');  // if nginx is in front — not in this repo, ops concern
res.flushHeaders();
```

Then `res.write('data: ' + JSON.stringify(event) + '\n\n')` per event.

Express 5 does not automatically flush; `flushHeaders()` plus writes is the usual pattern. Compression middleware is **not** installed in `src/index.js` today, which is good (gzip would buffer SSE). A future `compression` middleware would need a skip for `/api/chat`.

`chat.routes.js`: no header changes required for the limiter/CORS/API key. Optional later: expose `OPTIONS` already allowed by `chatCors`.

### 3.3 Conversation persistence

Keep the current rule: **one Mongo write per user turn, after the full assistant `content` is known.**

Proposed order for streamed Path C:

1. Load conversation (already at start of `chat`).
2. Run slot/forced-search branches as today (save + respond).
3. Tool rounds (buffered OpenAI) — no save yet; in-memory `profile` / cards / sources only.
4. Open SSE; stream final text deltas; concatenate `fullReply`.
5. `conversation.messages.push(user, assistant: fullReply)`; slice 40; `userProfile = result.profile`; **`await conversation.save()`**.
6. SSE `done` with structured fields that were ready **before or during** the text stream:
   - Cards/sources can be sent **before** tokens (they are known after tools) so the UI can render listings while text types.
   - `suggestedCta` depends on cards/sources/`leadCaptured` and `turnIndex`; can be computed before or after text; must be on `done`.
7. If `save()` fails after tokens were sent: client already showed text that is **not** in history. Must log and send `error`; next turn’s `toOpenAIHistory` would omit this assistant message. Mitigation: save **before** `done` but **after** text is complete (tokens already shown). Accept that a crash between last token and `save` drops history — same class of risk as today’s crash between `save` and `res.json`, inverted.

Do **not** persist each chunk (would thrash Mongo and violate `MAX_STORED_MESSAGES` semantics).

Abort/disconnect: if the client drops mid-stream, decide whether to save a partial assistant message. Today a failed request saves **nothing** (error before `save`). Partial save would pollute `toOpenAIHistory`. Recommend: **no save on abort**; match current failure behavior.

### 3.4 Rate limiter, origin, CORS, long-lived connections

| Layer | Today | Streaming impact |
|---|---|---|
| `requireApiKey` | Once per request, before handler | Unchanged. SSE is the same POST. |
| `restrictChatOrigin` / `chatCors` | Once per request | Unchanged. `credentials: true` + allowlist still apply. EventSource in browsers **cannot send custom headers**; if the frontend uses `EventSource`, **`x-api-key` cannot be set**. Current stack almost certainly uses `fetch` JSON. Streaming client must keep **`fetch` + `ReadableStream`**, not `EventSource`, unless the Next proxy injects the API key. |
| `validateChat` | Needs parsed JSON body | Unchanged; `express.json()` already ran. |
| `chatLimiter` | Memory store; increments when the middleware runs, **before** `chat()` | One POST still counts as **one** hit, even if the connection lasts 30s. No extra hits per token. **No shared store** across Node instances (already true). Long connection does **not** hold the rate-limit slot as a mutex; burst of 20 POSTs/minute still allowed. |
| Timeouts | None in chat code | Reverse proxies (nginx, Cloudflare, load balancer) may buffer or kill idle/long responses. **Could not confirm** production proxy settings from this repo. Backend should write an SSE comment/`:` heartbeat if tool rounds can exceed proxy idle limits (embedding + 4 LLM round-trips). |
| Node HTTP | Not configured in `src/index.js` | Default server timeouts are environment-specific. If a proxy waits for the full body (response buffering), SSE never reaches the browser — **ops must disable proxy buffering for `/api/chat`**. |
| `trust proxy` | `app.set('trust proxy', 1)` | Still needed so `rateLimit.ipKeyGenerator` is correct if sessionId were missing; sessionId is required so IP is fallback only. |

Rate limiter `message` is JSON. 429s stay non-streaming — correct.

### 3.5 Suggested backend event protocol (proposal only)

Example frames (not implemented):

```
event: meta
data: {"propertyCards":[...],"sources":[...],"viewAllMatching":null}

event: token
data: {"text":"Dubai Golden Visa"}

event: done
data: {"reply":"<full>","suggestedCta":"...","requiresClarification":false}

event: error
data: {"reply":"Sorry, I couldn't pull that up — try again in a moment"}
```

`meta` can fire after tools and **before** tokens so cards appear immediately. Final `done.reply` must equal the concatenation of tokens (and match Mongo `content`).

### 3.6 Frontend (explicitly not this repo)

This document **does not** specify rocky-reference diffs.

The current contract is: one `POST`, one JSON object with `reply`, `propertyCards`, `sources`, `suggestedCta`, `options`. Any backend SSE/NDJSON change requires the Next `app/api/chat/route.ts` proxy and `ChatBot.tsx` consumer to:

- stop `await res.json()` as the only path,
- read a byte stream,
- render tokens incrementally,
- apply cards/sources/chips from later events,
- keep API key / origin behavior on the proxy.

Until that ships, backend must keep returning buffered JSON **or** gate streaming behind a flag defaulting **off**.

---

## 4. Risks to the 4-round tool-calling loop

1. **Partial `tool_calls` execution** — parsing arguments before the stream finishes can yield `{}` (existing `JSON.parse` catch) and run `search_properties` / `capture_lead` with empty args. Accumulation is mandatory.

2. **`forceContentAnswer` / `tool_choice: 'none'`** — this is the best round to stream. If `stream: true` is also used on earlier `tool_choice: 'auto'` rounds, the loop must still wait for the full tool-call stream before `executeTool`; wall-clock time to first **user** token does not improve until tools finish. Streaming those rounds only adds complexity.

3. **Early clarification returns inside the loop** (purpose / bedrooms / empty results) happen **after** a tool round, with **no** further model call. If SSE already started (e.g. a premature `token` stream), chips + server copy must still be delivered without a model stream. Starting SSE too early is the bug.

4. **Empty `msg.content` after RAG** — today `synthesizeContentReply` fills in. A streaming last round might emit nothing, then the server would send a fallback in one chunk. UI should handle a late full-string `reply` on `done`.

5. **`MAX_TOOL_ROUNDS` exhaustion** — fallback string is not a model stream. Same as (4).

6. **Headers already sent vs `catch`** — a thrown error on round 3 after SSE start cannot use the current `res.status(500).json(...)`. Loop errors during tools (caught today per tool) are safer to keep as tool `modelPayload.error` so the model can continue. Uncaught errors after `flushHeaders` need a new path.

7. **Reasoning models / `reasoning_effort`** — already passed as `minimal`. Streaming may delay `content` deltas until reasoning finishes; first token latency might still be high. **Could not confirm** exact delta shape for `gpt-5-nano` from this repo (model id is env/default only).

8. **Duplicate user-visible text** — if the last streamed message is also returned as a full `reply` on `done`, the client must replace, not append.

9. **Proxy buffering** — looks like “streaming is broken” while the backend is correct.

10. **Client disconnect** — without abort, OpenAI + Mongo work continues; with abort, skip `save` (recommended).

11. **Rate limit vs duration** — does not cap concurrent long SSE connections per session beyond 20 POSTs/window. A session could hold several overlapping streams if the client retries. Not unique to streaming but cheaper to hit if the UI allows double-submit (today the wait is one JSON; streaming might enable a second send while the first is open unless the client disables input).

12. **Contract split** — Path A/B JSON vs Path C SSE forces two client parsers unless all paths are SSE-wrapped.

---

## 5. Suggested implementation sequence (still not doing it)

1. Keep JSON as default (`CHAT_STREAMING=false` or request flag).
2. Implement delta accumulation + optional `stream: true` **only** when `forceContentAnswer` (lowest risk to the tool loop).
3. SSE `token` + `done`; persist once after full text; fix `catch` for `headersSent`.
4. Optionally emit `propertyCards`/`sources` before tokens.
5. Unify Path A/B onto SSE **or** document dual-mode for the frontend task.
6. Confirm nginx/Cloudflare buffering off for `POST /api/chat`.
7. Frontend rocky-reference task: `fetch` stream reader, not `EventSource` (API key headers).

**Feasible:** yes, for the **final text** after tools. **Not a small patch:** `runModelLoop` + `chat` error handling + persistence ordering + client contract. Tool execution itself should stay fully buffered.
