/**
 * tmux-permission-watcher — detects Claude Code MCP tool permission prompts
 * appearing in tmux panes and routes them to Telegram.
 *
 * When Claude Code asks for permission to use an external MCP tool (docker,
 * github, etc.) the interactive prompt appears in the terminal rather than
 * going through the helyx MCP permission channel. This watcher polls every
 * active tmux window in the "bots" session, detects the "Do you want to
 * proceed?" prompt, sends a Telegram message with Yes/Always/No buttons,
 * and feeds the user's choice back via tmux send-keys.
 *
 * Uses the same permission_requests table and perm: callback flow as
 * channel/permissions.ts so the Telegram callback handler works unchanged.
 */

import type postgres from "postgres";

const POLL_INTERVAL_MS = 1000;
const RESPONSE_TIMEOUT_MS = 600_000; // 10 min
const TMUX_SESSION = "bots";
const TELEGRAM_API = "https://api.telegram.org";

// Claude Code terminal permission prompt indicators
// Matches "Do you want to proceed?" (appears just before the numbered options)
const PERMISSION_SIGNAL_RE = /do you want to proceed\?/i;
// The first choice is highlighted with ❯ when the prompt is active
const CHOICE_ACTIVE_RE = /❯\s*1[.)]\s*yes/i;

interface PendingEntry {
  requestId: string;
  windowIndex: string;
  windowName: string;
  chatId: string;
  startedAt: number;
  resolvedAt?: number;
}

function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/[\x00-\x09\x0b-\x1f]/g, "");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function runShell(cmd: string): Promise<string> {
  try {
    const proc = Bun.spawn(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim();
  } catch {
    return "";
  }
}

async function capturePane(windowIdx: string, numLines = 60): Promise<string[]> {
  const raw = await runShell(
    `tmux capture-pane -t "${TMUX_SESSION}:${windowIdx}" -p -S -${numLines} 2>/dev/null || true`,
  );
  return raw.split("\n").map(stripAnsi);
}

/**
 * Returns tool name + description if the pane contains an active permission prompt,
 * null otherwise.
 */
function detectPrompt(lines: string[]): { toolName: string; description: string } | null {
  // Find the last occurrence of the signal line
  let signalIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PERMISSION_SIGNAL_RE.test(lines[i])) {
      signalIdx = i;
      break;
    }
  }
  if (signalIdx === -1) return null;

  // Confirm prompt is still active: "❯ 1. Yes" must appear within 5 lines after the signal
  const afterSignal = lines.slice(signalIdx, Math.min(lines.length, signalIdx + 6));
  if (!afterSignal.some((l) => CHOICE_ACTIVE_RE.test(l))) return null;

  // Extract tool name from context above the signal (MCP tool names or server - tool format)
  const contextLines = lines.slice(Math.max(0, signalIdx - 25), signalIdx);
  let toolName = "";

  for (let i = contextLines.length - 1; i >= 0; i--) {
    const line = contextLines[i].trim();
    // mcp__server__tool_name
    const mcpFull = line.match(/\b(mcp__[\w]+__[\w]+)\b/);
    if (mcpFull) { toolName = mcpFull[1]; break; }
    // "server - tool_name (MCP)" format
    const mcpShort = line.match(/\b(\w+)\s*-\s*([\w_]+)\s*\(MCP\)/i);
    if (mcpShort) { toolName = `mcp__${mcpShort[1]}__${mcpShort[2]}`; break; }
    // "server wants to use tool_name" format
    const wantsTo = line.match(/(\w+)\s+wants\s+to\s+use\s+([\w_]+)/i);
    if (wantsTo) { toolName = `mcp__${wantsTo[1]}__${wantsTo[2]}`; break; }
  }

  if (!toolName) toolName = "mcp:unknown";

  // Build a short description from meaningful context lines
  const meaningful = contextLines
    .map((l) => l.trim())
    .filter((l) => l && !/^[╭╰│─ ]+$/.test(l) && !/^[·✶✻●⎿]/.test(l))
    .slice(-4);
  const description = meaningful.join("\n").trim() || toolName;

  return { toolName, description };
}

async function resolveTarget(
  sql: postgres.Sql,
  projectName: string,
): Promise<{ sessionId: number; chatId: string; forumExtra: Record<string, unknown> } | null> {
  // Look up active session for this project
  const sessionRows = await sql`
    SELECT s.id as session_id
    FROM sessions s
    WHERE s.project = ${projectName}
      AND s.status IN ('active', 'inactive')
    ORDER BY s.last_active DESC
    LIMIT 1
  `.catch(() => [] as any[]);

  if (sessionRows.length === 0) return null;
  const sessionId = sessionRows[0].session_id as number;

  // Resolve chat_id — check forum mode first
  const forumRows = await sql`
    SELECT p.forum_topic_id, bc.value as forum_chat_id
    FROM projects p
    LEFT JOIN bot_config bc ON bc.key = 'forum_chat_id'
    WHERE p.name = ${projectName}
    LIMIT 1
  `.catch(() => [] as any[]);

  const forumChatId: string | null = forumRows[0]?.forum_chat_id ?? null;
  const forumTopicId: number | null = forumRows[0]?.forum_topic_id ?? null;

  if (forumChatId && forumTopicId) {
    return {
      sessionId,
      chatId: forumChatId,
      forumExtra: { message_thread_id: forumTopicId },
    };
  }

  // Fall back to chat_sessions lookup
  const chatRows = await sql`
    SELECT cs.chat_id
    FROM chat_sessions cs
    WHERE cs.active_session_id = ${sessionId}
    LIMIT 1
  `.catch(() => [] as any[]);

  if (chatRows.length === 0) return null;
  return { sessionId, chatId: chatRows[0].chat_id as string, forumExtra: {} };
}

async function sendPermissionMessage(
  token: string,
  chatId: string,
  requestId: string,
  toolName: string,
  description: string,
  extra: Record<string, unknown>,
): Promise<{ ok: boolean; messageId: number | null }> {
  const text =
    `🔐 Allow? (terminal)\n\n` +
    `<b>${escapeHtml(toolName)}</b>\n` +
    `<i>${escapeHtml(description.slice(0, 300))}</i>`;
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: Number(chatId),
        text,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Yes", callback_data: `perm:allow:${requestId}` },
            { text: "✅ Always", callback_data: `perm:always:${requestId}` },
            { text: "❌ No", callback_data: `perm:deny:${requestId}` },
          ]],
        },
        ...extra,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, messageId: null };
    const data = (await res.json()) as { result?: { message_id?: number } };
    return { ok: true, messageId: data.result?.message_id ?? null };
  } catch {
    return { ok: false, messageId: null };
  }
}

async function editMessage(
  token: string,
  chatId: string,
  messageId: number,
  text: string,
): Promise<void> {
  try {
    await fetch(`${TELEGRAM_API}/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Number(chatId), message_id: messageId, text, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {}
}

async function pollForResponse(
  sql: postgres.Sql,
  token: string,
  entry: PendingEntry,
  telegramMsgId: number | null,
): Promise<void> {
  const startTime = Date.now();
  const { requestId, windowIndex, chatId } = entry;

  while (Date.now() - startTime < RESPONSE_TIMEOUT_MS) {
    // Check DB for user response
    const rows = await sql`
      SELECT response FROM permission_requests
      WHERE id = ${requestId} AND response IS NOT NULL
    `.catch(() => [] as any[]);

    if (rows.length > 0) {
      const behavior = rows[0].response as string;
      // Map behavior to numbered choice in Claude Code's terminal menu
      // 1 = Yes (once), 2 = Yes always, 3 = No
      const key = behavior === "deny" ? "3" : behavior === "always" ? "2" : "1";
      await runShell(`tmux send-keys -t "${TMUX_SESSION}:${windowIndex}" "${key}" Enter`);
      console.log(`[tmux-perm] ${requestId}: ${behavior} → key ${key} to ${TMUX_SESSION}:${windowIndex}`);
      entry.resolvedAt = Date.now();
      await sql`UPDATE permission_requests SET archived_at = NOW() WHERE id = ${requestId}`.catch(() => {});
      return;
    }

    // Check if prompt is still visible — if it disappeared, user may have answered in terminal
    const paneLines = await capturePane(windowIndex);
    const stillVisible = paneLines.some(
      (l) => PERMISSION_SIGNAL_RE.test(l) || CHOICE_ACTIVE_RE.test(l),
    );
    if (!stillVisible) {
      console.log(`[tmux-perm] ${requestId}: prompt gone from terminal (answered locally)`);
      entry.resolvedAt = Date.now();
      if (telegramMsgId) {
        await editMessage(token, chatId, telegramMsgId, `⚡ Resolved in terminal`);
      }
      await sql`UPDATE permission_requests SET archived_at = NOW() WHERE id = ${requestId}`.catch(() => {});
      return;
    }

    await Bun.sleep(500);
  }

  // Timeout — auto-deny
  console.warn(`[tmux-perm] ${requestId}: timeout, auto-denying`);
  await runShell(`tmux send-keys -t "${TMUX_SESSION}:${windowIndex}" "3" Enter`);
  entry.resolvedAt = Date.now();
  if (telegramMsgId) {
    await editMessage(token, chatId, telegramMsgId, `⏰ Timeout — denied`);
  }
  await sql`UPDATE permission_requests SET archived_at = NOW() WHERE id = ${requestId}`.catch(() => {});
}

async function pollWindows(
  sql: postgres.Sql,
  token: string,
  pending: Map<string, PendingEntry>,
): Promise<void> {
  const windowsOut = await runShell(
    `tmux list-windows -t ${TMUX_SESSION} -F "#{window_index} #{window_name}" 2>/dev/null || true`,
  );
  if (!windowsOut) return;

  for (const line of windowsOut.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const spaceIdx = line.indexOf(" ");
    const idx = line.slice(0, spaceIdx);
    const name = line.slice(spaceIdx + 1).trim();

    if (pending.has(idx)) continue;

    const lines = await capturePane(idx);
    const detected = detectPrompt(lines);
    if (!detected) continue;

    console.log(`[tmux-perm] prompt in ${TMUX_SESSION}:${idx} (${name}), tool: ${detected.toolName}`);

    const target = await resolveTarget(sql, name);
    if (!target) {
      console.warn(`[tmux-perm] no chat found for project "${name}" — skipping`);
      continue;
    }

    const requestId = `tmux-${crypto.randomUUID()}`;
    const { sessionId, chatId, forumExtra } = target;

    const sendResult = await sendPermissionMessage(
      token, chatId, requestId,
      detected.toolName, detected.description, forumExtra,
    );

    if (!sendResult.ok) {
      console.warn(`[tmux-perm] failed to send Telegram message for ${requestId}`);
      continue;
    }

    await sql`
      INSERT INTO permission_requests
        (id, session_id, chat_id, tool_name, description, message_id, tmux_target)
      VALUES
        (${requestId}, ${sessionId}, ${chatId}, ${detected.toolName},
         ${detected.description.slice(0, 1000)}, ${sendResult.messageId}, ${"bots:" + idx})
      ON CONFLICT (id) DO NOTHING
    `.catch((err) => console.error("[tmux-perm] insert error:", err.message));

    const entry: PendingEntry = {
      requestId,
      windowIndex: idx,
      windowName: name,
      chatId,
      startedAt: Date.now(),
    };
    pending.set(idx, entry);

    // Run response polling in background
    pollForResponse(sql, token, entry, sendResult.messageId).catch((err) =>
      console.error("[tmux-perm] response poll error:", err?.message),
    ).finally(() => {
      // Remove from pending so we can detect the next prompt on this window
      if (pending.get(idx) === entry) pending.delete(idx);
    });
  }
}

/**
 * Start the tmux permission watcher.
 * Returns immediately; runs the poll loop as a background task.
 */
export function startTmuxPermissionWatcher(sql: postgres.Sql, token: string): void {
  const pending = new Map<string, PendingEntry>();

  console.log("[tmux-perm] watcher started");

  const loop = async () => {
    while (true) {
      try {
        await pollWindows(sql, token, pending);
      } catch (err: any) {
        console.error("[tmux-perm] poll error:", err?.message);
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  };

  loop().catch((err) => console.error("[tmux-perm] fatal:", err?.message));
}
