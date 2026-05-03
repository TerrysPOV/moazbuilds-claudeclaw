---
name: session-recall
description: Hybrid keyword + semantic search over past Claude Code session history. Use when the user asks "what did we do about X", "you remember when", "was there a fix for Y", "earlier we talked about Z", or any callback to a prior conversation that isn't in the current session.
trigger:
  - "qu'est-ce qu'on avait fait"
  - "tu te souviens"
  - "c'était quoi le fix"
  - "on en avait parlé"
  - "retrouve-moi"
  - "what did we do about"
  - "was there a discussion"
  - "earlier we"
  - "remember when"
---

# session-recall

Hybrid FTS5 + sentence-transformer search over the JSONL session history that
Claude Code persists under `~/.claude/projects/`. Surfaces past sessions
relevant to the current question without loading their full text into context.

## When to use

- The user references something they remember discussing but you don't have
  it in the current context window.
- You need to check whether a problem was already solved in a prior session.
- The user asks for a status summary that spans multiple past sessions.

## How to use

```bash
memory-search recall "<query>" --top 5
```

Add `--no-summary` for a faster keyword/vector match without the LLM
summarization step.

For programmatic use inside skills:

```python
from memory_search import recall
result = recall("yfinance crumb fix", top_k=5)
for hit in result["hits"]:
    print(hit["score"], hit["timestamp"], hit["excerpt"])
print(result["summary"])
```

## Examples

```bash
memory-search recall "BREAKOUT_52W backtest results"
memory-search recall "fix yfinance crumb"
memory-search recall "Asterisk SRTP codec negotiation"
memory-search recall "IBKR Gateway zombie session"
```

## Reindex (when needed)

The indexer is idempotent (skips files whose mtime is unchanged) so it's safe
to run on every daemon start or on a cron.

```bash
memory-search index           # incremental
memory-search index --force   # full reindex (e.g. after model change)
memory-search stats           # quick health check
```

## Notes

- The first invocation downloads the sentence-transformer model (~80 MB).
- Vector search alone returns up to 50 candidates; FTS5 is layered on top
  for keyword anchoring and the two are blended with `alpha` (default 0.5).
- Search results are deduplicated per session: the top chunk wins.
- The `--summary` step uses `claude --print`, so it works without an
  Anthropic API key (relies on Claude Code's existing OAuth session).
