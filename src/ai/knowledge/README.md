# Rocky AI Knowledge Layer

Structured business knowledge for Rocky Real Estate.

This phase organises **what Rocky AI knows** into clear domains.  
It does **not** implement RAG, embeddings, vector databases, or semantic search.

---

## Purpose

Provide a stable, human-readable knowledge architecture that:

- Represents Rocky Real Estate accurately
- Separates static company knowledge from live/dynamic data
- Can later feed RAG, tool calling, and CMS-backed content without restructuring

---

## Structure

```
knowledge/
├── company/                 # About Rocky Real Estate
├── services/                # Core service domains
│   ├── buying/
│   ├── selling/
│   ├── renting/
│   ├── mortgage/
│   ├── property-management/
│   ├── inspection/
│   ├── brokerage/
│   └── after-sales/
├── faqs/                    # Common Q&A
├── blogs/                   # Educational / process content
├── area-guides/             # Dubai community summaries
├── developers/              # Developer profiles (static facts only)
├── communities/             # Community overviews
├── off-plan/                # Off-plan concepts & process
├── investment/              # General investment education (no guarantees)
├── knowledge-map.md         # What belongs where
├── knowledge-priority.md    # Source priority ranking
└── future-rag.md            # How this evolves into RAG later
```

---

## What lives here vs tools

| Type | Source | Example |
|------|--------|---------|
| Static knowledge | This folder (later CMS / DB) | Company info, services, blogs, area guides |
| Dynamic / live data | Tools / APIs | Prices, availability, payment plans, agent assignment |

Never store live inventory prices or availability as static markdown in this layer.

---

## Status

**Phase: Knowledge Layer architecture only.**  
Content files will be added gradually. RAG wiring is a later phase.
