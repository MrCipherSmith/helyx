# The voice path fails its first provider on every message and nothing tests the fallback

Status: formalized
Source: package `docs/requirements/io-layer-coverage-2026-08-05` (C4, the `utils/tts.ts` half)

## Problem

Every reply over 300 characters is spoken, so `utils/tts.ts` runs on almost
every message the operator receives. 529 of its 560 instrumented lines are
uncovered — 5.54%.

And it has been failing in production all day. `tts: Yandex error` with a 401
appears on every synthesis in `logs/bot.log`: the configured key is rejected,
the chain falls through to Piper, and the operator hears a voice that came from
the second provider. The fallback is load-bearing and has never been tested.

The decisions in that file are not small ones. It detects the language of the
text, asks a model to normalize it for speech, checks whether that model
answered in the wrong language, forces the remaining Latin into Cyrillic
because the Russian voice has no Latin phonemes, and then walks a provider
chain whose order differs by language. Every one of those is a silent
mis-decision away from an operator hearing something wrong, and none of them is
covered.

## Expected Outcome

- `utils/tts.ts` at or above 55% of lines.
- The provider chain is tested as a chain: the first provider failing must
  produce sound from the second, which is what production has been doing all
  day.
- The language decisions are tested, including the guard that exists because a
  normalizer once answered in the wrong language.

## Out of Scope

- `bot/media.ts`, the other half of C4. It needs a grammY `Context` double and
  is a flow of its own rather than a second half squeezed into this one.
- Fixing the Yandex key. The chain working around it is the subject here; the
  key is the operator's.
