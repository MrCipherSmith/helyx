// Shared handler logic for the skill_view MCP tool — used by both
// `mcp/tools.ts` (Claude Code subprocess MCP) and `channel/tools.ts`
// (host-side dispatch).
//
// Phase A: filesystem-backed skill loading + inline shell expansion.
// Phase C extension: agent_created_skills lookup + FR-C-6 lazy on-disk
// write + FR-C-7 use_count increment.

import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import {
  expandInlineShell,
  hasInlineShellTokens,
  parseFrontmatter,
} from "./skill-preprocessor.ts";

const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const AGENT_DIR_SUBPATH = "agent-created";

export interface SkillSqlContext {
  // Tagged-template SQL function (postgres.js).
  sql: any;
}

export function getSkillsDir(): string {
  return process.env.CLAUDE_SKILLS_DIR ?? `${process.env.HOME}/.claude/skills`;
}

// FR-C-6: atomic write of agent-created SKILL.md so Claude Code's native
// loader can also find it. tempFile + rename is the atomicity guarantee.
async function ensureAgentSkillFile(
  skillsDir: string,
  name: string,
  body: string,
): Promise<void> {
  const dir = `${skillsDir}/${AGENT_DIR_SUBPATH}/${name}`;
  const finalPath = `${dir}/SKILL.md`;
  const expectedSize = Buffer.byteLength(body, "utf8");

  try {
    const fileStat = await stat(finalPath);
    if (fileStat.size === expectedSize) return;
  } catch {
    // ENOENT — fall through to create.
  }

  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, body, { encoding: "utf8", mode: 0o600 });
  await rename(tmpPath, finalPath);
}

export async function handleSkillView(
  rawSkillName: unknown,
  ctx: SkillSqlContext,
): Promise<string> {
  const skillName = String(rawSkillName ?? "");
  // B-06: path-traversal guard — reject anything outside the kebab-case grammar
  // before either filesystem or SQL access.
  if (!NAME_RE.test(skillName)) {
    return JSON.stringify({ error: "invalid skill name", name: skillName });
  }

  const skillsDir = getSkillsDir();
  const startTime = Date.now();

  // 1) Postgres-backed agent-created skill takes precedence.
  const pgSkills = await ctx.sql`
    SELECT name, description, body FROM agent_created_skills
    WHERE name = ${skillName} AND status = 'active'
    LIMIT 1
  `;

  if (pgSkills.length > 0) {
    const row = pgSkills[0] as {
      name: string;
      description: string;
      body: string;
    };

    // FR-C-7: increment use_count + last_used_at. Awaited so transient pool
    // exhaustion surfaces in logs rather than silently dropping increments.
    try {
      await ctx.sql`
        UPDATE agent_created_skills
        SET use_count = use_count + 1, last_used_at = now()
        WHERE name = ${skillName}
      `;
    } catch (err) {
      console.warn("[skill_view] use_count update failed:", err);
    }

    // FR-C-6: lazy on-disk materialization for native Claude Code loading.
    try {
      await ensureAgentSkillFile(skillsDir, row.name, row.body);
    } catch (err) {
      console.warn("[skill_view] disk write failed:", err);
    }

    const expanded = await expandInlineShell(row.body);
    const durationMs = Date.now() - startTime;

    // FR-A-10 (aligned with PRD acceptance): log only when shell tokens were
    // actually expanded or errored.
    if (expanded.shellCount > 0 || expanded.errorsCount > 0) {
      ctx.sql`
        INSERT INTO skill_preprocess_log
          (skill_name, duration_ms, shell_count, errors_count, first_error)
        VALUES
          (${skillName}, ${durationMs}, ${expanded.shellCount}, ${expanded.errorsCount}, ${expanded.firstError ?? null})
      `.catch((err: unknown) =>
        console.warn("[skill_view] preprocess log failed:", err),
      );
    }

    return JSON.stringify({
      name: row.name,
      description: row.description,
      body: expanded.body,
      frontmatter: {},
    });
  }

  // 2) Filesystem skill (goodai-base, demo, native Claude Code skills).
  const skillPath = `${skillsDir}/${skillName}/SKILL.md`;
  const file = Bun.file(skillPath);
  if (!(await file.exists())) {
    return JSON.stringify({ error: "skill not found", name: skillName });
  }

  const raw = await file.text();

  // FR-A-8 fast path: no tokens → byte-identical to native loader, no log.
  if (!hasInlineShellTokens(raw)) {
    const { frontmatter, body } = parseFrontmatter(raw);
    return JSON.stringify({
      name: skillName,
      description: frontmatter.description ?? "",
      body,
      frontmatter,
    });
  }

  const expanded = await expandInlineShell(raw);
  const { frontmatter } = parseFrontmatter(raw);
  const durationMs = Date.now() - startTime;

  ctx.sql`
    INSERT INTO skill_preprocess_log
      (skill_name, duration_ms, shell_count, errors_count, first_error)
    VALUES
      (${skillName}, ${durationMs}, ${expanded.shellCount}, ${expanded.errorsCount}, ${expanded.firstError ?? null})
  `.catch((err: unknown) =>
    console.warn("[skill_view] preprocess log failed:", err),
  );

  return JSON.stringify({
    name: skillName,
    description: frontmatter.description ?? "",
    body: expanded.body,
    frontmatter,
  });
}
