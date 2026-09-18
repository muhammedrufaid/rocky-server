# Rocky AI Chatbot — Backend & RAG Analysis

**Scope:** this document describes the backend in `/Users/muhammedrufaid/Desktop/Rocky/rocky-server` as it exists in the working tree. Every capability is traced to an actual file and invocation. Where the repo is silent, the text says **Not found in codebase** or **Could not confirm — needs manual review**.

**Not in the current tree (despite appearing in an earlier git snapshot):** `BACKEND.md`, `src/ai/chat.qualify.js`. Those files were not present when this analysis was written.

---

## 1. Project Structure

### 1.1 Backend folder / file tree

```
rocky-server/
├── package.json
├── package-lock.json
├── .env.example
├── .gitignore
├── config/
│   └── db.js
├── docs/
│   └── API_INVENTORY.md
├── scripts/
│   ├── embedContent.js
│   ├── movePropertyEmbeddings.js
│   ├── migrateAreaGuides.js
│   ├── google-apps-script-careers.js
│   └── google-apps-script-jewel-tower-leads.js
└── src/
    ├── index.js
    ├── ai/
    │   ├── chat.routes.js
    │   ├── chat.controller.js
    │   ├── chat.prompt.js
    │   ├── chat.tools.js
    │   ├── chat.models.js
    │   └── chat.test.js
    ├── config/
    │   ├── s3.js
    │   └── cloudinary.js
    ├── constants/
    │   ├── s3.js
    │   ├── dubaiSouth.js
    │   └── featuredJebelAliVillageProperties.js
    ├── controllers/
    │   ├── authController.js
    │   ├── frontendController.js
    │   ├── salesforceController.js
    │   ├── areaGuideController.js
    │   ├── areaGuideLeadController.js
    │   ├── contactController.js
    │   ├── sellController.js
    │   ├── newsletterController.js
    │   ├── careerController.js
    │   ├── jewelTowerLeadController.js
    │   ├── landingPageLeadController.js
    │   ├── propertyManagementLeadController.js
    │   ├── factsheetController.js
    │   ├── teamtailorController.js
    │   ├── faqController.js
    │   ├── serviceController.js
    │   ├── blogController.js
    │   ├── teamMemberController.js
    │   ├── companyInfo.controller.js
    │   ├── googleBusinessProfileController.js
    │   └── googleReviewController.js
    ├── jobs/
    │   ├── salesforceMigrateScheduler.js
    │   ├── teamtailorSyncScheduler.js
    │   └── googleReviewsSyncScheduler.js
    ├── middleware/
    │   ├── apiKeyMiddleware.js
    │   ├── authMiddleware.js
    │   └── upload.js
    ├── models/
    │   ├── User.js
    │   ├── Property.js
    │   ├── PropertyEmbedding.js
    │   ├── ChatbotKnowledge.js
    │   ├── Blog.js
    │   ├── AreaGuide.js
    │   ├── AreaGuideLead.js
    │   ├── Faq.js
    │   ├── Service.js
    │   ├── CompanyInfo.js
    │   ├── Contact.js
    │   ├── sell.js
    │   ├── Career.js
    │   ├── Newsletter.js
    │   ├── Factsheet.js
    │   ├── TeamMember.js
    │   ├── TeamTailorJob.js
    │   ├── LandingPageLead.js
    │   ├── JewelTowerLead.js
    │   ├── PropertyManagementLead.js
    │   ├── GoogleBusinessProfileConnection.js
    │   └── GoogleBusinessProfileReview.js
    ├── routes/
    │   ├── authRoutes.js
    │   ├── frontendRoutes.js
    │   ├── salesforceRoutes.js
    │   ├── areaGuideRoutes.js
    │   ├── areaGuideLeadRoutes.js
    │   ├── contactRoutes.js
    │   ├── sellRoutes.js
    │   ├── newsletterRoutes.js
    │   ├── careerRoutes.js
    │   ├── jewelTowerLeadRoutes.js
    │   ├── landingPageLeadRoutes.js
    │   ├── propertyManagementLeadRoutes.js
    │   ├── factsheetRoutes.js
    │   ├── teamtailorRoutes.js
    │   ├── faqRoutes.js
    │   ├── serviceRoutes.js
    │   ├── blogRoutes.js
    │   ├── teamMemberRoutes.js
    │   ├── companyInfo.routes.js
    │   ├── googleReviewRoutes.js
    │   └── googleBusinessProfileAuthRoutes.js
    ├── services/
    │   ├── propertyDbService.js
    │   ├── propertyService.js
    │   ├── salesforceMigrateService.js
    │   ├── s3Service.js
    │   ├── zapierService.js
    │   ├── googleSheetsService.js
    │   ├── teamtailorService.js
    │   ├── googleBusinessProfileService.js
    │   ├── googleBusinessProfileReviewService.js
    │   └── areaGuideAgentOrdersService.js
    └── utils/
        ├── paginationUtils.js
        ├── xmlUtils.js
        ├── fileUtils.js
        └── tokenCrypto.js
```

Chat routes live under `src/ai/`, not `src/routes/`. `node_modules/` is gitignored and omitted. No `tests/` directory exists beyond `src/ai/chat.test.js`.

There is no `src/app.js`. There is no separate `src/config/index.js`. Environment loading is `require('dotenv').config()` in `src/index.js` (and again in several services/scripts).

### 1.2 Purpose of important files and folders

| Path | Purpose (from code) |
|---|---|
| `src/index.js` | Creates Express app, CORS, body parsers, `/api` API-key gate, mounts routers, global error handler, health check, DB connect, starts cron jobs, `app.listen`. |
| `config/db.js` | `mongoose.connect(process.env.MONGO_URI)`. |
| `src/ai/` | Entire chatbot: route, controller, system prompt, tools (property search + RAG + lead capture), Mongoose models for conversations/leads. |
| `scripts/embedContent.js` | **Only** batch job that creates CMS embeddings. Not called by the HTTP server. |
| `scripts/movePropertyEmbeddings.js` | One-off migration of listing vectors off `Property` docs. Not called at runtime. |
| `src/models/ChatbotKnowledge.js` | Schema for CMS chunks + vectors (`chatbot_knowledge`). |
| `src/models/PropertyEmbedding.js` | Schema for listing vectors (`property_embeddings`). Written by the move script; deleted on Salesforce stale cleanup. **No current code generates these vectors.** |
| `src/services/propertyDbService.js` | Structured Mongo listing queries used by frontend APIs **and** `search_properties`. Not vector search. |
| `src/services/propertyService.js` | Salesforce XML fetch/parse (live feed). Used by migrate, not by chat. |
| `src/middleware/` | Shared API key, JWT user auth, multer uploads. |
| `src/jobs/` | Salesforce migrate, TeamTailor job sync, Google reviews sync. **No embed/reindex cron.** |
| `docs/API_INVENTORY.md` | Lists “26 endpoints”; the live `src/index.js` mounts far more. Treat as stale. |

### 1.3 Express app structure

**Entry point:** `package.json` `"main": "src/index.js"`. Scripts: `"start": "node src/index.js"`, `"dev": "nodemon src/index.js"`.

**Bootstrap** (`src/index.js`): `connectDB()` → start three schedulers → `app.listen(PORT)` where `PORT = process.env.PORT || 5001`. Failure exits the process.

**Middleware order** (exact order in `src/index.js`):

1. `app.set('trust proxy', 1)`
2. `cors({ origin: true, methods: GET/POST/PUT/DELETE/PATCH/OPTIONS, allowedHeaders: Content-Type, Authorization, x-api-key, credentials: true })`
3. `express.text({ type: xml/plain, limit: '50mb' })` — Salesforce raw XML
4. `express.json()` — **no explicit size limit in this file**
5. `express.urlencoded({ extended: true })`
6. `app.use('/api', requireApiKey)` — all `/api/*` need `x-api-key` or `Authorization: Bearer <API_SECRET_KEY>`
7. Route mounts (see §3)
8. Global error handler `(err, req, res, next)` — JSON `{ success: false, message }`
9. `GET /` health check (public; **not** under `/api`)

**Chat-specific extra middleware** is on the chat router itself (`src/ai/chat.routes.js`), after the global `/api` API-key check: origin restriction → chat CORS → `POST /` with `validateChat` then `chatLimiter` then `chat`.

**Google OAuth** is mounted at `/auth/google` **outside** `/api` so Google’s redirect is not blocked by `requireApiKey`. Status endpoint on that router re-applies `requireApiKey`.

---

## 2. Database Layer

### 2.1 MongoDB connection

**File:** `config/db.js`

```4:11:config/db.js
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('MongoDB connected');
  } catch (err) {
    console.error('MongoDB connection error', err.message);
    process.exit(1);
  }
};
```

- Driver: **Mongoose** (`mongoose` `^9.2.2` in `package.json`), not the native driver as the primary API.
- Connection string: `process.env.MONGO_URI` only. **Not listed in `.env.example`.**
- **No** `mongoose.connect` options in this repo (`maxPoolSize`, `serverSelectionTimeoutMS`, etc.). Pooling therefore uses Mongoose/driver defaults. Exact pool size: **Could not confirm — needs manual review** (not set in code).
- Scripts `scripts/embedContent.js`, `scripts/movePropertyEmbeddings.js`, `scripts/migrateAreaGuides.js` each call `mongoose.connect(process.env.MONGO_URI)` independently.

Whether the URI points at **MongoDB Atlas** vs self-hosted Mongo is not encoded in this repo. Atlas Vector Search **is** invoked via `$vectorSearch` (see §7). That operator is an Atlas feature; a non-Atlas cluster would fail at query time. Actual Atlas project/index existence: **Could not confirm — needs manual review** (no index definition checked into this repo).

### 2.2 Collections / models

All models are Mongoose schemas under `src/models/` plus chatbot models in `src/ai/chat.models.js`.

| Model file | Explicit collection (if any) | Role |
|---|---|---|
| `src/ai/chat.models.js` → `Conversation` | `conversations` | Chat sessions |
| `src/ai/chat.models.js` → `Lead` | `leads` | Chatbot-captured leads |
| `src/models/ChatbotKnowledge.js` | `chatbot_knowledge` | CMS chunks + embeddings |
| `src/models/PropertyEmbedding.js` | `property_embeddings` | Listing embeddings (legacy / unused by chat) |
| `src/models/Property.js` | default `properties` | Salesforce listings |
| `src/models/Blog.js` | `blogs` | CMS blogs (embed source) |
| `src/models/AreaGuide.js` | `areaguides` | CMS area guides (embed source) |
| `src/models/AreaGuideLead.js` | **`areaguides`** | Lead form — **same collection name as AreaGuide** |
| `src/models/Faq.js` | default `faqs` | CMS FAQs (embed source) |
| `src/models/Service.js` | `services` | CMS services (embed source) |
| `src/models/CompanyInfo.js` | default `companyinfos` | Chat Q&A CMS (embed source) |
| `src/models/User.js` | default `users` | Admin/CMS login |
| `src/models/Contact.js` | default `contacts` | Contact form |
| `src/models/sell.js` | default `sells` | Sell-inquiry form |
| `src/models/Career.js` | default `careers` | Career applications |
| `src/models/Newsletter.js` | default `newsletters` | Newsletter emails |
| `src/models/Factsheet.js` | default `factsheets` | Uploaded PDFs (explicitly **not** embedded) |
| `src/models/TeamMember.js` | `teammembers` | Team pages (not embedded) |
| `src/models/TeamTailorJob.js` | default `teamtailorjobs` | Synced jobs |
| `src/models/LandingPageLead.js` | default `landingpageleads` | Landing-page form |
| `src/models/JewelTowerLead.js` | default `jeweltowerleads` | Jewel Tower form |
| `src/models/PropertyManagementLead.js` | default `propertymanagementleads` | PM form |
| `src/models/GoogleBusinessProfileConnection.js` | default | OAuth tokens (encrypted) |
| `src/models/GoogleBusinessProfileReview.js` | default | Synced reviews |

** collides:** `AreaGuide` and `AreaGuideLead` both pass `'areaguides'` as the collection. `AreaGuideLead.js` comments that this is historical. Whether production data is mixed: **Could not confirm — needs manual review**.

### 2.3 Chat / conversation storage

Defined in `src/ai/chat.models.js`.

- Lookup key: unique indexed `sessionId` (string).
- Created on first chat request in `loadConversation` (`src/ai/chat.controller.js`).
- `userProfile` holds intent, search filters, shown listing IDs, sell/PM slot state, last property cards, `leadCaptured`.
- Timestamps enabled on the conversation document.

### 2.4 Message storage and history

Each message in `conversations.messages[]`:

- `role`: `'user' | 'assistant'` only
- `content`: string
- `createdAt`

**Persist path** (`src/ai/chat.controller.js`): after a successful turn, push user + assistant, then `conversation.messages = conversation.messages.slice(-MAX_STORED_MESSAGES)` with `MAX_STORED_MESSAGES = 40`, then `conversation.save()`.

**Retrieve path for the LLM:** `toOpenAIHistory` takes `messages.slice(-HISTORY_TURNS * 2)` with `HISTORY_TURNS = 10` (last 20 stored messages) and maps `{ role, content }` only. Tool calls are **not** stored. Embeddings of messages are **not** stored.

Clarification turns (`clarificationResponse`) persist the same way.

---

## 3. API Layer

### 3.1 All mounted routes

Unless noted, every `/api/*` route also requires `requireApiKey` from `src/index.js`.

| Method | Path | Purpose | File |
|---|---|---|---|
| GET | `/` | Health JSON | `src/index.js` |
| POST | `/api/auth/signup` | Create user + JWT | `src/routes/authRoutes.js` → `src/controllers/authController.js` |
| POST | `/api/auth/login` | Login + JWT | same |
| GET | `/api/auth/users` | List users | same + `protect` JWT |
| GET | `/api/frontend/properties` | Paginated listings | `src/routes/frontendRoutes.js` → `src/controllers/frontendController.js` |
| GET | `/api/frontend/properties/search` | Listing suggestions | same |
| GET | `/api/frontend/properties/search-by-area` | Area suggestions | same |
| GET | `/api/frontend/properties/types` | Distinct types | same |
| GET | `/api/frontend/properties/types-by-category` | Types by category | same |
| GET | `/api/frontend/properties/off-plan` | Off-plan list | same |
| GET | `/api/frontend/properties/ready` | Ready list | same |
| GET | `/api/frontend/properties/buy` | Buy list | same |
| GET | `/api/frontend/properties/rent` | Rent list | same |
| GET | `/api/frontend/properties/dubai-south` | Dubai South list | same |
| GET | `/api/frontend/properties/dubai-south/by-listing-agent` | By agent | same |
| GET | `/api/frontend/properties/featured-dubai-south` | Featured DS | same |
| GET | `/api/frontend/properties/featured-jebel-ali-village` | Featured JAV | same |
| GET | `/api/frontend/properties/:propertyRefNo` | One listing | same |
| POST | `/api/salesforce/migrate` | Fetch XML feed → upsert | `src/routes/salesforceRoutes.js` |
| POST | `/api/salesforce/migrate-xml` | Raw XML → upsert | same |
| POST/GET/PUT/DELETE | `/api/area-guides`… | Area guide CMS + agent sync | `src/routes/areaGuideRoutes.js` |
| POST | `/api/area-guide-leads` | Public lead create | `src/routes/areaGuideLeadRoutes.js` |
| GET/PUT/DELETE | `/api/area-guide-leads`… | Admin CRUD | same + `requireUserToken` |
| POST | `/api/contact` | Public contact create | `src/routes/contactRoutes.js` |
| GET/PUT/DELETE | `/api/contact`… | Admin CRUD | same + JWT |
| POST | `/api/sell` | Public sell inquiry | `src/routes/sellRoutes.js` |
| GET/PUT/DELETE | `/api/sell`… | Admin CRUD | same + JWT |
| POST | `/api/newsletter` | Subscribe | `src/routes/newsletterRoutes.js` |
| POST | `/api/career` | Apply + CV upload | `src/routes/careerRoutes.js` |
| GET/PUT/DELETE | `/api/career`… | Admin CRUD | same + JWT |
| POST | `/api/jewel-tower-lead` | Public lead | `src/routes/jewelTowerLeadRoutes.js` |
| GET/PUT/DELETE | `/api/jewel-tower-lead`… | Admin | same + JWT |
| POST | `/api/landing-page-lead` | Public lead | `src/routes/landingPageLeadRoutes.js` |
| GET/PUT/DELETE | `/api/landing-page-lead`… | Admin | same + JWT |
| POST | `/api/property-management-lead` | Public lead | `src/routes/propertyManagementLeadRoutes.js` |
| GET/PUT/DELETE | `/api/property-management-lead`… | Admin | same + JWT |
| POST | `/api/factsheets` | Upload PDF factsheet | `src/routes/factsheetRoutes.js` |
| POST | `/api/teamtailor/sync` | Sync jobs now | `src/routes/teamtailorRoutes.js` |
| GET | `/api/teamtailor/jobs` | List jobs | same |
| GET | `/api/teamtailor/jobs/:id` | One job | same |
| CRUD | `/api/faqs` | FAQ CMS | `src/routes/faqRoutes.js` |
| CRUD | `/api/services` | Service CMS | `src/routes/serviceRoutes.js` |
| CRUD | `/api/blogs` | Blog CMS | `src/routes/blogRoutes.js` |
| CRUD | `/api/team-members` | Team CMS | `src/routes/teamMemberRoutes.js` |
| CRUD | `/api/company-info` | Company Q&A CMS | `src/routes/companyInfo.routes.js` |
| POST | `/api/chat` | Chatbot | `src/ai/chat.routes.js` → `src/ai/chat.controller.js` |
| GET | `/api/reviews/google` | Stored 5-star reviews | `src/routes/googleReviewRoutes.js` |
| GET | `/api/reviews/google/business-profiles` | GBP inspect | same |
| GET | `/auth/google` | Start GBP OAuth | `src/routes/googleBusinessProfileAuthRoutes.js` |
| GET | `/auth/google/callback` | OAuth callback | same |
| GET | `/auth/google/status` | Connection status | same + `requireApiKey` |

**No** HTTP route exists for embedding, reindexing, or querying `chatbot_knowledge` except indirectly via `POST /api/chat` → tool `search_content`.

### 3.2 Controllers (what each actually does)

| File | What it does |
|---|---|
| `src/ai/chat.controller.js` | Full chat turn: load conversation, slot-filling, optional forced listing search, OpenAI tool loop, persist messages/profile, JSON response. |
| `src/controllers/authController.js` | Signup/login with bcrypt+JWT; list users. |
| `src/controllers/frontendController.js` | Listing list/search/featured endpoints via `propertyDbService`. |
| `src/controllers/salesforceController.js` | Trigger migrate from URL or raw XML. |
| `src/controllers/areaGuideController.js` | Area guide CRUD + agentOrders sync. |
| `src/controllers/areaGuideLeadController.js` | Area-guide inquiry CRUD + Zapier. |
| `src/controllers/contactController.js` | Contact CRUD + Zapier. |
| `src/controllers/sellController.js` | Sell-inquiry CRUD + Zapier. |
| `src/controllers/newsletterController.js` | Email subscribe. |
| `src/controllers/careerController.js` | Career CRUD, S3 CV upload, Zapier + Google Sheets. |
| `src/controllers/jewelTowerLeadController.js` | Jewel Tower lead CRUD + sheets/Zapier. |
| `src/controllers/landingPageLeadController.js` | Landing lead CRUD + sheets/Zapier. |
| `src/controllers/propertyManagementLeadController.js` | PM lead CRUD + Zapier. |
| `src/controllers/factsheetController.js` | Store PDF URL/metadata after S3 upload. **Does not parse PDF text.** |
| `src/controllers/teamtailorController.js` | List/sync TeamTailor jobs. |
| `src/controllers/faqController.js` | FAQ CRUD with page enum validation. |
| `src/controllers/serviceController.js` | Service CMS CRUD. |
| `src/controllers/blogController.js` | Blog CMS CRUD + light content-block validation. |
| `src/controllers/teamMemberController.js` | Team member CMS CRUD. |
| `src/controllers/companyInfo.controller.js` | Company-info Q&A CRUD. |
| `src/controllers/googleBusinessProfileController.js` | OAuth start/callback/status HTML+JSON. |
| `src/controllers/googleReviewController.js` | Public reviews + profile inspect. |

### 3.3 Services (business logic)

| File | Used for |
|---|---|
| `src/services/propertyDbService.js` | Mongo listing queries (frontend + chat `search_properties`). |
| `src/services/propertyService.js` | Salesforce XML download/parse. |
| `src/services/salesforceMigrateService.js` | Bulk upsert properties; delete stale listings **and** matching `PropertyEmbedding` rows. |
| `src/services/s3Service.js` | Put/delete S3 objects; signed URL helper (helper not imported elsewhere). |
| `src/services/zapierService.js` | Optional Catch Hook POST. |
| `src/services/googleSheetsService.js` | Optional Apps Script POST. |
| `src/services/teamtailorService.js` | TeamTailor HTTP API + Mongo sync. |
| `src/services/googleBusinessProfileService.js` | OAuth + GBP API. |
| `src/services/googleBusinessProfileReviewService.js` | Review sync/list. |
| `src/services/areaGuideAgentOrdersService.js` | Keep `AreaGuide.agentOrders` aligned with listings. |

Chat “service” logic lives in `src/ai/chat.tools.js`, not under `src/services/`.

### 3.4 Middleware

| File | Exists? | Applied where |
|---|---|---|
| `src/middleware/apiKeyMiddleware.js` | Yes, real string compare | All `/api` + `/auth/google/status` |
| `src/middleware/authMiddleware.js` | Yes, JWT `protect` / `requireUserToken` | User list + admin lead CRUDs. **Not** on CMS write routes (blogs/faqs/services/…). |
| `src/middleware/upload.js` | Yes, multer | Career CV, factsheet PDF. Cloudinary `upload` export is unused by routes. |
| Logging middleware (morgan/winston) | **Not found in codebase** | `console.log` / `console.error` only |
| Global validation library middleware | **Not found in codebase** | Per-route manual checks |
| Rate limit | Yes, **chat only** | `express-rate-limit` in `src/ai/chat.routes.js` |

### 3.5 Utilities / helpers

| File | Role |
|---|---|
| `src/utils/paginationUtils.js` | Query page/limit parse; in-memory paginate. |
| `src/utils/xmlUtils.js` | XML node helpers for Salesforce parse. |
| `src/utils/fileUtils.js` | Unique S3 filenames / keys. |
| `src/utils/tokenCrypto.js` | AES-256-GCM encrypt/decrypt using `GOOGLE_CLIENT_SECRET` as key material. |

### 3.6 Configuration files

| File | Role |
|---|---|
| `.env.example` | Documented env vars (incomplete vs actual `process.env` usage — see § env table). |
| `config/db.js` | Mongo connect. |
| `src/config/s3.js` | Lazy `S3Client` + region probe. |
| `src/config/cloudinary.js` | `cloudinary.config` — **throws at require time** if Cloudinary env vars missing. |
| `src/constants/s3.js` | Folders, MIME types, max sizes. |

---

## 4. Cross-Cutting Concerns

### 4.1 Authentication / authorization

**Present and invoked:**

1. **Shared API key** — `src/middleware/apiKeyMiddleware.js`. Compares `x-api-key` or `Authorization: Bearer …` to `process.env.API_SECRET_KEY`. If env unset → 500. If mismatch → 401. This is a static shared secret, not per-user auth.

2. **User JWT** — `src/controllers/authController.js` signs `{ id: userId }` with `process.env.JWT_SECRET`, expiry `JWT_EXPIRES_IN || '7d'`. `src/middleware/authMiddleware.js` verifies and loads `User`. Used on admin lead routes and `GET /api/auth/users`.

3. **Password hashing** — `src/models/User.js` bcrypt `pre('save')` and `comparePassword`.

**Gaps that are in the code, not guesses:**

- CMS mutating routes (`/api/blogs`, `/api/faqs`, `/api/services`, `/api/area-guides`, `/api/company-info`, `/api/team-members`) have **API key only**, no JWT.
- `POST /api/auth/signup` is API-key-only; anyone with the key can create users.
- `POST /api/salesforce/migrate` and `/migrate-xml` are API-key-only.
- Chat is API-key + origin check + rate limit; **no user JWT**. Session is a client-supplied `sessionId` string (max 128 chars).

### 4.2 Error handling

- Chat: local `try/catch` in `chat()` → 500 JSON with friendly reply, except Mongoose validation-looking messages returned as **200** with `success: false` (`src/ai/chat.controller.js`).
- Tool failures inside `runModelLoop` are caught and turned into `{ modelPayload: { error } }` so the model can continue.
- Global Express handler in `src/index.js` for thrown errors (comment mentions Multer/Cloudinary).
- Most other controllers use per-handler `try/catch` → `{ success: false, message }`. **Not a single shared error class.**
- Schedulers log and swallow errors so the process stays up.

### 4.3 Logging

**No logging library** (no winston/pino/morgan in `package.json` or `require()`). Logging is `console.log` / `console.warn` / `console.error`.

Chat specifically logs OpenAI `finish_reason`, `usage`, content length, and every tool name/args (`src/ai/chat.controller.js`). That can include visitor messages and PII in process stdout.

### 4.4 Input validation

**No Joi/Zod/express-validator in first-party code.** (Zod appears only as a transitive dependency of the `openai` package in `package-lock.json`.)

Chat validation is hand-written in `validateChat` (`src/ai/chat.routes.js`): `sessionId`, `message` length, optional `intent` enum.

Other routes: ad hoc `if (!field)` checks and some Mongoose `required` / `match` / `enum`.

### 4.5 Rate limiting

**Implemented only for chat.** `express-rate-limit` in `src/ai/chat.routes.js`:

- `windowMs`: `CHAT_RATE_LIMIT_WINDOW_MS` or 60_000
- `max`: `CHAT_RATE_LIMIT_MAX` or 20
- Key: `chat-session:${sessionId}` if present, else IP via `rateLimit.ipKeyGenerator`
- Response: `{ success: false, message: 'Too many chat requests…' }`

No rate limit on signup, migrate, CMS writes, or embedding script HTTP (there is no embed HTTP).

`scripts/embedContent.js` retries OpenAI **429** up to 4 attempts with `attempt * 2000` ms delay. Query embeddings in chat have **no** retry.

### 4.6 Caching

**Not found in codebase:** Redis, in-memory LRU for embeddings, HTTP cache headers for chat, or caching of query vectors / vector-search results.

Salesforce migrate keeps an in-process `lastContentHash` of XML (`src/services/salesforceMigrateService.js`) so a **single Node process** can skip unchanged feeds. That is not a cache for RAG.

S3 client is lazily singletoned in `src/config/s3.js`. OpenAI clients are **new’d on every** `getOpenAI()` call (`src/ai/chat.controller.js`, `src/ai/chat.tools.js`).

---

## 5. File Upload & Document Processing

### 5.1 Upload endpoints and storage

| Endpoint | Middleware | Storage | Controller |
|---|---|---|---|
| `POST /api/career` (and PUT) | `uploadCV` — multer **memory**, PDF only, size `getMaxFileSize('cv')` | AWS S3 folder `cvs` via `s3Service.uploadFile` | `src/controllers/careerController.js` |
| `POST /api/factsheets` | `uploadPDF` — multer memory, PDF, `getMaxFileSize('pdf')` | AWS S3 folder `pdfs` | `src/controllers/factsheetController.js` |

`src/middleware/upload.js` also exports `uploadImage` / `uploadVideo` (S3 memory multer) and a Cloudinary `upload` for CVs. **No route imports `uploadImage`, `uploadVideo`, or Cloudinary `upload`.**

Cloudinary is still **loaded** because `upload.js` `require`s `src/config/cloudinary.js`, which calls `requireEnv('CLOUDINARY_CLOUD_NAME'|'_API_KEY'|'_API_SECRET')` at module load. Career/factsheet routes therefore depend on Cloudinary env vars even though they write to S3.

CV public URL is built as `https://${bucket}.s3.${region}.amazonaws.com/${key}` in `careerController.js`. `.env.example` documents `PUBLIC_BASE_URL` for CV URLs; **`PUBLIC_BASE_URL` is not referenced in any `.js` file.**

`s3Service.getSignedUrl` / `getFileStream` are exported and **never imported** by controllers.

### 5.2 Document parsing (RAG-related)

**Not implemented.** `package.json` has no PDF/DOCX parser. `scripts/embedContent.js` header states it **skips factsheets (PDFs, no extractable text)**. Factsheet upload stores `fileUrl` / `fileName` only.

Blog “parsing” for embeddings is `blogBlocksToText` in `scripts/embedContent.js`: concatenates `block.text` and `block.items`. Image `src`/`alt` are not included. Blog embedded `faqs[]` on the Blog model are **not** fed into embeddings.

---

## 6. AI Provider Integration

### 6.1 Provider / model actually called

**Provider:** OpenAI, via official `openai` SDK `^5.23.2`.

**Chat completions** — `src/ai/chat.controller.js` `runModelLoop`:

```1351:1398:src/ai/chat.controller.js
async function runModelLoop({ sessionId, userProfile, history, userMessage, turnIndex }) {
  const openai = getOpenAI();
  const model = process.env.OPENAI_CHAT_MODEL || process.env.OPENAI_MODEL || 'gpt-5-nano';
  const reasoningEffort = process.env.OPENAI_REASONING_EFFORT || 'minimal';
  // ...
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

Default chat model string in code and `.env.example`: `gpt-5-nano`. Whether that model id is valid in the deployed OpenAI account: **Could not confirm — needs manual review**.

**Embeddings:** `openai.embeddings.create` in `src/ai/chat.tools.js` `embedQuery` and `scripts/embedContent.js` `embedBatch`. Model: `process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'`.

No Anthropic, Cohere, Azure OpenAI client, or local model calls were found.

### 6.2 API key and client init

```39:44:src/ai/chat.controller.js
function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  return new OpenAI({ apiKey });
}
```

Identical pattern in `src/ai/chat.tools.js` `getOpenAI` and `scripts/embedContent.js` (`new OpenAI({ apiKey: process.env.OPENAI_API_KEY })`). No organization/baseURL/timeout options.

### 6.3 Prompt construction (exact assembly)

In `runModelLoop` the messages array is:

1. `{ role: 'system', content: getSystemPrompt(userProfile) }`
2. `...history` (prior user/assistant strings)
3. `{ role: 'user', content: userMessage }`

Then, for each tool round, the assistant message (including `tool_calls`) is pushed, then `{ role: 'tool', tool_call_id, content: JSON.stringify(result.modelPayload) }`.

`getSystemPrompt` is `src/ai/chat.prompt.js`. It interpolates a JSON dump of the visitor profile and, if present, a “Properties currently shown…” line from `lastPropertyCards`.

**RAG context is not a separate “CONTEXT:” template in the system prompt.** Retrieved chunks are injected as the **tool result JSON** (`modelPayload` with `chunks`, `count`, `instruction`). See §7.

### 6.4 System prompt(s)

**Single builder:** `getSystemPrompt` in `src/ai/chat.prompt.js`.

Purpose (from the string itself): Rocky Real Estate website chatbot; locked intent; tools `search_content` / `search_properties` / `capture_lead`; priority of site content over general knowledge; hallucination constraints on prices/listings; informational-answer length rules; CTAs.

Additional **tool-result instructions** are strings inside `searchContent` / `searchProperties` payloads in `src/ai/chat.tools.js` (e.g. “Reply in AT MOST 2 short sentences…”).

### 6.5 Conversation context

- Stored last 40 messages; sent last 20 (`HISTORY_TURNS * 2`).
- Profile fields (intent, filters, last cards) go into the **system** prompt every turn, not as extra user messages.
- Tool transcripts from previous HTTP requests are **not** replayed.
- Retrieval query is whatever the model puts in `search_content.query` this turn — not an automatic embedding of the full history.

### 6.6 Token handling / limits

| Constant | File | Value | Role |
|---|---|---|---|
| `HISTORY_TURNS` | `chat.controller.js` | 10 | History window |
| `MAX_STORED_MESSAGES` | same | 40 | DB cap |
| `MAX_TOOL_ROUNDS` | same | 4 | Tool loop cap |
| `TOOL_MAX_TOKENS` | same | 1024 | `max_completion_tokens` before tools return |
| `REPLY_MAX_TOKENS` | same | 600 | after any tool results |
| `CONTENT_REPLY_MAX_TOKENS` | same | 600 | after content-only search |
| `CHAT_MESSAGE_MAX_LENGTH` | `chat.routes.js` | env or 2000 | inbound user message chars |
| Chunk excerpt | `chat.tools.js` | 420 chars | truncated before sending to the model |
| `synthesizeContentReply` | `chat.controller.js` | 220 chars | fallback excerpt |

**No tiktoken / token counter.** **No prompt-budget truncation** beyond message-count slicing and chunk `slice(0, 420)`.

### 6.7 Streaming

**Not implemented.** Grep found no `stream: true`, SSE, `text/event-stream`, or `res.write` in this repo. Chat always `res.status(200).json(payload)`.

---

## 7. Embedding & RAG System

This system is **CMS RAG only**. Listing search is **structured Mongo filters**, not embeddings.

### What content is actually embedded

**Documents (CMS), not chat messages.** Confirmed in `scripts/embedContent.js` `collectSources` + `documentsToChunks`:

| SourceType | Source query | Text actually concatenated |
|---|---|---|
| `blog` | `Blog.find({ isActive: true })` | `title`, `subtitle`, `description`, `blogBlocksToText(content)` |
| `area_guide` | `AreaGuide.find({ isActive: true })` | `title`, `about`, highlight **titles** only |
| `faq` | `Faq.find({ isActive: true })` | `Q: ${question}\nA: ${answer}` |
| `service` | `Service.find({ isActive: true })` | title, description, overviewHeading, overview lines, subservice title/description/points |
| `company_info` | `CompanyInfo.find({ isActive: true })` | topic, category, Q/A |

**Not embedded (confirmed by absence from `collectSources` / comments):**

- Chat messages
- Properties / `property_embeddings` (not written by this script)
- Factsheets (comment: skipped)
- Team members, reviews, TeamTailor jobs
- Blog `faqs[]`, blog `keywords`, area-guide `mapQuery` / `listingsSearch`
- Inactive CMS rows (`isActive: true` filter)

### Where embedding logic starts

- **Index / ingest:** CLI `node scripts/embedContent.js` (`run()` at bottom of that file). **Not** hooked from `src/index.js`, CMS controllers, or cron.
- **Query-time:** `searchContent` → `embedQuery` in `src/ai/chat.tools.js`, invoked only when the model (or a tool dispatcher) calls `search_content`.

### All files that handle embedding

| File | Functions | Runtime? |
|---|---|---|
| `scripts/embedContent.js` | `chunkText`, `documentsToChunks`, `embedBatch`, `upsertChunks`, `run` | Manual CLI |
| `src/ai/chat.tools.js` | `embedQuery`, `searchContent` | Yes, during chat if tool fires |
| `src/models/ChatbotKnowledge.js` | schema | Storage |
| `src/models/PropertyEmbedding.js` | schema | Storage for listing vectors; **chat does not read it** |
| `scripts/movePropertyEmbeddings.js` | copy Property.embedding → collection | One-off CLI |
| `src/services/salesforceMigrateService.js` | `PropertyEmbedding.deleteMany` on stale listings | Yes, on migrate |
| `src/services/propertyDbService.js` | strips `embedding`/`embeddingHash` from listing API docs | Defensive leftover |

### Embedding provider actually called

OpenAI `embeddings.create`. Not Cohere, not a local model.

### Embedding model specified in the API call

`text-embedding-3-small` unless `OPENAI_EMBEDDING_MODEL` is set. The create call does **not** pass `dimensions` or `encoding_format`.

### Packages used for embedding — actual invocation

| Package | Invoked for embeddings? |
|---|---|
| `openai` | **Yes** — `embeddings.create` in `scripts/embedContent.js` and `src/ai/chat.tools.js` |
| LangChain / llama-index / pinecone / weaviate / chroma | **Not found in codebase** |

### Where the embedding API call happens

Ingest:

```224:230:scripts/embedContent.js
async function embedBatch(openai, texts, attempt = 1) {
  try {
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: texts,
    });
```

Query:

```2752:2756:src/ai/chat.tools.js
async function embedQuery(query) {
  const openai = getOpenAI();
  const model = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
  const response = await openai.embeddings.create({ model, input: query });
  return response.data[0].embedding;
}
```

### Text preprocessing / cleaning before embedding

- `String(text).trim()`
- Paragraph split on `\n{2,}`
- Collapse whitespace inside a paragraph: `replace(/\s+/g, ' ')`
- Blog blocks: text + list items only
- Hash: SHA-256 of **chunk content** (`hashContent`)

No lowercasing, stopword removal, HTML strip library, or language detection.

### Document parsing pipeline feeding into embedding

CMS Mongo documents → field concatenation → `chunkText` → hash → skip unchanged hashes → `embedBatch` → `ChatbotKnowledge.bulkWrite` upsert.

No file ingest pipeline.

### Chunking strategy

`chunkText` in `scripts/embedContent.js`:

- **Method:** paragraph-accumulate (split on blank lines), not recursive character split, not semantic splitter, not token-based.
- `MAX_CHUNK_CHARS = 2000`
- `TARGET_CHUNK_CHARS = 1600` — if current chunk is already ≥ 1600 and the next paragraph would exceed 2000, flush and start a new chunk.
- Oversize single paragraph: hard-sliced every 2000 chars with **no overlap**.
- **Overlap: none** (not implemented).

`chunkIndex` is computed on the in-memory doc object and **not written** to Mongo (`$set` only title, url, content, embedding).

### Metadata attached to each stored chunk

Schema `src/models/ChatbotKnowledge.js`:

- `sourceType`, `sourceId`, `title`, `url`, `content`, `embedding` (`[Number]`), `embeddingHash`
- Mongoose `timestamps`
- Unique index `{ sourceType, sourceId, embeddingHash }`

Not stored: score, chunkIndex, token count, locale, published date.

### How / where embeddings are stored

- Collection `chatbot_knowledge`, field `embedding`, Mongoose type `[Number]` (JSON array of floats as returned by OpenAI).
- Listing vectors (if any) in `property_embeddings.embedding` + `embeddingHash` + `propertyRefNo`.

### MongoDB Atlas Vector Search vs other vector DB

Chat retrieval uses Mongo aggregation `$vectorSearch` on `ChatbotKnowledge` (`src/ai/chat.tools.js`). That is **MongoDB Atlas Vector Search**, not Pinecone/Weaviate/Qdrant.

Index **name** in code: `process.env.CHATBOT_VECTOR_INDEX || 'chatbot_knowledge_vector_index'`.

**No** Atlas index JSON, Terraform, or `createSearchIndex` script is in this repository. Similarity metric, number of dimensions, and whether the index actually exists in the deployed cluster: **Could not confirm — needs manual review**.

### Vector dimensions

**Not specified in API calls or schemas.** `movePropertyEmbeddings.js` comment says “~1500-dim vectors”; that is a comment only, not a runtime check. OpenAI `text-embedding-3-small` default size is **not asserted in code**.

### Vector index configuration

| Item | In repo? |
|---|---|
| Index name | Yes — env/default string above |
| Index definition file | **Not found in codebase** |
| Similarity metric (cosine/dot/euclidean) | **Not found in codebase** |
| Filterable fields on the index | **Not found in codebase** |

### Vector search query implementation

```2771:2803:src/ai/chat.tools.js
  const queryVector = await embedQuery(q);
  const rows = await ChatbotKnowledge.aggregate([
    {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        path: 'embedding',
        queryVector,
        numCandidates: 80,
        limit: CONTENT_LIMIT,
      },
    },
    { $addFields: { score: { $meta: 'vectorSearchScore' } } },
    {
      $match: {
        sourceType: { $ne: 'property' },
        score: { $gte: VECTOR_MIN_SCORE },
      },
    },
    {
      $project: {
        _id: 0,
        sourceType: 1,
        title: 1,
        url: 1,
        content: 1,
        score: 1,
      },
    },
  ]);
```

`CONTENT_LIMIT = 8`. `numCandidates = 80` (hardcoded).

### Semantic search / retrieval logic

Yes: embed the tool `query` string, `$vectorSearch`, then score threshold. No BM25/`$text` on `chatbot_knowledge`.

### Top-K

Hardcoded `CONTENT_LIMIT = 8` in `src/ai/chat.tools.js`. Not an env var. Applied as `$vectorSearch.limit`. Rows may be fewer after `$match` on score.

### Similarity score handling / threshold

`VECTOR_MIN_SCORE = Number(process.env.CHAT_VECTOR_MIN_SCORE) || 0.75`. Applied in `$match` after `$vectorSearch`. Score is Atlas `vectorSearchScore`. **What that score means (cosine vs other) depends on the Atlas index — not in this repo.**

### Metadata filtering in retrieval

Only `sourceType: { $ne: 'property' }`. Current embed script never writes `sourceType: 'property'`, so this filter is a leftover. No filter by locale, date, or `isActive` at query time (inactive docs are simply not re-upserted until the next CLI run, and stale hashes are deleted then).

### Reranking

**Not implemented** as a second model (no Cohere rerank, no cross-encoder).

`rankRelatedContentSources` (`src/ai/chat.tools.js`) **reorders source buttons** (blog → area guide → company_info → FAQ → service → listing), max 2 unique non-homepage URLs. It does **not** reorder chunks fed to the LLM. Chunks stay in aggregation order.

### Hybrid search (vector + keyword)

**Not implemented** for CMS RAG.

Listing search is separate keyword/regex/filter Mongo (`propertyDbService`), not combined with vectors.

### Keyword / full-text search separately

- Listings: regex/contains on title/city/locality/etc. in `src/services/propertyDbService.js` (`SEARCH_FIELDS`). **Not** Mongo `$text`.
- CMS chatbot_knowledge: **no** `$text` / Atlas lexical search in code.

### How retrieved chunks are selected / deduplicated before use

- Vector stage already `limit: 8`.
- Score threshold may drop rows.
- Chunks themselves are **not** deduped by `sourceId` (multiple chunks from one blog can all go to the model).
- Sources for UI buttons are URL-deduped in `rankRelatedContentSources` and again `uniqueBy(..., url || title)` in the controller.

### How retrieved context is injected into the LLM prompt

Tool message content is `JSON.stringify(result.modelPayload)`:

```2821:2831:src/ai/chat.tools.js
  return {
    propertyCards: [],
    sources: ranked,
    leadCaptured: false,
    profilePatch: {},
    modelPayload: {
      count: rows.length,
      chunks: shortChunks,
      instruction:
        "CRITICAL: Reply in AT MOST 2 short sentences ...",
    },
  };
```

Each `shortChunk`: `{ sourceType, title, url, content }` with content whitespace-collapsed and **sliced to 420 characters**.

System prompt also says: when `search_content` returns matching chunks, answer from them in 2–3 short sentences; if none, fall back to general-knowledge rules (`src/ai/chat.prompt.js`).

### Source / citation handling

- UI: `sources` array of `{ title, url }` (max 2 after ranking). Company info often has `url: ''` in embed script, so those rows are dropped by `rankRelatedContentSources` (`filter s.url`).
- Model is told **not** to include raw URLs; “related pages are buttons”.
- `synthesizeContentReply` may mention the first chunk’s title in fallback copy.
- No footnote markers, no forced citation IDs in the reply schema.

### Conversation-aware retrieval

**Not implemented as a retrieval feature.** `searchContent({ query })` embeds only the tool argument. History can influence the **query string the model chooses**, but the server does not concatenate prior turns into the embedding input.

### Query rewriting / reformulation

**No dedicated rewrite step.** No HyDE. The model may paraphrase when it fills `query`. Repeat `search_content` after a hit is short-circuited with the previous chunks (`chat.controller.js`).

### Embedding regeneration / update on document edit

**Not automatic.** Blog/FAQ/service/company-info/area-guide controllers do not call `embedContent.js`. Stale vectors remain until someone runs the CLI. The CLI upserts new hashes and `deleteMany`s hashes no longer present for that `sourceType+sourceId`, and deletes chunks whose `sourceId` is gone for that type.

### Duplicate embedding prevention

Skip embed if `sourceType:sourceId:embeddingHash` already exists (`upsertChunks`). Unique Mongo index on those three fields. Same text → same SHA-256 → skip.

Different whitespace that survives `chunkText` normalization would still hash-collide; raw CMS edits that don’t change chunk text skip re-embed.

### Re-indexing logic

Full rebuild is “run the script again”. No separate reindex command, no Atlas index recreation in repo.

### Delete / update embedding logic

- Update: `bulkWrite` `updateOne` upsert on hash key (`scripts/embedContent.js`).
- Delete stale hashes per source document; delete sourceIds no longer in the CMS dump.
- Listing embeddings: deleted when Salesforce migrate removes a `propertyRefNo` (`salesforceMigrateService.js`). **No generator** fills that collection afterward.

### Batch embedding

Yes, ingest only: `BATCH_SIZE = 64`, `input: texts` array. Query path embeds **one** string per `search_content` call.

### Embedding error handling and retry

- Ingest: retry on HTTP 429, max 4 attempts, linear backoff `attempt * 2000` ms; other errors throw (`embedBatch`).
- Query: **no retry**. Failure is caught by `runModelLoop` tool `try/catch` and returned as `modelPayload.error`.

### Cost / performance considerations evident in code

- Hash skip avoids re-embedding unchanged chunks.
- Batch 64 on ingest.
- Query: new OpenAI client per call; no query-embedding cache.
- Chunks truncated to 420 chars before the chat model (reduces completion tokens, not embedding cost).
- `numCandidates: 80` vs `limit: 8`.
- Chat rate limit is on HTTP turns, not on embedding QPS.

### RAG failure handling

If `$vectorSearch` / `embedQuery` throws: tool result `{ error: err.message }`; loop continues. After empty model content with `usedSearchContent`, `synthesizeContentReply` or `FRIENDLY_CHAT_ERROR`. After 4 tool rounds, same fallback.

### Empty retrieval handling

Empty `rows` → `count: 0`, `chunks: []`, still includes the instruction string. System prompt: fall back to **general knowledge** for generic real-estate concepts, or refuse if unrelated to real estate. Server does **not** error out. `synthesizeContentReply([])` returns `''`.

### Hallucination-prevention mechanisms (in prompts / tools only)

From `src/ai/chat.prompt.js` and tool descriptions:

- Prefer tool results over general knowledge.
- Do not state prices/availability/company facts unless they appeared in a tool result this conversation or in shown property cards.
- Do not claim listings exist unless `search_properties` returned results.
- Server ignores guessed bedrooms/budgets (`chat.tools.js` comments + filter merge logic).
- Content answers: preserve source facts; don’t invent thresholds/fees.
- Unrelated topics: refuse and redirect.

**No** separate grounding classifier or citation-required post-check in code.

### Listing search is not RAG

`search_properties` → `propertyDbService.fetchBuyProperties` / `fetchRentProperties` / `fetchOffPlanProperties` with purpose/type/location/beds/price filters (`src/ai/chat.tools.js` `fetchPropertyCards`). Limit `PROPERTY_LIMIT = 6`.

---

## 8. RAG Data Flow (Real, Not Theoretical)

Generic template:

`User question → API request → query processing → query embedding → vector search → retrieved chunks → context construction → LLM request → AI response → database storage → frontend response`

**What this codebase actually does:**

```
Client POST /api/chat  { sessionId, message, optional intent }
  → requireApiKey
  → restrictChatOrigin + chat CORS
  → validateChat + rate limit
  → chat() loads Conversation by sessionId (create if missing)
  → optional request-body property types merged into lastSearchFilters
  → resolvePendingSlots (sell / PM / bedrooms / purpose / empty-results chips)
       ↳ if clarify: persist messages, return JSON chips — NO LLM, NO embeddings
  → maybe bedroomClarifyIfNeeded — same, no LLM
  → if listing intent ready: runForcedPropertySearch
       ↳ search_properties → Mongo listing query (NOT vectors)
       ↳ persist + JSON — often NO LLM
  → else runModelLoop:
       1. LLM chat.completions.create (system prompt + last 20 msgs + new user msg + tools)
       2. If the model calls search_content:
            embedQuery(tool query) → $vectorSearch → threshold → shortChunks
            tool result JSON appended
       3. If search_properties: Mongo filters, not embeddings
       4. If capture_lead: Lead.create
       5. Repeat up to 4 rounds; after a content hit, force tool_choice none
       6. Final assistant text (or synthesizeContentReply / friendly error)
  → append user+assistant (cap 40), save userProfile
  → JSON { reply, propertyCards, sources, suggestedCta, viewAllMatching, optional options }
```

**Corrections to the generic RAG pipeline:**

| Template step | In this repo |
|---|---|
| Query processing | Trim + slot parsers + intent lock. **No** embed-time rewrite. |
| Query embedding | **Only if** the model calls `search_content` (or would, after forced listing path is skipped). |
| Vector search | CMS only. Listings skip this entirely. |
| Context construction | Tool JSON with 420-char excerpts, not a stuffed system prompt. |
| LLM request | Often **first**, then retrieval as a tool — retrieval-after-planning, not retrieve-then-generate. Forced listing path **skips the LLM**. |
| Streaming | Missing. |
| Embed ingest | Offline CLI, not on the request path. |
| Message embedding | Missing. |

---

## 9. Package Audit

| Package | Why it appears installed | Where used | Status | Upgrade / replace notes |
|---|---|---|---|---|
| `express` `^5.2.1` | HTTP server | `src/index.js`, all routers | Active | Express 5 is current in this repo; watch middleware/`req.body` XML vs JSON. |
| `mongoose` `^9.2.2` | ODM | models, `config/db.js`, scripts | Active | Keep aligned with Atlas. |
| `dotenv` `^17.3.1` | Load `.env` | `src/index.js`, several services/scripts | Active | Duplicate `config()` calls are harmless but noisy. |
| `cors` `^2.8.6` | CORS | `src/index.js` (open) + `chat.routes.js` (allowlist) | Active | Global `origin: true` is wider than chat allowlist. |
| `openai` `^5.23.2` | Chat + embeddings | `chat.controller.js`, `chat.tools.js`, `embedContent.js` | **Active (RAG + LLM)** | Pin model names; SDK v5 `max_completion_tokens` / `reasoning_effort` are actually passed. |
| `express-rate-limit` `^8.7.0` | Chat QPS | `src/ai/chat.routes.js` | Active (chat only) | |
| `jsonwebtoken` `^9.0.3` | User JWT | `authController.js`, `authMiddleware.js` | Active | `JWT_SECRET` missing from `.env.example`. |
| `bcrypt` `^6.0.0` | Password hash | `src/models/User.js` | Active | |
| `multer` `^2.1.1` | Multipart upload | `src/middleware/upload.js` | Active | |
| `@aws-sdk/client-s3` | S3 put/delete/get | `src/config/s3.js`, `src/services/s3Service.js` | Active | |
| `@aws-sdk/s3-request-presigner` | Presign GET | `s3Service.getSignedUrl` | **Imported; no other file calls `getSignedUrl`** | Dead at HTTP layer. |
| `cloudinary` `^1.41.3` | Cloudinary SDK | `src/config/cloudinary.js` ← `upload.js` | Loaded; **no route uses Cloudinary storage** | Boot-time hard dependency. Candidate to remove if S3-only. |
| `multer-storage-cloudinary` `^4.0.0` | Cloudinary multer | `upload.js` `CloudinaryStorage` | Wired to unused `upload` export | Dead unless something requires `{ upload }`. |
| `fast-xml-parser` `^5.4.1` | Salesforce XML | `propertyService.js`, `salesforceController.js` | Active | |
| `googleapis` `^178.0.0` | GBP OAuth/API | `googleBusinessProfileService.js` | Active | |
| `node-cron` `^4.2.1` | Schedulers | three `src/jobs/*` | Active | **No embed cron.** |
| `axios` `^1.16.1` | HTTP client | **No `require('axios')` in any `.js` file** | **Unused** | Remove or use; code uses global `fetch`. |
| `nodemon` (dev) | Reload | `npm run dev` | Active (dev) | |
| `jest` | `"test": "jest"` in package.json | **Not in dependencies.** Tests are `node:test` in `src/ai/chat.test.js` | Script/package mismatch | Change script to `node --test src/ai/chat.test.js` or add Jest. |

### Embedding / RAG-related packages (explicit)

| Package | Real usage |
|---|---|
| `openai` | **Yes** — `embeddings.create` + `chat.completions.create` |
| Any other vector/RAG SDK | **Not found** |

Mongoose `$vectorSearch` is a MongoDB server feature, not an npm package.

---

## Environment variables actually referenced

| Variable | File(s) | What it controls |
|---|---|---|
| `MONGO_URI` | `config/db.js`, embed/move/migrate scripts | Mongo connection. **Missing from `.env.example`.** |
| `PORT` | `src/index.js` | Listen port (default 5001) |
| `API_SECRET_KEY` | `apiKeyMiddleware.js` | Shared `/api` secret |
| `JWT_SECRET` | `authController.js`, `authMiddleware.js` | User JWT. **Missing from `.env.example`.** |
| `JWT_EXPIRES_IN` | `authController.js` | JWT ttl (default `7d`) |
| `OPENAI_API_KEY` | chat + embed script | OpenAI auth |
| `OPENAI_CHAT_MODEL` / `OPENAI_MODEL` | `chat.controller.js` | Chat model (default `gpt-5-nano`) |
| `OPENAI_REASONING_EFFORT` | `chat.controller.js` | `reasoning_effort` (default `minimal`) |
| `OPENAI_EMBEDDING_MODEL` | `chat.tools.js`, `embedContent.js` | Embedding model (default `text-embedding-3-small`) |
| `FRONTEND_URL` | `chat.tools.js`, `embedContent.js` | Absolute CMS/listing URLs |
| `CHAT_ALLOWED_ORIGINS` | `chat.routes.js` | Chat CORS allowlist |
| `CHAT_RATE_LIMIT_WINDOW_MS` / `CHAT_RATE_LIMIT_MAX` | `chat.routes.js` | Chat limiter |
| `CHAT_MESSAGE_MAX_LENGTH` | `chat.routes.js` | Max user message chars |
| `CHATBOT_VECTOR_INDEX` | `chat.tools.js` | Atlas index name |
| `CHAT_VECTOR_MIN_SCORE` | `chat.tools.js` | Min vector score (default 0.75) |
| `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_S3_BUCKET` | `config/s3.js`, career URLs | S3 |
| `AWS_S3_MAX_IMAGE_SIZE` / `_VIDEO_` / `_PDF_` / `_CV_` | `constants/s3.js` | Upload caps |
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` | `config/cloudinary.js` | Required at `upload.js` load. **Missing from `.env.example`.** |
| `BASE_URL_SALESFORCE` | `propertyService.js` | XML feed URL. **Missing from `.env.example`.** |
| `SALESFORCE_MIGRATE_*` | `salesforceMigrateScheduler.js` | Cron enable/schedule/skip/tz. **Missing from `.env.example`.** |
| `TEAMTAILOR_API_TOKEN` / `_VERSION` / `_BASE_URL` / `TEAMTAILOR_SYNC_*` | teamtailor service + job | Jobs API + cron |
| `ZAPIER_WEBHOOK_URL` | `zapierService.js` | Shared Catch Hook |
| `JEWEL_TOWER_ZAPIER_WEBHOOK_URL` | `zapierService.js` | Jewel Tower hook |
| `GOOGLE_SHEETS_WEBHOOK_URL` | `googleSheetsService.js` | Careers sheet |
| `GOOGLE_SHEETS_JEWEL_TOWER_LEAD_URL` | same | Jewel sheet |
| `GOOGLE_SHEETS_LANDING_PAGE_LEAD_URL` | same | Landing sheet |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_CALLBACK_URL` | GBP service + `tokenCrypto.js` | OAuth + token encryption key |
| `GOOGLE_BUSINESS_ACCOUNT_NAME` / `_LOCATION_NAME` | GBP service | Optional pin |
| `GOOGLE_REVIEWS_SYNC_*` | reviews scheduler | Cron |
| `NODE_ENV` | GBP cookie `secure` flag | `production` → secure cookie |
| `PUBLIC_BASE_URL` | `.env.example` only | **Not read by any JS file** |

---

## 10. Assessment

### Implemented correctly

| Area | Evidence |
|---|---|
| End-to-end chat HTTP path | `chat.routes.js` → `chat()` → persist |
| Tool-calling RAG for CMS | `search_content` → embed → `$vectorSearch` → tool JSON |
| Offline CMS embed with hash skip + stale delete | `scripts/embedContent.js` |
| Listing search as structured DB query (not fake semantic) | `propertyDbService` + `search_properties` |
| Conversation + profile persistence | `chat.models.js` / `chat.controller.js` |
| Chat origin allowlist + per-session rate limit + message length cap | `chat.routes.js` |
| Prompt rules against inventing listings/prices | `chat.prompt.js` |
| Lead capture to `leads` | `captureLead` |
| API key gate on `/api` | `src/index.js` |
| Chat tests for routing/buttons (not live OpenAI) | `src/ai/chat.test.js` via `node:test` |

### Partially implemented

| Area | What’s missing |
|---|---|
| Atlas vector search | Query code exists; **index definition not in repo**; deploy must be manual |
| Property embeddings | Schema + move script + delete-on-stale; **no generator; chat never queries them** |
| CMS freshness | Embed script works; **no hook from CMS writes / no cron** |
| Cloudinary | Configured and required at load; **unused by routes** |
| S3 signed URLs | Implemented; **unused** |
| Chat CORS | Tight on `/api/chat`; global CORS is `origin: true` |
| Auth | JWT exists; **CMS writes and signup unprotected by JWT** |
| Error handling | Inconsistent per controller; chat swallows some validation as 200 |

### Missing entirely

| Feature | Status |
|---|---|
| Streaming tokens | Not implemented |
| Message embeddings | Not implemented |
| Query rewrite / HyDE | Not implemented |
| Hybrid lexical+vector CMS search | Not implemented |
| Reranker model | Not implemented |
| PDF/document RAG | Not implemented (factsheets skipped) |
| Auto re-embed on CMS change | Not implemented |
| Embedding HTTP admin API | Not implemented |
| Redis / result cache | Not implemented |
| Token counting | Not implemented |
| Dedicated logging/APM | Not implemented |
| Vector index IaC | Not found in codebase |

### Unnecessary / dead

| Item | Why |
|---|---|
| `axios` | Never required |
| Cloudinary multer `upload` + possibly Cloudinary deps | No route uses them |
| `uploadImage` / `uploadVideo` exports | Unused |
| `s3Service.getSignedUrl` / `getFileStream` | Unused by controllers |
| `ChatbotKnowledge` re-export from `chat.models.js` | Tools import the model file directly |
| `sourceType != 'property'` filter | Embed pipeline never writes that type |
| `PUBLIC_BASE_URL` in `.env.example` | Unread |
| `package.json` `"test": "jest"` | Jest not installed; tests use `node:test` |
| `docs/API_INVENTORY.md` | Incomplete vs live mounts |
| `Property.embedding` strip in `propertyDbService` | Schema no longer has those fields |

### What could break in production

| Risk | Why |
|---|---|
| `$vectorSearch` fails | Index missing/wrong name/wrong path/dims; chat content answers degrade to errors/general knowledge |
| Stale CMS answers | Embed job not in `src/index.js` jobs |
| Cloudinary env missing | Requiring career/factsheet routes can throw before S3 runs |
| `MONGO_URI` / `JWT_SECRET` undocumented | Easy misconfig |
| OpenAI model id `gpt-5-nano` | If account doesn’t have it, every chat 500s |
| SessionId rate-limit key | Clients can mint unlimited sessionIds to bypass (falls back to IP only when sessionId absent; validation requires sessionId, so key is always session-scoped) |
| `conversations` growth | 40 messages/session but unbounded number of sessions; no TTL index |
| Shared API key leak | Full CMS + migrate + chat |
| `areaguides` collection shared by two models | Queries can mix guides and leads |

### Security problems

- Static `API_SECRET_KEY` on all `/api` routes; chat origin check allows **missing** `Origin` (`if (!origin) return next()`).
- CMS mutating APIs without JWT.
- Open signup behind the same API key.
- Salesforce migrate behind API key only.
- Chat `sessionId` is attacker-chosen; can append to another user’s thread if guessed/leaked (128-char string, uniqueness only).
- Chat logs tool arguments (may include PII) to stdout.
- `GOOGLE_CLIENT_SECRET` reused as AES key for stored OAuth tokens (`tokenCrypto.js`) — coupling OAuth secret to encryption.
- No helmet, no CSRF discussion in code (cookie used for OAuth state).
- Global CORS `origin: true` with `credentials: true`.

### Performance problems

- New `OpenAI()` per call.
- Query embedding every `search_content` with no cache.
- Up to 4 sequential LLM round-trips per user message (`MAX_TOOL_ROUNDS`).
- Forced listing path is actually faster (skips LLM) — content questions always pay LLM + possibly embed + vector.
- `$vectorSearch` then `$match` on score may over-fetch then drop below 8.
- No connection pool tuning.

### Scalability problems

- Embed script loads **all** active CMS docs then **all** existing knowledge hashes into memory.
- Rate limit is in-memory per Node process (`express-rate-limit` default); multiple instances don’t share counters (**Could not confirm** custom store — none is passed, so default memory store).
- Conversations have no expiry.
- Salesforce skip-hash is per-process memory only.

### MongoDB optimization opportunities

- Confirm Atlas vector index on `chatbot_knowledge.embedding` (not in repo).
- TTL or `updatedAt` index on `conversations`.
- Resolve `areaguides` dual-model collection.
- Listing search already uses indexes on purpose/type/locality; numeric filters still `$facet` scan — existing comment in `propertyDbService.js`.
- Don’t `$project` large unused fields on vector path (already projects a small set).

### Embedding optimization opportunities

- Cron or CMS-write hook instead of manual CLI.
- Persist `chunkIndex`; store source `updatedAt`.
- Don’t embed image-only blocks (already skipped); do embed blog `faqs[]`.
- Query-embedding cache keyed by normalized question.
- Retry + timeout on `embedQuery`.
- Pass explicit `dimensions` and keep Atlas index in lockstep.

### RAG quality improvements

- Retrieve **before** the first LLM call for known content intents (`isGeneralKnowledgeQuery` already exists in tools and is used to **skip property search**, not to auto-call `search_content`).
- Deduplicate chunks by `sourceId` before prompting.
- Inject title + url + score in a tighter template; drop empty-url company_info from retrieval or give them a URL.
- Tune `CHAT_VECTOR_MIN_SCORE` with real evals (currently default 0.75 with no eval harness in repo).

### Chunking improvements

- Add overlap on the 2000-char hard slice.
- Token-based sizes matching `text-embedding-3-small` context.
- Keep FAQ Q/A atomic (already mostly one chunk unless very long).
- Include area-guide body fields beyond highlight titles.

### Retrieval improvements

- Pre-filter in `$vectorSearch` (Atlas `filter`) instead of post `$match` where possible.
- Hybrid lexical + vector for names (“Golden Visa”, brand phrases).
- Conversation-aware query: embed latest user message server-side rather than trusting the model’s `query`.
- Use `property_embeddings` or drop the collection to avoid a false sense of listing RAG.

### Prompt improvements

- System prompt is very long (listing slot machine + RAG). Splitting content vs listing modes would reduce instruction conflict.
- Empty retrieval currently allows “general information” — easy hallucination path for Dubai legal/fee questions.

### Vector-search improvements

- Check index into repo (JSON) with metric, dims, path.
- Log scores in non-prod only (today rows include score but it is **not** passed to the model in `shortChunks`).
- Evaluate `numCandidates` vs latency.

### Error-handling improvements

- Distinguish OpenAI 429 vs Atlas index errors vs validation.
- Don’t return HTTP 200 for Mongoose validation failures in chat.
- Structured logger; stop logging full tool argument strings in production.

### Recommended architecture improvements

- Treat `scripts/embedContent.js` as a job: cron or queue after CMS save.
- Single OpenAI client module.
- Split `chat.tools.js` (~3000 lines) into listing / RAG / lead modules (file is already the bottleneck).
- Remove unused axios/Cloudinary path or actually use them.
- Put vector index + `MONGO_URI` in `.env.example` and runbooks.
- JWT (or role check) on CMS write + migrate.

### Recommended refactoring

- Stop exporting unused multer Cloudinary pipeline; lazy-load Cloudinary only if that path is used.
- Align `npm test` with `node --test src/ai/chat.test.js`.
- Move `Conversation`/`Lead` models fully under `src/models/`.
- Delete or implement property-embedding generation; remove `sourceType != property` if unused.

### Recommended next development steps

1. **Verify in Atlas** that `chatbot_knowledge_vector_index` exists on `embedding`, metric and dimensions match `text-embedding-3-small` output. **Could not confirm from this repo.**
2. Run `node scripts/embedContent.js` after CMS changes; then add a scheduler.
3. Add an integration test that mocks OpenAI embeddings + a fixture aggregate (today tests don’t hit RAG).
4. Auto-call `search_content` for `isGeneralKnowledgeQuery` / `isContentKnowledgeTopic` the same way listings are forced.
5. Remove dead dependencies (`axios`) and dead upload/Cloudinary boot coupling.
6. Protect CMS and migrate routes with `protect` (or role `superadmin`).
7. Decide the fate of `property_embeddings` (generate + search, or delete).
8. Add conversation TTL and shared rate-limit store if running multiple Node instances.

---

*End of analysis. Statements without a file path above are labeled unverified on purpose.*
