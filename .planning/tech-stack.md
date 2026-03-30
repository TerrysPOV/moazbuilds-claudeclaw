# Tech Stack — ClaudeClaw v2

## Core Runtime

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | **Bun** | Fast startup, native TypeScript, ESM-first, built-in test runner |
| Package Manager | **Bun** | Native workspace support, fast installs, deterministic lockfile |
| Language | **TypeScript** | Type safety, IDE support, maintainability |
| Module System | **ESM** | Native async loading, tree-shaking, modern JS features |

## Persistence

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Primary Store | **Flat JSON/JSONL files** | Zero dependencies, human-readable, version-controllable backups |
| Event Log | **Append-only JSONL** | Immutable history, replay capability, easy to tail/inspect |
| Queue State | **JSON files** | Atomic writes, simple to backup/restore |

### Storage Locations
```
.claude/claudeclaw/
├── event-log/           # Append-only event log (rotated daily)
├── retry-queue.json     # Retry queue state
├── dlq.jsonl            # Dead letter queue
├── session-map.json     # Channel→session mappings
├── audit-log.jsonl      # Policy decision audit trail
├── usage/               # Per-session usage accounting
├── workflows/           # Persisted workflow state
└── paused.json          # Pause state flag
```

## Testing

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Test Runner | **Bun test** | Built-in, fast, Jest-compatible API |
| Test Location | `src/__tests__/` | Co-located with source |
| Coverage | **Bun built-in** | Native coverage reporting |

## Project Structure

```
moazbuilds-claudeclaw/
├── src/
│   ├── __tests__/           # Test files
│   ├── commands/            # Telegram, Discord adapters (existing)
│   ├── gateway/             # NEW: Session mapping layer
│   ├── policy/              # NEW: Policy engine
│   ├── governance/          # NEW: Cost + model governance
│   ├── orchestrator/        # NEW: Task graph + workflow
│   ├── escalation/          # NEW: Human escalation
│   ├── adapters/            # NEW: Additional channel adapters
│   ├── ui/                  # Web dashboard (existing)
│   └── prompts/             # Prompt templates (existing)
├── .planning/               # GSD planning artifacts
├── PROJECT.md               # Project definition
├── WORKLOG.md               # Ongoing work log
├── package.json
├── tsconfig.json
└── bun.lock
```

## Key Dependencies

### Existing (Preserved)
- Runtime dependencies managed via `package.json` (Bun-based)
- No changes to existing dependency set

### New (To Add)
- None initially — all new modules use Bun built-ins and native APIs
- Optional: `uuid` for event IDs (or use `crypto.randomUUID()`)

## Design Decisions

### Why Flat Files Over Database?
1. **Simplicity:** No external service to configure or maintain
2. **Portability:** Easy to backup, restore, version control
3. **Debugging:** Human-readable, easy to inspect with standard tools
4. **Performance:** Sufficient for expected load (single daemon, moderate event volume)
5. **Atomicity:** Bun's `Bun.write()` provides atomic file writes

### Why Bun Over Node.js?
1. **Speed:** Faster startup and execution
2. **Native TypeScript:** No transpile step needed
3. **Built-in Testing:** No Jest/Vitest configuration
4. **Modern APIs:** Native fetch, WebSocket, etc.

### Why ESM Over CommonJS?
1. **Tree-shaking:** Smaller bundles if bundling needed
2. **Top-level await:** Cleaner async initialization
3. **Native async:** Better for I/O-bound daemon
4. **Future-proof:** ESM is the standard

## Constraints & Non-Negotiables

1. **No database dependencies** — flat files only
2. **No breaking changes** to existing modules
3. **Bun-compatible** — no Node.js-specific APIs
4. **ESM-only** — no CommonJS require()
5. **TypeScript strict mode** — type safety required

## Evolution Path

### Phase 1-3: Foundation
- Core event infrastructure
- Session management
- Basic policy engine

### Phase 4-5: Governance + Orchestration
- Cost tracking
- Task graphs

### Phase 6-7: Advanced Features
- Human escalation
- Additional adapters

### Future Considerations (Post-v2)
- Optional SQLite for high-volume deployments
- Optional Redis for distributed setups
- Optional PostgreSQL for enterprise deployments

These are **explicitly out of scope** for v2 but the architecture should not preclude them.
