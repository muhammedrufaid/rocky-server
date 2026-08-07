# Knowledge Priority

Ranks information sources for Rocky AI when multiple sources could answer a question.

Higher priority wins when sources conflict or overlap.

---

## Priority ranking

### Priority 1 — Live Property APIs (Tools)

**Why first:** Prices, availability, payment plans, and unit status change constantly. Serving stale markdown as “current inventory” creates false confidence and damages trust.

Use for:

- Property search results
- Specific listing details
- Live availability
- Current asking prices

---

### Priority 2 — Company Information

**Why second:** Brand identity, contact methods, and who Rocky is must stay accurate and consistent. Wrong company facts are high-risk.

Use for:

- What Rocky Real Estate is
- Contact / office information (when verified)
- Company positioning and process at a high level

Folder: `company/`

---

### Priority 3 — Services

**Why third:** Clients ask what Rocky can do for them. Service descriptions drive journey routing (buy, rent, manage, mortgage assistance, etc.) and must match real offerings only.

Use for:

- Buying, selling, renting
- Property management, brokerage, inspection, after-sales
- Mortgage assistance (non-advisory framing)

Folder: `services/**`

---

### Priority 4 — Area Guides

**Why fourth:** Area context helps discovery conversations, but is secondary to live inventory and company/service truth. Guides orient users; they do not replace search.

Use for:

- Community lifestyle summaries
- High-level area orientation

Folder: `area-guides/` (and closely related `communities/`)

---

### Priority 5 — Blogs

**Why fifth:** Educational depth is valuable for process and concepts, but articles can be longer, older, or broader than a direct service answer. Prefer services/company/FAQs for short factual replies when available.

Use for:

- Buying / renting process explainers
- Freehold / leasehold overviews
- Investor visa education (non-legal)
- Market education (non-promissory)

Folder: `blogs/`

---

### Priority 6 — FAQs

**Why sixth:** FAQs are useful shortcuts for common questions, but they are often brief and may lag behind fuller service or company docs. Use when a short approved answer exists; escalate to richer sources when more detail is needed.

Use for:

- Common short Q&A
- Quick clarifications

Folder: `faqs/`

---

## Conflict resolution

```
Live tool / API data
        ↓ overrides
Company knowledge
        ↓ overrides
Services knowledge
        ↓ overrides
Area guides / communities
        ↓ overrides
Blogs
        ↓ overrides
FAQs
```

If still unsure → say information is unavailable → offer a human specialist.

---

## What priority does *not* mean

- Priority is **not** “always retrieve blogs last in RAG scoring” as a hard vector rule — it is a **business source-of-truth** order.
- Live tools are skipped when the question is purely educational/static.
- Never invent to fill a gap between priority levels.
