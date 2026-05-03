"""
memory-search — hybrid FTS5 + sentence-transformer recall over Claude Code sessions.
"""

from .db import index_all, index_session, search, stats
from .recall import recall, summarize, format_for_humans, format_as_json

__version__ = "0.1.0"

__all__ = [
    "index_all",
    "index_session",
    "search",
    "stats",
    "recall",
    "summarize",
    "format_for_humans",
    "format_as_json",
    "__version__",
]
