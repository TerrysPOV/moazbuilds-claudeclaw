# Sprint 0 cross-validation traces

External validation of Sprint 0 spike findings (per #109) on two platforms different from the ones in `docs/spikes/`. Posted as follow-up to PR #106 review.

## Scope

| Spike | What was reproduced |
|---|---|
| 0.4 (slash via stdin) | Plain-stdin downshift to `--print` mode; full PTY-required confirmation |
| 0.5 (lifecycle markers) | `/compact`, `/clear`, `/quit` JSONL diffs; `compact_boundary` + `compactMetadata` shape |
| bonus | `stop_hook_summary` subtype observed (when Stop hooks are configured) |

## Platforms

| Platform | claude version | OS | Arch | Reason |
|---|---|---|---|---|
| S26 (proot) | **2.1.126** | Ubuntu 24.04 in proot (Android) | ARM64 | Different version than Terry's spike to test forward compat |
| ProDesk | **2.1.143** | Ubuntu 24.04 native | x86_64 | Same version as Terry's spike to validate transfer across hardware/install |

Two-axis sanity check: version skew and arch/OS skew.

## TL;DR

All findings from `docs/spikes/0.4-slash-stdin.md` and `docs/spikes/0.5-lifecycle-markers.md` reproduce **structurally identically** on both platforms.

- Plain stdin gates to `--print` and dies with `Error: Input must be provided either through stdin or as a prompt argument when using --print` (exit 1). Timing varies (~3.6 s on Ubuntu native, ~5.5 s under proot) but the behavior is the same.
- `compact_boundary` system subtype appears on successful `/compact` with sufficient history, on both 2.1.126 and 2.1.143.
- `compactMetadata` shape on both versions: `{trigger, preTokens, postTokens, durationMs, preservedSegment: {headUuid, anchorUuid, tailUuid}}`.
- `/clear` rotation: same on both. Old JSONL untouched; new session UUID file materialises; `/clear` + `/exit` envelopes go to the new file.
- `/quit` envelope: `<command-name>/exit</command-name>` + `<local-command-stdout>{farewell}</local-command-stdout>` on both.
- Farewell variants: collected `Bye!`, `Goodbye!`, `See ya!`, `Catch you later!` on 2.1.126 (4 distinct; spec mentions 2). The randomization is client-side and looks consistent across versions.

## New observation worth flagging

**`stop_hook_summary` subtype** — not enumerated in §5.2 or in `docs/spikes/0.2-jsonl-schema-snapshot.md`. Fires once per turn when the operator has Stop hooks configured (the ProDesk instance has `~/<workspace>/hooks/stop-hook.sh`; the proot instance has none, so it doesn't appear there).

Shape:

```json
{
  "type": "system",
  "subtype": "stop_hook_summary",
  "hookCount": 1,
  "hookInfos": [
    {"command": "~/<workspace>/hooks/stop-hook.sh", "durationMs": 40}
  ],
  "hookErrors": [],
  "preventedContinuation": false,
  "stopReason": "",
  "hasOutput": false,
  "level": "suggestion",
  "toolUseID": "...",
  "uuid": "...",
  "timestamp": "...",
  "cwd": "...",
  "sessionId": "...",
  "version": "2.1.143",
  "gitBranch": "HEAD",
  "slug": "..."
}
```

Two ways to handle in the tailer:
- enumerate it explicitly as `bus.event.hook_summary` (carries useful timing telemetry per turn)
- let it fall through to `bus.event.unknown` for now; revisit when hooks-on-Bus design is on the table

Either is defensible. The shape suggests it'd be a useful observability event if surfaced.

## Layout

```
cross-validation/
├── README.md                                    (this file)
├── probes/
│   ├── slash-stdin-probe.py                     # Spike 0.4, Python pty.fork() (bun-pty-equivalent for systems without bun)
│   └── lifecycle-deep-probe.py                  # Spike 0.5 with multi-turn variants
└── fixtures/
    ├── slash-stdin/
    │   └── results-s26.json                     # 3 plain-stdin runs + 3 PTY runs + --print sanity
    ├── lifecycle/                               # claude 2.1.126 (proot), 1-turn history
    │   ├── compact/                             # /compact no-op (insufficient history)
    │   ├── clear/                               # /clear rotation
    │   └── quit/                                # /quit envelope
    ├── lifecycle-multi-turn/                    # claude 2.1.126 (proot), 4-turn history
    │   ├── A-compact-multi-turn/                # /compact with compact_boundary
    │   ├── B-farewell-enumeration/              # 5x /quit (note: probe limitation captured 0 farewells in the multi-turn dir; the 4 variants are in lifecycle-deep summaries via repeated runs — see captured fixtures)
    │   └── C-clear-with-history/                # /clear with real prior turns
    └── lifecycle-multi-turn-prodesk/            # claude 2.1.143 (Ubuntu native)
        ├── A-compact-multi-turn/
        ├── B-farewell-enumeration/
        └── C-clear-with-history/
```

## Probes — Python (`pty.fork()`)

Terry's Sprint 0 probes use `bun-pty`. The Python ports here are functional equivalents using the standard-library `pty` module (kernel `/dev/ptmx` underneath, same primitive). They run on any POSIX system with Python 3.10+ — useful for cross-validating from a host that doesn't have Bun installed.

```bash
# Defaults are baked into the script; override via env for your layout
SPIKE_HOME=$HOME SPIKE_CLAUDE=$(which claude) python3 docs/spikes/cross-validation/probes/lifecycle-deep-probe.py
```

## Probe limitations honestly disclosed

- The probe sends `\r` to the PTY to commit input. In the no-prior-prompt case the bare `/quit` is sometimes queued as input text rather than recognized as a slash command (the REPL state appears to require a prior turn before `/`-commands are reliably parsed). All multi-turn fixtures got around this by sending a real prompt first. This looks like a probe-timing issue, not a `claude` behavior issue — bun-pty in Terry's spike runs presumably gets around it via different REPL-ready detection.
- Test B's farewell enumeration in `lifecycle-multi-turn/` captured 0 because of the same issue. The 4 distinct farewells (`Bye!`, `Goodbye!`, `See ya!`, `Catch you later!`) were captured across the broader run set on 2.1.126 — see individual session JSONLs.
- Capture used `--permission-mode plan` to avoid the bypass-permissions confirmation dialog; an `Enter` blast was sent at startup to dismiss the trust dialog.

## Implication for §5.2

If the four points are useful to fold in:

1. `stop_hook_summary` enumerated explicitly (or marked "fall-through to unknown — Hooks-on-Bus is a separate design")
2. `compactMetadata.preservedSegment.{head,anchor,tail}Uuid` documented so the tailer can correlate pre/post compact transcript ranges
3. The `attachment.type: "plan_mode"` content block observed when permission-mode is `plan` (not in 0.2 schema either) — same fall-through question as `stop_hook_summary`
4. `slug` field on every line (auto-generated from first prompt) — useful as a human-readable session label in dashboards

Happy to extend any of these into a follow-up patch on §5.2 if useful.

---

**Captured**: 2026-05-17
**By**: @Nibbler1250
**Cross-validates**: PR #109 (Spike findings)
