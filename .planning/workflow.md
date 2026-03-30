# Workflow — ClaudeClaw v2 Upgrade

## GSD Configuration

```yaml
project_type: brownfield_upgrade
execution_mode: sequential_phases
parallel_plans: false  # Each phase depends on previous
auto_advance: false    # Require explicit checkpoint between phases
tdd_required: true     # All new modules need tests
commit_style: atomic   # Each sub-item is a separate commit
```

## Phase Gate Structure

This project uses **sequential phase gates** — each phase must be complete before the next begins.

```
Phase 1 (Event Bus) ──► Phase 2 (Gateway) ──► Phase 3 (Policy)
      │                      │                      │
      ▼                      ▼                      ▼
   [PLAN.md]             [PLAN.md]             [PLAN.md]
   [Tasks A.1-A.5]       [Tasks B.1-B.4]       [Tasks C.1-C.5]
      │                      │                      │
      ▼                      ▼                      ▼
   Checkpoint           Checkpoint            Checkpoint
      │                      │                      │
      ▼                      ▼                      ▼
   Phase 2 start        Phase 3 start         Phase 4 start
```

## Task Execution Pattern

Each task follows this pattern:

```
┌─────────────────┐
│  1. RED Phase   │  Write failing test
│  (if TDD)       │
└────────┬────────┘
         ▼
┌─────────────────┐
│  2. GREEN Phase │  Implement to pass test
│                 │
└────────┬────────┘
         ▼
┌─────────────────┐
│  3. REFACTOR    │  Clean up (optional)
│  (if needed)    │
└────────┬────────┘
         ▼
┌─────────────────┐
│  4. COMMIT      │  Atomic commit with
│                 │  conventional message
└────────┬────────┘
         ▼
┌─────────────────┐
│  5. VERIFY      │  Run tests, check
│                 │  against done criteria
└─────────────────┘
```

## Commit Message Format

```
feat(A.1): add event-log module

- Append-only log with sequence numbers
- Daily rotation at 10MB
- TypeScript interfaces for EventEntry

test(A.1): add unit tests for event-log

- Test append and read operations
- Verify sequence number increment
- Test log rotation trigger
```

## Checkpoint Types

### Between Tasks (Auto)
- No checkpoint needed between tasks within a phase
- Continue executing until phase complete

### Between Phases (Manual)
- **checkpoint:human-verify** after each phase
- Verify: all tests pass, integration tests complete
- Verify: no regression in existing functionality

### Example Phase Transition
```
Phase 1 (Event Bus) Complete
├── All unit tests passing
├── Integration tests passing  
├── No existing functionality broken
└── Documentation complete

CHECKPOINT: human-verify
├── Review event-log implementation
├── Review retry queue behavior
└── Approve Phase 2 start

Phase 2 (Gateway) Start
```

## Deviation Handling

### Rule 1: Auto-fix bugs
- Fix inline → add tests → verify → continue → track

### Rule 2: Auto-add missing critical functionality
- Error handling, validation, null checks → add without asking

### Rule 3: Auto-fix blocking issues
- Missing imports, broken types → fix to continue

### Rule 4: Ask about architectural changes
- New DB table (not column) → STOP, checkpoint
- Major schema changes → STOP, checkpoint
- Breaking API changes → STOP, checkpoint

## Rollback Strategy

If a phase introduces breaking changes:

1. **Immediate:** `git revert` of offending commits
2. **Investigation:** Root cause analysis in WORKLOG.md
3. **Recovery:** Fix forward or re-plan phase
4. **Documentation:** Update PLAN.md with lessons learned

## Quality Gates

Each phase must pass:

| Gate | Check | Command |
|------|-------|---------|
| Unit Tests | All new modules tested | `bun test` |
| Type Check | No TypeScript errors | `bun tsc --noEmit` |
| Lint | No lint errors | `bun lint` (if configured) |
| Integration | Phase-specific integration tests | `bun test:integration` |
| Existing | No regression in existing | Manual verification |

## Communication

### Daily Standup (Self)
Update WORKLOG.md with:
- What was completed yesterday
- What's planned today
- Any blockers or decisions needed

### Phase Completion
Create SUMMARY.md with:
- What was built
- Key decisions made
- Deviations from plan
- Metrics (files created, tests added, duration)

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Breaking existing | Preserve all existing modules, additive only |
| Scope creep | Strict phase gates, defer non-critical features |
| Test coverage | TDD required, coverage check before commit |
| Performance | Benchmark existing, measure new |
| Complexity | Small modules, clear interfaces, heavy documentation |

## Success Metrics

- **Test Coverage:** > 80% for new modules
- **Commit Frequency:** At least one commit per task
- **Phase Duration:** Target < 1 week per phase
- **Defect Rate:** Zero known bugs at phase completion
- **Documentation:** Every public API documented
