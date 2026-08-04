import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type Bot } from "grammy";
import { randomUUID } from "crypto";
import { resolve as resolvePath } from "path";
import { z } from "zod";
import { executeTool } from "./tools.ts";
import { registerMcpSession, unregisterMcpSession } from "./bridge.ts";
import { handleDashboardRequest } from "./dashboard-api.ts";
import { sessionManager, setTerminationCallback } from "../sessions/manager.ts";
import { getForumChatId } from "../bot/forum-cache.ts";
import { escapeHtml } from "../bot/format.ts";
import { CONFIG } from "../config.ts";
import { sql } from "../memory/db.ts";
import { parseHookInput, denyWithAnswers, ANSWER_TIMEOUT_MS, type Answer } from "../utils/ask-question.ts";

import { readOrCreateToken, tokenMatches } from "../utils/hook-token.ts";
import { summaryFor } from "../utils/turn-summary.ts";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "fs";

/** The shared secret, read once — created on first start by whichever side runs first. */
const HOOK_TOKEN = readOrCreateToken(CONFIG.HOST_CLAUDE_CONFIG, {
  exists: existsSync,
  read: (path) => readFileSync(path, "utf-8"),
  write: (path, contents) => {
    writeFileSync(path, contents, { mode: 0o600 });
    // `mode` only applies when the file is created. An installation whose
    // config or token predates this — or was written before the mode was set —
    // would keep whatever permissions it had, which is the one thing this whole
    // change is about.
    chmodSync(path, 0o600);
  },
});

/** A question payload is small; anything larger is not one. */
const MAX_ASK_QUESTION_BODY = 256 * 1024;
/** Each waiter holds a socket and polls once a second. */
const MAX_ASK_QUESTION_WAITERS = 16;
let askQuestionWaiters = 0;
import { runQuestionExchange, resolveTarget } from "../services/ask-question.ts";
import { sendTelegramMessage, editTelegramMessage } from "../channel/telegram.ts";
import { summarizeOnDisconnect, summarizeWork, extractFactsFromTranscript } from "../memory/summarizer.ts";
import { verifyJwt } from "../dashboard/auth.ts";
import { IncomingMessage, ServerResponse } from "http";
import { createServer } from "http";

function parseCookie(req: IncomingMessage, name: string): string | undefined {
  const cookies = req.headers.cookie;
  if (!cookies) return undefined;
  const match = cookies.split(";").find((c) => c.trim().startsWith(`${name}=`));
  return match?.split("=").slice(1).join("=").trim();
}

async function isAuthenticated(req: IncomingMessage): Promise<boolean> {
  const token = parseCookie(req, "token");
  if (!token) return false;
  return (await verifyJwt(token)) !== null;
}

function isLocalRequest(req: IncomingMessage): boolean {
  const raw = req.socket.remoteAddress ?? "";
  if (raw === "127.0.0.1" || raw === "::1" || raw === "::ffff:127.0.0.1" || raw === "") return true;
  // Normalize IPv4-mapped IPv6
  const addr = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  const parts = addr.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) return false;
  const [a, b] = parts;
  // Allow all Docker bridge networks (RFC 1918: 172.16–31.x.x)
  return a === 172 && b >= 16 && b <= 31;
}

function isAllowedTranscriptPath(p: string): boolean {
  const resolved = resolvePath(String(p));
  return resolved.startsWith("/home") || resolved.startsWith("/root") || resolved.startsWith("/tmp");
}

// Track active transports by session
const transports = new Map<string, StreamableHTTPServerTransport>();

import { pendingExpects, pushExpect, tryAutoLink, rememberTransportProject, forgetTransportProject } from "./pending-expects.ts";

function registerTools(server: McpServer, bot: Bot | null, getClientId?: () => string | undefined): void {
  const exec = (name: string, args: Record<string, unknown>) => {
    const clientId = getClientId?.();
    // Retry auto-link on every tool call — catches the race where channel.ts registered
    // its expect after the transport already initialized (startup timing gap).
    if (clientId && sessionManager.getSessionIdByClient(clientId) === undefined) {
      tryAutoLink(clientId).catch(() => {});
    }
    return executeTool(name, { ...args, _clientId: clientId }, bot);
  };
  // Memory tools
  server.tool(
    "remember",
    "Save information to long-term memory with semantic embedding",
    {
      content: z.string().describe("The information to remember"),
      type: z.enum(["fact", "summary", "decision", "note"]).default("note").describe("Type of memory"),
      tags: z.array(z.string()).optional().describe("Tags for categorization"),
      source: z.enum(["telegram", "cli", "api"]).default("cli").describe("Source of the memory"),
    },
    async (args) => exec("remember", args),
  );

  server.tool(
    "recall",
    "Semantic search through long-term memory",
    {
      query: z.string().describe("Search query"),
      limit: z.number().default(5).describe("Max results"),
      type: z.enum(["fact", "summary", "decision", "note"]).optional().describe("Filter by type"),
      tags: z.array(z.string()).optional().describe("Filter by tags"),
    },
    async (args) => exec("recall", args),
  );

  server.tool(
    "forget",
    "Delete a memory by ID",
    { id: z.number().describe("Memory ID to delete") },
    async (args) => exec("forget", args),
  );

  server.tool(
    "list_memories",
    "List memories with optional filters",
    {
      type: z.enum(["fact", "summary", "decision", "note"]).optional(),
      tags: z.array(z.string()).optional(),
      limit: z.number().default(20),
      offset: z.number().default(0),
    },
    async (args) => exec("list_memories", args),
  );

  // Telegram tools
  server.tool(
    "reply",
    "Send a message to a Telegram chat",
    {
      chat_id: z.string().describe("Telegram chat ID"),
      text: z.string().describe("Message text"),
      parse_mode: z.enum(["Markdown", "MarkdownV2", "HTML"]).optional(),
    },
    async (args) => exec("reply", args),
  );

  server.tool(
    "react",
    "Set a reaction on a Telegram message",
    {
      chat_id: z.string().describe("Telegram chat ID"),
      message_id: z.number().describe("Message ID"),
      emoji: z.string().describe("Reaction emoji"),
    },
    async (args) => exec("react", args),
  );

  server.tool(
    "edit_message",
    "Edit a bot message in Telegram",
    {
      chat_id: z.string().describe("Telegram chat ID"),
      message_id: z.number().describe("Message ID to edit"),
      text: z.string().describe("New text"),
      parse_mode: z.enum(["Markdown", "MarkdownV2", "HTML"]).optional(),
    },
    async (args) => exec("edit_message", args),
  );

  // Session tools
  server.tool(
    "list_sessions",
    "List all registered sessions",
    {},
    async (args) => exec("list_sessions", args),
  );

  server.tool(
    "session_info",
    "Get details about a specific session",
    { session_id: z.number().describe("Session ID") },
    async (args) => exec("session_info", args),
  );

  server.tool(
    "set_session_name",
    "Set a human-readable name and project path for this CLI session. Call this at the start of a session.",
    {
      name: z.string().describe("Human-readable session name (e.g. project name)"),
      project_path: z.string().optional().describe("Working directory path"),
    },
    async (args) => exec("set_session_name", args),
  );

  server.tool(
    "search_project_context",
    "Semantic search over long-term project context and work summaries. Use when you need knowledge from prior sessions about this project.",
    {
      query: z.string().describe("Natural language search query"),
      project_path: z.string().optional().describe("Project path to search in. Defaults to current session project_path."),
      limit: z.number().optional().describe("Number of results to return (default: 5, max: 20)"),
    },
    async (args) => exec("search_project_context", args),
  );

  server.tool(
    "skill_view",
    "Load a skill and return its content with inline shell tokens expanded. Use this when you need to read a skill file that contains dynamic context via !`cmd` syntax.",
    {
      name: z.string().describe("Skill name (kebab-case, e.g. 'git-state')"),
    },
    async (args) => exec("skill_view", args),
  );

  server.tool(
    "propose_skill",
    "Propose a new agent-created skill from session transcript. Distills the workflow into a SKILL.md and sends a Telegram approval message.",
    {
      name: z.string().optional().describe("Suggested skill name (kebab-case)"),
      description: z.string().optional().describe("One-line description starting with 'Use when'"),
      body: z.string().optional().describe("SKILL.md body"),
      transcript: z.string().describe("Session transcript for distillation"),
      chat_id: z.string().optional().describe("Telegram chat ID for approval message"),
    },
    async (args) => exec("propose_skill", args),
  );

  server.tool(
    "save_skill",
    "Approve or reject a proposed skill",
    {
      skill_id: z.number().describe("Skill ID from propose_skill response"),
      approved: z.boolean().describe("Approve (true) or reject (false)"),
    },
    async (args) => exec("save_skill", args),
  );

  server.tool(
    "list_agent_skills",
    "List all active agent-created skills",
    {},
    async (args) => exec("list_agent_skills", args),
  );

  server.tool(
    "curator_run",
    "Manually trigger a curator run to review agent-created skills",
    {},
    async (args) => exec("curator_run", args),
  );

  server.tool(
    "curator_status",
    "Get curator run history",
    { limit: z.number().optional().describe("Number of runs to return (default 10)") },
    async (args) => exec("curator_status", args),
  );
}

function createMcpServer(bot: Bot | null, getClientId?: () => string | undefined): McpServer {
  const server = new McpServer(
    {
      name: "helyx",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        experimental: {
          "claude/channel": {},
        },
      },
    },
  );

  registerTools(server, bot, getClientId);
  return server;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += String(chunk); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * Say that the turn is over, when the session did not.
 *
 * Only what a session sends through the `reply` tool reaches Telegram, so a
 * turn that ends without one delivers nothing and the status message freezes on
 * the terminal's last line — finished and hung become indistinguishable. This
 * runs at the end of every turn and fills that silence.
 *
 * Every failure is silent by design. This is a courtesy at the end of work that
 * already succeeded; it must never be the reason a turn appears to fail.
 */
export interface TurnSummaryDeps {
  sql: typeof sql;
  token: string | undefined;
  read: (path: string) => string;
  send: typeof sendTelegramMessage;
}

export async function deliverTurnSummary(
  transcriptPath: string,
  projectPath: string,
  deps: TurnSummaryDeps = {
    sql,
    token: CONFIG.TELEGRAM_BOT_TOKEN,
    read: (path) => readFileSync(path, "utf-8"),
    send: sendTelegramMessage,
  },
): Promise<void> {
  if (!deps.token) return;

  let transcript: string;
  try {
    transcript = deps.read(transcriptPath);
  } catch {
    return;
  }

  const summary = summaryFor(transcript);
  if (!summary) return;

  // The same resolution the question hook uses: by working directory, to the
  // project's topic. A summary in the forum's General is a summary the operator
  // does not read — and this whole feature exists to be read.
  const target = await resolveTarget(deps.sql, { sessionId: "", cwd: projectPath });
  if (!target) return;

  await deps.send(deps.token, target.chatId, summary, {
    parse_mode: "HTML",
    ...target.extra,
  });
}

export function startMcpHttpServer(bot: Bot | null): ReturnType<typeof createServer> {
  if (CONFIG.TELEGRAM_TRANSPORT === "webhook" && !CONFIG.TELEGRAM_WEBHOOK_SECRET) {
    console.error("[security] FATAL: TELEGRAM_WEBHOOK_SECRET must be set in webhook mode. Generate with: openssl rand -hex 32");
    process.exit(1);
  }

  // Register session crash notification callback
  if (bot) {
    setTerminationCallback((sessionId, projectPath, sessionName) => {
      (async () => {
        try {
          const forumChatId = await getForumChatId();
          if (!forumChatId) return;

          let forumTopicId: number | null = null;
          if (projectPath) {
            const proj = await sql`SELECT forum_topic_id FROM projects WHERE project_path = ${projectPath} AND forum_topic_id IS NOT NULL LIMIT 1`;
            forumTopicId = proj[0]?.forum_topic_id ?? null;
          }
          if (!forumTopicId) return;

          const label = escapeHtml(sessionName ?? `#${sessionId}`);
          const pathLine = projectPath ? `\n📁 <code>${escapeHtml(projectPath)}</code>` : "";
          await bot.api.sendMessage(
            Number(forumChatId),
            `⚠️ Сессия <b>${label}</b> завершилась.${pathLine}\n` +
            `Запусти Claude Code заново — бот подключится автоматически.`,
            { parse_mode: "HTML", message_thread_id: forumTopicId },
          );
        } catch (err) {
          console.error("[session-notify] failed to send termination notification:", err);
        }
      })();
    });
  }


  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${CONFIG.PORT}`);

    if (url.pathname === "/health") {
      try {
        await sql`SELECT 1`;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          db: "connected",
          uptime: Math.round(process.uptime()),
          sessions: transports.size,
        }));
      } catch (err: any) {
        console.error("[health] db check failed:", err?.message);
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", db: "disconnected" }));
      }
      return;
    }

    // API: trigger summarization for a session (requires auth or local)
    if (url.pathname === "/api/summarize" && req.method === "POST") {
      if (!isLocalRequest(req) && !(await isAuthenticated(req))) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      try {
        const body = await new Promise<string>((resolve, reject) => {
          let data = "";
          req.on("data", (chunk) => (data += chunk));
          req.on("end", () => resolve(data));
          req.on("error", reject);
        });
        const { session_id, project_path } = JSON.parse(body);
        if (!session_id) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "session_id required" }));
          return;
        }
        // Run summarization in background
        summarizeOnDisconnect(session_id, project_path).catch((err) =>
          console.error("[api] summarize failed:", err)
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message }));
      }
      return;
    }

    // API: register a project session from shell CLI (local requests only)
    if (url.pathname === "/api/sessions/register" && req.method === "POST") {
      if (!isLocalRequest(req)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }
      try {
        const body = await new Promise<string>((resolve, reject) => {
          let data = "";
          req.on("data", (chunk) => (data += chunk));
          req.on("end", () => resolve(data));
          req.on("error", reject);
        });
        const parsed = JSON.parse(body);
        const { projectPath, name } = parsed;
        // parsed.cliType is accepted by callers but has never been stored or
        // acted on; only cliConfig reaches the project record.
        const rawConfig = parsed.cliConfig ?? {};

        if (!projectPath || typeof projectPath !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "projectPath required" }));
          return;
        }
        const { basename } = await import("path");
        const sessionName = name ?? basename(projectPath);
        const clientId = `claude-${basename(projectPath)}-${Date.now()}`;
        // Sanitize optional model from cliConfig
        const cliConfig: Record<string, unknown> = {};
        if (typeof rawConfig.model === "string") cliConfig.model = rawConfig.model;
        const session = await sessionManager.register(clientId, sessionName, projectPath, cliConfig);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessionId: session.id, name: session.name }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message }));
      }
      return;
    }


    // API: pre-register an expected HTTP MCP connection from channel.ts (local only)
    if (url.pathname === "/api/sessions/expect" && req.method === "POST") {
      if (!isLocalRequest(req)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }
      try {
        const body = await new Promise<string>((resolve, reject) => {
          let data = "";
          req.on("data", (chunk) => (data += chunk));
          req.on("end", () => resolve(data));
          req.on("error", reject);
        });
        const { session_id, project_path } = JSON.parse(body);
        if (!session_id || typeof session_id !== "number") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "session_id required" }));
          return;
        }
        const expectPath = typeof project_path === "string" && project_path.startsWith("/") ? project_path : null;
        await pushExpect(session_id, expectPath);
        console.log(`[mcp] pending expect registered: session #${session_id}${expectPath ? ` (${expectPath})` : ""} (queue: ${pendingExpects.size})`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message }));
      }
      return;
    }

    // POST /api/sessions/:id/summarize-work
    const workSumMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/summarize-work$/);
    if (req.method === "POST" && workSumMatch) {
      if (!isLocalRequest(req) && !(await isAuthenticated(req))) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      const sessionId = parseInt(workSumMatch[1], 10);
      try {
        const ok = await summarizeWork(sessionId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, skipped: !ok }));
      } catch (err: any) {
        console.error("[api] summarize-work error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // POST /api/hooks/ask-question — Claude Code PreToolUse hook for
    // AskUserQuestion. Unlike the other hook endpoints this one *blocks*: it
    // holds the request open until the operator taps an answer in Telegram, and
    // the hook's own 600s timeout is what bounds it. Answering here is the
    // whole point — a fire-and-forget notification would tell the operator
    // about a question they still could not answer.
    if (url.pathname === "/api/hooks/ask-question" && req.method === "POST") {
      // Stricter than the other hook endpoints on purpose. This one sends a
      // message to the operator's chat and then holds a connection open for ten
      // minutes, while isLocalRequest trusts every container on the Docker
      // network. The shared secret narrows that to whoever can read
      // ~/.claude/helyx-hook-token.
      if (!isLocalRequest(req) || !tokenMatches(HOOK_TOKEN, req.headers["x-helyx-hook-token"])) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }
      try {
        if (askQuestionWaiters >= MAX_ASK_QUESTION_WAITERS) {
          // Each waiter holds a socket and polls Postgres once a second. A cap
          // keeps a misbehaving caller from turning that into a load source;
          // 204 means the terminal simply keeps the question.
          console.warn("[hooks/ask-question] too many waiters, declining");
          res.writeHead(204);
          res.end();
          return;
        }

        const body = await new Promise<string>((resolve, reject) => {
          let data = "";
          req.on("data", (chunk) => {
            data += chunk;
            // Bounded: the payload is a handful of questions, and an unbounded
            // read on a local socket is a way to spend all the memory there is.
            if (data.length > MAX_ASK_QUESTION_BODY) {
              reject(new Error("payload too large"));
              req.destroy();
            }
          });
          req.on("end", () => resolve(data));
          req.on("error", reject);
        });

        const input = parseHookInput(body);
        // Not a question this path can carry. Silence lets the terminal have
        // it, which is exactly the behaviour that existed before.
        if (!input) {
          res.writeHead(204);
          res.end();
          return;
        }

        const deps = {
          sql,
          sendMessage: async (chatId: string, text: string, extra: Record<string, unknown>) => {
            const r = await sendTelegramMessage(CONFIG.TELEGRAM_BOT_TOKEN, chatId, text, extra);
            return { ok: r.ok, messageId: r.messageId };
          },
          editMessage: async (chatId: string, messageId: number, text: string, extra?: Record<string, unknown>) =>
            editTelegramMessage(CONFIG.TELEGRAM_BOT_TOKEN, chatId, messageId, text, {
              parse_mode: "HTML",
              ...extra,
            }),
        };

        // Capacity is taken, and the socket watched, before any work is done.
        //
        // Registration sends Telegram messages, so doing it first meant every
        // concurrent caller passed the capacity check and sent its prompts
        // before any of them counted — and a client that hung up during those
        // sends was never noticed, leaving the request to wait out its full ten
        // minutes for nobody. The ordering itself lives in the service, where
        // it can be tested.
        askQuestionWaiters++;
        let clientGone = false;
        const onGone = () => { clientGone = true; };
        req.on("aborted", onGone);
        res.on("close", onGone);

        let answers: Answer[] | null = null;
        try {
          answers = await runQuestionExchange(deps, input, {
            timeoutMs: ANSWER_TIMEOUT_MS,
            clientGone: () => clientGone,
          });
        } finally {
          askQuestionWaiters--;
          req.off("aborted", onGone);
          res.off("close", onGone);
        }

        if (!answers) {
          // Timed out, or withdrawn. The hook prints nothing, Claude Code
          // proceeds as if it had not run, and the selector appears in the
          // terminal as it always did.
          res.writeHead(204);
          res.end();
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(denyWithAnswers(input.questions, answers));
      } catch (err: unknown) {
        console.error("[hooks/ask-question] error:", err instanceof Error ? err.message : String(err));
        if (!res.headersSent) {
          // 204 rather than 500: whatever went wrong here, the terminal must
          // still get its selector.
          res.writeHead(204);
          res.end();
        }
      }
      return;
    }

    // POST /api/hooks/stop — Claude Code Stop hook: extract facts from transcript
    if (url.pathname === "/api/hooks/stop" && req.method === "POST") {
      if (!isLocalRequest(req)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }
      try {
        const body = await new Promise<string>((resolve, reject) => {
          let data = "";
          req.on("data", (chunk) => (data += chunk));
          req.on("end", () => resolve(data));
          req.on("error", reject);
        });
        const { transcript_path, project_path } = JSON.parse(body);
        if (!transcript_path || !project_path) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "transcript_path and project_path required" }));
          return;
        }
        if (!isAllowedTranscriptPath(transcript_path)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid transcript_path" }));
          return;
        }
        // Non-blocking — respond immediately, extract in background
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        extractFactsFromTranscript(transcript_path as string, project_path as string)
          .catch((err) => console.error("[hooks/stop] extractFactsFromTranscript error:", err?.message));
        deliverTurnSummary(transcript_path as string, project_path as string)
          .catch((err) => console.error("[hooks/stop] deliverTurnSummary error:", err?.message));
      } catch (err: any) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err?.message }));
        }
      }
      return;
    }

    // Telegram webhook endpoint — return 200 immediately, process in background
    if (bot && CONFIG.TELEGRAM_TRANSPORT === "webhook" && req.method === "POST" && url.pathname === CONFIG.TELEGRAM_WEBHOOK_PATH) {
      // Validate secret token
      const secretToken = req.headers["x-telegram-bot-api-secret-token"];
      if (CONFIG.TELEGRAM_WEBHOOK_SECRET && secretToken !== CONFIG.TELEGRAM_WEBHOOK_SECRET) {
        res.writeHead(401);
        res.end();
        return;
      }

      const body = await readBody(req);

      // Acknowledge immediately — prevents Telegram retries and unblocks next update
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");

      // Process update in background (non-blocking)
      try {
        const update = JSON.parse(body);
        bot.handleUpdate(update).catch((err: any) =>
          console.error("[webhook] handleUpdate error:", err?.message ?? err)
        );
      } catch (err: any) {
        console.error("[webhook] parse error:", err?.message);
      }
      return;
    }

    // Dashboard API + static files.
    // Gated on ENABLE_DASHBOARD: when off, dashboard routes simply do not
    // exist and fall through to the 404 below. The /mcp route beneath this
    // block is deliberately outside the guard — dashboard and MCP share this
    // server, and disabling one must not touch the other.
    if (CONFIG.ENABLE_DASHBOARD) {
      try {
        const handled = await handleDashboardRequest(req, res, url);
        if (handled) return;
      } catch (err: any) {
        console.error("[dashboard] error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message }));
        return;
      }
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    // MCP endpoint: loopback + Docker bridge only — no JWT.
    // Intentional: Claude Code CLI connects from localhost or the Docker bridge
    // (172.16–31.x.x). External JWT auth would break CLI auto-connect. If the
    // port is ever exposed beyond localhost, add token auth here.
    if (!isLocalRequest(req)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (req.method === "GET" || req.method === "DELETE") {
        res.writeHead(400);
        res.end("Missing session ID");
        return;
      }

      // Track transport's MCP session ID (UUID)
      let transportSessionId: string | undefined;

      const mcpServer = createMcpServer(bot, () => transportSessionId);

      // Project identity declared by the CLI via header (set through
      // HELYX_PROJECT_PATH env expansion in the mcp server config).
      const rawProjectHeader = req.headers["x-helyx-project"];
      const declaredProject =
        typeof rawProjectHeader === "string" && rawProjectHeader.startsWith("/")
          ? rawProjectHeader
          : null;

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          transports.set(id, transport!);
          registerMcpSession(id, mcpServer);
          transportSessionId = id;
          sessionManager.trackTransport(id);
          if (declaredProject) rememberTransportProject(id, declaredProject);
          console.log(`[mcp] transport initialized: ${id.slice(0, 12)}${declaredProject ? ` (${declaredProject})` : ""}`);
          // Try auto-link immediately (if channel.ts registered expect before us)
          tryAutoLink(id).catch((err) => console.error("[mcp] auto-link failed:", err?.message));
        },
      });

      transport.onclose = async () => {
        const sid = transport!.sessionId;
        if (sid) {
          transports.delete(sid);
          unregisterMcpSession(sid);
          const hasDbSession = sessionManager.getSessionIdByClient(sid) !== undefined;
          sessionManager.untrackTransport(sid);
          forgetTransportProject(sid);
          if (hasDbSession) {
            await sessionManager.disconnect(sid);
          }
          console.log(`[mcp] transport closed: ${sid.slice(0, 12)}${hasDbSession ? " (db session cleaned up)" : ""}`);
        }
      };

      await mcpServer.connect(transport);
    }

    let body: unknown = undefined;
    if (req.method === "POST") {
      body = await new Promise<unknown>((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => {
          data += chunk;
          if (data.length > 5_000_000) { req.destroy(); reject(new Error("Body too large")); }
        });
        req.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
        req.on("error", reject);
      });
    }

    await transport.handleRequest(req, res, body);
  });

  httpServer.listen(CONFIG.PORT, () => {
    console.log(`[mcp] HTTP server listening on port ${CONFIG.PORT}`);
  });

  return httpServer;
}
