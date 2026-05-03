"""
Command-line entry point for memory-search.

Usage:
    memory-search index [--force]
    memory-search recall "query" [--top 5] [--alpha 0.5] [--no-summary] [--json]
    memory-search stats
    memory-search --help
"""

from __future__ import annotations

import argparse
import json
import logging
import sys

from . import db
from .recall import recall as do_recall, format_for_humans, format_as_json


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="memory-search",
        description="Hybrid keyword + semantic search over Claude Code session history.",
    )
    p.add_argument("-v", "--verbose", action="store_true", help="Verbose logging")
    sub = p.add_subparsers(dest="cmd", required=True, metavar="COMMAND")

    p_index = sub.add_parser("index", help="(Re)index session JSONL files into the DB")
    p_index.add_argument("--force", action="store_true",
                         help="Re-index every file even if mtime unchanged")

    p_recall = sub.add_parser("recall", help="Search past sessions for a query")
    p_recall.add_argument("query", help="Free-text query")
    p_recall.add_argument("--top", type=int, default=5,
                          help="Max number of sessions to return (default: 5)")
    p_recall.add_argument("--alpha", type=float, default=None,
                          help="Hybrid blend (1.0=semantic only, 0.0=FTS5 only, default: 0.5)")
    p_recall.add_argument("--no-summary", action="store_true",
                          help="Skip the claude --print summary step")
    p_recall.add_argument("--json", action="store_true",
                          help="Emit JSON instead of human-readable output")

    sub.add_parser("stats", help="Print DB stats (sessions/chunks/vectorized)")

    return p


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )

    if args.cmd == "index":
        result = db.index_all(force=args.force)
        print(f"📂 found: {result['found']}")
        print(f"✅ indexed: {result['indexed']}")
        print(f"⏭️  skipped (up-to-date): {result['skipped']}")
        return 0

    if args.cmd == "recall":
        result = do_recall(
            args.query,
            top_k=args.top,
            alpha=args.alpha,
            do_summary=not args.no_summary,
        )
        if args.json:
            print(format_as_json(result))
        else:
            print(format_for_humans(result))
        return 0 if result["hits"] else 1

    if args.cmd == "stats":
        s = db.stats()
        print(f"📊 sessions: {s['sessions']}")
        print(f"📦 chunks: {s['chunks']} ({s['vectorized']} with vectors)")
        return 0

    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
