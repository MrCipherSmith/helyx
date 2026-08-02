# Implementation Plan

Status: agreed

## Approach

Three modules, split by what they decide rather than by where they came from.
A single `cli-helpers.ts` would be a drawer, not a module.

- **`utils/cli-flags.ts`** — `parseFlags(argv)` plus `flagValue(flags, key)`,
  which carries the "empty string counts as absent" rule that `cli.ts:190`
  applies today. Moving both keeps the pair's semantics in one place.
- **`utils/host-memory.ts`** — the three parsers (`parseCgroupV2Max`,
  `parseCgroupV1Limit`, `parseMemTotal`) and `presetsThatFit(presets, mem)`.
  `availableMemoryMb` stays in `cli.ts` as the thin function that reads the
  three files and calls the parsers, because reading them is the only part
  that is not pure.
- **`utils/stop-hook.ts`** — `classifyCheckout({ botDir, tmpDir, gitPathIsFile })`
  returning the same `string | null` reason `isEphemeralCheckout` returns, and
  `pruneStaleStopHooks(stop, hookSuffix, exists)`. The filesystem checks become
  parameters: the caller in `cli.ts` passes `existsSync`, the tests pass a
  predicate over a set. That is what makes the array surgery testable without
  writing to anyone's real `~/.claude/settings.json`.

Extraction is mechanical — bodies move unchanged except where a filesystem
call becomes a parameter. The behaviour to preserve is exactly today's,
including its quirks, and the tests state what those quirks are rather than
correcting them silently. Where a quirk looks like a defect it is recorded in
the journal, not fixed in this flow.

## Steps

1. `utils/cli-flags.ts` + tests; rewire `parseFlags`/`flag` in `cli.ts`.
2. `utils/host-memory.ts` + tests; rewire `availableMemoryMb` and the preset
   filter at `cli.ts:418`.
3. `utils/stop-hook.ts` + tests; rewire `isEphemeralCheckout` and
   `pruneStaleStopHooks`.
4. `bun run typecheck`, `bun run lint`, `bun test tests/unit/`,
   `keryx health run`.
5. Sanity-run the CLI itself: `helyx --help` and `helyx ps` must behave as
   before, since no test covers the top-level dispatch.

## Risks

- **`pruneStaleStopHooks` mutates its argument in place** and the caller
  depends on that. The extracted version must keep mutating rather than
  returning a copy, or the settings file is written unchanged and stale hooks
  survive. Tests assert the mutation, not just the count.
- **`parseFlags` has edge cases nobody has written down**: `--flag=` (empty),
  a value that itself starts with `--`, a bare `--`, a repeated flag. The
  tests pin current behaviour; any that looks wrong goes in the journal for a
  separate decision rather than being changed here.
- **`classifyCheckout` currently hardcodes a `/tmp/` prefix check** in
  addition to the resolved tmpdir. On a host where `TMPDIR` is elsewhere this
  is a second, independent rule. Preserved as-is and tested as-is.
- No test covers the top-level `switch`, so step 5 is the only thing standing
  between a bad rewire and a broken CLI. It is not optional.
