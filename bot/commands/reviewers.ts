/**
 * `/reviewers` — manage the independent code reviewers.
 *
 * The review pipeline runs every enabled reviewer in parallel on a review
 * request (see `services/reviewer-service.ts`). These commands list them,
 * add/remove them, pick their models, and check whether each is currently
 * available (Codex login, provider balance).
 */

import type { Context } from "grammy";
import {
  defaultReviewers,
  getReviewerStatuses,
  getReviewers,
  setReviewers,
  type Reviewer,
} from "../../services/reviewer-service.ts";
import { providerService } from "../../services/provider-service.ts";

/** Render one reviewer line for /reviewers. */
function renderReviewer(r: Reviewer): string {
  const target = r.kind === "codex" ? "codex" : `provider #${r.providerId}`;
  return `${r.enabled ? "🟢" : "⚪️"} ${r.id} — ${r.model} (${target})`;
}

export async function handleReviewers(ctx: Context): Promise<void> {
  const reviewers = await getReviewers();
  const lines = reviewers.map(renderReviewer);
  const header = "Reviewers (run in parallel on a review):\n";
  await ctx.reply(header + (lines.join("\n") || "(none)") + "\n\nUse /reviewers status, /reviewers add, /reviewers remove <id>, /reviewers default.");
}

export async function handleReviewersStatus(ctx: Context): Promise<void> {
  const statuses = await getReviewerStatuses();
  const lines = statuses.map((s) => `${s.available ? "🟢" : "🔴"} ${s.label} (${s.model}) — ${s.detail}`);
  await ctx.reply("Reviewer availability:\n" + (lines.join("\n") || "(none)"));
}

export async function handleReviewersAdd(ctx: Context): Promise<void> {
  const args = (ctx.message?.text ?? "").replace(/^\/reviewers_add\s*/, "").trim();
  const parts = args.split(/\s+/).filter(Boolean);

  if (parts[0] === "codex") {
    const model = parts[1] ?? process.env.CODEX_MODEL ?? "gpt-5.6-sol";
    const reviewers = await getReviewers();
    if (reviewers.some((r) => r.id === "codex")) {
      await ctx.reply("Codex reviewer already exists. Use /reviewers remove codex first, or pick its model in config.");
      return;
    }
    await setReviewers([...reviewers, { id: "codex", kind: "codex", model, enabled: true }]);
    await ctx.reply(`Added Codex reviewer (${model}).`);
    return;
  }

  if (parts[0] === "provider") {
    const [ref, model] = [parts[1], parts[2]];
    if (!ref || !model) {
      await ctx.reply("Usage: /reviewers add provider <name|id> <model>\n  e.g. /reviewers add provider DeepSeek deepseek-v4-pro");
      return;
    }
    const provider = /^\d+$/.test(ref)
      ? await providerService.get(Number(ref))
      : await providerService.getByName(ref);
    if (!provider) {
      await ctx.reply(`Provider "${ref}" not found. See /providers.`);
      return;
    }
    const id = `provider:${provider.id}`;
    const reviewers = await getReviewers();
    if (reviewers.some((r) => r.id === id)) {
      await ctx.reply(`A reviewer for ${provider.name} already exists. Remove it first: /reviewers remove ${id}`);
      return;
    }
    await setReviewers([...reviewers, { id, kind: "provider", providerId: provider.id, model, enabled: true }]);
    await ctx.reply(`Added ${provider.name} reviewer (${model}).`);
    return;
  }

  await ctx.reply("Usage:\n  /reviewers add codex [model]\n  /reviewers add provider <name|id> <model>");
}

export async function handleReviewersRemove(ctx: Context): Promise<void> {
  const id = (ctx.message?.text ?? "").replace(/^\/reviewers_remove\s*/, "").trim();
  if (!id) {
    await ctx.reply("Usage: /reviewers remove <id>  (e.g. codex, provider:4)");
    return;
  }
  const reviewers = await getReviewers();
  const next = reviewers.filter((r) => r.id !== id);
  if (next.length === reviewers.length) {
    await ctx.reply(`No reviewer with id "${id}".`);
    return;
  }
  await setReviewers(next);
  await ctx.reply(`Removed reviewer "${id}".`);
}

export async function handleReviewersDefault(ctx: Context): Promise<void> {
  const defaults = await defaultReviewers();
  await setReviewers(defaults);
  await ctx.reply("Reviewers reset to default:\n" + defaults.map(renderReviewer).join("\n"));
}
