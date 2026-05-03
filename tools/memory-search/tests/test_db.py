"""
Smoke tests for memory_search.db.

These don't load the real sentence-transformer model; instead they patch
`memory_search.db.vectorize` to emit a deterministic 384-dim vector.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import pytest

from memory_search import db


# --- Fixtures ---

@pytest.fixture(autouse=True)
def isolated_paths(tmp_path, monkeypatch):
    """Point the DB and sessions dir at a tmpdir for every test."""
    db_file = tmp_path / "memory.db"
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    monkeypatch.setenv("MEMORY_SEARCH_DB", str(db_file))
    monkeypatch.setenv("MEMORY_SEARCH_SESSIONS_DIR", str(sessions))
    yield tmp_path


@pytest.fixture
def fake_vectorize(monkeypatch):
    """Replace the real model with a hash-based deterministic vector."""
    def _v(texts):
        # Normalized 384-dim vector seeded from hash of each text
        out = []
        for t in texts:
            seed = abs(hash(t)) % (2**31)
            rng = np.random.default_rng(seed)
            v = rng.normal(size=384).astype(np.float32)
            v /= np.linalg.norm(v) + 1e-9
            out.append(v)
        return np.stack(out)
    monkeypatch.setattr(db, "vectorize", _v)


def write_session(sessions_dir: Path, session_id: str, turns: list[tuple[str, str]]) -> Path:
    """Create a minimal JSONL file mimicking Claude Code's session format."""
    path = sessions_dir / f"{session_id}.jsonl"
    with open(path, "w") as f:
        for i, (role, text) in enumerate(turns):
            entry = {
                "type": role,  # "user" or "assistant"
                "sessionId": session_id,
                "timestamp": f"2026-05-03T10:00:{i:02d}Z",
                "message": {"role": role, "content": text},
            }
            f.write(json.dumps(entry) + "\n")
    return path


# --- Tests ---

def test_get_db_creates_schema(tmp_path):
    conn = db.get_db(tmp_path / "fresh.db")
    tables = {row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    )}
    assert {"sessions", "chunks"}.issubset(tables)
    conn.close()


def test_index_session_writes_chunks(isolated_paths, fake_vectorize):
    sess_dir = isolated_paths / "sessions"
    path = write_session(sess_dir, "abc123", [
        ("user", "How do I configure Asterisk for a SIP trunk to Twilio?"),
        ("assistant", "You configure pjsip.conf with a transport-udp section..."),
        ("user", "Can I use the same trunk for outbound only?"),
        ("assistant", "Yes, leave the origination block empty."),
    ])

    conn = db.get_db()
    indexed = db.index_session(conn, path)
    conn.close()
    assert indexed is True

    s = db.stats()
    assert s["sessions"] == 1
    assert s["chunks"] >= 1
    assert s["vectorized"] == s["chunks"]


def test_index_skips_when_unchanged(isolated_paths, fake_vectorize):
    sess_dir = isolated_paths / "sessions"
    path = write_session(sess_dir, "abc123", [
        ("user", "Hello world this is a long enough message to get past the 20-char filter."),
        ("assistant", "Hi there, this is also a sufficiently long reply for indexing."),
    ])

    conn = db.get_db()
    assert db.index_session(conn, path) is True
    # Second call without --force: should skip
    assert db.index_session(conn, path) is False
    conn.close()


def test_search_finds_relevant_session(isolated_paths, fake_vectorize):
    sess_dir = isolated_paths / "sessions"
    write_session(sess_dir, "asterisk-help", [
        ("user", "How do I configure Asterisk pjsip endpoints for SRTP?"),
        ("assistant", "Use media_encryption=sdes with optimistic mode for fallback."),
        ("user", "What about codec negotiation problems with Linphone?"),
        ("assistant", "Make sure ulaw and opus are both allowed in the endpoint."),
    ])
    write_session(sess_dir, "trading-hello", [
        ("user", "What's a swing trading pattern that uses 52-week breakouts?"),
        ("assistant", "Look at BREAKOUT_52W with confirmation on volume."),
        ("user", "How does it compare to a flat base breakout?"),
        ("assistant", "The 52W breakout requires a longer consolidation period."),
    ])

    db.index_all()

    # FTS5 should match exact "Asterisk" keyword strongly
    hits = db.search("Asterisk pjsip", top_k=5, alpha=0.0)
    assert any(h["session_id"] == "asterisk-help" for h in hits)


def test_search_returns_empty_on_empty_db(isolated_paths, fake_vectorize):
    hits = db.search("anything", top_k=5)
    assert hits == []


def test_stats_on_empty_db(isolated_paths):
    s = db.stats()
    assert s == {"sessions": 0, "chunks": 0, "vectorized": 0}
