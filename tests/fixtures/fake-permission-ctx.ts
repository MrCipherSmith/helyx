/**
 * A world for `PermissionHandler` to run in.
 *
 * `handle()` and `pollForResponse()` are almost entirely about talking to a
 * database, a chat API and an MCP client. There is no pure function left to
 * extract from them — the extraction flows already took the parts that were
 * one — so the only honest way to test them is to stand a fake world up and
 * watch what the handler does to it.
 *
 * The doubles record rather than assert. A double that asserts decides in
 * advance what matters and hides everything else; one that records lets each
 * test ask its own question, which is why the interesting properties here are
 * plain arrays.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type postgres from "postgres";
import type { StatusManager } from "../../channel/status.ts";
import { HoldCounter } from "../../utils/hold-counter.ts";
import { FakeSql } from "./fake-sql.ts";

/** One `mcp.notification()` call. */
export interface RecordedNotification {
  method: string;
  params: Record<string, unknown>;
}

/**
 * The MCP client double.
 *
 * This is how a test sees the only thing the handler ultimately returns to
 * Claude Code: `allow` or `deny`, once. Both halves of that matter — a handler
 * that answers twice is as broken as one that never answers, and only a
 * recorded list can tell the difference.
 */
export class FakeMcp {
  readonly notifications: RecordedNotification[] = [];

  async notification(n: { method: string; params?: Record<string, unknown> }): Promise<void> {
    this.notifications.push({ method: n.method, params: n.params ?? {} });
  }

  /** The `behavior` values sent back, in order. */
  behaviors(): unknown[] {
    return this.notifications
      .filter((n) => n.method === "notifications/claude/channel/permission")
      .map((n) => n.params.behavior);
  }

  asServer(): Server {
    return this as unknown as Server;
  }
}

/** One `updateStatus()` call. */
export interface RecordedStatus {
  chatId: string;
  stage: string;
}

/**
 * The status-manager double.
 *
 * `holdAwaitingPermission` delegates to the real `HoldCounter` instead of
 * reimplementing the lease. The lease semantics — a release that counts once
 * however often it is called, a depth that only reaches zero when the last
 * holder lets go — are the behaviour under test here, not scaffolding around
 * it, and a second implementation of them living in a fixture is precisely the
 * divergence the last three flows were about.
 */
export class FakeStatusManager {
  readonly statuses: RecordedStatus[] = [];
  readonly holds = new HoldCounter();

  /** How many times a hold was taken, including ones already released. */
  holdsTaken = 0;

  async updateStatus(chatId: string, stage: string): Promise<void> {
    this.statuses.push({ chatId, stage });
  }

  holdAwaitingPermission(chatId: string): () => void {
    this.holdsTaken++;
    return this.holds.acquire(chatId);
  }

  /** Is the waiting signal up for this chat? */
  isAwaiting(chatId: string): boolean {
    return this.holds.isHeld(chatId);
  }

  /** The stage texts, in order — the usual thing a test wants to assert on. */
  stages(): string[] {
    return this.statuses.map((s) => s.stage);
  }

  asStatusManager(): StatusManager {
    return this as unknown as StatusManager;
  }
}

/** What `makePermissionWorld` hands back. */
export interface PermissionWorld {
  db: FakeSql;
  mcp: FakeMcp;
  status: FakeStatusManager;
  /** The context object, shaped as `PermissionHandler` expects it. */
  ctx: {
    sql: postgres.Sql;
    mcp: Server;
    sessionId: () => number | null;
    projectPath: string;
    token: () => string | undefined;
    homeDir: string;
    forumChatId?: () => string | null;
    forumTopicId?: () => number | null;
    permissionTimeoutMs?: () => number;
  };
}

export interface PermissionWorldOptions {
  sessionId?: number | null;
  projectPath?: string;
  token?: string | undefined;
  /**
   * Defaults to a path that exists but holds no `settings.local.json`, so
   * `loadAutoApproveRules` finds nothing rather than reading the developer's
   * real `~/.claude` — which would make the test's result depend on the machine
   * it runs on.
   */
  homeDir?: string;
  forumChatId?: string | null;
  forumTopicId?: number | null;
  permissionTimeoutMs?: number;
}

/**
 * Build a complete world: a fake database, a fake MCP client, a recording
 * status manager, and the context tying them together.
 *
 * The defaults describe the ordinary case — one session, a token present, no
 * forum — so a test states only what it is actually about.
 */
export function makePermissionWorld(options: PermissionWorldOptions = {}): PermissionWorld {
  const db = new FakeSql();
  const mcp = new FakeMcp();
  const status = new FakeStatusManager();

  const sessionId = options.sessionId === undefined ? 1 : options.sessionId;
  const token = "token" in options ? options.token : "test-token";

  const ctx: PermissionWorld["ctx"] = {
    sql: db.sql as unknown as postgres.Sql,
    mcp: mcp.asServer(),
    sessionId: () => sessionId,
    projectPath: options.projectPath ?? "/tmp/fake-project",
    token: () => token,
    // A directory with no .claude in it: the rule loader must come up empty
    // from the fixture rather than from whatever the developer has configured.
    homeDir: options.homeDir ?? "/nonexistent-home-for-tests",
  };

  if (options.forumChatId !== undefined) ctx.forumChatId = () => options.forumChatId ?? null;
  if (options.forumTopicId !== undefined) ctx.forumTopicId = () => options.forumTopicId ?? null;
  if (options.permissionTimeoutMs !== undefined) {
    const ms = options.permissionTimeoutMs;
    ctx.permissionTimeoutMs = () => ms;
  }

  return { db, mcp, status, ctx };
}
