/**
 * What the watchdog concludes from a terminal.
 *
 * `scripts/tmux-watchdog.ts` reads every session's pane and decides from the
 * text on it whether to wake the operator: a permission prompt waiting for an
 * answer, a session stuck in an editor, a credential prompt, a crash. 470 of
 * its 500 lines were uncovered.
 *
 * These decisions are pattern matches over a terminal, which is the most
 * brittle input in the system, and this file has been wrong before: a stripper
 * that made a working session look hung, classifiers that fired on any mention
 * of the word "permission", a pane parser that failed silently on un-stripped
 * ANSI. A regex that stops matching costs an operator a session that waits for
 * ever; one that matches too much costs a notification on every message. Both
 * failures are silent.
 *
 * So each detector is driven over text shaped like the pane it really reads,
 * and — as importantly — over the near-miss it must not fire on.
 */

import { describe, test, expect } from "bun:test";
import { FakeSql } from "../fixtures/fake-sql.ts";
import {
  detectPermissionPrompt,
  detectSpinner,
  detectEditor,
  detectCredential,
  detectCrash,
  detectDevChannelPrompt,
  canAlert,
  fetchActiveSessions,
  fetchSessionsWithOpenStatus,
} from "../../scripts/tmux-watchdog.ts";

/** A permission prompt as Claude Code draws it. */
const PERMISSION_PANE = [
  "● I'll check the container status.",
  "",
  "╭──────────────────────────────────────────────╮",
  "│ Docker - docker_container_list (MCP)         │",
  "│                                              │",
  "│ List all containers                          │",
  "╰──────────────────────────────────────────────╯",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again",
  "  3. No, and tell Claude what to do differently",
];

describe("a prompt waiting for an answer", () => {
  test("is recognised, and the tool is named", () => {
    const found = detectPermissionPrompt(PERMISSION_PANE);

    expect(found).not.toBeNull();
    expect(found!.toolName).toContain("docker");
    expect(found!.description).toBeTruthy();
  });

  test("ordinary output that merely mentions permission does not count", () => {
    // The classifier this replaces fired on any line containing "permission",
    // "approve" or "waiting", so a session explaining a permissions bug woke
    // the operator up.
    const pane = [
      "● Fixed the permission check in bot/access.ts",
      "  ⎿ the guard now denies when TELEGRAM_CHAT_ID is unset",
      "● Waiting for the test suite to finish",
    ];

    expect(detectPermissionPrompt(pane)).toBeNull();
  });

  test("an empty pane is not a prompt", () => {
    expect(detectPermissionPrompt([])).toBeNull();
  });
});

describe("a session that is working", () => {
  test("a spinner near the bottom means work is happening", () => {
    expect(detectSpinner(["● Done", "· Sautéing… (12s)"])).toBe(true);
  });

  test("a spinner far above the fold is stale, not current", () => {
    // Only the last ten lines count: a spinner higher up is from a turn that
    // has already finished.
    const pane = ["· Sautéing… (12s)", ...Array(20).fill("  output line")];

    expect(detectSpinner(pane)).toBe(false);
  });

  test("a bullet that is not a spinner does not count", () => {
    expect(detectSpinner(["● Done", "  ⎿ 1443 tests passed"])).toBe(false);
  });
});

describe("a session stuck somewhere it cannot answer from", () => {
  test("vim is detected by its mode line", () => {
    expect(detectEditor(["-- INSERT --"])).toBe("vim");
    expect(detectEditor(["-- VISUAL --"])).toBe("vim");
  });

  test("nano is detected by its footer", () => {
    expect(detectEditor(["^G Get Help    ^X Exit"])).toBe("nano");
  });

  test("talking about vim is not being in vim", () => {
    expect(detectEditor(["● Opened the file in vim to check the encoding"])).toBeNull();
  });

  test("a credential prompt is caught", () => {
    expect(detectCredential(["Enter passphrase for key '/home/altsay/.ssh/id_ed25519':"]))
      .toContain("passphrase");
  });

  test("a crash reports the exit code it carried", () => {
    expect(detectCrash(["[run-cli] Exited with code 137"])).toBe(137);
  });

  test("a clean exit is not a crash", () => {
    // Code 0 is not matched by the pattern: it is how a session ends normally.
    expect(detectCrash(["[run-cli] Exited with code 0"])).toBeNull();
  });

  test("the development-channel dialog needs both halves: the warning and the prompt", () => {
    // Written as a one-liner first and it failed, which is the point: the
    // warning text alone scrolls past on every start. Only the warning *with*
    // the confirmation line still on screen means something is waiting.
    const warningOnly = ["Channels (experimental) — restart without --dangerously-load-development-channels"];
    const waiting = [...warningOnly, "Press Enter to confirm"];

    expect(detectDevChannelPrompt(warningOnly)).toBe(false);
    expect(detectDevChannelPrompt(waiting)).toBe(true);
    expect(detectDevChannelPrompt(["● nothing unusual here"])).toBe(false);
  });
});

describe("not telling the operator the same thing twice", () => {
  test("the first alert goes, a repeat inside the window does not, and later one does", () => {
    // An alert that repeats every poll is how an operator learns to ignore the
    // channel entirely.
    const state = { alerts: {} } as unknown as Parameters<typeof canAlert>[0];

    expect(canAlert(state, "stall", 60_000)).toBe(true);

    state.alerts.stall = Date.now();
    expect(canAlert(state, "stall", 60_000)).toBe(false);

    state.alerts.stall = Date.now() - 61_000;
    expect(canAlert(state, "stall", 60_000)).toBe(true);
  });

  test("a cooldown is per kind, not per window", () => {
    const state = { alerts: { stall: Date.now() } } as unknown as Parameters<typeof canAlert>[0];

    expect(canAlert(state, "crash", 60_000)).toBe(true);
  });
});

describe("reading the sessions to watch", () => {
  test("rows become sessions, with the forum target and idle signal carried through", () => {
    const db = new FakeSql();
    db.program("FROM sessions s", {
      rows: [{
        session_id: 4,
        project_id: 57,
        project: "keryx",
        project_path: "/home/altsay/keryx",
        last_active: new Date("2026-08-05T18:00:00Z"),
        last_message_at: new Date("2026-08-05T16:00:00Z"),
        chat_id: "-100777",
        forum_topic_id: 54295,
        forum_chat_id: "-1003908750902",
      }],
    });

    return fetchActiveSessions(db.sql as never).then((sessions) => {
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        sessionId: 4,
        projectId: 57,
        project: "keryx",
        forumTopicId: 54295,
        forumChatId: "-1003908750902",
      });
      expect(sessions[0]!.lastActive).toBeInstanceOf(Date);
      expect(sessions[0]!.lastMessageAt).toBeInstanceOf(Date);
    });
  });

  test("a session that has never had a message queued gets null, not a crash", () => {
    const db = new FakeSql();
    db.program("FROM sessions s", {
      rows: [{
        session_id: 9,
        project_id: null,
        project: "brand-new",
        project_path: null,
        last_active: new Date("2026-08-05T18:00:00Z"),
        last_message_at: null,
        chat_id: "-100777",
        forum_topic_id: null,
        forum_chat_id: null,
      }],
    });

    return fetchActiveSessions(db.sql as never).then((sessions) => {
      expect(sessions[0]!.lastMessageAt).toBeNull();
      expect(sessions[0]!.projectId).toBeNull();
    });
  });

  test("a database that will not answer stops the watchdog from watching, not from running", async () => {
    // The query is guarded because a watchdog that throws on a bad connection
    // stops watching everything, including the sessions it could still see.
    const db = new FakeSql();
    db.program("FROM sessions s", { error: new Error("connection refused") });

    expect(await fetchActiveSessions(db.sql as never)).toEqual([]);
  });
});

describe("which sessions have a turn in progress", () => {
  test("a session with an open status message is in the set", async () => {
    const db = new FakeSql();
    db.program("FROM active_status_messages", { rows: [{ session_id: 4 }, { session_id: 12 }] });

    const inProgress = await fetchSessionsWithOpenStatus(db.sql as never);
    expect(inProgress.has(4)).toBe(true);
    expect(inProgress.has(12)).toBe(true);
    expect(inProgress.has(999)).toBe(false);
  });

  test("no open status messages is an empty set, not an error", async () => {
    const db = new FakeSql();
    db.program("FROM active_status_messages", { rows: [] });

    expect((await fetchSessionsWithOpenStatus(db.sql as never)).size).toBe(0);
  });

  test("a database that will not answer yields an empty set rather than throwing", async () => {
    const db = new FakeSql();
    db.program("FROM active_status_messages", { error: new Error("connection refused") });

    expect((await fetchSessionsWithOpenStatus(db.sql as never)).size).toBe(0);
  });
});
