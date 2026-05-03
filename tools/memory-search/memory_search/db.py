"""
Session memory DB: SQLite + FTS5 + sentence-transformer vectors.

Indexes Claude Code session JSONL files (`~/.claude/projects/*/...jsonl`)
for hybrid keyword + semantic recall. The same DB is used by `recall.py`
to surface past sessions that are relevant to a query.

Refactored from the original `session-db.py` PoC (Nibbler1250, April 2026).
"""

from __future__ import annotations

import json
import logging
import sqlite3
import sys
from pathlib import Path
from typing import Iterable, Optional

import numpy as np

from . import config

log = logging.getLogger(__name__)

_model = None  # lazy-loaded sentence-transformer


# --- Model ---

def get_model():
    """Lazy-load the sentence-transformer (heavy, ~80MB on first use)."""
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(config.embedding_model_name())
    return _model


def vectorize(texts: list[str]) -> np.ndarray:
    """Embed a batch of strings; vectors are L2-normalized for cosine via dot product."""
    return get_model().encode(texts, normalize_embeddings=True, show_progress_bar=False)


# --- DB lifecycle ---

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    session_id    TEXT PRIMARY KEY,
    first_message TEXT,
    last_message  TEXT,
    turn_count    INTEGER DEFAULT 0,
    indexed_at    REAL,
    file_path     TEXT
);

CREATE TABLE IF NOT EXISTS chunks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL REFERENCES sessions(session_id),
    chunk_index   INTEGER NOT NULL,
    role          TEXT NOT NULL,
    content       TEXT NOT NULL,
    timestamp     TEXT,
    vector        BLOB
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content,
    content='chunks',
    content_rowid='id',
    tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
"""


def get_db(path: Optional[Path] = None) -> sqlite3.Connection:
    """Open the DB, create the file's parent dir if needed, apply schema."""
    db_file = path or config.db_path()
    db_file.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_file))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


# --- Parsing ---

def parse_session_file(jsonl_path: Path) -> list[dict]:
    """Extract user/assistant text messages from a Claude Code session JSONL file."""
    messages: list[dict] = []
    msg_max = config.message_max_chars()
    try:
        with open(jsonl_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                if entry.get("type") not in ("user", "assistant"):
                    continue

                msg = entry.get("message", {})
                role = msg.get("role", entry.get("type", ""))
                content = msg.get("content", "")

                # `content` can be a list of blocks (Claude API format) or a string
                if isinstance(content, list):
                    parts = [
                        block.get("text", "")
                        for block in content
                        if isinstance(block, dict) and block.get("type") == "text"
                    ]
                    content = " ".join(parts)

                if not content or not isinstance(content, str):
                    continue

                content = content.strip()
                # Skip noise (very short turns)
                if len(content) < 20:
                    continue

                messages.append({
                    "role": role,
                    "content": content[:msg_max],
                    "timestamp": entry.get("timestamp", ""),
                    "session_id": entry.get("sessionId", ""),
                })
    except OSError as e:
        log.warning("could not read %s: %s", jsonl_path, e)
    return messages


def chunk_messages(messages: list[dict]) -> list[dict]:
    """Group consecutive messages into chunks for better embedding context."""
    size = config.chunk_size()
    excerpt_chars = config.chunk_msg_excerpt_chars()
    chunks: list[dict] = []
    for i in range(0, len(messages), size):
        group = messages[i:i + size]
        combined = " | ".join(
            f"[{m['role']}] {m['content'][:excerpt_chars]}" for m in group
        )
        chunks.append({
            "content": combined,
            "role": "mixed",
            "timestamp": group[0]["timestamp"] if group else "",
            "chunk_index": i // size,
        })
    return chunks


# --- Indexing ---

def index_session(
    conn: sqlite3.Connection,
    jsonl_path: Path,
    *,
    force: bool = False,
) -> bool:
    """
    Index one session file. Idempotent (skips if mtime unchanged unless `force`).
    Returns True if (re)indexed, False if skipped.
    """
    session_id = jsonl_path.stem

    if not force:
        row = conn.execute(
            "SELECT indexed_at FROM sessions WHERE session_id = ?", (session_id,)
        ).fetchone()
        if row and row[0] and jsonl_path.stat().st_mtime <= row[0]:
            return False

    messages = parse_session_file(jsonl_path)
    if not messages:
        return False

    # Wipe previous data for this session (clean re-index)
    conn.execute("DELETE FROM chunks WHERE session_id = ?", (session_id,))
    conn.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))

    chunks = chunk_messages(messages)
    if not chunks:
        return False

    vectors = vectorize([c["content"] for c in chunks])

    first_ts = messages[0]["timestamp"]
    last_ts = messages[-1]["timestamp"]
    conn.execute(
        "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)",
        (session_id, first_ts, last_ts, len(messages),
         jsonl_path.stat().st_mtime, str(jsonl_path)),
    )

    for chunk, vec in zip(chunks, vectors):
        conn.execute(
            "INSERT INTO chunks (session_id, chunk_index, role, content, timestamp, vector) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (session_id, chunk["chunk_index"], chunk["role"],
             chunk["content"], chunk["timestamp"], vec.tobytes()),
        )

    conn.commit()
    return True


def index_all(
    *,
    force: bool = False,
    sessions_dirs: Optional[Iterable[Path]] = None,
) -> dict:
    """
    Walk every configured sessions directory, index every JSONL.
    Returns counts.
    """
    dirs = list(sessions_dirs) if sessions_dirs is not None else config.sessions_dirs()
    if not dirs:
        log.warning("no sessions directories configured (set MEMORY_SEARCH_SESSIONS_DIR)")
        return {"indexed": 0, "skipped": 0, "found": 0}

    conn = get_db()
    indexed = 0
    skipped = 0
    found = 0
    for d in dirs:
        for jsonl in sorted(Path(d).rglob("*.jsonl")):
            found += 1
            if index_session(conn, jsonl, force=force):
                indexed += 1
            else:
                skipped += 1
    conn.close()
    return {"indexed": indexed, "skipped": skipped, "found": found}


# --- Search ---

def search(
    query: str,
    *,
    top_k: int = 5,
    alpha: Optional[float] = None,
) -> list[dict]:
    """
    Hybrid search: alpha * semantic_score + (1 - alpha) * fts5_score.
    Returns up to top_k unique sessions, best chunk per session.
    """
    if alpha is None:
        alpha = config.default_alpha()

    conn = get_db()

    # FTS5 phase
    fts_scores: dict[int, float] = {}
    try:
        rows = conn.execute(
            "SELECT rowid, rank FROM chunks_fts WHERE content MATCH ? ORDER BY rank LIMIT 50",
            (query,),
        ).fetchall()
        if rows:
            ranks = [r[1] for r in rows]
            lo, hi = min(ranks), max(ranks)
            span = (hi - lo) or 1
            for rowid, rank in rows:
                # FTS5 rank is BM25-derived: lower (more negative) = better match.
                # Invert so that the best match maps to 1.0, worst to 0.0.
                fts_scores[rowid] = 1.0 - (rank - lo) / span
    except sqlite3.OperationalError:
        # FTS5 throws on some queries (e.g. only stop-words); fall back to vector only.
        pass

    # Vector phase
    query_vec = vectorize([query])[0]
    rows = conn.execute(
        "SELECT id, session_id, content, timestamp, vector FROM chunks WHERE vector IS NOT NULL"
    ).fetchall()

    vec_scores: dict[int, tuple[float, str, str, str]] = {}
    for chunk_id, session_id, content, ts, vec_bytes in rows:
        if not vec_bytes:
            continue
        vec = np.frombuffer(vec_bytes, dtype=np.float32)
        score = float(np.dot(query_vec, vec))
        vec_scores[chunk_id] = (score, session_id, content, ts)

    # Normalize vector scores into [0, 1]
    if vec_scores:
        scores = [v[0] for v in vec_scores.values()]
        lo, hi = min(scores), max(scores)
        span = (hi - lo) or 1
        vec_norm = {
            k: ((v[0] - lo) / span, v[1], v[2], v[3])
            for k, v in vec_scores.items()
        }
    else:
        vec_norm = {}

    # Blend
    candidates: list[tuple[float, int, str, str, str]] = []
    for chunk_id in set(fts_scores) | set(vec_norm):
        fts = fts_scores.get(chunk_id, 0.0)
        if chunk_id in vec_norm:
            v_score, session_id, content, ts = vec_norm[chunk_id]
        else:
            v_score = 0.0
            row = conn.execute(
                "SELECT session_id, content, timestamp FROM chunks WHERE id = ?",
                (chunk_id,),
            ).fetchone()
            if not row:
                continue
            session_id, content, ts = row
        combined = alpha * v_score + (1 - alpha) * fts
        candidates.append((combined, chunk_id, session_id, content, ts))

    candidates.sort(reverse=True)

    results = []
    seen_sessions: set[str] = set()
    for score, _chunk_id, session_id, content, ts in candidates:
        if session_id in seen_sessions:
            continue
        seen_sessions.add(session_id)
        sess = conn.execute(
            "SELECT first_message, turn_count FROM sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        results.append({
            "score": round(score, 4),
            "session_id": session_id,
            "timestamp": ts or (sess[0] if sess else ""),
            "turn_count": sess[1] if sess else 0,
            "excerpt": content[:500],
        })
        if len(results) >= top_k:
            break

    conn.close()
    return results


def stats() -> dict:
    """Return counts for inspection / health-check."""
    conn = get_db()
    sessions = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    chunks = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    with_vec = conn.execute(
        "SELECT COUNT(*) FROM chunks WHERE vector IS NOT NULL"
    ).fetchone()[0]
    conn.close()
    return {"sessions": sessions, "chunks": chunks, "vectorized": with_vec}
