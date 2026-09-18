# Rocky Server Backend

Onboarding reference for `rocky-server`. This is an Express API for the Rocky Real Estate website **and** the website chatbot. Everything below is taken from the current source; it is not a design spec.

Entry point: `src/index.js`. Package: `package.json` (`name`: `rocky-server`, `"type": "commonjs"`).

---

## 1. Tech Stack

| Layer | What is used |
| --- | --- |
| Language / module system | JavaScript, CommonJS (`require` / `module.exports`) |
| Runtime | Node.js |
| HTTP framework | Express `^5.2.1` (`src/index.js`) |
| Database | MongoDB via Mongoose `^9.2.2` (`config/db.js` → `process.env.MONGO_URI`) |
| LLM | OpenAI Node SDK `^5.23.2` (`src/ai/chat.controller.js`, `src/ai/chat.tools.js`, `scripts/embedContent.js`) |
| Auth | Shared API key middleware + JWT (`jsonwebtoken`, `bcrypt`) |
| Rate limiting | `express-rate-limit` on `POST /api/chat` only (`src/ai/chat.routes.js`) |
| File upload | Multer; career CVs and factsheet PDFs go to AWS S3 (`@aws-sdk/client-s3`); Cloudinary is still configured because `src/middleware/upload.js` imports `src/config/cloudinary.js` |
| XML / listings feed | `fast-xml-parser` + Salesforce XML feed (`src/services/propertyService.js`, `src/services/salesforceMigrateService.js`) |
| Cron | `node-cron` (Salesforce migrate, TeamTailor jobs, Google reviews) |
| HTTP clients | `axios` (TeamTailor / Salesforce-related), native `fetch` (Zapier, Google Sheets) |
| Google | `googleapis` (Business Profile OAuth + reviews) |
| Tests | `src/ai/chat.test.js` uses Node’s built-in `node:test`. `package.json` `"test": "jest"` does **not** match that file, and `jest` is not in dependencies. |

Key npm packages from `package.json`: `express`, `mongoose`, `openai`, `cors`, `dotenv`, `express-rate-limit`, `jsonwebtoken`, `bcrypt`, `multer`, `multer-storage-cloudinary`, `cloudinary`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `axios`, `fast-xml-parser`, `googleapis`, `node-cron`.

---

## 2. Folder / Module Structure

```
rocky-server/
├── config/db.js                 Mongo connect
├── scripts/                     embedContent.js, migrateAreaGuides.js, movePropertyEmbeddings.js, Google Apps Script helpers
├── src/
│   ├── index.js                 App bootstrap, middleware, route mounts, schedulers
│   ├── ai/                      Chatbot (the LLM product)
│   │   ├── chat.routes.js
│   │   ├── chat.controller.js
│   │   ├── chat.prompt.js
│   │   ├── chat.tools.js
│   │   ├── chat.qualify.js
│   │   ├── chat.models.js       Conversation + Lead schemas
│   │   └── chat.test.js
│   ├── routes/                  All non-chat HTTP routers
│   ├── controllers/
│   ├── models/                  Mongoose models (CMS, leads, listings, reviews)
│   ├── services/                DB queries, Zapier, S3, Salesforce, Google, TeamTailor
│   ├── middleware/              apiKey, JWT, multer
│   ├── jobs/                    Cron schedulers
│   ├── config/                  s3.js, cloudinary.js
│   ├── constants/
│   └── utils/
└── docs/API_INVENTORY.md        Outdated (lists 26 endpoints; the app has far more)
```

How a chat request flows:

1. `src/index.js` mounts `src/ai/chat.routes.js` at `/api/chat` (after global `requireApiKey`).
2. Route middleware: origin allowlist, CORS, body validation, per-session rate limit.
3. `chat` in `src/ai/chat.controller.js` loads/creates a `Conversation`, runs deterministic slot/intent logic, then either returns a clarification or calls OpenAI with tools.
4. Tools in `src/ai/chat.tools.js` hit Mongo listings (`src/services/propertyDbService.js`), Atlas vector search (`ChatbotKnowledge`), or insert a `Lead`.

---

## 3. API Routes

**Global rules** (`src/index.js`):

- All `/api/*` routes require `x-api-key` or `Authorization: Bearer <API_SECRET_KEY>` (`src/middleware/apiKeyMiddleware.js`).
- `GET /` is public.
- `/auth/google` is **not** under `/api` (Google OAuth redirect). `/auth/google/status` applies `requireApiKey` itself.
- CORS: `origin: true`, methods GET/POST/PUT/DELETE/PATCH/OPTIONS, headers `Content-Type`, `Authorization`, `x-api-key`.
- JSON + urlencoded parsers. Raw XML/text up to 50mb for Salesforce migrate.

Admin-style list/update/delete on enquiry collections also require a **user JWT** (`protect` / `requireUserToken` in `src/middleware/authMiddleware.js`): `Authorization: Bearer <user JWT>` **in addition to** the API key. That conflicts with using the same `Authorization` header for the API key — those routes must send the API key as `x-api-key`.

CMS write routes (blogs, FAQs, services, etc.) are **not** JWT-protected; API key only.

### Health

| Method | Path | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/` | Health | none | `{ message: "Rocky RealEstate API is running" }` |

### Auth — `/api/auth` (`src/routes/authRoutes.js`, `src/controllers/authController.js`)

| Method | Path | Auth | Request | Response |
| --- | --- | --- | --- | --- |
| POST | `/api/auth/signup` | API key | `{ name, email, password }` | `201 { success, message, data: { user: { id, name, email }, token } }` |
| POST | `/api/auth/login` | API key | `{ email, password }` | `200 { success, message, data: { user, token } }` |
| GET | `/api/auth/users` | API key + JWT | none | `{ success, count, data: users }` (password stripped) |

JWT payload: `{ id: userId }`, signed with `JWT_SECRET`, expiry `JWT_EXPIRES_IN` or `7d`. `User.role` is stored but never used for authorization.

### Chat — `/api/chat` (`src/ai/chat.routes.js`, `src/ai/chat.controller.js`)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/chat` | One chatbot turn |

Extra middleware: origin allowlist (`CHAT_ALLOWED_ORIGINS`), chat CORS (POST/OPTIONS), `validateChat`, `express-rate-limit`.

**Request JSON**

```json
{
  "sessionId": "string, required, trimmed, max 128 chars",
  "message": "string, required, trimmed, max CHAT_MESSAGE_MAX_LENGTH (default 2000)",
  "intent": "optional: BUY | RENT | OFF_PLAN | SELL_PROPERTY | PROPERTY_MANAGEMENT",
  "pageContext": "optional page hint; currently PROPERTY_MANAGEMENT (also property-management / Property Management). Ignored if unrecognised.",
  "property_type": "optional, also propertyType / type",
  "property_types": "optional array or comma list",
  "custom_property_type": "optional, used when property_type is Other"
}
```

`intent` is normalized to uppercase with spaces/hyphens → `_`. Unrecognised intent → `400`.

`pageContext` is an optional **hint**, not a lock. Only `PROPERTY_MANAGEMENT` is used today (`property-management`, `property_management`, and `Property Management` all normalize to it). Unknown values are ignored. It applies only when the conversation has **no intent yet** and the message does not already parse as buy / rent / sell / off-plan / property management. A clear user intent always wins. After the visitor changes direction, later turns ignore `pageContext` even if the frontend keeps sending it. `intent` is still the explicit client override and is unchanged.

**Success `200` JSON** (fields present depend on the turn)

```json
{
  "reply": "string",
  "propertyCards": [{ "id", "title", "price", "beds", "baths", "area", "imageUrl", "listingUrl", "location", "purpose", "furnished", "propertyType" }],
  "sources": [{ "title", "url" }],
  "suggestedCta": "string | null",
  "viewAllMatching": { "total", "url", "label" } | null,
  "requiresClarification": true,
  "options": ["chip labels"],
  "select": "single",
  "qualification": { "slots": {}, "question": { "slot", "question", "options" } },
  "leadCaptured": true
}
```

- Clarification turns (`clarificationResponse`) include `leadCaptured` and empty `propertyCards` / `sources` / `suggestedCta` / `viewAllMatching`.
- Forced listing-search and model-loop success payloads do **not** currently include `leadCaptured`.
- Validation errors: `{ success: false, message }` with 400/403.
- Rate limit: `{ success: false, message: "Too many chat requests, please try again shortly" }`.
- Handler errors: `{ success, reply, message, propertyCards: [], sources: [] }` — mongoose content validation is returned as `200` with the friendly error string; other errors are `500`.

There is no GET/list/delete conversation endpoint, no streaming endpoint, and no separate “reset session” endpoint.

### Frontend properties — `/api/frontend` (`src/routes/frontendRoutes.js`, `src/controllers/frontendController.js`, `src/services/propertyDbService.js`)

Shared list query: `page` (default 1), `limit` (default 10, max 100), `search`, optional `filters` JSON **or** direct keys `propertyType`, `city`, `locality`, `subLocality`, `towerName`, `bedrooms`, `bathrooms`, `furnished`, `offPlan`, `propertyStatus`, `priceMin`, `priceMax`, `propertySizeMin`, `propertySizeMax`.

List responses: `{ properties, total, pagination }` where `pagination` is `{ page, limit, totalPages, hasNextPage, hasPrevPage }`. Invalid `filters` JSON → `{ message: "Invalid \"filters\" JSON payload" }`.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/frontend/properties` | All listings |
| GET | `/api/frontend/properties/search` | Autocomplete. Query `q`, `limit` (default 10, max 20). `{ suggestions: [{ propertyRefNo, towerName, propertyPurpose, propertyType, locality, subLocality }] }` |
| GET | `/api/frontend/properties/search-by-area` | `q` required. `{ suggestions: [{ type, label, full }] }` |
| GET | `/api/frontend/properties/types` | JSON array of unique `propertyType` strings |
| GET | `/api/frontend/properties/types-by-category` | `[{ type, category: "Residential" \| "Commercial" }]` |
| GET | `/api/frontend/properties/off-plan` | `offPlan === "Yes"` |
| GET | `/api/frontend/properties/ready` | Ready (not off-plan) |
| GET | `/api/frontend/properties/buy` | Buy purpose |
| GET | `/api/frontend/properties/rent` | Rent purpose |
| GET | `/api/frontend/properties/dubai-south` | Forces locality Dubai South |
| GET | `/api/frontend/properties/dubai-south/by-listing-agent` | Query `listingAgent` required. Extra field `listingAgent` on response |
| GET | `/api/frontend/properties/featured-dubai-south` | Azizi Venice; default `limit` 6 |
| GET | `/api/frontend/properties/featured-jebel-ali-village` | `{ properties, total, missingRefs }` |
| GET | `/api/frontend/properties/:propertyRefNo` | Single listing document, or `404 { message }` |

`embedding` / `embeddingHash` are stripped from public property payloads (`propertyDbService.js`).

### Salesforce — `/api/salesforce` (`src/routes/salesforceRoutes.js`)

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| POST | `/api/salesforce/migrate` | none; fetches `BASE_URL_SALESFORCE` | `{ success, message?, count, result? }` or skipped |
| POST | `/api/salesforce/migrate-xml` | raw XML body (`application/xml` / `text/xml`) | `{ success, message, parsedCount, count, result }` |

### Enquiry / lead CRUD

Create is public (API key only). GET/PUT/DELETE require JWT unless noted.

**Contact** `/api/contact` — body `{ fullName, email, phone, inquiryType, message }`. Create also POSTs Zapier (`ZAPIER_WEBHOOK_URL`). Response `{ success, message, data }` including `source: "Contact Us"`.

**Sell** `/api/sell` — `{ fullName, phone, email, propertyType, locationArea, message }`. `propertyType` enum in `src/models/sell.js`: Apartment, Villa, Townhouse, Penthouse, Office, Shop, Warehouse, Land, Other.

**Newsletter** `POST /api/newsletter` — `{ email }`. Duplicate email returns `200 Already subscribed`. No list endpoint.

**Career** `/api/career` — `multipart/form-data`: `fullName` (or `name`), `email`, `phone`, `position`, file field `cv` (PDF only, S3). Response includes stored career doc. Google Sheets via `GOOGLE_SHEETS_WEBHOOK_URL`. Zapier uses `ZAPIER_SOURCES.CAREERS`, which is **commented out** in `src/services/zapierService.js`, so `source` is `undefined` and the shared Zapier hook is skipped.

**Jewel Tower** `/api/jewel-tower-lead` — `{ fullName, email, phone, message }`. Google Sheets `GOOGLE_SHEETS_JEWEL_TOWER_LEAD_URL`. Zapier `JEWEL_TOWER_ZAPIER_WEBHOOK_URL`. `ZAPIER_SOURCES.JEWEL_TOWER_LEAD` is also commented out.

**Landing page** `/api/landing-page-lead` — `{ landingPage, subSource, fullName, email, phone, message }`. Sheets + Zapier.

**Property management form** `/api/property-management-lead` — `{ fullName, email, phone, message }`. Zapier.

**Area guide leads** `/api/area-guide-leads` — `{ fullName, email, phone, inquiryType, propertyType, message, subSource? }`. Zapier.

Typical admin list: `{ success, count, data }`. Get-by-id `404` if missing. Invalid ObjectId → `400`.

### Factsheets — `/api/factsheets`

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| POST | `/api/factsheets` | multipart `fullName` + file field `pdf` | `201 { success, data: { id, fullName, fileUrl, fileName, createdAt } }` |

No list/get/delete routes.

### TeamTailor — `/api/teamtailor`

| Method | Path | Query | Response |
| --- | --- | --- | --- |
| GET | `/api/teamtailor/jobs` | `live=true` (API) or `status`, `humanStatus` (DB) | `{ success, source, count, data }` |
| GET | `/api/teamtailor/jobs/:id` | `live=true` optional | `{ success, source, data }` |
| POST | `/api/teamtailor/sync` | none | `{ success, message, count, upserted, modified, deleted, staleIds }` |

### CMS

**FAQs** `/api/faqs` (`src/controllers/faqController.js`)

- POST `{ page, slug?, question, answer, order?, isActive? }`. `page` must be one of the enum in `src/models/Faq.js`.
- GET `?page=&slug=&isActive=`
- GET/PUT/DELETE `/:id`

**Services** `/api/services`

- POST `{ slug, title, description, image?, icon?, overviewHeading?, overview?, subservices?, isActive? }`
- GET `?isActive=`
- GET `/slug/:slug`, GET `/:id`, PUT/DELETE `/:id`

**Blogs** `/api/blogs`

- POST `{ slug|path, title, category, description, content (required array of blocks with type), subtitle?, image?, isFeatured?, faqs?, keywords?, isActive? }`
- GET `?isActive=&category=&isFeatured=`
- GET `/slug/:slug`, GET `/:id`, PUT/DELETE `/:id`

**Team members** `/api/team-members`

- POST `{ order (number), name, department, designation, slug?, isAdmin?, isAgent?, image?, phone?, email?, whatsapp?, languages?, experience?, businessCardPdf?, isActive? }`
- GET `?isActive=&isAgent=&isAdmin=&department=`
- GET `/slug/:slug`, GET `/:id`, PUT/DELETE `/:id`

**Company info (chatbot Q&A)** `/api/company-info`

- POST `{ topic, question, answer, category?, isActive? }`
- GET `?topic=&category=&isActive=`
- GET `/topic/:topic`, GET `/:id`, PUT/DELETE `/:id`

**Area guides** `/api/area-guides`

- POST `{ order, title, about, mapQuery, slug|path, keyHighlights?, agentOrders?, image?, listingsSearch?, isActive? }`
- POST `/sync-agents` query/body `rebuild`, `includeInactive`
- GET `?isActive=&includeAgents=true`
- GET `/agents?listingsSearch=` (or `area` / `terms`)
- GET `/slug/:slug`, GET `/:id`
- POST `/:id/sync-agents`
- PUT/DELETE `/:id`

Typical CMS success: `{ success, message?, count?, data }`.

### Google reviews — `/api/reviews` (`src/routes/googleReviewRoutes.js`)

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/reviews/google` | 5-star reviews only: `{ success, data: [{ _id, starRating, reviewerName, comment }], pagination: { page, limit, total, pages } }`. Query `accountId` / `locationId` / `accountName` / `locationName` → `400`. Default `limit` 20. |
| GET | `/api/reviews/google/business-profiles` | `{ success, accounts, locations, message, diagnostics }`. `409` if not connected. |

### Google Business Profile OAuth — `/auth/google` (`src/routes/googleBusinessProfileAuthRoutes.js`)

| Method | Path | Behaviour |
| --- | --- | --- |
| GET | `/auth/google` | Sets OAuth state cookie, redirects to Google |
| GET | `/auth/google/callback` | HTML success/failure page; stores encrypted tokens |
| GET | `/auth/google/status` | API key required. JSON from `getSafeConnectionStatus()` (no tokens) |

---

## 4. LLM Integration

**Provider:** OpenAI Chat Completions API (`openai.chat.completions.create` in `runModelLoop`, `src/ai/chat.controller.js`).

**Model:** `process.env.OPENAI_CHAT_MODEL` or `OPENAI_MODEL`, default **`gpt-5-nano`**.

**Embeddings:** `process.env.OPENAI_EMBEDDING_MODEL` or **`text-embedding-3-small`** (`embedQuery` in `chat.tools.js`; batch embed in `scripts/embedContent.js`).

**Params actually passed to chat completions:**

| Param | Value |
| --- | --- |
| `model` | env / `gpt-5-nano` |
| `messages` | system + last history + user (+ tool messages in-loop) |
| `tools` | `TOOL_DEFINITIONS` from `chat.tools.js` |
| `tool_choice` | `'auto'`, or force `search_content` on first round for content topics, or `'none'` after content hits |
| `max_completion_tokens` | 1024 (tool round), 600 (after tools / content replies) |
| `reasoning_effort` | `OPENAI_REASONING_EFFORT` or `'minimal'` |

**Not set:** `temperature`, `stream`, `top_p`. Responses are **not streamed**; the HTTP handler waits for the full completion and returns one JSON body.

**System prompt:** `getSystemPrompt(userProfile)` in `src/ai/chat.prompt.js`. It injects a JSON snapshot of the visitor profile (areas, budget, bedrooms, purpose, intent, lastSearchFilters, slotFlow, qualificationSlots, leadCaptured) plus a “Properties currently shown” line from `lastPropertyCards`. Rules in the prompt: locked intent, server-owned qualification questions, three tools, no invented listings/prices, short replies, content vs listing routing.

**Tools** (`TOOL_DEFINITIONS` in `src/ai/chat.tools.js`):

1. `search_properties` — filters: `location`, `bedrooms`, `budgetMin`, `budgetMax`, `type`, `types`, `purpose`. Executes Mongo listing queries via `propertyDbService` (`fetchBuyProperties` / `fetchRentProperties` / off-plan). Returns up to **6** cards (`PROPERTY_LIMIT`), plus `viewAllMatching` frontend URL. Can ask for purpose/bedrooms, offer empty-result chips, blend an area-guide blurb, exclude already-shown `propertyRefNo`s.
2. `search_content` — required `query`. Embeds the query, Atlas `$vectorSearch` on `chatbot_knowledge.embedding`, index `CHATBOT_VECTOR_INDEX` (default `chatbot_knowledge_vector_index`), `numCandidates: 80`, `limit: 8`, min score `CHAT_VECTOR_MIN_SCORE` (default `0.75`), excludes `sourceType: "property"`. Chunks truncated to 420 chars. Related buttons: max 2 URLs, ranked blog → area guide → company_info → FAQ → service → listing, never homepage.
3. `capture_lead` — required `name`, `phone`, `email`, `intent`. Writes `leads` collection. Duplicate capture in the same session is a no-op (`leadAlreadyCaptured`). Service inquiries can pass `emailOptional: true` from the controller (not in the public tool schema).

Loop: up to **4** tool rounds (`MAX_TOOL_ROUNDS`). Empty model content after `search_content` is replaced by `synthesizeContentReply` (excerpt from first chunk) or `"Sorry, I couldn't pull that up — try again in a moment"`.

**Deterministic path (often skips the LLM):** if slot resolution returns `type: 'continue'` and the turn is a listing search, `runForcedPropertySearch` calls `search_properties` directly and returns canned copy (`foundListingsReply`, empty-result copy, bedroom/purpose chips). Sell, property-management, and many clarifications never call OpenAI. Optional `pageContext: PROPERTY_MANAGEMENT` can start the property-management flow on the first turn when the message has no listing intent; it is not stored on the session and does not override a later buy / rent / sell / off-plan message.

**Content index job:** `node scripts/embedContent.js` (optional `--dry-run`). Embeds active blogs, area guides, FAQs, services, company info. Skips factsheets. Chunk size ~1600–2000 chars. Upserts by `(sourceType, sourceId, embeddingHash)`; deletes stale chunks.

---

## 5. Conversation / Message Handling

**Storage:** MongoDB collection `conversations` (`Conversation` in `src/ai/chat.models.js`). Keyed by unique `sessionId` from the client. Created on first message (`loadConversation`).

**Messages:** array of `{ role: "user" | "assistant", content, createdAt }`. After each turn, both the user line and assistant `reply` are appended, then sliced to the last **40** (`MAX_STORED_MESSAGES`). Tool calls are **not** stored.

**Passed to the LLM:** last **10 turns** = 20 messages (`HISTORY_TURNS * 2`) via `toOpenAIHistory` — only `role` + `content`.

**Session state (`userProfile` on the same document):** preferred areas, budget min/max, bedrooms, purpose, intent (`BUY` / `RENT` / `OFF_PLAN` / `SELL_PROPERTY` / `PROPERTY_MANAGEMENT`), last property cards (max 10 stored), shown listing IDs, search signature / executed flag, explored areas, `lastSearchFilters`, `slotFlow.awaiting` (+ optional JSON `alternatives`), `qualificationSlots`, `sellListing`, `serviceInquiry`, `leadCaptured`.

Slot awaiting values used in code include: `purpose`, `bedrooms`, `listingIntake`, `location`, `nearbyArea`, `budget`, `emptyResults`, `alternatives`, `sell`, `sellServiceLocation`, `pmNeed`, `pmProperty`, `serviceLocation`, `serviceContact`.

**Qualification** (`src/ai/chat.qualify.js`): derives slots from the latest user text (purpose, type, location, beds, budget, furnished, move-in, must-haves, usage, focus, readiness). Up to **3** blocking questions before the first search (`QUESTION_CAP`); up to **2** optional follow-ups after results (`OPTIONAL_CAP`). `"any"` / `"doesn't matter"` fills the pending slot.

**Not used for chat history:** in-memory store, Redis, or listing vector search. `property_embeddings` is a separate collection; chatbot listing search is filter/query on `properties`, not embeddings.

**Chat leads:** collection `leads` (`Lead` in `chat.models.js`): `name`, `phone`, `email` (optional empty string), `intent`, `sessionId`. These are **not** written to Contact / Sell / PropertyManagementLead and are **not** sent to Zapier.

---

## 6. Auth & Security

| Mechanism | Where | Behaviour |
| --- | --- | --- |
| Shared API key | `src/middleware/apiKeyMiddleware.js`, applied to `/api` in `src/index.js` | Header `x-api-key` **or** `Authorization: Bearer <API_SECRET_KEY>`. Missing env → `500`. Mismatch → `401`. |
| User JWT | `src/middleware/authMiddleware.js` | `Authorization: Bearer <jwt>`. Verifies `JWT_SECRET`, loads `User` by `decoded.id`. Used on enquiry admin routes and `GET /api/auth/users`. No role checks. |
| Chat origin | `restrictChatOrigin` + extra `cors` in `chat.routes.js` | Default allowlist: `https://www.rockyrealestate.com`, `https://rockyrealestate.com`, `http://localhost:3000`. Override `CHAT_ALLOWED_ORIGINS` (comma-separated). Missing origin is allowed. Else `403`. |
| Chat rate limit | `express-rate-limit` | Window `CHAT_RATE_LIMIT_WINDOW_MS` (default 60s), max `CHAT_RATE_LIMIT_MAX` (default 20). Key: `chat-session:<sessionId>` or IP. |
| Chat body limits | `validateChat` | `sessionId` required ≤128 chars; `message` required ≤ `CHAT_MESSAGE_MAX_LENGTH`. Optional `intent` (known values or `400`). Optional `pageContext` (string; unrecognised values ignored). |
| Google OAuth | `/auth/google` | State cookie vs `state` query; tokens encrypted with AES-256-GCM keyed from SHA-256 of `GOOGLE_CLIENT_SECRET` (`src/utils/tokenCrypto.js`). Tokens `select: false` on the connection model. |
| Property internals | `propertyDbService.js` | `embedding` / `embeddingHash` projected out of frontend APIs. |

Passwords: bcrypt, `select: false`, min length 6 (`src/models/User.js`).

No CSRF tokens. No per-route rate limits except chat. CMS mutating endpoints are not JWT-gated.

---

## 7. Database Schema

MongoDB. Mongoose models (collection names are default pluralization unless noted).

### Chat (`src/ai/chat.models.js`)

**`conversations`**

- `sessionId` (unique, indexed)
- `messages[]`: `role` (`user`|`assistant`), `content`, `createdAt`
- `userProfile`: nested object described in §5 (including `lastPropertyCards[]`, `lastSearchFilters`, `slotFlow`, `qualificationSlots`, `sellListing`, `serviceInquiry`, `leadCaptured`)
- timestamps

**`leads`**

- `name`, `phone`, `email` (optional, indexed), `intent`, `sessionId` (indexed), timestamps

**`chatbot_knowledge`** (`src/models/ChatbotKnowledge.js`, collection forced)

- `sourceType`, `sourceId`, `title`, `url`, `content`, `embedding` (number[]), `embeddingHash`
- unique index `(sourceType, sourceId, embeddingHash)`
- `sourceType` values written by `embedContent.js`: `blog`, `area_guide`, `faq`, `service`, `company_info`

### Listings

**`properties`** (`src/models/Property.js`): `propertyRefNo` (unique), permit fields, `propertyStatus`, `propertyPurpose`, `propertyType`, size, beds/baths, `offPlan`, `lastUpdated`, `city`, `locality`, `subLocality`, `towerName`, title/description, `price`, `furnished`, `rentFrequency`, listing agent fields, `features[]`, `portals[]`, `images[]`. No timestamps.

**`property_embeddings`** (`src/models/PropertyEmbedding.js`): `propertyRefNo` (unique), `embedding`, `embeddingHash`, timestamps. Used by migrate cleanup (`salesforceMigrateService.js` deletes embeddings for removed refs) and `scripts/movePropertyEmbeddings.js`. **Not** queried by the chatbot.

### Users & CMS

**`users`:** `name`, `email` (unique), `password`, `role` enum `superadmin` | `postadmin` | `content-writer` (default `content-writer`), timestamps.

**`faqs`:** `page` (enum in model), `slug`, `question`, `answer`, `order`, `isActive`.

**`services`** (collection `services`): `slug` unique, `title`, `image`, `icon`, `description`, `overviewHeading`, `overview[]`, `subservices[{ id, title, icon, description, points }]`, `isActive`.

**`blogs`** (collection `blogs`): `slug` unique, `title`, `category`, `subtitle`, `description`, `image`, `path`, `isFeatured`, `content[]` (strict: false blocks, `type` required), `faqs[{ question, answer }]`, `keywords[]`, `isActive`.

**`teammembers`:** `order` unique, `isAdmin`, `isAgent`, `name`, `slug` unique, `department`, `designation`, `image`, `phone`, `email`, `whatsapp`, `languages[]`, `experience[]`, `businessCardPdf`, `isActive`.

**`areaguides`** (`AreaGuide`): `order` unique, `slug` unique, `title`, `about`, `keyHighlights[{ icon, title }]`, `agentOrders[]`, `mapQuery`, `image`, `path`, `listingsSearch[]`, `isActive`.

**`companyinfos`:** `topic`, `question`, `answer`, `category` (default `general`), `isActive`.

### Website leads / other

| Model | File | Fields (required unless noted) |
| --- | --- | --- |
| Contact | `src/models/Contact.js` | `subSource` (default `Contact Us`), `fullName`, `email`, `phone`, `inquiryType`, `message` |
| Sell | `src/models/sell.js` | `subSource`, `fullName`, `phone`, `email`, `propertyType` (enum), `locationArea`, `message` |
| Newsletter | `src/models/Newsletter.js` | `email` unique |
| Career | `src/models/Career.js` | `fullName`, `email`, `phone`, `position`, CV metadata (`cv.key`, urls, size, etc.) |
| JewelTowerLead | `src/models/JewelTowerLead.js` | `fullName`, `email`, `phone`, `message` |
| LandingPageLead | `src/models/LandingPageLead.js` | `landingPage`, `subSource`, `fullName`, `email`, `phone`, `message` |
| PropertyManagementLead | `src/models/PropertyManagementLead.js` | `subSource` default `Property Management`, `fullName`, `email`, `phone`, `message` |
| AreaGuideLead | `src/models/AreaGuideLead.js` | `subSource`, `fullName`, `email`, `phone`, `inquiryType`, `propertyType`, `message`. **Collection name forced to `areaguides`** (same string as AreaGuide CMS docs) |
| Factsheet | `src/models/Factsheet.js` | `fullName`, `fileUrl`, `fileName?`, `createdAt` only |
| TeamTailorJob | `src/models/TeamTailorJob.js` | `teamtailorId` unique plus mirrored TeamTailor fields (title, body, status, picture, apply URLs, requirements, etc.) |
| GoogleBusinessProfileConnection | `src/models/GoogleBusinessProfileConnection.js` | singleton `connectionKey` default `company`; encrypted `accessToken` / `refreshToken` (select false); expiry, scope, Google account metadata |
| GoogleBusinessProfileReview | `src/models/GoogleBusinessProfileReview.js` | `googleReviewId` unique, reviewer fields, `starRating` 1–5, comment, times, reply, location/account names, `fetchedAt` |

---

## 8. Error Handling & Logging

**Express error handler** (`src/index.js`): four-arg middleware. Sends `{ success: false, message }` with `err.statusCode || err.status || 400`. Used for Multer/Cloudinary failures.

**Per-controller:** most handlers `try/catch` and return `{ success: false, message }` with 400/401/404/500. Frontend property routes often omit `success` and return `{ message }`.

**Chat:** `console.error('POST /api/chat error:', error)`. Tool failures inside the model loop are caught and returned to the model as `{ error }` in `modelPayload`. OpenAI finish_reason, usage, content length, and tool names are `console.log`’d in `runModelLoop`.

**Startup:** `connectDB` logs `MongoDB connected` or `MongoDB connection error` then `process.exit(1)`. `bootstrap().catch` logs `Failed to start server` and exits.

**Jobs:** Salesforce / TeamTailor / Google review schedulers log ISO timestamps and swallow run errors (`console.error` with message).

**Integrations:** Zapier and Google Sheets helpers log warnings if env URL missing, log HTTP failures, **do not throw** (create-lead HTTP still succeeds). S3 CV/factsheet delete failures are logged only.

**Auth middleware:** `console.warn('[auth] …')` on missing/invalid/expired tokens.

There is no structured logger (no Winston/Pino), no request-id middleware, and no error-tracking SDK in `package.json`.

---

## 9. Known Gaps / TODOs

No `TODO` / `FIXME` comments exist in the JS tree. Gaps visible from the code:

- **No LLM streaming.** Chat is a single JSON response.
- **No conversation admin API** (list, inspect, delete, export).
- **Chat leads are isolated** from website Contact/Sell/PM collections and from Zapier/Sheets.
- **`leadCaptured` is omitted** from the main search/model success JSON (only clarification responses include it).
- **`parseFurnishedFromMessage` is called in `applyListingFilterUpdate` (`chat.controller.js`) but is not imported** there — a furnishing chip on an existing search can throw `ReferenceError`.
- **`package.json` `"test": "jest"`** vs tests written for `node --test src/ai/chat.test.js`; Jest is not a dependency.
- **`docs/API_INVENTORY.md` is stale** (26 endpoints; Dubai South, chat, CMS, reviews, etc. are missing).
- **`User.role` is never enforced.** CMS writes are API-key-only.
- **`ZAPIER_SOURCES.CAREERS` and `JEWEL_TOWER_LEAD` are commented out**, so those create handlers pass `source: undefined` into Zapier (shared hook then skips).
- **`PUBLIC_BASE_URL` is in `.env.example` but unused** in source. Career `cvUrl` is built from `AWS_S3_BUCKET` + `AWS_REGION`.
- **Cloudinary env is required at process load** because `src/middleware/upload.js` imports `src/config/cloudinary.js`, even though career/factsheet uploads use S3 memory storage.
- **Chatbot listing search does not use `property_embeddings` / vector search**; only CMS content does.
- **`embedContent.js` is manual** (not a cron). New CMS rows are invisible to `search_content` until it is run. Atlas index `chatbot_knowledge_vector_index` must exist.
- **AreaGuide and AreaGuideLead both use collection `areaguides`.**
- **No GET for factsheets or newsletters** beyond create/subscribe.
- **`.env.example` does not list** `MONGO_URI`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `BASE_URL_SALESFORCE`, Salesforce migrate cron vars, or Cloudinary vars, all of which the code reads.

---

## 10. Environment Variables / Config

Loaded via `dotenv` in `src/index.js` and `config/db.js`. Canonical comments: `.env.example`. Values below are what the **code** reads.

### Required for the process to serve `/api`

| Variable | Used in | Purpose |
| --- | --- | --- |
| `MONGO_URI` | `config/db.js` | Mongo connection. Missing → process exits on boot. |
| `API_SECRET_KEY` | `apiKeyMiddleware.js` | Shared key for all `/api` routes. Missing → every `/api` call is `500`. |
| `CLOUDINARY_CLOUD_NAME` | `src/config/cloudinary.js` | Required at import of `upload.js` (boot). |
| `CLOUDINARY_API_KEY` | same | same |
| `CLOUDINARY_API_SECRET` | same | same |

### Server

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5001` | HTTP port |
| `NODE_ENV` | — | Affects Google OAuth cookie `secure` when callback is not `https` |

### Auth (admin JWT)

| Variable | Default | Purpose |
| --- | --- | --- |
| `JWT_SECRET` | none | Sign/verify user tokens. Required for login/signup token and `protect`. |
| `JWT_EXPIRES_IN` | `7d` | JWT expiry |

### Chatbot / OpenAI

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | none | Chat + embeddings. Missing throws when a model/tool embed runs. |
| `OPENAI_CHAT_MODEL` | `gpt-5-nano` | Chat model (`OPENAI_MODEL` is a fallback) |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Query + CMS embeddings |
| `OPENAI_REASONING_EFFORT` | `minimal` | Passed to chat completions |
| `FRONTEND_URL` | `https://www.rockyrealestate.com` | Listing and content URLs in cards/sources |
| `CHAT_ALLOWED_ORIGINS` | rocky production + `http://localhost:3000` | Chat origin allowlist |
| `CHAT_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window |
| `CHAT_RATE_LIMIT_MAX` | `20` | Max requests per session/IP per window |
| `CHAT_MESSAGE_MAX_LENGTH` | `2000` | Max `message` length |
| `CHATBOT_VECTOR_INDEX` | `chatbot_knowledge_vector_index` | Atlas vector index name |
| `CHAT_VECTOR_MIN_SCORE` | `0.75` | Min `$vectorSearch` score |

### Listings feed

| Variable | Default | Purpose |
| --- | --- | --- |
| `BASE_URL_SALESFORCE` | none | XML feed URL; required for migrate |
| `SALESFORCE_MIGRATE_ENABLED` | on unless `"false"` | Hourly cron |
| `SALESFORCE_MIGRATE_CRON` | `0 * * * *` | Cron expression |
| `SALESFORCE_MIGRATE_SKIP_IF_UNCHANGED` | on unless `"false"` | Skip bulkWrite if feed hash unchanged |
| `SALESFORCE_MIGRATE_ON_START` | off unless `"true"` | Run migrate at boot |
| `SALESFORCE_MIGRATE_TZ` | unset | node-cron timezone |

### AWS S3 (careers CV, factsheet PDF)

| Variable | Default | Purpose |
| --- | --- | --- |
| `AWS_REGION` | — | Required when S3 client is used |
| `AWS_ACCESS_KEY_ID` | — | same |
| `AWS_SECRET_ACCESS_KEY` | — | same |
| `AWS_S3_BUCKET` | — | same |
| `AWS_S3_MAX_IMAGE_SIZE` | 5MB | Unused by current career/factsheet routes; used by unused `uploadImage` |
| `AWS_S3_MAX_VIDEO_SIZE` | 100MB | unused in routes |
| `AWS_S3_MAX_PDF_SIZE` | 10MB | factsheet |
| `AWS_S3_MAX_CV_SIZE` | 5MB in `constants/s3.js` (`.env.example` comment says 10MB) | career CV |

### Zapier / Sheets (optional; skip if unset)

| Variable | Purpose |
| --- | --- |
| `ZAPIER_WEBHOOK_URL` | Contact, sell, area-guide, landing, PM (and career if `source` were set) |
| `JEWEL_TOWER_ZAPIER_WEBHOOK_URL` | Jewel Tower leads |
| `GOOGLE_SHEETS_WEBHOOK_URL` | Career rows |
| `GOOGLE_SHEETS_JEWEL_TOWER_LEAD_URL` | Jewel Tower rows |
| `GOOGLE_SHEETS_LANDING_PAGE_LEAD_URL` | Landing page rows |

### TeamTailor

| Variable | Default | Purpose |
| --- | --- | --- |
| `TEAMTAILOR_API_TOKEN` | none | API + scheduler (scheduler no-ops without it) |
| `TEAMTAILOR_API_BASE_URL` | `https://api.teamtailor.com/v1` | |
| `TEAMTAILOR_API_VERSION` | `20240404` | |
| `TEAMTAILOR_SYNC_ENABLED` | on unless `"false"` | |
| `TEAMTAILOR_SYNC_CRON` | `*/5 * * * *` | |
| `TEAMTAILOR_SYNC_ON_START` | on unless `"false"` | |
| `TEAMTAILOR_SYNC_TZ` | unset | |

### Google Business Profile

| Variable | Default | Purpose |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | — | OAuth |
| `GOOGLE_CLIENT_SECRET` | — | OAuth **and** token encryption key |
| `GOOGLE_CALLBACK_URL` | fallback inside service | Must match Google console; also used for cookie `secure` |
| `GOOGLE_BUSINESS_ACCOUNT_NAME` | auto if exactly one | Pin account |
| `GOOGLE_BUSINESS_LOCATION_NAME` | auto if exactly one | Pin location |
| `GOOGLE_REVIEWS_SYNC_ENABLED` | on unless `"false"` | |
| `GOOGLE_REVIEWS_SYNC_CRON` | `*/30 * * * *` | |
| `GOOGLE_REVIEWS_SYNC_ON_START` | on unless `"false"` | |
| `GOOGLE_REVIEWS_SYNC_TZ` | unset | |

### Documented but unused in source

| Variable | Note |
| --- | --- |
| `PUBLIC_BASE_URL` | Only in `.env.example` |

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | `node src/index.js` |
| `npm run dev` | `nodemon src/index.js` |
| `npm test` | `jest` (does not run `src/ai/chat.test.js` as written) |
| `node --test src/ai/chat.test.js` | Chat parser/qualification unit tests (no OpenAI) |
| `node scripts/embedContent.js` | Rebuild `chatbot_knowledge` embeddings |
| `npm run migrate:area-guides` | `scripts/migrateAreaGuides.js` |
| `node scripts/movePropertyEmbeddings.js` | Move listing vectors into `property_embeddings` |
