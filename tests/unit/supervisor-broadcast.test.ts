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
import { isOurContainer, parseContainerLine, composeProjectFor } from "../../utils/supervisor-status.ts";
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
  const scope = { composeProject: "helyx", projects: ["carlson-bot", "api"] };
  const labelled = (composeProject: string, name: string) => ({ composeProject, name, status: "Up" });
  const unlabelled = (name: string) => ({ composeProject: "", name, status: "Up" });

  test("the compose label decides, and it decides exactly", () => {
    expect(isOurContainer(labelled("helyx", "helyx-bot-1"), scope)).toBe(true);
    expect(isOurContainer(labelled("carlson-bot", "carlson-bot-web-1"), scope)).toBe(true);
    expect(isOurContainer(labelled("something-else", "helyx-bot-1"), scope)).toBe(false);
  });

  test("a name prefix does not prove ownership", () => {
    // The reason the label is used at all: a project registered as `api` would
    // otherwise adopt an unrelated `api-worker-1`, and `docker ps -a` now lists
    // stopped foreign containers too.
    expect(isOurContainer(labelled("other-stack", "api-worker-1"), scope)).toBe(false);
    expect(isOurContainer(unlabelled("api-worker-1"), scope)).toBe(false);
    expect(isOurContainer(unlabelled("helyx-experiment"), scope)).toBe(false);
  });

  test("a container started outside compose is matched by its exact name", () => {
    expect(isOurContainer(unlabelled("helyx"), scope)).toBe(true);
    expect(isOurContainer(unlabelled("carlson-bot"), scope)).toBe(true);
    expect(isOurContainer(unlabelled("nginx"), scope)).toBe(false);
  });

  test("no owners means nothing is ours", () => {
    expect(isOurContainer(labelled("helyx", "helyx-bot-1"), { composeProject: "", projects: [] })).toBe(false);
    expect(isOurContainer(labelled("helyx", "x"), { composeProject: "  ", projects: ["", " "] })).toBe(false);
  });
});

describe("composeProjectFor", () => {
  test("compose derives its default from the directory, and so does this", () => {
    // Assuming the literal "helyx" excluded every installation living anywhere
    // else: the listing came back fine, nothing in it was recognised, and an
    // empty set of owned containers reads as a healthy one.
    expect(composeProjectFor("/home/altsay/bots/helyx")).toBe("helyx");
    expect(composeProjectFor("/home/someone/my-bot")).toBe("my-bot");
    expect(composeProjectFor("/srv/Helyx_Prod/")).toBe("helyx_prod");
  });

  test("characters compose drops are dropped", () => {
    expect(composeProjectFor("/srv/My Bot!")).toBe("mybot");
  });

  test("an explicit override wins", () => {
    expect(composeProjectFor("/home/x/helyx", "custom")).toBe("custom");
    expect(composeProjectFor("/home/x/helyx", "  ")).toBe("helyx");
  });
});

describe("parseContainerLine", () => {
  test("reads the label, the name and the status", () => {
    expect(parseContainerLine("helyx\thelyx-bot-1\tUp 3 hours (healthy)")).toEqual({
      composeProject: "helyx",
      name: "helyx-bot-1",
      status: "Up 3 hours (healthy)",
    });
  });

  test("an unlabelled container still parses", () => {
    // Started with `--name` rather than by compose. It has no project label,
    // and the only thing left to match on is the name itself.
    expect(parseContainerLine("\tnginx\tUp 3 weeks")).toEqual({
      composeProject: "",
      name: "nginx",
      status: "Up 3 weeks",
    });
  });

  test("a status containing a tab does not lose its tail", () => {
    expect(parseContainerLine("helyx\tbot\tUp\t3 hours")?.status).toBe("Up\t3 hours");
  });

  test("a line that is not a listing is not one", () => {
    // The command runs with `2>/dev/null || true`, so a daemon error can arrive
    // where a listing was expected.
    expect(parseContainerLine("Cannot connect to the Docker daemon")).toBeNull();
    expect(parseContainerLine("")).toBeNull();
    expect(parseContainerLine("helyx\tname\t")).toBeNull();
    expect(parseContainerLine("helyx\t\tUp 3 hours")).toBeNull();
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
      return { ok: true, output: "helyx\thelyx-bot-1\tUp 2 hours (healthy)" };
    });

    expect(seen.some((c) => c.includes("docker ps -a"))).toBe(true);
  });

  test("a crashed container is reported red", async () => {
    const { db, runShell } = world({ docker: "helyx\thelyx-bot-1\tExited (1) 3 minutes ago" });

    await sendStatusBroadcast(db.sql as never, runShell);

    expect(broadcastText()).toContain("🔴 helyx-bot-1");
    expect(broadcastText()).toContain("Exited");
  });

  test("a healthy container is reported green", async () => {
    const { db, runShell } = world({ docker: "helyx\thelyx-postgres-1\tUp 5 days (healthy)" });

    await sendStatusBroadcast(db.sql as never, runShell);

    expect(broadcastText()).toContain("🟢 helyx-postgres-1");
  });

  test("containers belonging to someone else are left out", async () => {
    const { db, runShell } = world({
      docker: [
        "helyx\thelyx-bot-1\tUp 2 hours (healthy)",
        "deprecated\tdeprecated-postgres\tExited (0) 5 days ago",
        "\tnginx\tUp 3 weeks",
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
      docker: "carlson-bot\tcarlson-bot-app-1\tExited (137) 1 minute ago",
      projects: ["carlson-bot"],
    });

    await sendStatusBroadcast(db.sql as never, runShell);

    expect(broadcastText()).toContain("🔴 carlson-bot-app-1");
  });

  test("a container status is escaped before it becomes markup", async () => {
    // Docker's status text is not ours, and the broadcast is sent with
    // parse_mode HTML. An unescaped angle bracket fails the send silently —
    // which is how the supervisor's other alerts were lost.
    const { db, runShell } = world({ docker: "helyx\thelyx-bot-1\tExited (1) <weird> ago" });

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

describe("silent when healthy, loud when not", () => {
  // The distinction the whole broadcast exists for. Editing in place is
  // deliberate — a five-minute heartbeat that notifies is a heartbeat the
  // operator mutes — and a problem must therefore *not* be an edit, or it
  // arrives with the same silence as good news.
  function world(docker: string, projects: string[] = []) {
    const db = new FakeSql();
    db.program(SELECT_PROJECTS, { rows: projects.map((name) => ({ name })) });
    db.program(SELECT_SESSIONS, { rows: [] });
    return { db, runShell: async () => ({ ok: true, output: docker }) };
  }

  const methodsUsed = () =>
    http.requests.map((r) => r.url.split("/").pop()).filter((m) => m !== undefined);

  test("a healthy update edits the existing message and sends nothing", async () => {
    const healthy = world("helyx\thelyx-bot-1\tUp 2 hours (healthy)");

    // A first run, whatever it does — the module remembers its status message
    // across calls, and across tests.
    await sendStatusBroadcast(healthy.db.sql as never, healthy.runShell);

    http.requests.length = 0;
    const second = world("helyx\thelyx-bot-1\tUp 2 hours (healthy)");
    await sendStatusBroadcast(second.db.sql as never, second.runShell);

    expect(methodsUsed()).toEqual([EDIT]);
  });

  test("a problem replaces the message rather than editing it", async () => {
    // Otherwise the red status arrives as a silent edit to a message the
    // operator has already read and scrolled past.
    const healthy = world("helyx\thelyx-bot-1\tUp 2 hours (healthy)");
    await sendStatusBroadcast(healthy.db.sql as never, healthy.runShell);

    http.requests.length = 0;
    const broken = world("helyx\thelyx-bot-1\tExited (1) 2 minutes ago");
    await sendStatusBroadcast(broken.db.sql as never, broken.runShell);

    const methods = methodsUsed();
    expect(methods).toContain("deleteMessage");
    expect(methods).toContain(SEND);
    expect(methods).not.toContain(EDIT);
  });

  test("an unreadable docker listing is loud too", async () => {
    const healthy = world("helyx\thelyx-bot-1\tUp 2 hours (healthy)");
    await sendStatusBroadcast(healthy.db.sql as never, healthy.runShell);

    http.requests.length = 0;
    const blind = world("");
    await sendStatusBroadcast(blind.db.sql as never, blind.runShell);

    expect(methodsUsed()).toContain(SEND);
    expect(methodsUsed()).not.toContain(EDIT);
  });

  test("a readable listing with nothing of ours in it is a problem, not health", async () => {
    // The failure the scope introduces: an installation whose containers do not
    // match reports a clean list of nothing, and nothing reads as fine.
    const healthy = world("helyx\thelyx-bot-1\tUp 2 hours (healthy)");
    await sendStatusBroadcast(healthy.db.sql as never, healthy.runShell);

    http.requests.length = 0;
    const foreign = world("other\tother-db-1\tUp 3 days");
    await sendStatusBroadcast(foreign.db.sql as never, foreign.runShell);

    const methods = methodsUsed();
    expect(methods).toContain(SEND);
    expect(methods).not.toContain(EDIT);
    const text = String((http.requests.find((r) => r.url.endsWith(SEND))?.body as { text?: string })?.text ?? "");
    expect(text).toContain("no containers matched");
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
