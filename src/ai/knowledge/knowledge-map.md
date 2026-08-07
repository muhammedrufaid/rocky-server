# Knowledge Map

Defines **what belongs where**, how Rocky AI should choose a source, and which content is static vs dynamic.

This map guides future RAG retrieval and tool routing. It is documentation only — no search implementation in this phase.

---

## Domain ownership

| Domain | Folder | Typical content |
|--------|--------|-----------------|
| Company | `company/` | About Rocky, contacts, high-level process |
| Services (index) | `services/` | Overview of service catalogue |
| Buying | `services/buying/` | Buy journey & service explainers |
| Selling | `services/selling/` | Sell journey & marketing support |
| Renting | `services/renting/` | Rent / lease journey |
| Mortgage | `services/mortgage/` | Mortgage assistance (non-advisory) |
| Property management | `services/property-management/` | Management packages & scope |
| Inspection | `services/inspection/` | Inspection service explainers |
| Brokerage | `services/brokerage/` | Brokerage role & process |
| After-sales | `services/after-sales/` | Post-transaction support |
| FAQs | `faqs/` | Short Q&A |
| Blogs | `blogs/` | Longer educational articles |
| Area guides | `area-guides/` | Dubai area summaries |
| Developers | `developers/` | Verified developer profiles |
| Communities | `communities/` | Community overviews |
| Off-plan | `off-plan/` | Off-plan education & process |
| Investment | `investment/` | Investment education (no guarantees) |

---

## Static vs dynamic

### Static → Knowledge Layer

Content that changes slowly and can live as curated documents (markdown / CMS / DB sync into this tree):

```
Company Information          →  knowledge/company/
Services                     →  knowledge/services/**
Area Guide                   →  knowledge/area-guides/
Communities                  →  knowledge/communities/
Blog                         →  knowledge/blogs/
FAQs                         →  knowledge/faqs/
Developers (curated facts)   →  knowledge/developers/
Off-plan education           →  knowledge/off-plan/
Investment education         →  knowledge/investment/
```

### Dynamic → Tools / Live APIs

Content that changes frequently and must not be hard-coded as “truth” in markdown:

```
Property Prices              →  Property Tool / Live Inventory API
Property Availability        →  Property Tool
Payment Plans (project)      →  Property / Project Tool
Completion Dates (live)      →  Property / Project Tool
Agent Assignments            →  CRM / Lead / Agent Tool
Viewing Slots                →  Booking Tool
Lead Status                  →  CRM Tool
```

---

## How AI should search (future behaviour)

When answering, choose the source type first:

1. **Is this live inventory / price / availability?**  
   → Use **property tools** (not knowledge files).

2. **Is this about Rocky as a company or its services?**  
   → Search **knowledge** (`company/`, `services/**`).

3. **Is this about an area or community?**  
   → Search **knowledge** (`area-guides/`, `communities/`).

4. **Is this educational (process, freehold, visa overview)?**  
   → Search **knowledge** (`blogs/`, `faqs/`, relevant service folder).

5. **Is this about a developer or off-plan concept?**  
   → Search **knowledge** (`developers/`, `off-plan/`) for static facts;  
   → Use **tools** for live project units / prices.

6. **Nothing found?**  
   → Say information is unavailable; offer to connect a specialist.  
   → Never invent.

---

## Decision examples

| User need | Source |
|-----------|--------|
| “What is Rocky Real Estate?” | Static → `company/` |
| “What property management services do you offer?” | Static → `services/property-management/` |
| “Tell me about Dubai Hills” | Static → `area-guides/` / `communities/` |
| “Show me 3-bed villas under 5M in Dubai Hills” | Dynamic → Property Tool |
| “What’s the price of REF-123?” | Dynamic → Property Tool |
| “How does buying work?” | Static → `services/buying/` or `blogs/` |
| “Book a viewing tomorrow” | Dynamic → Booking / Lead tools |
| “What’s the ROI on Marina?” | Do not invent → knowledge if curated; else decline + specialist |

---

## Content rules

- One canonical home per topic (avoid copying the same article into multiple folders).
- Cross-link in metadata later (e.g. blog ↔ buying process) rather than duplicating.
- Knowledge files are **approved business content**, not model improvisation dumps.
- Dynamic fields must never be “frozen” into static markdown as current truth.
