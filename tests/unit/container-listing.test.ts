/**
 * One answer to "which containers exist".
 *
 * The supervisor asked Docker twice. The status broadcast ran `docker ps -a`,
 * because a crashed container does not appear as broken without it — it
 * vanishes, and a vanished container is indistinguishable from one that was
 * never there. The health analyst's snapshot, thirty lines away, still ran
 * `docker ps`: it was asked to judge system health from a list that
 * structurally could not contain a dead container, and had no ownership filter
 * either, so what it did contain might belong to someone else.
 *
 * These drive the real listing and the real snapshot with a fake shell.
 */

import { describe, test, expect } from "bun:test";
import { FakeSql } from "../fixtures/fake-sql.ts";
import { listOwnedContainers, DOCKER_LIST_COMMAND, type RunShell } from "../../utils/supervisor-status.ts";
import { collectSystemSnapshot } from "../../scripts/supervisor.ts";

/** The compose project this supervisor answers for, as it derives it. */
const OURS = "helyx";

const row = (project: string, name: string, status: string) => `${project}\t${name}\t${status}`;

function shell(output: string): { run: RunShell; commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    run: async (cmd: string) => {
      commands.push(cmd);
      return { ok: true, output };
    },
  };
}

describe("listOwnedContainers", () => {
  test("an exited container is listed, and listed as unhealthy", () => {
    // The whole point of `-a`. Without it this row cannot exist.
    const { run } = shell(
      [
        row(OURS, "helyx-bot-1", "Up 2 hours (healthy)"),
        row(OURS, "helyx-postgres-1", "Exited (1) 5 minutes ago"),
      ].join("\n"),
    );

    return listOwnedContainers(run, { composeProject: OURS, projects: [] }).then((listing) => {
      expect(listing.usable).toBe(true);
      expect(listing.containers.map((c) => c.name)).toEqual(["helyx-bot-1", "helyx-postgres-1"]);
      expect(listing.containers[1]!.health.healthy).toBe(false);
      expect(listing.containers[1]!.health.reason).toBe("Exited");
    });
  });

  test("the command carries -a and the compose label", async () => {
    // Asserted rather than assumed: the defect this replaces was a call site
    // that had quietly kept the shorter command.
    const { run, commands } = shell(row(OURS, "helyx-bot-1", "Up 2 hours"));

    await listOwnedContainers(run, { composeProject: OURS, projects: [] });

    expect(commands).toEqual([DOCKER_LIST_COMMAND]);
    expect(DOCKER_LIST_COMMAND).toContain("docker ps -a");
  });

  test("someone else's container is not ours to report", async () => {
    const { run } = shell(
      [
        row("someone-else", "their-api-1", "Exited (137) 2 days ago"),
        row(OURS, "helyx-bot-1", "Up 2 hours (healthy)"),
      ].join("\n"),
    );

    const listing = await listOwnedContainers(run, { composeProject: OURS, projects: [] });

    expect(listing.containers.map((c) => c.name)).toEqual(["helyx-bot-1"]);
  });

  test("a project's own container is ours too", async () => {
    const { run } = shell(row("vantage-backend", "vantage-backend-api-1", "Up 3 days"));

    const listing = await listOwnedContainers(run, {
      composeProject: OURS,
      projects: ["vantage-backend"],
    });

    expect(listing.containers.map((c) => c.name)).toEqual(["vantage-backend-api-1"]);
  });

  test("output with no listing in it is unusable, not empty", async () => {
    // `2>/dev/null || true` turns a dead daemon into a clean-looking nothing,
    // and nothing reads as health.
    const { run } = shell("Cannot connect to the Docker daemon");

    const listing = await listOwnedContainers(run, { composeProject: OURS, projects: [] });

    expect(listing.usable).toBe(false);
    expect(listing.containers).toEqual([]);
  });

  test("a readable listing with nothing of ours in it is usable and empty", async () => {
    // A different state from the one above, and the caller acts differently on
    // it: this one means the scope no longer matches reality.
    const { run } = shell(row("someone-else", "their-api-1", "Up 1 hour"));

    const listing = await listOwnedContainers(run, { composeProject: OURS, projects: [] });

    expect(listing.usable).toBe(true);
    expect(listing.containers).toEqual([]);
  });
});

describe("the snapshot the health analyst reads", () => {
  function db(): FakeSql {
    const fake = new FakeSql();
    // Ownership comes from the registered projects rather than from the compose
    // project name, which `collectSystemSnapshot` derives from the directory the
    // checkout happens to live in. Tests that depend on that pass in a folder
    // called `helyx` and fail in a git worktree — found by running this suite
    // from one.
    fake.program("FROM projects", { rows: [{ name: OURS }] });
    return fake;
  }

  test("contains a container that has died", async () => {
    const { run } = shell(
      [
        row(OURS, "helyx-bot-1", "Up 2 hours (healthy)"),
        row(OURS, "helyx-postgres-1", "Exited (1) 5 minutes ago"),
      ].join("\n"),
    );

    const snapshot = await collectSystemSnapshot(db().sql as never, run);

    expect(snapshot.dockerContainers).toContain("helyx-postgres-1");
    expect(snapshot.dockerContainers).toContain("Exited (1) 5 minutes ago");
  });

  test("an unreadable listing is reported as unavailable, not as no containers", async () => {
    const { run } = shell("Cannot connect to the Docker daemon");

    const snapshot = await collectSystemSnapshot(db().sql as never, run);

    expect(snapshot.dockerContainers).toBe("unavailable");
  });

  test("a readable listing with nothing of ours says so", async () => {
    const { run } = shell(row("someone-else", "their-api-1", "Up 1 hour"));

    const snapshot = await collectSystemSnapshot(db().sql as never, run);

    expect(snapshot.dockerContainers).toBe("no containers");
  });
});
