# memory-search

Hybrid keyword + semantic recall over Claude Code session history.

Indexes the JSONL session files Claude Code writes under `~/.claude/projects/`
into a local SQLite database (FTS5 + sentence-transformer vectors), then lets
you query that history by meaning, not just exact words.

Optional: pipe the top hits through `claude --print` to get a short narrative
answer to your query — works without an Anthropic API key, since it reuses
Claude Code's own OAuth session.

## Why

ClaudeClaw's curated `MEMORY.md` is great for facts the agent should always
remember. But everything you've ever discussed in a Claude Code session is
already on disk as JSONL — and most of it is too verbose to pin in `MEMORY.md`.

`memory-search` gives Claude (and you) a way to recall past sessions on demand,
without paying the context cost of loading them. Think of it as long-term
episodic memory next to the existing semantic memory.

## Install

```bash
cd tools/memory-search
pip install -e .
```

This installs a `memory-search` console script. The first run will download
the sentence-transformer model (`all-MiniLM-L6-v2`, ~80 MB).

## Usage

```bash
# Index every Claude Code session JSONL on disk
memory-search index

# Re-index everything (e.g. after model change)
memory-search index --force

# Search past sessions
memory-search recall "BREAKOUT_52W swing trader pattern"

# Search without the summary (faster, no claude CLI required)
memory-search recall "yfinance crumb fix" --no-summary

# Programmatic / scripting use
memory-search recall "voice pipeline asterisk" --json --top 3
```

Sample output:

```
🔍 Recherche : "voice pipeline asterisk"

✅ 3 session(s) trouvée(s) :

  📅 2026-05-02T22:54 | Score: 0.5 | 119 tours
     Asterisk installé, extension 100 → AGI Python pipeline STT/Claude/TTS...

  📅 2026-04-28T04:23 | Score: 0.42 | 33 tours
     Whisper local actif, messages vocaux Telegram...

💬 Résumé :
----------------------------------------
- Pipeline vocal 2-way Asterisk + AGI Python opérationnel sur ext 100
- Voix québécoise Antoine via Edge TTS, STT via Groq Whisper large-v3
- Forward Telegram natif via /api/inject
```

## Configuration

All paths and tunables are env-overridable:

| Env var | Default | Purpose |
|---|---|---|
| `MEMORY_SEARCH_DB` | `~/.claude/claudeclaw/memory-search.db` | SQLite DB path |
| `MEMORY_SEARCH_SESSIONS_DIR` | All subdirs of `~/.claude/projects/` | Where to find session JSONLs (colon-separated) |
| `MEMORY_SEARCH_MODEL` | `all-MiniLM-L6-v2` | sentence-transformer model |
| `MEMORY_SEARCH_DIM` | `384` | Embedding dimensionality |
| `MEMORY_SEARCH_ALPHA` | `0.5` | Hybrid blend (1.0=semantic, 0.0=FTS5) |
| `MEMORY_SEARCH_CHUNK_SIZE` | `5` | Messages per chunk |
| `MEMORY_SEARCH_MSG_MAX` | `2000` | Max chars per message before truncation |
| `MEMORY_SEARCH_CHUNK_EXCERPT` | `400` | Max chars per message inside a chunk |
| `MEMORY_SEARCH_SUMMARY_MODEL` | `claude-haiku-4-5` | Model for the summary step |
| `MEMORY_SEARCH_SUMMARY_TIMEOUT` | `30` | Summary subprocess timeout (seconds) |
| `CLAUDECLAW_CLAUDE_BIN` | `which claude` | Path to the `claude` CLI used for summaries |

## How it works

```
session JSONL → parse user/assistant text turns → chunk(5 turns) → embed → store
                                                                         ↓
                                                                  SQLite + FTS5
                                                                         ↓
query → vectorize → cosine via dot                                       │
        FTS5 keyword match                                               │
        weighted blend → top-K → optional claude --print summary  ───────┘
```

- **Idempotent indexing**: `index_session()` skips files whose `mtime`
  hasn't changed since the last indexing pass.
- **Hybrid scoring**: `alpha * semantic + (1 - alpha) * fts5` after
  per-pool min-max normalization.
- **Per-session deduplication**: search returns at most one chunk per
  session (the highest-scoring one), so your top-K is K distinct sessions.

## Library use

```python
from memory_search import index_all, recall

index_all()                    # one-shot reindex
result = recall("yfinance fix")
for hit in result["hits"]:
    print(hit["score"], hit["timestamp"], hit["excerpt"])
print(result["summary"])
```

## Development

```bash
pip install -e ".[dev]"
pytest
```

## License

MIT — same as ClaudeClaw-Plus.
