/**
 * `runReviewers` end to end, against a real database and a fake network.
 *
 * The one thing worth proving here is the one nobody proved before: that a
 * caller who passes a sentence results in a reviewer that receives code.
 * `scripts/review.ts` passes a sentence, CLAUDE.md said the model "reads the
 * git diff itself from the prompt", and no code put a diff in the prompt — so
 * every provider review was made blind until a model said out loud that it had
 * been shown nothing.
 *
 * Skipped rather than failed when no database is reachable, the same way the
 * rest of the database-backed suite behaves.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { runReviewers, setReviewers } from "../../services/reviewer-service.ts";
import { providerService } from "../../services/provider-service.ts";
import { sql } from "../../memory/db.ts";
import { installFakeFetch, type FakeFetch } from "../fixtures/fake-fetch.ts";
import { installPassingScanner } from "../fixtures/fake-scanner.ts";

const TEST_DATABASE_ENV = "HELYX_TEST_DATABASE";
const hasDatabase = Boolean(process.env[TEST_DATABASE_ENV]);

describe.skipIf(!hasDatabase)("runReviewers", () => {
  let http: FakeFetch;
  let restore: () => void;
  let restoreScanner: () => void;
  let providerId: number;

  beforeEach(async () => {
    ({ http, restore } = installFakeFetch());
    // runReviewers now scans the diff on the way out (E4). These tests are about
    // the diff reaching the reviewer, not the boundary, so the scanner is pinned
    // to a clean pass — otherwise the result would depend on whether keryx is
    // installed on the machine running the suite (it is not, on CI).
    ({ restore: restoreScanner } = installPassingScanner());
    await sql`DELETE FROM providers WHERE name = 'ReviewFixture'`;
    const created = await providerService.create({
      name: "ReviewFixture",
      baseUrl: "https://provider.test/v1",
      authToken: "fixture-token",
      authScheme: "bearer",
    });
    providerId = created.id;
    await setReviewers([
      { id: `provider:${providerId}`, kind: "provider", providerId, model: "some-model", enabled: true },
    ]);
  });

  afterEach(async () => {
    restore();
    restoreScanner();
    await sql`DELETE FROM providers WHERE name = 'ReviewFixture'`.catch(() => {});
  });

  test("the reviewer receives the request and the code, from a caller that sent only a sentence", async () => {
    http.program("/chat/completions", { json: { choices: [{ message: { content: "line 3 leaks a handle" }, finish_reason: "stop" }] } });

    const result = await runReviewers(
      "Review PR #61.",
      async () => "--- a/utils/x.ts\n+++ b/utils/x.ts\n+const handle = open(path);",
    );

    expect(result.mode).toBe("external");
    expect(result.reports[0]?.content).toBe("line 3 leaks a handle");

    const sent = JSON.stringify(http.last("/chat/completions")!.body);
    expect(sent).toContain("Review PR #61.");
    // The assertion this whole flow exists for.
    expect(sent).toContain("const handle = open(path);");
  });

  test("a working tree with no diff tells the reviewer so instead of asking it to guess", async () => {
    http.program("/chat/completions", { json: { choices: [{ message: { content: "nothing to review" } }] } });

    await runReviewers("Review the branch.", async () => "");

    expect(JSON.stringify(http.last("/chat/completions")!.body)).toContain("No diff");
  });

  test("no enabled reviewers means self, and nothing is sent", async () => {
    await setReviewers([]);
    const result = await runReviewers("Review.", async () => "+x");

    expect(result.mode).toBe("self");
    expect(result.reports).toEqual([]);
    expect(http.count("/chat/completions")).toBe(0);
  });

  test("the diff is read once, however many reviewers there are", async () => {
    await setReviewers([
      { id: `provider:${providerId}`, kind: "provider", providerId, model: "a", enabled: true },
      { id: `provider:${providerId}b`, kind: "provider", providerId, model: "b", enabled: true },
    ]);
    http.program("/chat/completions", { json: { choices: [{ message: { content: "ok" } }] } });

    let reads = 0;
    await runReviewers("Review.", async () => { reads++; return "+x"; });

    expect(reads).toBe(1);
    expect(http.count("/chat/completions")).toBe(2);
  });
});
