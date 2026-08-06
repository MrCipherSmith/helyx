# Implementation Plan

Status: frozen

## Approach

Pin the environment the suite runs in rather than teach eight tests to cope
with two environments. `tests/preload.ts` already does exactly this for
`TELEGRAM_BOT_TOKEN` and `SUPERVISOR_CHAT_ID`, and says why in a comment that
applies word for word here: the constants are captured at import, so a test
file cannot set them, and leaving the real ones in place means the suite reads
whatever the developer happens to have. Provider credentials join them — fixed,
fake, and the same on every machine.

The Yandex demotion is a product decision, not a test fix, and lands in the
same change because it rewrites the chain the tests describe. Note that the
docstring above `synthesize` has claimed `Piper → Yandex → Groq` all along
while the code did the opposite; after this the two agree.

The dashboard test stops depending on a build artifact by writing the one file
it needs when it is missing, and removing only what it wrote.

The gemma-loop failure is the one this plan cannot name with certainty. The
first reading — an unawaited upload from the voice tests landing inside the
window where the gemma test owns the `fetch` stub — did not survive an attempt
to reproduce it: ten runs, four of them under the full CI condition, all clean.
What the CI log does prove is a different defect on the same path, and a real
one in production rather than in a test: `synthesizePiper` names its output
`/tmp/piper-tts-${Date.now()}.wav`, and the `finally` that deletes it runs
asynchronously, so two syntheses one millisecond apart delete each other's
audio. That is the `ENOENT` in the log, on a file the process had just written.
It is fixed; the gemma test is left to CI to judge rather than to a fix that
would be guesswork.

## Steps

1. `utils/tts.ts`: in the Russian `auto` chain, try Piper before Yandex. Update
   the two comments that describe the order.
2. `tests/preload.ts`: pin `YANDEX_API_KEY`, `YANDEX_FOLDER_ID`, `GROQ_API_KEY`
   to fake values and `OPENAI_API_KEY`, `OPENROUTER_API_KEY` to empty, with the
   reasoning stated.
3. `tests/unit/tts-chain.test.ts`: rewrite the chain tests around the new order
   — Piper first, Yandex on Piper's failure, Groq on both.
4. `tests/unit/dashboard-auth.test.ts`: create `dashboard/dist/index.html` when
   absent, clean up only in that case.
5. `utils/tts.ts`: give each Piper synthesis its own output path.
6. Verify: full suite with the provider keys blanked and `dashboard/dist` moved
   aside — the CI condition, reproduced locally, must be green.

## Risks

- Pinning a fake `GROQ_API_KEY` turns the normalizer on for every test that
  synthesizes. It is already stubbed at `fetch` in the tests that care; any test
  that did not expect it will surface in the full run, which step 6 covers.
- Demoting Yandex changes what the operator hears: Piper is a local model and
  its Russian is worse than Yandex's. This is the operator's own instruction,
  recorded here because the reason will not be obvious from the diff later.
