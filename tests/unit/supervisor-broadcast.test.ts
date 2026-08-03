/**
 * Loop 4 — the five-minute status broadcast, and what the supervisor is
 * answerable for.
 *
 * The container question had been open since the loop was written, and
 * answering it is what unblocks listing stopped containers at all. `docker ps`
 * shows only what is running, so a container that crashed does not appear as
 * broken — it vanishes, and a vanished container is indistinguishable from one
 * that was never there. That is how the red state stayed unreachable for weeks
 * while a crash loop reported green.
 *
 * `docker ps -a` shows it, at the price of also showing everything else on the
 * host. So the scope is decided: helyx's own stack, and the projects running
 * under it.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { sendStatusBroadcast, cleanVoiceStatuses, updateProcessHealth } from "../../scripts/supervisor.ts";
import { isOurContainer, parseContainerLine } from "../../utils/supervisor-status.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";
import { installFakeFetch, type FakeFetch } from "../fixtures/fake-fetch.ts";
import { uniqueName } from "../fixtures/unique.ts";

const SELECT_PROJECTS = "SELECT name FROM projects";
const SELECT_SESSIONS = "FROM sessions s";
const SEND = "sendMessage";
const EDIT = "editMessageText";

let http: FakeFetch;
let restore: () => void;

beforeEach(() => {
  ({ http, restore } = installFakeFetch());
  http.program("api.telegram.org", { json: { ok: true, result: { message_id: 4000 } } });
});

afterEach(() => restore());

describe("isOurContainer", () => {
  const scope = { composeProject: "helyx", projects: ["carlson-bot", "vantage"] };

  test("helyx's own stack", () => {
    expect(isOurContainer("helyx-bot-1", scope)).toBe(true);
    expect(isOurContainer("helyx-postgres-1", scope)).toBe(true);
    expect(isOurContainer("helyx", scope)).toBe(true);
  });

  test("a project's containers", () => {
    expect(isOurContainer("carlson-bot-web-1", scope)).toBe(true);
    expect(isOurContainer("vantage-api-1", scope)).toBe(true);
  });

  test("someone else's container is not ours to report", () => {
    // Reporting it would train the operator to ignore the alert, which costs
    // more than the container nobody was watching.
    expect(isOurContainer("nginx", scope)).toBe(false);
    expect(isOurContainer("deprecated-postgres", scope)).toBe(false);
    expect(isOurContainer("some-other-stack-db-1", scope)).toBe(false);
  });

  test("a name that merely contains ours is not adopted", () => {
    // Matched on the compose naming convention rather than on a substring:
    // `my-helyx-experiment` belongs to whoever named it that.
    expect(isOurContainer("my-helyx-experiment", scope)).toBe(false);
    expect(isOurContainer("not-vantage-api", scope)).toBe(false);
    expect(isOurContainer("helyxor-1", scope)).toBe(false);
  });

  test("empty names and empty owners decide nothing", () => {
    expect(isOurContainer("", scope)).toBe(false);
    expect(isOurContainer("anything", { composeProject: "", projects: [] })).toBe(false);
    expect(isOurContainer("anything", { composeProject: "helyx", projects: ["", "  "] })).toBe(false);
  });
});

describe("parseContainerLine", () => {
  test("reads a name and a status", () => {
    expect(parseContainerLine("helyx-bot-1\tUp 3 hours (healthy)")).toEqual({
      name: "helyx-bot-1",
      status: "Up 3 hours (healthy)",
    });
  });

  test("a line that is not a listing is not one", () => {
    // The command runs with `2>/dev/null || true`, so an error message can
    // arrive where a listing was expected.
    expect(parseContainerLine("Cannot connect to the Docker daemon")).toBeNull();
    expect(parseContainerLine("")).toBeNull();
    expect(parseContainerLine("name\t")).toBeNull();
    expect(parseContainerLine("\tUp 3 hours")).toBeNull();
  });
});

describe("the broadcast", () => {
  function world(options: { docker?: string; projects?: string[] } = {}) {
    const db = new FakeSql();
    db.program(SELECT_PROJECTS, { rows: (options.projects ?? []).map((name) => ({ name })) });
    db.program(SELECT_SESSIONS, { rows: [] });
    const runShell = async (cmd: string) => ({
      ok: true,
      output: cmd.includes("docker ps") ? (options.docker ?? "") : "",
    });
    return { db, runShell };
  }

  /**
   * The status text, whether it was sent or edited.
   *
   * The loop keeps one status message and edits it in place while everything is
   * healthy — silently, so a five-minute heartbeat does not notify — and only
   * sends a fresh one when there is a problem. Looking only at sends would miss
   * every healthy broadcast after the first.
   */
  function broadcastText(): string {
    const last = [...http.requests].reverse().find((r) => r.url.includes(SEND) || r.url.includes(EDIT));
    return String((last?.body as { text?: string })?.text ?? "");
  }

  test("it asks for stopped containers too", async () => {
    // The whole point. Without `-a` a crashed container is simply absent, and
    // absence reads as health.
    const seen: string[] = [];
    const { db } = world();
    await sendStatusBroadcast(db.sql as never, async (cmd) => {
      seen.push(cmd);
      return { ok: true, output: "helyx-bot-1\tUp 2 hours (healthy)" };
    });

    expect(seen.some((c) => c.includes("docker ps -a"))).toBe(true);
  });

  test("a crashed container is reported red", async () => {
    const { db, runShell } = world({ docker: "helyx-bot-1\tExited (1) 3 minutes ago" });

    await sendStatusBroadcast(db.sql as never, runShell);

    expect(broadcastText()).toContain("🔴 helyx-bot-1");
    expect(broadcastText()).toContain("Exited");
  });

  test("a healthy container is reported green", async () => {
    const { db, runShell } = world({ docker: "helyx-postgres-1\tUp 5 days (healthy)" });

    await sendStatusBroadcast(db.sql as never, runShell);

    expect(broadcastText()).toContain("🟢 helyx-postgres-1");
  });

  test("containers belonging to someone else are left out", async () => {
    const { db, runShell } = world({
      docker: [
        "helyx-bot-1\tUp 2 hours (healthy)",
        "deprecated-postgres\tExited (0) 5 days ago",
        "nginx\tUp 3 weeks",
      ].join("\n"),
      projects: [],
    });

    await sendStatusBroadcast(db.sql as never, runShell);

    const text = broadcastText();
    expect(text).toContain("helyx-bot-1");
    expect(text).not.toContain("deprecated-postgres");
    expect(text).not.toContain("nginx");
  });

  test("a project's own container is included", async () => {
    const { db, runShell } = world({
      docker: "carlson-bot-app-1\tExited (137) 1 minute ago",
      projects: ["carlson-bot"],
    });

    await sendStatusBroadcast(db.sql as never, runShell);

    expect(broadcastText()).toContain("🔴 carlson-bot-app-1");
  });

  test("a container status is escaped before it becomes markup", async () => {
    // Docker's status text is not ours, and the broadcast is sent with
    // parse_mode HTML. An unescaped angle bracket fails the send silently —
    // which is how the supervisor's other alerts were lost.
    const { db, runShell } = world({ docker: "helyx-bot-1\tExited (1) <weird> ago" });

    await sendStatusBroadcast(db.sql as never, runShell);

    expect(broadcastText()).toContain("&lt;weird&gt;");
    expect(broadcastText()).not.toContain("<weird>");
  });

  test("an unusable docker listing is not read as an empty host", async () => {
    // `2>/dev/null || true` turns a dead daemon into a clean-looking nothing,
    // and nothing is indistinguishable from everything being fine.
    const { db, runShell } = world({ docker: "" });

    await sendStatusBroadcast(db.sql as never, runShell);

    expect(broadcastText()).toMatch(/docker|Docker|🔴|⚠️/);
  });
});

describe("the small loops", () => {
  test("stale voice statuses are cleared", async () => {
    const db = new FakeSql();

    await cleanVoiceStatuses(db.sql as never);

    expect(db.queries.length).toBeGreaterThan(0);
  });

  test("process health is recorded under a name", async () => {
    const db = new FakeSql();

    await updateProcessHealth(db.sql as never);

    const writes = db.matching("process_health");
    expect(writes.length).toBeGreaterThan(0);
  });

  test("a failing database does not take the loop down with it", async () => {
    // Every supervisor loop swallows its own errors on purpose: a supervisor
    // that dies on a database hiccup stops supervising.
    const db = new FakeSql();
    db.program("", { error: new Error("connection reset") });

    await expect(cleanVoiceStatuses(db.sql as never)).resolves.toBeUndefined();
    await expect(updateProcessHealth(db.sql as never)).resolves.toBeUndefined();
  });
});

describe("names are unique per test", () => {
  test("the helper does not repeat across a re-run", () => {
    // The supervisor's dedup maps are module state; this is the same guard the
    // other supervisor suites use.
    expect(uniqueName("x")).not.toBe(uniqueName("x"));
  });
});
