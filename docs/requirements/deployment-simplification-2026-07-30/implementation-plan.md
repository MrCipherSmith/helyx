# Implementation Plan: Deployment Simplification

Version: 1.1.0

## Ordering Rationale

The order below is driven by dependency, not by value. Task 2 must precede
Task 5 because CI cannot publish a dashboard-off variant until the build
argument exists. Task 1 must precede Tasks 3 and 4 because presets and flags are
both expressed in terms of profiles.

```text
T2 (build flag) ──┬──> T5 (publish image)
                  │
T1 (profiles) ────┼──> T3 (model presets)
                  └──> T4 (unattended mode)

T6 (image layering) — independent, any time
```

T1, T2 and T6 are mutually independent and may run in parallel.

**Value order, revised 2026-07-30 after measurement: T2, T6, T1, T3, T4, T5.**
This no longer coincides with the dependency order, as it did when this plan was
written.

T2 moved to the top for a reason the original plan did not have: it is the only
task that removes the build's memory wall (256 MB versus a failure at 512 MB).
T6 is new. T5 moved down — it was justified as *enabling* small-host deployment,
and measurement showed it does not, T2 does. Rationale in PRD §7.

---

## T1 — Deployment profiles in the wizard

**Goal.** Replace the flat prompt sequence with a profile choice that sets every
downstream default, then ask only what the profile needs.

**Files.** `cli.ts` (`setup()` at line 123 and the prompt block through ~line
300), `config.ts` (`HELYX_PROFILE` in `EnvSchema`).

**Work.**

1. Add a profile constant table encoding the three bundles from
   specification §4.
2. Make the profile the first prompt, before the existing deployment-type
   question.
3. Gate each subsequent prompt on the profile: `minimal` skips the Ollama
   block, the Piper voice selector, and the dashboard question (it is `false` by
   definition).
4. Write `HELYX_PROFILE` to `.env` alongside the resolved values.

**Acceptance.** A6 — `minimal` asks no more than four questions.

**Notes.** Profiles choose defaults only. Every variable stays hand-writable, or
risk K3 materialises the first time someone needs a setting the profile hid.

**Effort.** Moderate. Mostly restructuring existing prompt code; no new
subsystems.

---

## T2 — Dashboard feature flag

**Goal.** Dashboard off by default, gated at build and runtime.

**Files.** `Dockerfile` (stages at lines 5–16, `COPY --from=` at 34 and 37),
`config.ts` (`ENABLE_DASHBOARD`), `mcp/server.ts` (line 517),
`mcp/dashboard-api.ts` (dist paths, lines 17–18), `cli.ts` (wizard question).

**Work.**

1. Add the `WITH_DASHBOARD` build argument; make both build stages and both
   `COPY --from=` lines conditional.
2. Add `ENABLE_DASHBOARD` to `EnvSchema` with the absent-vs-false distinction
   from specification §3.1.
3. Guard `handleDashboardRequest` at `mcp/server.ts:517`. The guard sits around
   that call only — the `/mcp` route below it must not move or change.
4. Make `mcp/dashboard-api.ts` tolerate missing dist directories, so a
   dashboard-off image does not throw at import time.
5. Add the wizard question, default *no*, skipped entirely in `minimal`.

**Acceptance.** A1, A2, A3, A4, A5, A16.

**Notes — revised 2026-07-30 after measurement.** This task's rationale was
originally "the build argument shrinks the image". That is measurably false: a
dashboard-free build is 3.13 GB against 3.14 GB, because the compiled dashboard
is 1.02 MB (specification §2.2).

The build argument still matters, for a different and better reason. The
dashboard webapp build is the step that runs out of memory under constraint: the
full build fails at 512 MB inside `bun run build`, while the same build with
those stages removed succeeds at 256 MB. **This task is what makes a small host
viable**, and on that basis it is now the highest-value task in the package.

A runtime flag alone still does not satisfy it — the runtime flag stops route
registration, but only the build argument removes the failing step.

Risk K2 remains the one to watch: verify the MCP endpoint independently, because
dashboard and MCP share both the port and the request path.

**Effort.** Moderate. Small diffs in several files; the risk is in the shared
request path, not in volume.

---

## T3 — Lightweight model presets with memory precheck

**Depends on.** T1.

**Goal.** Stop offering a 9.6 GB model to a host that cannot serve it.

**Files.** `cli.ts` (the Ollama block, ~lines 175–205), `config.ts`
(`OLLAMA_CHAT_MODEL`, `SUMMARIZE_MODEL`, `EMBEDDING_MODEL` defaults).

**Work.**

1. Add the preset table from specification §5 — `tiny` is `qwen3:1.7b`, `small`
   is `qwen3:4b`.
2. **Disable Qwen3 reasoning mode** for both chat and summarization, via
   `/no_think` or the equivalent Ollama parameter, and verify a stored summary
   contains no `<think>` block (specification §5.2). Skipping this does not fail
   loudly — it quietly writes reasoning traces into saved summaries.
3. Read available memory — cgroup limit when present, host total otherwise.
4. Filter the offered presets against it; when no chat preset fits, say so and
   fall back to the API path.
5. Keep `nomic-embed-text` as the embedding default in `local`; leave embeddings
   unset in `minimal`, which disables semantic memory search.

**Acceptance.** A7, plus a clean-summary check for step 2.

**Notes.** The precheck warns rather than hard-blocks when memory cannot be
determined (risk K5). Preset *names* are the contract; the model each maps to is
a maintenance decision and will drift as models are released.

**Effort.** Small. One self-contained block plus a memory read.

---

## T4 — Non-interactive install

**Depends on.** T1.

**Goal.** Provisioning from cloud-init, CI, or any script with no terminal.

**Files.** `cli.ts` (argv parsing, the `ask`/`askChoice`/`askMultiCheck` helpers
at lines 37/44/58, and the `setup` case in the dispatch switch), `install.sh`
(line 134).

**Work.**

1. Parse the flag set from specification §6.1 in the `setup` entry point.
2. Teach the three helpers to resolve from parsed flags instead of stdin when
   unattended. This is the whole mechanism — every prompt already routes through
   them, so no prompt needs individual handling.
3. Fail by name on a missing required value; never fall back to prompting.
4. In `install.sh`, forward flags and bypass `< /dev/tty` when any are present.

**Acceptance.** A8, A9.

**Effort.** Small to moderate. The helper indirection is what keeps this
contained.

---

## T5 — Publish prebuilt image

**Depends on.** T2.

**Goal.** Remove local building, and with it the ~2 GB build-memory floor that
currently dictates the minimum server size.

**Files.** `.github/workflows/build.yml` (or a new publish workflow),
`install.sh`, `docker-compose.yml` (`build: .` at line 3).

**Work.**

1. Extend CI to push two variants from one workflow, using the built-in
   `GITHUB_TOKEN` with `packages: write`:
   - `ghcr.io/mrciphersmith/helyx:<version>` — dashboard-off, the default;
   - `ghcr.io/mrciphersmith/helyx:<version>-dashboard` — dashboard-on.

   `latest` may be published *in addition to* the version tag, never instead of
   it (risk K4).
2. **Flip the GHCR package to public after the first push.** Package visibility
   does not inherit from repository visibility — a new package is private even
   under a public repo, and every external `install.sh` run fails at pull with
   an unhelpful error until this one-time setting is changed.
3. **Make the Piper runtime deliberate and drop the voices** (specification
   §5A). The runtime is already in the image via `COPY . .` — replace that
   accident with an explicit `COPY` of `piper/piper/`, add `piper/voices` to
   `.dockerignore` (−181 MB from every image), and narrow the bind mount from
   `./piper` to `./piper/voices` so it stops shadowing the runtime.
4. Point `install.sh` at the published image, with `--build-local` to opt out.
5. Allow `docker-compose.yml` to take a published image instead of `build: .`.

**Acceptance.** A10, A11, A12, A13, A14, A15.

**Notes — revised 2026-07-30 after measurement.** This task was originally
justified as removing the ~2 GB build-memory floor that dictated the minimum
server size. That floor is not 2 GB, and once T2 lands it is 256 MB
(specification §2.1) — so publishing no longer *enables* deployment on a small
host, it only makes it faster and toolchain-free. Real value, lower priority
than when this plan was written.

**Notes.** `.github/workflows/build.yml` builds the image today but never
pushes it, so registry authentication, tagging policy, and multi-variant build
are all new. This is the task with the most unfamiliar surface even though its
diff is not the largest.

**Effort.** Moderate. CI work, plus a decision on registry and tagging.

---

## T6 — Fix image layering

**Added 2026-07-30**, from the layer breakdown taken while measuring build
memory. No task in the original package addressed image size at the layer level,
because the package assumed the dashboard was responsible. It is not
(specification §2.2).

**Goal.** Cut the image roughly in half by fixing how layers are produced, not
by removing features.

**Files.** `Dockerfile`, `.dockerignore`.

**Work.**

1. **Eliminate the 905 MB `chown -R bun /app` layer.** It is a third of the
   image, produced by one line: `chown -R` rewrites every file it touches, so
   the layer is a full duplicate of everything copied above it. Use
   `COPY --chown=bun` on the copies instead, or set ownership before the bulk
   copy rather than after.
2. **Exclude `piper/voices` from the build context** — 181 MB, shared with T5
   step 3. Voices belong on the host, not in the image.
3. Re-examine the 414 MB `COPY . .` against `.dockerignore`: `logs/` (15 MB) and
   `graphify-out/` (4 MB) are in the context today and have no reason to ship.
4. Measure after each change. The point of this task is a number, so an
   unmeasured "improvement" does not count as done.

**Acceptance.** S8 — image materially smaller than the 3.13 GB baseline. Item 1
alone should account for most of it.

**Notes.** Independent of every other task; can run at any time. Nothing here
changes runtime behaviour, which makes it unusually cheap for its effect —
though `--chown` on a large copy has its own cost, so item 1 must be measured
rather than assumed.

**Effort.** Small. A handful of Dockerfile lines, plus a build to verify each.

---

## Verification Sequence

Run after all six tasks, on a clean 2 GB host:

0. Build the dashboard-off image under a 256 MB / 2 CPU builder; it must
   complete with no OOM kill (A16). This is the claim T2 rests on — verify it
   against the real build argument, not the simulated Dockerfile used to
   establish it in §2.1.
1. `install.sh` with no flags → interactive, `minimal`, no local build (A10, A6).
2. Confirm dashboard routes 404 and `/mcp` connects (A1, A2).
3. Re-run unattended with stdin closed (A8), then with a required flag removed
   (A9).
4. Start with a pre-existing `.env` lacking `ENABLE_DASHBOARD`; dashboard must
   still come up (A3).
5. Build and run the dashboard-on variant; confirm no regression (A5).
6. Leave the minimal deployment for 24 h under normal Telegram traffic (A11).

Step 4 is the one most easily forgotten and the one that breaks existing users.

## Decisions

| # | Question | Decision | Date |
|---|----------|----------|------|
| Q1 | Which registry — GHCR or Docker Hub? | **GHCR.** Auth uses the built-in `GITHUB_TOKEN`, so no separate account or stored PAT. Docker Hub's anonymous pull limit would hit exactly the first-time self-hoster this package exists to serve. Docker Hub's one advantage — a shorter, more recognisable name — does not apply, because the image reference lives inside `install.sh` and no user ever types it. | 2026-07-30 |
| Q2 | Which concrete models back `tiny` and `small`? | **`qwen3:1.7b` and `qwen3:4b`.** Selected on multilingual competence, because the local model's harder job is summarizing Russian conversation history, not chat. Qwen3-4B also beats Gemma3-4B on every axis that matters here — smaller, double the context, no unused vision tower. Full rationale and the `<think>`-suppression caveat in specification §5.1–5.2. | 2026-07-30 |
| Q3 | Should `local` default the dashboard on, since its host is larger? | **No — off everywhere except `full`.** Host size does not decide it: after T5 nobody builds locally, and the dashboard's runtime cost is negligible. Two other things decide it. Orthogonality — a profile answers where inference happens, not how much web UI you want. Exposure — `webhook` transport publishes the shared HTTP server through a tunnel, which makes dashboard routes publicly reachable behind only their own auth. `local` still *asks* (default no); `minimal` does not ask. See specification §4.4. | 2026-07-30 |
| Q4 | Does the published image ship Piper voices, or download them at setup? | **Split them: runtime baked, voices downloaded.** Decision unchanged, premise corrected. Both runtime *and* voices are already in the image via `COPY . .` (233 MB) — the earlier finding that nothing was there rested on `which piper`, which only proves the binary is not on `PATH`. So the work is to make the runtime an explicit `COPY`, exclude `piper/voices` from the context (−181 MB), and narrow the bind mount so it stops shadowing the runtime. A separate `-piper` variant was rejected: two variants would become four. See specification §5A. | 2026-07-30 |

## Open Questions

None. All four questions raised at package creation are decided.

Answering Q4 surfaced a defect rather than a new question — PRD P5, Piper
shipping unintentionally with every voice — which is folded into T5 and T6 as
work rather than left open.

Profiling the build (specification §2.1–2.2) likewise produced corrections, not
questions: it overturned the ~2 GB assumption, showed the dashboard costs memory
rather than image size, and exposed the 905 MB `chown -R` layer that became T6.
All are recorded in place; nothing was left unresolved.
