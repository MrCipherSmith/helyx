# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The Codex reviewer is invoked through the `exec` subcommand rather than the removed `--no-interactive` flag, proven by a test that captures the spawned argv and asserts `exec` is present and `--no-interactive` is absent.
- AC2: Codex failures are classified rather than collapsed: a usage error, an unsupported model, a rate limit, an auth failure, a non-zero exit and an empty stdout each produce a distinct, named error, and the real CLI output observed in this flow (`unexpected argument '--no-interactive' found`, `The 'gpt-4.5-mini' model is not supported when using Codex with a ChatGPT account`) is classified as usage and unsupported-model respectively — never as a limit.
- AC3: A provider review request carries an output budget large enough for a reasoning model, and a response that comes back empty with `finish_reason: "length"` is reported as truncation rather than as `empty response`, proven against a faked provider response reproducing the measured shape.
- AC4: The `Authorization`/`x-api-key` choice follows `providers.auth_scheme` and is decided by one shared helper used by both `fetchProviderModels` and the review call, with tests for both schemes.
- AC5: `runReviewers` builds the prompt itself, attaching the diff to the operator's request, so a caller passing only a sentence still results in the reviewer receiving code; proven by asserting the request body sent to the faked provider contains both the request text and diff content.
- AC6: The attached diff is bounded, and when it is cut the prompt says so in text the model can read, proven by a test over an oversized diff.
- AC7: Both world-facing functions accept their spawn and fetch as parameters defaulting to the real ones, so the tests above need no network and no Codex CLI; `blockedRequests()` from the network guard stays at zero for this suite.
- AC8: Full gate green — `bun run typecheck` clean, `bun run lint` 0 errors, `bun test tests/unit/` passes with the new tests included.
- AC9: The reviewers are run for real against PR #61 after the fix, and the outcome of each is reported honestly — a working review, or a named reason it did not run.
