import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { projectService } from "../../services/project-service.ts";
import type { ProviderSelection } from "../../services/project-service.ts";
import { sql } from "../../memory/db.ts";
import { replyInThread } from "../format.ts";

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
 */
export function configLabels(cfg: ProviderSelection | undefined): { provider: string; model: string } {
  return {
    provider: cfg?.providerName?.trim() || "Claude",
    model: cfg?.model?.trim() || "default",
  };
}

/**
 * Build the /projects message body — text lines and the per-project keyboard
 * rows. Both render sites (the initial reply and the post-action re-render) call
 * this, so the per-project layout lives in exactly one place.
 *
 * Each settled project gets two rows:
 *   1. the action row — Stop/Start (left) | ⚙️ settings (right);
 *   2. an info row beneath it — provider name (left, under the action button)
 *      and the current model (right, under the gear) — so what each project runs
 *      on is readable at a glance, beside its controls.
 *
 * Provider and model used to repeat inside the text line ("· Provider/model");
 * they now live only in the info-row buttons, so that annotation is gone. The
 * info buttons are display-only: a `pminf:<id>` callback names the project and
 * its config and changes no state. A pending project shows its pending marker
 * but no controls — its settled state is unknown until the command completes.
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
    lines.push(`${isActive ? "🟢" : "⚪"} ${p.name}  (${p.path})`);

    keyboard
      .text(isActive ? `⏹ Stop ${p.name}` : `▶️ Start ${p.name}`, `proj:${isActive ? "stop" : "start"}:${p.id}`)
      .text("⚙️", `pmchg:${p.id}:prov`)
      .row();

    const { provider, model } = configLabels(selections.get(p.id));
    keyboard.text(provider, `pminf:${p.id}`).text(model, `pminf:${p.id}`).row();
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
  // no state change. The provider/model buttons under each action read as status.
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

  const action = parts[1]; // "start" | "stop" | "refresh" | "start_all"
  const id = Number(parts[2]);

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
    await projectService.stop(id);
  }

  await ctx.answerCallbackQuery({
    text: action === "start" ? `Starting ${project.name}...` : `Stopping ${project.name}...`,
  });

  await rerenderProjects(ctx);
}
