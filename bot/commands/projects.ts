import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sql } from "../../memory/db.ts";
import { basename } from "path";

interface Project {
  name: string;
  path: string;
  provider?: string;
}

const PROJECTS_FILE = "/app/tmux-projects.json";

export async function loadProjects(): Promise<Project[]> {
  try {
    return JSON.parse(await Bun.file(PROJECTS_FILE).text());
  } catch {
    return [];
  }
}

export async function saveProjects(projects: Project[]): Promise<void> {
  await Bun.write(PROJECTS_FILE, JSON.stringify(projects, null, 2) + "\n");
}

export async function handleProjects(ctx: Context): Promise<void> {
  const projects = await loadProjects();

  if (projects.length === 0) {
    await ctx.reply("No projects configured.\nUse /project-add to add one.");
    return;
  }

  // Get active remote sessions for status check
  const active = await sql`
    SELECT project FROM sessions WHERE source = 'remote' AND status = 'active'
  `;
  const activeProjects = new Set(active.map((r: any) => r.project));

  const kb = new InlineKeyboard();
  const lines: string[] = ["Projects:\n"];

  for (const p of projects) {
    const isActive = activeProjects.has(p.name);
    const icon = isActive ? "🟢" : "⚫";
    lines.push(`${icon} ${p.name}  (${p.path})`);
    if (isActive) {
      kb.text(`⏹ Stop ${p.name}`, `proj:stop:${p.name}`).row();
    } else {
      kb.text(`▶️ Start ${p.name}`, `proj:start:${p.name}`).row();
    }
  }

  await ctx.reply(lines.join("\n"), { reply_markup: kb });
}

export async function handleProjectCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const parts = data.split(":");
  const action = parts[1]; // "start" | "stop"
  const name = parts.slice(2).join(":"); // project name

  if (!action || !name) {
    await ctx.answerCallbackQuery({ text: "Invalid" });
    return;
  }

  const projects = await loadProjects();
  const project = projects.find((p) => p.name === name);

  if (!project && action === "start") {
    await ctx.answerCallbackQuery({ text: "Project not found" });
    return;
  }

  await sql`
    INSERT INTO admin_commands (command, payload)
    VALUES (
      ${action === "start" ? "proj_start" : "proj_stop"},
      ${JSON.stringify({ name, path: project?.path ?? "" })}::jsonb
    )
  `;

  await ctx.answerCallbackQuery({
    text: action === "start" ? `Starting ${name}...` : `Stopping ${name}...`,
  });

  // Refresh the message
  await ctx.deleteMessage().catch(() => {});
  await handleProjects(ctx);
}
