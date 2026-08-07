# Future RAG Evolution

Describes how this Knowledge Layer can evolve into Retrieval-Augmented Generation **without changing the folder architecture**.

**This document is design only. No RAG is implemented in this phase.**

---

## What stays the same

The current tree remains the **canonical content map**:

```
knowledge/
  company/
  services/**
  faqs/
  blogs/
  area-guides/
  developers/
  communities/
  off-plan/
  investment/
```

RAG should **ingest from these domains**, not invent a parallel taxonomy.

---

## Evolution path (conceptual)

```
Markdown / CMS content in knowledge/*
            ↓
       Chunking
            ↓
       Embeddings
            ↓
     Vector index
            ↓
   Semantic retrieval
            ↓
  Inject into prompt / context
            ↓
     Rocky AI response
```

Live inventory continues to bypass RAG and go through **tools**.

---

## Chunking

Future chunking can follow folder boundaries:

| Domain | Suggested chunk style |
|--------|------------------------|
| `faqs/` | One FAQ = one chunk |
| `company/`, `services/**` | Section-sized chunks (H2/H3) |
| `blogs/` | Paragraph / section chunks with article metadata |
| `area-guides/`, `communities/` | Per-area document or per-section |
| `developers/` | Per-developer profile |
| `off-plan/`, `investment/` | Section chunks; strict metadata flags (educational, no guarantees) |

Each chunk should carry metadata such as:

- `domain` (e.g. `services.buying`, `area-guides`)
- `source` (markdown path / CMS id)
- `static: true`
- `updatedAt`
- optional `locale`

---

## Embeddings & vector search

Later, a retrieval service can:

1. Load approved documents from this tree (or CMS sync into the same domains)
2. Chunk + embed
3. Store vectors in a chosen backend (Pinecone, Chroma, MongoDB Atlas Vector Search, OpenSearch, etc.)
4. At query time, embed the user question and retrieve top-k chunks
5. Filter by domain using `knowledge-map.md` + `knowledge-priority.md`
6. Pass retrieved text into the existing prompt assembly (`prompt.service`) alongside conversation history

**Architecture constraint:** ChatService still talks to AIProviderService; retrieval becomes an additional step *before* generate — not a rewrite of providers.

---

## Semantic search vs tools

| Query type | Path |
|------------|------|
| “What is freehold?” | Semantic search over `blogs/` / `faqs/` |
| “Tell me about Dubai Hills” | Semantic search over `area-guides/` |
| “3-bed villa under 5M in Dubai Hills” | **Property tool** (structured filters), not vector search |
| “Price of REF-123” | **Property tool** |

RAG does not replace tool calling for dynamic inventory.

---

## Why this architecture does not need to change

- Domains are already separated → clean metadata filters
- Static vs dynamic is already documented → prevents embedding live prices
- Priority ranking already exists → retrieval re-ranking / routing policy
- Prompt layer already assembles system + business rules → RAG context is another fragment

Adding RAG later should be **additive**:

```
Prompt fragments today:
  system.md + business-rules.md + tools.md (+ conversation)

Prompt fragments with RAG:
  system.md + business-rules.md + tools.md
  + retrieved knowledge chunks
  + conversation
  (+ tool results when tools exist)
```

---

## Explicitly out of scope for this phase

- Vector databases
- Embeddings generation
- Pinecone / Chroma / LangChain
- Mongo vector search
- OpenSearch / ElasticSearch
- Semantic search APIs
- Chunking pipelines
- Ingestion jobs

Those belong to a later RAG implementation phase.
