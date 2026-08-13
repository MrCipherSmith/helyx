# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

Source: `docs/requirements/keryx-adoption-2026-08-12/specification.md` §A1
Acceptance criteria (A1.1–A1.11), preserved 1:1.

## Criteria

- AC1: The operator channel is not scanned. A test asserts that `reply` on both `channel/tools.ts` and `mcp/tools.ts` invokes no scanner, and fails if one is ever added.
- AC2: A reply containing an AWS-key-shaped string is still delivered to Telegram, unchanged — the same test, from the other side.
- AC3: That same reply, when the configured voice is remote, is synthesised by local `piper` instead, and the substitution is recorded.
- AC4: A git diff containing a key-shaped string is not sent to a third-party reviewer model; the reviewer is skipped and the skip is reported.
- AC5: A reviewer report or auxiliary-model completion containing an injection pattern is not fed into a session unredacted.
- AC6: The local Ollama base URL (`utils/aux-llm-client.ts:31`) skips scanning entirely — a local call is not a crossing.
- AC7: Killing or renaming the `keryx` binary causes remote crossings to fall back or be skipped, and never causes a reply to be withheld.
- AC8: A test asserts the verdict is read from parsed `--json` output; a test fails if the implementation branches on the process exit code.
- AC9: A test asserts the finding's `target` reads back `external`.
- AC10: Whether remote TTS and remote transcription are active is visible from a status surface without reading `.env`.
- AC11: Added latency is measured on the crossings only; the operator path is unmeasured because it is untouched (M1).
