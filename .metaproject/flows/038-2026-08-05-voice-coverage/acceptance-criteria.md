# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Text too short to speak and `TTS_PROVIDER=none` both return null without reaching any provider; proved by test.
- AC2: With Yandex answering, the result is its audio; proved by test asserting the format and that Yandex was the door used.
- AC3: With Yandex failing, the result is Piper's audio — the path production has taken on every message today; proved by test.
- AC4: With Yandex and Piper both failing, the chain reaches the third provider rather than returning null; proved by test.
- AC5: English text does not try Yandex; proved by test.
- AC6: A normalizer that answers in the wrong language is discarded in favour of the stripped original; proved by test asserting what reached the provider.
- AC7: For Russian, whatever Latin the normalizer leaves is cyrillized before it reaches the provider; proved by test asserting the text the provider received.
- AC8: The Piper stub writes the file at the path taken from the argv it was given, so the test proves audio is produced rather than that a binary was invoked.
- AC9: `utils/tts.ts` line coverage is measured before and after and both figures are recorded; the after figure is at or above 55%, or the shortfall is stated with what remains uncovered.
- AC10: Whole unit suite green and `tsc --noEmit` clean, with `Bun.spawn`, `fetch` and `CONFIG` restored so no later test file sees them changed.
- AC11: The change is recorded in `CHANGELOG.md` under Unreleased.
- AC12: Every reviewer round on the draft PR ends with no unresolved finding in the files this flow changes.
