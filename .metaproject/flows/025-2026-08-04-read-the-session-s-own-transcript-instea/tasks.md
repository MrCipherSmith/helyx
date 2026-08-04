# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context |
| T2 | implement | Implement per plan |
| T3 | test | Add/adjust tests and make them pass |
| T4 | review | Self-review and prepare draft PR |
| T5 | implement | transcript-locate: resolve by cwd match, tail by offset |
| T6 | implement | transcript-events: entry to display line, existing vocabulary |
| T7 | implement | transcript-monitor: poll loop, ring buffer, stop handle |
| T8 | implement | wire into StatusManager ahead of tmux, keep fallbacks |
| T9 | implement | raise ACTIVITY_LINES, leave the character budget alone |
| T10 | test | tests: fixtures with decoys, truncated write, oversized file, unknown entry |
| T11 | review | full gate: typecheck, lint, unit suite |

T1 is the analysis already folded into `context.md`. T2–T4 are the scaffolded
umbrella tasks; T5–T11 are the work they stand for.

## Notes on T6

The vocabulary is not a free choice. Four existing consumers read it:

- `channel/status.ts:accumulateTurnActivity` — `● ` lines, and
  `● (Read|Write|Edit|Create): <path>` for the file counter;
- `channel/status.ts:accumulateStats` — `● (Edit|Write): <path>` and
  `Added N lines, removed N lines`;
- `utils/status-format.ts:detectPhase` — the last `● ` line picks the emoji;
- `utils/status-format.ts:scrapeTokenInfo` — `↓ <n> tokens`.

A new dialect breaks all four silently.
