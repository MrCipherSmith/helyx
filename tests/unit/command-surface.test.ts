/**
 * A command nobody can find is a command that does not exist.
 *
 * `/now` was written, registered as a handler, tested, shipped — and appeared
 * in none of the three places Telegram shows a command, so the only way to
 * reach it was to already know it was there. Nothing failed; it was simply
 * invisible for its whole life.
 *
 * A command becomes visible in three independent places, and each of them is a
 * separate list somebody has to remember to edit:
 *
 *   1. `setMyCommands` in main.ts — the native autocomplete, and two lists:
 *      one for private chats, one for groups. A bot used from a forum topic
 *      reads the group list, so the private one alone is not enough.
 *   2. `GROUPS` in bot/commands/menu.ts — the `/menu` navigator, plus a
 *      `dispatch` arm, which is a second edit in the same file.
 *   3. `handlers.ts` — the handler itself, without which the other two point
 *      at nothing.
 *
 * These tests read the sources. That is unusual and deliberate: the failure
 * being guarded against is a list that was never edited, and there is no
 * runtime behaviour to observe because the omission produces none.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "../..");
const read = (p: string) => Bun.file(resolve(ROOT, p)).text();

const mainTs = await read("main.ts");
const menuTs = await read("bot/commands/menu.ts");
const handlersTs = await read("bot/handlers.ts");

/** The two `setMyCommands` calls, split so each can be asserted on separately. */
const privateBlock = mainTs.slice(
  mainTs.indexOf("setMyCommands"),
  mainTs.indexOf("all_private_chats"),
);
const groupBlock = mainTs.slice(
  mainTs.indexOf("setMyCommands", mainTs.indexOf("all_private_chats")),
  mainTs.indexOf("all_group_chats"),
);

/** Commands that must be reachable every way a command can be reached. */
const VISIBLE_EVERYWHERE = ["now", "restart_docker", "restart_host"] as const;

describe("a command is visible in all three places or in none", () => {
  for (const cmd of VISIBLE_EVERYWHERE) {
    describe(`/${cmd}`, () => {
      test("has a handler", () => {
        expect(handlersTs).toContain(`b.command("${cmd}"`);
      });

      test("is in the private-chat autocomplete", () => {
        expect(privateBlock).toContain(`command: "${cmd}"`);
      });

      test("is in the group autocomplete — this bot is used from forum topics", () => {
        expect(groupBlock).toContain(`command: "${cmd}"`);
      });

      test("is in a /menu group", () => {
        expect(menuTs).toContain(`name: "${cmd}"`);
      });

      test("is dispatchable from /menu — a button that reaches the default arm is a dead button", () => {
        expect(menuTs).toContain(`case "${cmd}":`);
      });
    });
  }
});

describe("/now in particular", () => {
  test("is not filed under a dmOnly group", () => {
    // The Session group is dmOnly, and this bot is driven from forum topics
    // where that group is not rendered at all — which would leave /now exactly
    // as invisible as it was before, one level further in.
    const groupOf = (cmd: string): string => {
      const at = menuTs.indexOf(`name: "${cmd}"`);
      const before = menuTs.slice(0, at);
      const idAt = before.lastIndexOf("id: ");
      return before.slice(idAt, before.indexOf("\n", idAt));
    };
    const owner = groupOf("now");
    const groupBody = menuTs.slice(menuTs.indexOf(owner), menuTs.indexOf(`name: "now"`));
    // Comments stripped: this file explains *why* /now is not in the dmOnly
    // group, and the explanation must not read as the flag it warns about.
    const flags = groupBody.replace(/\/\/.*$/gm, "");
    expect(flags).not.toContain("dmOnly");
  });
});

describe("the two halves are named as halves", () => {
  test("/restart_docker and /restart_host enqueue distinct commands", async () => {
    const systemTs = await read("bot/commands/system.ts");
    expect(systemTs).toContain(`"docker_restart_all"`);
    expect(systemTs).toContain(`"host_restart"`);
  });

  test("both are in the /system panel too, not only as slash commands", async () => {
    const systemTs = await read("bot/commands/system.ts");
    expect(systemTs).toContain("sys:restart_docker");
    expect(systemTs).toContain("sys:restart_host");
  });

  test("both are covered by the panel's in-progress guard", async () => {
    // Without this a second press queues a second restart behind the first.
    const systemTs = await read("bot/commands/system.ts");
    const pendingQuery = systemTs.slice(systemTs.indexOf("FROM admin_commands"), systemTs.indexOf("ORDER BY created_at"));
    expect(pendingQuery).toContain("docker_restart_all");
    expect(pendingQuery).toContain("host_restart");
  });

  test("the daemon knows what to do with each", async () => {
    const daemonTs = await read("scripts/admin-daemon.ts");
    expect(daemonTs).toContain(`case "docker_restart_all":`);
    expect(daemonTs).toContain(`case "host_restart":`);
  });

  test("bounce and host_restart share one implementation", async () => {
    // Four buttons reaching one broken start path is what the 2026-08-05
    // outage was; two entry points keeping two copies of the fix in step is
    // how it would come back.
    const daemonTs = await read("scripts/admin-daemon.ts");
    const bounceCase = daemonTs.slice(daemonTs.indexOf(`case "bounce":`), daemonTs.indexOf(`case "channel_kill":`));
    expect(bounceCase).toContain("restart-host-run.ts");
  });
});
