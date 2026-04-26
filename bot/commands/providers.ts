/**
 * /providers — list configured model providers (read-only for Phase 3).
 * CRUD via Telegram is Phase 4+ scope.
 */
import type { Context } from "grammy";
import { sql } from "../../memory/db.ts";

export async function handleProviders(ctx: Context): Promise<void> {
  let rows: Array<{
    id: number; name: string; provider_type: string;
    base_url: string | null; default_model: string | null; enabled: boolean;
  }>;
  try {
    rows = await sql`
      SELECT id, name, provider_type, base_url, default_model, enabled
      FROM model_providers
      ORDER BY enabled DESC, name ASC
    ` as any;
  } catch (err) {
    await ctx.reply(
      "⚠️ <b>model_providers</b> table not available.\n\n" +
        "Run the migration first: <code>bun memory/db.ts</code>",
      { parse_mode: "HTML" },
    );
    return;
  }

  if (rows.length === 0) {
    await ctx.reply("No providers configured.");
    return;
  }

  const lines: string[] = ["<b>Configured providers</b>:"];
  for (const r of rows) {
    const status = r.enabled ? "✅" : "🚫";
    const baseUrl = r.base_url ? ` <i>(${r.base_url})</i>` : "";
    const defaultModel = r.default_model ? ` — default: <code>${r.default_model}</code>` : "";
    lines.push(`${status} <b>${r.name}</b> [${r.provider_type}]${baseUrl}${defaultModel}`);
  }
  lines.push("");
  lines.push("<i>Use /models to assign a model profile to this session.</i>");

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}
