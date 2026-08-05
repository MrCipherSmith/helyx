# Implementation Plan

Status: formalized

## Approach

`synthesize` reaches the world through exactly two doors: `fetch` for Yandex,
Groq, Kokoro, OpenAI and the normalizer, and `Bun.spawn` for Piper. Both are
replaceable, so the whole decision surface can be driven without a network or a
voice model.

The Piper stub does what Piper does: it reads the output path out of the argv it
was given and writes a file there. Anything less would test that the code calls
a binary, rather than that it produces sound.

The cases follow the decisions, not the lines:

- **Nothing to say** — under ten characters, and `TTS_PROVIDER=none`.
- **The chain** — Yandex answers; Yandex fails and Piper answers, which is what
  production does on every message today; both fail and Groq answers.
- **Language** — Russian text takes the Russian order, English text does not try
  Yandex at all.
- **The guard** — a normalizer that answers in the wrong language is discarded
  in favour of the stripped original, which is why the guard was written.
- **Cyrillization** — what the provider actually receives, because the Russian
  voice has no Latin phonemes and a Latin word left in reaches the operator as
  silence or noise.

`CONFIG.TTS_PROVIDER` is read per call, so a test can set it and put it back.

### Rejected alternatives

- **Let Piper really run.** The binary is present, so the test would pass here
  and take seconds, and fail on any machine without it — while proving nothing
  about the chain.
- **Test each provider function directly.** They are three-line fetch wrappers;
  the value is in the order they are tried and what is handed to them.

## Steps

1. `tests/unit/tts-chain.test.ts` with both doors stubbed.
2. Re-measure and record before and after.
3. CHANGELOG entry.

## Risks

- **Stubbing `Bun.spawn` globally.** Restored in `afterEach`; the file is the
  only one that touches it.
- **`CONFIG` is shared.** The provider field is saved and restored per test.
- **Tests pin current behaviour, including the parts that are odd.** Where a
  case looks wrong it is named in the test rather than asserted silently.
