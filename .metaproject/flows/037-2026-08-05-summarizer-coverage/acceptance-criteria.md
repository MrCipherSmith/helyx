# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A fixture installs doubles for the LLM client and for long- and short-term memory, and restores the real modules afterwards from a snapshot of their values rather than from the live namespace.
- AC2: `trySummarize` is covered for: too few messages to bother, a model that answers with nothing, a summary the triage rejects, and one that is kept and written.
- AC3: `summarizeWork` is covered for the same decisions from its own entry point.
- AC4: `extractProjectKnowledge` is covered for: no project path, too few messages, an answer with no usable facts, and facts that are saved.
- AC5: The idle timer lifecycle is covered — a timer is set, a second touch replaces rather than duplicates it, and stopping clears it — with the clock replaced so no test waits.
- AC6: No production behaviour changes in this flow except a defect it finds, and any such change is named in the CHANGELOG as a defect.
- AC7: `memory/summarizer.ts` line coverage is measured before and after and both figures are recorded; the after figure is at or above 60%, or the shortfall is stated with what remains uncovered.
- AC8: Whole unit suite green and `tsc --noEmit` clean, with the module doubles restored so no later test file sees them.
- AC9: The change is recorded in `CHANGELOG.md` under Unreleased.
- AC10: Every reviewer round on the draft PR ends with no unresolved finding in the files this flow changes.
