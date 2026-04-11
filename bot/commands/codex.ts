import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { logger } from "../../logger.ts";

// Strip ANSI escape codes
function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[mGKHF]/g, "").replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
}

export async function handleCodexSetup(ctx: Context): Promise<void> {
  const statusMsg = await ctx.reply("Starting Codex device auth...");

  let proc: ReturnType<typeof Bun.spawn> | null = null;

  try {
    proc = Bun.spawn(["npx", "@openai/codex", "login", "--device-auth"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    // Read stdout until we get the URL and code (or timeout)
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 30_000;

    let authUrl: string | null = null;
    let userCode: string | null = null;

    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += stripAnsi(decoder.decode(value));

      // Parse URL — look for https://auth.openai.com/codex/device
      const urlMatch = buffer.match(/https:\/\/auth\.openai\.com\/codex\/device/);
      if (urlMatch) authUrl = urlMatch[0];

      // Parse device code — pattern like ABCD-EFGH (letters/digits, dash in middle)
      const codeMatch = buffer.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/);
      if (codeMatch) userCode = codeMatch[1];

      if (authUrl && userCode) break;
    }
    reader.releaseLock();

    if (!authUrl || !userCode) {
      logger.warn({ buffer }, "codex login: failed to parse device auth output");
      await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, "Failed to start device auth. Check bot logs.");
      return;
    }

    // Send auth info with button
    const kb = new InlineKeyboard().url("Open in browser", authUrl);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      `*Codex Login*\n\n1\\. Open the link below in your browser\n2\\. Enter this code: \`${userCode}\`\n\n_Code expires in 15 minutes\\. Don't share it\\._`,
      { parse_mode: "MarkdownV2", reply_markup: kb },
    );

    logger.info({ userCode }, "codex login: device auth initiated");

    // Poll for completion (up to 15 min, every 5s)
    const pollDeadline = Date.now() + 15 * 60_000;
    let authenticated = false;

    while (Date.now() < pollDeadline) {
      await Bun.sleep(5_000);

      const check = Bun.spawn(["npx", "@openai/codex", "login", "status"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, FORCE_COLOR: "0" },
      });
      const raw = await new Response(check.stdout).text();
      const status = stripAnsi(raw).trim().toLowerCase();
      await check.exited;

      if (status.includes("logged in") || status.startsWith("logged in")) {
        authenticated = true;
        break;
      }

      // Also check if main process ended (error / already done)
      if (proc.exitCode !== null && proc.exitCode === 0) {
        // Re-check status once more
        const check2 = Bun.spawn(["npx", "@openai/codex", "login", "status"], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, FORCE_COLOR: "0" },
        });
        const raw2 = await new Response(check2.stdout).text();
        await check2.exited;
        if (stripAnsi(raw2).toLowerCase().includes("logged in")) {
          authenticated = true;
        }
        break;
      }
    }

    if (authenticated) {
      await ctx.reply("Codex authenticated successfully. You can now use `/codex_review` for AI-powered code review.");
      logger.info("codex login: authentication completed");
    } else {
      await ctx.reply("Codex login timed out or was not completed. Run /codex_setup again if needed.");
    }
  } catch (err) {
    logger.error({ err }, "codex login error");
    await ctx.reply("Error running codex login. Check bot logs.");
  } finally {
    proc?.kill();
  }
}

// Model used by Codex — override via CODEX_MODEL env var (default: o3)
const CODEX_MODEL = process.env.CODEX_MODEL ?? "o3";

export async function handleCodexReview(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  // Everything after /codex_review, or a default prompt
  const prompt = text.replace(/^\/codex_review\s*/, "").trim()
    || "Review the latest changes on the current branch. Summarize what changed and flag any issues.";

  const statusMsg = await ctx.reply("Checking Codex auth...");

  // Check if logged in first
  try {
    const check = Bun.spawn(["npx", "@openai/codex", "login", "status"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const raw = stripAnsi(await new Response(check.stdout).text()).trim().toLowerCase();
    await check.exited;

    if (raw.includes("not logged") || raw === "") {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        "Codex is not authenticated. Run /codex_setup first to log in.",
      );
      return;
    }
  } catch (err) {
    logger.error({ err }, "codex review: status check failed");
  }

  await ctx.api.editMessageText(
    ctx.chat!.id,
    statusMsg.message_id,
    `Running Codex review (${CODEX_MODEL})...\n\n_${prompt}_`,
    { parse_mode: "Markdown" },
  );

  let codexFailed = false;

  try {
    const proc = Bun.spawn(["npx", "@openai/codex", "--no-interactive", "-m", CODEX_MODEL, prompt], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const output = stripAnsi(stdout).trim();
    const errOut = stripAnsi(stderr).trim().toLowerCase();

    // Detect quota/auth errors
    const isLimitError =
      exitCode !== 0 ||
      !output ||
      errOut.includes("rate limit") ||
      errOut.includes("quota") ||
      errOut.includes("unauthorized") ||
      errOut.includes("not logged") ||
      output.toLowerCase().includes("rate limit") ||
      output.toLowerCase().includes("quota exceeded");

    if (isLimitError) {
      logger.warn({ exitCode, errOut: errOut.slice(0, 200) }, "codex review: failed or quota exceeded — fallback");
      codexFailed = true;
    } else {
      // Send Codex output
      const MAX = 4000;
      if (output.length <= MAX) {
        await ctx.reply(`*Codex Review* (${CODEX_MODEL})\n\n${output}`, { parse_mode: "Markdown" }).catch(() =>
          ctx.reply(`Codex Review (${CODEX_MODEL})\n\n${output}`)
        );
      } else {
        const chunks = output.match(/.{1,4000}/gs) ?? [output];
        for (const [i, chunk] of chunks.entries()) {
          const header = i === 0 ? `*Codex Review* (${CODEX_MODEL})\n\n` : `*(continued ${i + 1}/${chunks.length})*\n\n`;
          await ctx.reply(header + chunk, { parse_mode: "Markdown" }).catch(() =>
            ctx.reply(header + chunk)
          );
        }
      }
    }
  } catch (err) {
    logger.error({ err }, "codex review error");
    codexFailed = true;
  }

  if (codexFailed) {
    // Fallback: ask active Claude session to do the review natively
    await ctx.reply(
      "Codex unavailable (quota or auth issue) — forwarding review request to Claude.",
    );
    // Re-route as a plain text message to the active session by simulating a text reply
    // The CLAUDE.md native fallback will pick this up and run the review skill
    if (ctx.message) {
      ctx.message.text = prompt;
      const { handleText } = await import("../text-handler.ts");
      await handleText(ctx as Parameters<typeof handleText>[0]);
    }
  }
}

export async function handleCodexStatus(ctx: Context): Promise<void> {
  try {
    const proc = Bun.spawn(["npx", "@openai/codex", "login", "status"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const raw = await new Response(proc.stdout).text();
    await proc.exited;
    const status = stripAnsi(raw).trim();
    await ctx.reply(`Codex status: ${status || "unknown"}`);
  } catch (err) {
    logger.error({ err }, "codex status error");
    await ctx.reply("Error checking codex status.");
  }
}
