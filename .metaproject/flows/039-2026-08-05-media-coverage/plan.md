# Implementation Plan

Status: formalized

## Approach

`deliverMedia` is not exported; the flow exports it for the tests with the
comment saying so, as five files in this programme already do.

It reaches nine collaborators through module imports, so the doubles go in at
the module boundary and are installed and restored per test — the containment
that a top-level `mock.module` cost five other files earlier today.

Three cases, which are the three outcomes a file can have:

1. **A CLI session** — the message is queued with its attachment, and nothing
   is sent to a model.
2. **A standalone chat with an image** — the picture is inlined into the prompt
   and the answer is streamed back.
3. **A standalone chat with anything else, or an image that cannot be inlined**
   — the operator is told the file was received rather than left wondering.

### Rejected alternatives

- **Test through `handleMedia`.** It downloads first; the decision worth
  pinning is what happens after.
- **Assert on `isImage`/`fitsInline`.** Pure, extracted, already tested. What is
  untested is the code that acts on their answers.

## Steps

1. Export `deliverMedia` for the tests.
2. `tests/unit/media-delivery.test.ts` with the module doubles.
3. Re-measure and record before and after.
4. CHANGELOG entry.

## Risks

- **Nine doubles is a lot of fixture.** Each one is a single function, and the
  test asserts what reached it rather than how it was called.
- **Module replacement leaking.** Per test, restored after, and the whole suite
  is run to prove it.
