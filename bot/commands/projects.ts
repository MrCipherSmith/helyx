import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { projectService } from "../../services/project-service.ts";
import type { ProviderSelection } from "../../services/project-service.ts";
import { sql } from "../../memory/db.ts";
import { replyInThread } from "../format.ts";
import { providerLabels } from "../../utils/supervisor-status.ts";
import { beginRestartConfirmation } from "../restart-confirm.ts";

async function getPendingActions(): Promise<Map<number, "start" | "stop">> {
  const rows = await sql`
    SELECT payload, command FROM admin_commands
    WHERE command IN ('proj_start', 'proj_stop') AND status IN ('pending', 'processing')
  `;
  const map = new Map<number, "start" | "stop">();
  for (const row of rows) {
    const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    const id = Number(payload.project_id);
    if (id) map.set(id, row.command === "proj_start" ? "start" : "stop");
  }
  return map;
}

/** Provider/model selection per project, for the annotation in the list. */
async function getSelections(ids: number[]): Promise<Map<number, ProviderSelection>> {
  const map = new Map<number, ProviderSelection>();
  if (ids.length === 0) return map;
  const rows = await sql`
    SELECT pr.id, pr.model, pv.id AS provider_id, pv.name AS provider_name
    FROM projects pr
    LEFT JOIN providers pv ON pv.id = pr.provider_id
    WHERE pr.id = ANY(${ids})
  `;
  for (const row of rows) {
    map.set(Number(row.id), {
      providerId: row.provider_id ?? null,
      providerName: row.provider_name ?? null,
      model: row.model ?? null,
    });
  }
  return map;
}

/** The slice of a project row that the list rendering depends on. */
export type ProjectListItem = { id: number; name: string; path: string; session_status: string | null };

/**
 * The two labels a project's info row carries, never empty.
 *
 * Telegram refuses a button with empty text, and refuses the whole message with
 * it — one blank label would cost the operator the entire list, not one button.
 * `projects.model` is free-form TEXT and resolve-provider-env already guards
 * against a blank one, so trim-to-default rather than null-coalesce.
 *
 * The defaults themselves moved to `utils/supervisor-status.ts` when the
 * supervisor's session list started naming the same pair: "Claude" and "default"
 * are a statement about what a null column means, and two copies of it would
 * disagree the first time either one changed.
 */
export function configLabels(cfg: ProviderSelection | undefined): { provider: string; model: string } {
  return providerLabels(cfg);
}

/**
 * Build the /projects message body — text lines and the per-project keyboard
 * rows. Both render sites (the initial reply and the post-action re-render) call
 * this, so the per-project layout lives in exactly one place.
 *
 * Telegram renders the text block and the keyboard as two separate areas: every
 * project's status line sits together at the top, and every project's buttons
 * sit together, stacked, below — with nothing but row order tying a button back
 * to the project it belongs to. With more than a handful of projects that stack
 * reads as an undifferentiated wall of "⏹", "⚙️", "🧹" (screenshot-reported,
 * 2026-09-04). Each project now gets a header row first — its status emoji and
 * name, own full-width row, tapping it answers the same provider/model toast
 * `pminf:` always has — so the eye has a name to anchor to before the icons.
 *
 * Provider and model were briefly moved out of the text and into a second row
 * of display-only buttons, one under each control. It reads well in a mockup
 * and badly on a phone: Telegram sizes an inline button to its row, so two
 * buttons share the width and a label like `deepseek-v4-pro` or
 * `geekom-model-1` is truncated to something that no longer names the model.
 * The text line has the full width and does not truncate, which is the whole
 * reason it is the right place for a value the operator reads rather than
 * presses. They stayed there.
 *
 * The controls themselves are icon-only now, not `⏹ Stop keryx` — the header
 * row above already names the project, so the label was pure repetition, and
 * dropping it is what lets Stop/⚙️/🧹 share one row instead of two.
 *
 * A pending project shows its pending marker but no controls: its settled state
 * is unknown until the command completes.
 *
 * The trailing rows are the only thing the two sites ever disagreed about, so
 * they are a parameter rather than a second copy of the loop. `fresh` is the
 * reply to /projects: Start All when more than one project is stopped, Refresh
 * while anything is pending. `rerender` is the in-place edit after an action,
 * which always offers Refresh (something is pending by definition) and never
 * Start All.
 */
export function renderProjectsMessage(
  projects: ProjectListItem[],
  selections: Map<number, ProviderSelection>,
  pending: Map<number, "start" | "stop">,
  variant: "fresh" | "rerender" = "fresh",
): { text: string; keyboard: InlineKeyboard } {
  const lines: string[] = ["Projects:\n"];
  const keyboard = new InlineKeyboard();

  for (const p of projects) {
    const pendingAction = pending.get(p.id);
    if (pendingAction) {
      lines.push(`${pendingAction === "start" ? "⏳▶️" : "⏳⏹"} ${p.name}  (${p.path})`);
      continue;
    }
    const isActive = p.session_status === "active";
    const statusEmoji = isActive ? "🟢" : "⚪";
    const { provider, model } = configLabels(selections.get(p.id));
    lines.push(`${statusEmoji} ${p.name}  (${p.path})  ·  ${provider} / ${model}`);

    keyboard.text(`${statusEmoji} ${p.name}`, `pminf:${p.id}`).row();

    if (isActive) {
      keyboard
        .text("⏹", `proj:stop:${p.id}`)
        .text("⚙️", `pmchg:${p.id}:prov`)
        .text("🧹", `proj:clearctx:${p.id}`)
        .row();
    } else {
      keyboard.text("▶️", `proj:start:${p.id}`).text("⚙️", `pmchg:${p.id}:prov`).row();
    }
  }

  if (variant === "rerender") {
    keyboard.text("🔄 Refresh", "proj:refresh").row();
  } else {
    const stopped = projects.filter((p) => p.session_status !== "active" && !pending.has(p.id));
    if (stopped.length > 1) keyboard.text("▶️ Start All", "proj:start_all").row();
    if (pending.size > 0) keyboard.text("🔄 Refresh", "proj:refresh").row();
  }

  return { text: lines.join("\n"), keyboard };
}

/**
 * Re-render the list by editing the current message in place.
 *
 * Telegram refuses to edit a message whose text+keyboard are unchanged, and one
 * older than 48h; the catch covers both ("not modified" is a no-op, anything
 * else falls back to delete + resend). Used after a start/stop/start_all changes
 * state so the operator sees the new status without a second message.
 */
async function rerenderProjects(ctx: Context): Promise<void> {
  const [projects, pending] = await Promise.all([projectService.list(), getPendingActions()]);
  const selections = await getSelections(projects.map((p) => p.id));
  const { text, keyboard } = renderProjectsMessage(projects, selections, pending, "rerender");
  await ctx.editMessageText(text, { reply_markup: keyboard }).catch(async (err: any) => {
    // Ignore "message is not modified" — content unchanged, nothing to do
    if (err?.description?.includes("not modified") || err?.message?.includes("not modified")) return;
    // For other errors (e.g. message too old to edit), delete and re-send
    await ctx.deleteMessage().catch(() => {});
    await replyInThread(ctx, text, { reply_markup: keyboard });
  });
}

export async function handleProjects(ctx: Context): Promise<void> {
  const [projects, pending] = await Promise.all([
    projectService.list(),
    getPendingActions(),
  ]);

  if (projects.length === 0) {
    await replyInThread(ctx, "No projects configured.\nUse /project-add to add one.");
    return;
  }

  const selections = await getSelections(projects.map((p) => p.id));
  const { text, keyboard } = renderProjectsMessage(projects, selections, pending, "fresh");

  await replyInThread(ctx, text, { reply_markup: keyboard });
}

export async function handleProjectCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const parts = data.split(":");

  // pminf:<projectId> — display-only: answer with the project's current config,
  // no state change. Now doubles as each project's header row (see
  // renderProjectsMessage) — the icon-only controls below it dropped the name
  // from their labels, so this is where a tap still gets it back.
  //
  // The absence of a row means the project is gone, not that it is on stock
  // Claude: an old /projects message outlives a `/project-remove`, and answering
  // "Claude / default" would describe a project that no longer exists. Only a
  // row with null columns is a default configuration.
  if (parts[0] === "pminf") {
    const id = Number(parts[1]);
    if (!id) {
      await ctx.answerCallbackQuery({ text: "Unknown project" });
      return;
    }
    const [project, selections] = await Promise.all([projectService.get(id), getSelections([id])]);
    if (!project || !selections.has(id)) {
      await ctx.answerCallbackQuery({ text: "Project not found" });
      return;
    }
    const { provider, model } = configLabels(selections.get(id));
    // Names the project: with several on screen the toast is otherwise
    // ambiguous, and it repeats the two labels the operator just tapped.
    await ctx.answerCallbackQuery({ text: `${project.name}: ${provider} / ${model} — ⚙️ to change` });
    return;
  }

  const action = parts[1]; // "start" | "stop" | "refresh" | "start_all" | "clearctx" | "clearctx_go" | "clearctx_cancel"
  const id = Number(parts[2]);

  // 🧹 Clear context — /clear discards the ENTIRE conversation history for
  // that project's session, not just whatever prompted the tap, so this gets
  // its own explicit confirm/cancel step rather than firing straight from the
  // list — the same reasoning `proj_stop` already gets a gate for, though
  // this isn't a restart/downtime action so it doesn't go through
  // `beginRestartConfirmation`'s fingerprint model (that module gates
  // `half`/`scope`/`downtime`, none of which apply to clearing a transcript).
  if (action === "clearctx" || action === "clearctx_go" || action === "clearctx_cancel") {
    const project = await projectService.get(id);
    if (!project) {
      await ctx.answerCallbackQuery({ text: "Project not found" });
      return;
    }

    if (action === "clearctx") {
      await ctx.answerCallbackQuery();
      const confirmKeyboard = new InlineKeyboard()
        .text(`🧹 Yes, clear ${project.name}`, `proj:clearctx_go:${id}`)
        .row()
        .text("Cancel", `proj:clearctx_cancel:${id}`);
      await ctx.editMessageText(
        `Clear ${project.name}'s context? This sends /clear to the live session — it discards the whole conversation history, not just the last task.`,
        { reply_markup: confirmKeyboard },
      );
      return;
    }

    if (action === "clearctx_cancel") {
      await ctx.answerCallbackQuery({ text: "Cancelled" });
      await rerenderProjects(ctx);
      return;
    }

    // clearctx_go
    await sql`
      INSERT INTO admin_commands (command, payload)
      VALUES ('tmux_send_keys', ${sql.json({ project: project.name, action: "clear_context" })})
    `;
    await ctx.answerCallbackQuery({ text: `🧹 Clearing ${project.name}'s context...` });
    await rerenderProjects(ctx);
    return;
  }

  if (action === "refresh") {
    await ctx.answerCallbackQuery({ text: "Refreshed" });
    await ctx.deleteMessage().catch(() => {});
    await handleProjects(ctx);
    return;
  }

  if (action === "start_all") {
    const [allProjects, pendingNow] = await Promise.all([
      projectService.list(),
      getPendingActions(),
    ]);
    const toStart = allProjects.filter(
      (p) => p.session_status !== "active" && !pendingNow.has(p.id),
    );
    await Promise.all(toStart.map((p) => projectService.start(p.id)));
    await ctx.answerCallbackQuery({ text: `Starting ${toStart.length} project(s)...` });
    await ctx.deleteMessage().catch(() => {});
    await handleProjects(ctx);
    return;
  }

  if (!action || !id) {
    await ctx.answerCallbackQuery({ text: "Invalid" });
    return;
  }

  const [project, pendingBefore] = await Promise.all([
    projectService.get(id),
    getPendingActions(),
  ]);
  if (!project) {
    await ctx.answerCallbackQuery({ text: "Project not found" });
    return;
  }

  // Idempotency: skip if there's already a pending/processing command for this project
  const alreadyPending = pendingBefore.get(id);
  if (alreadyPending) {
    await ctx.answerCallbackQuery({ text: `Already ${alreadyPending === "start" ? "starting" : "stopping"} ${project.name}...` });
    return;
  }

  if (action === "start") {
    await projectService.start(id);
  } else {
    // A2 — `proj_stop` is gated (CLAUDE.md names this button as *the* way to
    // stop one project's session, and F1/2026-08-12 found it enqueueing with
    // no grant and silently dying at the daemon). Same two-tap flow as
    // `/system`'s buttons: state the fingerprint, wait for `grant:go:<id>`,
    // only then enqueue. `project.path` is always set (from `projects`), so
    // this always has a fingerprint and always shows the confirmation.
    const gated = await beginRestartConfirmation(ctx, "proj_stop", {
      project_id: project.id,
      path: project.path,
      name: project.name,
      tmux_session_name: project.tmux_session_name,
    });
    if (gated) return;
    // Unreachable in practice — `proj_stop` always derives a fingerprint from
    // a real project's `path` — but if `fingerprintOf` ever disagreed with
    // this call site about what "gated" means, falling through to the old
    // direct-enqueue would be exactly the silent bypass F1 found. Refuse
    // instead.
    await ctx.answerCallbackQuery({ text: "Could not start the stop confirmation — try /system" });
    return;
  }

  await ctx.answerCallbackQuery({
    text: `Starting ${project.name}...`,
  });

  await rerenderProjects(ctx);
}
