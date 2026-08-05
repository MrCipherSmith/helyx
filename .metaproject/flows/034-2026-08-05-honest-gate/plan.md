# Implementation Plan

Status: formalized

## Approach

The defect is sequencing, so the fix is a sequence with a name.

```json
"health": "bun run test:coverage && keryx test run && keryx health run"
```

Coverage first because the gate imports it; a project-scope test run second
because health ignores a changed-scope report; the gate last. Anyone — a person
or an agent — who wants to know where the project stands runs one command
instead of remembering three and their order.

`scripts/coverage-summary.ts` is the bridge the whole reading rests on and has
no test. It gets one: lcov in, Istanbul-shaped summary out, totals summed rather
than averaged — the arithmetic that would otherwise be believed because the
number looks plausible.

The package's measurement table is replaced with the exact lcov figures and
labelled as such. An estimate presented as a measurement is the same class of
defect as everything else in this programme.

The memory note is superseded through `keryx memory supersede`, never by hand.

### Rejected alternatives

- **Make the post-commit hook run the full suite.** It would make every commit
  slow to fix a report nobody reads between commits.
- **Have health run the tests itself.** It offers `mode: auto` and already does;
  the problem is which report is newest, not who ran it.
- **Leave the estimates and add a footnote.** The numbers are used to order the
  remaining seven flows; wrong numbers order them wrongly.

## Steps

1. `health` script in `package.json`.
2. A test for `scripts/coverage-summary.ts`.
3. Exact figures into `docs/requirements/io-layer-coverage-2026-08-05`.
4. Supersede the memory note.
5. CHANGELOG entry.

## Risks

- **The honest number is worse than the published one** — 36.25% against a
  claimed 47.90%. That is the point of measuring; the gap to the floor is larger
  than block C assumed and the plan says so rather than the plan looking better.
- **`bun run health` takes about a minute.** It runs the suite twice, once for
  coverage and once for the report. Stated rather than hidden; a single run that
  produced both would need Bun to emit an Istanbul summary, which it does not.
