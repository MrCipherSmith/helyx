# Metrics and Validation: Adopting keryx Patterns into helyx

Version: 1.1.0

## Purpose

What each area is measured by, and what evidence closes it. A criterion that
cannot be observed is not listed here — it is a requirement in
[prd.md](prd.md) or an acceptance criterion in [specification.md](specification.md).

Two of the measurements below are **already taken**: the keryx-side probes in
§M1.1, which were run on 2026-08-12 and are what turned A1 from a plan into a
design with two specific traps in it.

---

## M1 — External boundary scan (A1)

### M1.1 Scanner behaviour — measured 2026-08-12, keryx v0.2.16

| Probe | Result | Consequence for the design |
|---|---|---|
| Clean input | `gate: PASS`, `action: allow`, 0 findings | Baseline works. |
| `AKIAIOSFODNN7EXAMPLE` | `gate: FAIL`, `action: block`, `secrets.aws-access-key`, `severity: critical`, `confidence: 0.98` | Detection works on the obvious case. |
| Exit code on block, bare | `0` | **The verdict cannot be read from the exit code.** |
| Exit code on block, `--json` | `0` | Same. |
| Exit code on block, `--runtime claude` | `0` | Same. `--runtime` does not change it. |
| `--target telegram` | accepted; finding records `"target": "unknown"` | An invalid target is silently downgraded. |
| `--target external` | finding records `"target": "external"` | This is the correct value. |
| `--target nonsense` | accepted, no error | Confirms the silent downgrade is general. |

These two — the zero exit code and the silent target downgrade — are each
sufficient on their own to produce a control that appears to work and does
nothing. Both have a dedicated acceptance test (A1.8, A1.9).

### M1.2 Latency

Measured **on the crossings only**. The operator path is not measured because it
is not touched; if a latency number ever appears for `reply`, something was built
that this package forbids.

| Metric | Target | How measured |
|---|---|---|
| Added latency per crossing, small payload | stated, then held | Wall-clock around the scan call, p50 and p95, per crossing. |
| Added latency, E4 diff payload (largest) | stated, then held | Same. A diff is the biggest thing that crosses. |
| Timeout rate | < 0.1% of crossings | Count of scans hitting `timeoutMs`. |

No numeric target is set in advance. Setting one before the first measurement
would be a guess wearing a threshold's clothes.

### M1.3 False positives — the gate on enabling

Run the scanner over a corpus of the payloads that actually cross, before merge.

| Metric | Threshold |
|---|---|
| Crossings blocked with nothing sensitive in them | Reported per category, with examples, before merge. |
| Categories responsible | Named. A single noisy rule is a recorded exception, not a reason to disable scanning. |

The corpus is **git diffs and reviewer reports** — the E4 payloads — plus a
sample of E3 prompts. Diffs are where token-shaped strings live in ordinary
content: `.env.example` fragments, test fixtures, documentation of a key format.
Reply history is explicitly *not* the corpus any more, because replies are no
longer scanned.

### M1.4 Coverage

| Evidence | Closes |
|---|---|
| A test that fails if any scan appears on `channel/tools.ts` or `mcp/tools.ts` reply | A1.1, **P-1.0** |
| A key-shaped string in a reply is still delivered, unchanged | A1.2, P-1.0 |
| A test that fails if a crossing exists without a scan | P-1.1 |
| The local Ollama URL and local `piper` invoke no scanner | A1.6, P-1.2 |
| A finding on E1 produces a piper-synthesised voice, not a missing one | A1.3, P-1.3 |
| A test that fails if the implementation branches on the exit code | A1.8, P-1.5 |
| A test asserting the finding's `target` reads back `external` | A1.9, P-1.8 |
| Renaming the `keryx` binary causes fallback or skip, and never a withheld reply | A1.7, P-1.4 |
| Status shows which remote services are active without reading `.env` | A1.10, R1.6 |

---

## M2 — Action-bound approval (A2)

### M2.1 The incident tests

The two recorded incidents in `CLAUDE.md` become executable:

| Test | Asserts |
|---|---|
| Grant for `container/all/brief`, presented for `sessions/all/brief` | Refused, and the refusal names both fingerprints. |
| Grant for `sessions/<path>/brief`, presented for `sessions/all/brief` | Refused. A one-project restart does not authorize a stack restart. |
| Grant presented twice | Second presentation refused. |
| Grant presented after `expiresAt` | Refused. |
| Restart requested with no approver reachable | Denied, not allowed, not held. |
| Two concurrent restarts | Second refused by the lease, with holder and age — unchanged behaviour, pinned. |
| `bun cli.ts bounce` during an in-flight Telegram restart | No longer races silently. |
| Watchdog restarts a wedged session of a project it holds a standing grant for | Proceeds unattended; recorded as an autonomous action. |
| Watchdog presented with `container`, `both`, or `all` | Refused each time. This is the test that keeps the single-use exemption from becoming a hole. |
| Standing grant used twice | Both uses succeed; the grant is not consumed. An operator grant used twice fails the second time. |

### M2.2 Approval fatigue

The metric that tells you the fingerprint is too narrow:

| Metric | Watch for |
|---|---|
| Approval prompts per restart actually performed | A ratio above 1 means the operator is being asked more than once for one intent. |
| Median time from prompt to answer | A collapsing time means the operator has stopped reading. That is the failure this area exists to prevent, and it would arrive disguised as success. |

### M2.3 Wording

| Evidence | Closes |
|---|---|
| The confirmation text names `half`, `scope` and `downtime` before the operator answers | A2.6, P-2.1 |
| The `statedTo` field records the sentence shown | Makes a disputed restart reconstructible from what was asked, not from what the code meant. |

---

## M3 — Compaction record (A3)

| Evidence | Closes |
|---|---|
| A fixture transcript containing a `compact_boundary` entry parses without error | A3.2 |
| A session that compacts produces one operator-visible line naming when and what | A3.1 |
| A transcript with no boundary entry behaves byte-identically to today | A3.3 |
| A test asserting the refusal on rewriting a recorded entry | A3.4, and keryx's `EvidenceDeletionError` property in helyx's own terms |

There is no useful rate or threshold here. Compaction either surfaces or it does
not.

---

## M4 — Engine connector (A4)

Documentation-only, so the validation is documentary:

| Evidence | Closes |
|---|---|
| `codex-session-engine-2026-08-09` uses `provider` and `connector` with the stated meanings, contradicting nothing it already says | A4.1 |
| Every engine attribute that package needs is expressible in the schema, `limitSignal: null` included | A4.2 |
| The credential rules read as helyx policy, not as a description of keryx | A4.3 |
| The Chat Completions finding appears with its boundary attached and is not phrased as a recommendation | A4.4 |

The last row is the one worth checking adversarially. It is the finding most
likely to be quoted later without its second half.

---

## M5 — Perimeter (A5)

| Evidence | Closes |
|---|---|
| Pin test: a message in a topic mapped to no project reaches no session and produces a refusal in that topic | A5.1, P-5.2 |
| Pin test: supergroup membership alone authorizes nothing | A5.2, P-5.1 |
| A reply for a project with no topic mapping fails visibly rather than landing in General | A5.3 |
| A grep-shaped test: no code path reads a secret value from a Telegram message body | A5.4, P-5.3 |
| A replayed callback is refused; an expired one is refused | A5.5, P-5.4 |
| Startup with `ALLOW_ALL_USERS` on emits a warning naming the consequence | A5.6, P-5.5 |

The two pin tests are the cheapest items in the package and protect the two
controls helyx already got right. A control that is correct and untested is one
refactor from being incorrect and unnoticed.

---

## Package-level validation

| # | Check | Method |
|---|---|---|
| V1 | Every "today" claim about helyx carries a `file:line` | Read the package; each is cited. |
| V2 | Every citation resolves in the current tree | Spot-check the cited lines. |
| V3 | keryx claims carry the commit they were read at | `af380a6a`, v0.2.16, stated in README and specification. |
| V4 | No area claims an implementation that does not exist | Evidence grades in [prd.md](prd.md); `spec`-graded areas say so in every document. |
| V5 | A5 distinguishes pins from work | Pins are marked in the acceptance criteria and in the plan. |
| V6 | Schemas are valid JSON and are referenced from the specification | Parse each; each is linked. |

## Known measurement gaps

Stated rather than left to be discovered:

- **No baseline for M1.2.** Crossing latency today is not instrumented, so the
  "added" latency is measured as before-and-after on the same build rather than
  against a historical number.
- **No corpus yet for M1.3.** Diffs and reviewer reports are reproducible from
  git and from `services/review-artifacts.ts`, but have never been assembled as
  a scanning corpus; doing so is part of A1, not a prerequisite that exists.
- **M2.2 cannot be measured before A2 ships.** Approval fatigue is a
  post-deployment metric. It is listed so that it is watched, not so that it
  gates the merge.
- **Media captions and file uploads are unmeasured.** They are not crossings in
  the E1–E5 sense — they go to Telegram, which is the operator channel — so they
  are out of scope by P-1.0 rather than deferred.
