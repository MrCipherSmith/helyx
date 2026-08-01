import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  providerService,
  DEFAULT_PROVIDER_LABEL,
  fetchProviderModels,
  describeRefreshFailure,
} from "../../services/provider-service.ts";
import type { ProviderSummary, RefreshResult } from "../../services/provider-service.ts";
import { projectService } from "../../services/project-service.ts";
import { PROVIDER_PRESETS, findPreset } from "../providers/presets.ts";
import type { ProviderModel } from "../providers/presets.ts";
import { setPendingInput } from "../handlers.ts";
import { replyInThread } from "../format.ts";
import { logger } from "../../logger.ts";

/**
 * Telegram surface for provider registration and per-project provider/model
 * selection.
 *
 * Callback scheme (kept well under Telegram's 64-byte limit):
 *   prov:add                                  open the preset picker
 *   prov:preset:<key>                         start the add-flow for a preset
 *   prov:rm:<id>                              remove a provider
 *   pmchg:<projectId>:prov|model              open a change submenu
 *   pmsel:<projectId>:prov:<providerId|def>   select provider
 *   pmsel:<projectId>:model:<pid|def>:<idx>   select model by index
 *   pmref:<projectId>:<providerId|def>        refetch that provider's models
 *
 * Models are selected by index rather than id because a model id can exceed
 * the callback-data budget on its own.
 */

/**
 * Last-resort tiers for the default endpoint.
 *
 * Only reached when the default has never been refreshed and no key is
 * configured to refresh it with. Any hardcoded list goes stale, so this exists
 * to keep the picker usable, not to be correct.
 */
/**
 * How long each add-flow step waits for the operator's message.
 *
 * Two minutes was too short for the step that matters: the token prompt sends
 * the operator off to the provider's dashboard to mint a key, and by the time
 * they paste it back the pending handler has expired — so the message falls
 * through to the session as ordinary text and the flow appears to have ignored
 * it. Ten minutes covers a detour through a login page.
 */
const ADD_FLOW_TTL_MS = 10 * 60_000;

/**
 * How many model ids the add-flow echoes back for confirmation.
 *
 * OpenRouter answers with several hundred; joining all their ids runs past
 * Telegram's 4096-character message limit and the send fails outright, which is
 * indistinguishable from the bot having dropped the token. Accepting with "ok"
 * still stores the full list — only the preview is trimmed.
 */
const PREVIEW_MODEL_LIMIT = 30;

/**
 * How many models the picker draws buttons for.
 *
 * One row per model does not survive a provider with hundreds of them: the
 * keyboard is rejected and the operator gets no picker at all. Free models sort
 * first, so the cut falls on the paid tail.
 */
const PICKER_MODEL_LIMIT = 40;

export const FALLBACK_DEFAULT_MODELS: ProviderModel[] = [
  { id: "claude-sonnet-4-20250514", label: "Sonnet 4" },
  { id: "claude-opus-4-20250514", label: "Opus 4" },
  { id: "claude-3-5-haiku-20241022", label: "Haiku 3.5" },
];

/**
 * The models to offer for a provider, default included.
 *
 * Both cases render a stored list that `refreshModels` writes — the default's
 * from `bot_config` (passed in as `storedDefaults`), a registered provider's
 * from its own row — so refreshing behaves identically whichever is selected.
 * The hardcoded tiers appear only for a default that has never been refreshed.
 */
export function modelsFor(
  provider: ProviderSummary | null,
  storedDefaults: ProviderModel[] = [],
): ProviderModel[] {
  const own = provider ? ((provider.models ?? []) as ProviderModel[]) : storedDefaults;
  const offered = own.length ? own : provider ? [] : FALLBACK_DEFAULT_MODELS;
  return [{ id: "", label: "Provider default" }, ...offered];
}

/** Button text for a model — free tiers carry a marker so the top of the list reads as one. */
function modelButtonLabel(model: ProviderModel): string {
  return model.free ? `🆓 ${model.label}` : model.label;
}

/** A comma-separated id list short enough for one Telegram message. */
function previewModels(models: ProviderModel[]): string {
  const shown = models.slice(0, PREVIEW_MODEL_LIMIT);
  const hidden = models.length - shown.length;
  return shown.map((m) => m.id).join(", ") + (hidden > 0 ? `, … +${hidden} more` : "");
}

/** Stored default-provider models, or [] when a real provider is selected. */
async function storedDefaultsFor(providerId: number | null): Promise<ProviderModel[]> {
  return providerId === null ? providerService.getDefaultModels() : [];
}

// --- /providers ------------------------------------------------------------

export async function handleProviders(ctx: Context): Promise<void> {
  const providers = await providerService.list();
  const kb = new InlineKeyboard();

  const lines = ["<b>LLM providers</b>", ""];
  if (providers.length === 0) {
    lines.push("None registered — every project uses the default Anthropic endpoint.");
  } else {
    for (const p of providers) {
      const modelCount = (p.models ?? []).length;
      lines.push(`• <b>${p.name}</b> — <code>${p.base_url}</code>`);
      lines.push(`  ${p.auth_scheme} · ${modelCount} model(s)`);
      kb.text(`🗑 ${p.name}`, `prov:rm:${p.id}`).row();
    }
  }

  kb.text("➕ Add provider", "prov:add").row();
  await replyInThread(ctx, lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}

async function showPresetPicker(ctx: Context): Promise<void> {
  const kb = new InlineKeyboard();
  for (const preset of PROVIDER_PRESETS) {
    kb.text(preset.name, `prov:preset:${preset.key}`).row();
  }
  await ctx.editMessageText("Pick a provider to add:", { reply_markup: kb }).catch(async () => {
    await replyInThread(ctx, "Pick a provider to add:", { reply_markup: kb });
  });
}

/**
 * Add-flow. Three sequential prompts driven by setPendingInput: base URL (only
 * for Custom, otherwise prefilled), token, models.
 *
 * The token prompt tells the operator to delete their message: it reaches
 * Telegram's servers in plaintext, and helyx cannot undo that.
 */
async function startAddFlow(ctx: Context, presetKey: string): Promise<void> {
  const preset = findPreset(presetKey);
  if (!preset) {
    await ctx.answerCallbackQuery({ text: "Unknown preset" });
    return;
  }

  const askToken = async (baseUrl: string) => {
    await replyInThread(
      ctx,
      `<b>${preset.name}</b>\n<code>${baseUrl}</code>\n\nSend the API token (${preset.tokenHint}).\n` +
        `⚠️ Delete your message afterwards — Telegram keeps it otherwise.`,
      { parse_mode: "HTML" },
    );
    setPendingInput(ctx, async (tokenCtx) => {
      const token = tokenCtx.message?.text?.trim();
      if (!token) return;

      // Acknowledge before the network call. Asking the provider costs up to 16s
      // across both candidate paths, and an unacknowledged pause is exactly what
      // a dropped message looks like.
      await tokenCtx.reply(`Token received — asking ${preset.name} for its models…`).catch(() => {});

      // Ask the provider before offering anything hardcoded. A preset list is a
      // snapshot of whatever was current when it was written, and vendors move:
      // the GLM preset named 4.6 while z.ai was already shipping 5.2.
      const fetched = await fetchProviderModels(baseUrl, token, preset.authScheme);
      const offered = fetched ?? preset.models;
      const source = fetched
        ? `${offered.length} model(s) from ${preset.name}, free tiers first`
        : `Could not reach the provider's model list — falling back to presets`;

      await tokenCtx.reply(
        offered.length
          ? `${source}:\n${previewModels(offered)}\n\nSend "ok" to accept all, or your own comma-separated list.`
          : "Models, comma-separated (or \"none\"):",
      );
      setPendingInput(tokenCtx, async (modelsCtx) => {
        const raw = modelsCtx.message?.text?.trim() ?? "";
        let models: ProviderModel[];
        if (!raw || raw.toLowerCase() === "none") models = [];
        else if (raw.toLowerCase() === "ok") models = offered;
        else models = raw.split(",").map((s) => s.trim()).filter(Boolean).map((id) => ({ id, label: id }));

        try {
          const created = await providerService.create({
            name: preset.key === "custom" ? new URL(baseUrl).hostname : preset.name,
            baseUrl,
            authToken: token,
            authScheme: preset.authScheme,
            models,
          });
          await modelsCtx.reply(
            `✅ Added <b>${created.name}</b> with ${models.length} model(s).\n` +
              `Set it on a project from /projects → ⚙️.`,
            { parse_mode: "HTML" },
          );
        } catch (err: any) {
          await modelsCtx.reply(`❌ ${err?.message ?? "could not add provider"}`);
        }
      }, ADD_FLOW_TTL_MS);
    }, ADD_FLOW_TTL_MS);
  };

  if (preset.key === "custom") {
    await replyInThread(ctx, "Send the base URL (e.g. https://api.example.com/anthropic):");
    setPendingInput(ctx, async (urlCtx) => {
      const baseUrl = urlCtx.message?.text?.trim();
      if (!baseUrl) return;
      await askToken(baseUrl);
    }, ADD_FLOW_TTL_MS);
  } else {
    await askToken(preset.baseUrl);
  }
}

export async function handleProviderCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const parts = data.split(":");
  const action = parts[1];

  if (action === "add") {
    await ctx.answerCallbackQuery();
    await showPresetPicker(ctx);
    return;
  }

  if (action === "preset") {
    await ctx.answerCallbackQuery();
    await startAddFlow(ctx, parts[2] ?? "");
    return;
  }

  if (action === "rm") {
    const id = Number(parts[2]);
    if (!id) {
      await ctx.answerCallbackQuery({ text: "Invalid" });
      return;
    }
    const { removed, affectedProjects } = await providerService.remove(id);
    await ctx.answerCallbackQuery({ text: removed ? "Removed" : "Not found" });
    if (removed) {
      // Say which projects changed meaning — ON DELETE SET NULL moved them back
      // to the default endpoint, and they will not act on it until restarted.
      const note = affectedProjects.length
        ? `\n\n⚠️ Back on the default endpoint at next restart: ${affectedProjects.join(", ")}`
        : "";
      await replyInThread(ctx, `Provider removed.${note}`);
    }
    return;
  }

  await ctx.answerCallbackQuery({ text: "Unknown action" });
}

// --- per-project provider/model selection ----------------------------------

export async function showProviderPicker(ctx: Context, projectId: number, edit = true): Promise<void> {
  const [providers, selection] = await Promise.all([
    providerService.list(),
    projectService.getProviderSelection(projectId),
  ]);

  const kb = new InlineKeyboard();
  const currentId = selection?.providerId ?? null;
  kb.text(`${currentId === null ? "✅ " : ""}${DEFAULT_PROVIDER_LABEL}`, `pmsel:${projectId}:prov:def`).row();
  for (const p of providers) {
    kb.text(`${currentId === p.id ? "✅ " : ""}${p.name}`, `pmsel:${projectId}:prov:${p.id}`).row();
  }

  const text = providers.length
    ? "Choose a provider:"
    : "No providers registered yet — /providers to add one.";
  if (edit) {
    await ctx.editMessageText(text, { reply_markup: kb }).catch(async () => {
      await replyInThread(ctx, text, { reply_markup: kb });
    });
  } else {
    await replyInThread(ctx, text, { reply_markup: kb });
  }
}

async function showModelPicker(
  ctx: Context,
  projectId: number,
  providerId: number | null,
  note = "",
): Promise<void> {
  const [providers, selection, storedDefaults] = await Promise.all([
    providerService.list(),
    projectService.getProviderSelection(projectId),
    storedDefaultsFor(providerId),
  ]);
  const provider = providerId === null ? null : providers.find((p) => p.id === providerId) ?? null;
  const models = modelsFor(provider, storedDefaults);
  const current = selection?.model ?? "";

  const kb = new InlineKeyboard();
  // Sliced from the front, so a button's position still is its index in the
  // full list — which is what the pmsel callback resolves against.
  const shown = models.slice(0, PICKER_MODEL_LIMIT);
  shown.forEach((m, idx) => {
    const mark = m.id === current ? "✅ " : "";
    kb.text(`${mark}${modelButtonLabel(m)}`, `pmsel:${projectId}:model:${providerId ?? "def"}:${idx}`).row();
  });
  kb.text("🔄 Refresh list", `pmref:${projectId}:${providerId ?? "def"}`).row();

  const hidden = models.length - shown.length;
  const overflow = hidden > 0 ? `\n${hidden} more not shown — free tiers come first.` : "";
  const label = provider?.name ?? DEFAULT_PROVIDER_LABEL;
  const text = `Model for ${label}:${note ? `\n${note}` : ""}${overflow}`;
  await ctx.editMessageText(text, { reply_markup: kb }).catch(async () => {
    await replyInThread(ctx, text, { reply_markup: kb });
  });
}

/**
 * Apply a selection and restart the project.
 *
 * The restart is the point: provider config is resolved at launch inside
 * run-cli.sh, so a running session keeps its old endpoint until it is
 * restarted. Writing the row alone changes nothing the operator can see.
 */
async function applyAndRestart(ctx: Context, projectId: number, what: string): Promise<void> {
  const [project, selection] = await Promise.all([
    projectService.get(projectId),
    projectService.getProviderSelection(projectId),
  ]);
  if (!project) {
    await ctx.answerCallbackQuery({ text: "Project not found" });
    return;
  }

  const outcome = await projectService.restart(projectId, `provider/model change: ${what}`);
  const providerLabel = selection?.providerName ?? DEFAULT_PROVIDER_LABEL;
  const modelLabel = selection?.model || "provider default";

  const suffix = outcome === "skipped_already_pending"
    ? "\n(a restart was already queued — the new config applies to it)"
    : "";
  await ctx.editMessageText(
    `🔄 <b>${project.name}</b> restarting on ${providerLabel} · ${modelLabel}${suffix}`,
    { parse_mode: "HTML" },
  ).catch(() => {});
  logger.info({ projectId, provider: providerLabel, model: modelLabel, outcome }, "provider change applied");
}

export async function handleProjectModelCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const parts = data.split(":");

  // pmchg:<projectId>:prov|model — open a submenu
  if (parts[0] === "pmchg") {
    const projectId = Number(parts[1]);
    if (!projectId) {
      await ctx.answerCallbackQuery({ text: "Invalid" });
      return;
    }
    await ctx.answerCallbackQuery();
    if (parts[2] === "prov") {
      await showProviderPicker(ctx, projectId);
    } else {
      const selection = await projectService.getProviderSelection(projectId);
      await showModelPicker(ctx, projectId, selection?.providerId ?? null);
    }
    return;
  }

  // pmref:<projectId>:<providerId|def> — refetch and redraw
  if (parts[0] === "pmref") {
    const projectId = Number(parts[1]);
    if (!projectId) {
      await ctx.answerCallbackQuery({ text: "Invalid" });
      return;
    }
    const providerId = parts[2] === "def" ? null : Number(parts[2]);
    if (providerId !== null && !providerId) {
      await ctx.answerCallbackQuery({ text: "Invalid" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Asking the provider…" });
    const result: RefreshResult = await providerService.refreshModels(providerId).catch((err) => {
      logger.warn({ err, providerId }, "model refresh failed");
      return { ok: false, reason: "unreachable" } as const;
    });
    const note = result.ok
      ? `↻ ${result.models.length} model(s) from the provider`
      : `⚠️ ${describeRefreshFailure(result.reason)} — showing the stored list`;
    logger.info(
      { projectId, providerId, ok: result.ok, count: result.ok ? result.models.length : 0 },
      "model list refresh",
    );
    await showModelPicker(ctx, projectId, providerId, note);
    return;
  }

  // pmsel:<projectId>:prov:<id|def> | pmsel:<projectId>:model:<pid|def>:<idx>
  const projectId = Number(parts[1]);
  const kind = parts[2];
  if (!projectId || !kind) {
    await ctx.answerCallbackQuery({ text: "Invalid" });
    return;
  }

  if (kind === "prov") {
    const raw = parts[3];
    const providerId = raw === "def" ? null : Number(raw);
    await projectService.setProvider(projectId, providerId);
    // Switching provider invalidates a model belonging to the previous one.
    // Clearing it is safer than carrying a model the new endpoint rejects.
    await projectService.setModel(projectId, null);
    await ctx.answerCallbackQuery({ text: "Provider set — pick a model" });
    await showModelPicker(ctx, projectId, providerId);
    return;
  }

  if (kind === "model") {
    const rawProvider = parts[3];
    const providerId = rawProvider === "def" ? null : Number(rawProvider);
    const idx = Number(parts[4]);
    const [providers, storedDefaults] = await Promise.all([
      providerService.list(),
      storedDefaultsFor(providerId),
    ]);
    const provider = providerId === null ? null : providers.find((p) => p.id === providerId) ?? null;
    const models = modelsFor(provider, storedDefaults);
    const chosen = models[idx];
    if (!chosen) {
      await ctx.answerCallbackQuery({ text: "Unknown model" });
      return;
    }
    await projectService.setModel(projectId, chosen.id || null);
    await ctx.answerCallbackQuery({ text: "Applied — restarting" });
    await applyAndRestart(ctx, projectId, chosen.label);
    return;
  }

  await ctx.answerCallbackQuery({ text: "Unknown action" });
}
