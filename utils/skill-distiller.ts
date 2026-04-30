import { resolve } from "node:path";
import { sql } from "../memory/db.ts";
import { callAuxLlm } from "./aux-llm-client.ts";

const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_DESCRIPTION = 1024;
const MAX_BODY = 100000;
const SHELL_TOKEN_RE = /!`[^`\n]+`/;

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationWarning {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export function validateSkillInput(
  name: string,
  description: string,
  body: string,
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  if (!NAME_RE.test(name)) {
    errors.push({ field: "name", message: "name must be kebab-case, 1-64 chars, lowercase + digits + hyphens only" });
  }

  if (!description.startsWith("Use when")) {
    errors.push({ field: "description", message: 'description must start with "Use when"' });
  }

  if (description.length > MAX_DESCRIPTION) {
    errors.push({ field: "description", message: `description too long (max ${MAX_DESCRIPTION} chars)` });
  }

  if (body.length > MAX_BODY) {
    errors.push({ field: "body", message: `body too long (max ${MAX_BODY} chars)` });
  }

  // Frontmatter sanity: if it opens with ---, require a closing --- and at
  // least one key-value line. Anything tighter than this is left to YAML
  // parsers downstream — Bun has no built-in YAML parser and we don't want a
  // dep just for validation.
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end <= 0) {
      errors.push({ field: "body", message: "frontmatter is missing closing ---" });
    } else {
      const fmText = body.slice(4, end);
      const hasAnyKey = fmText.split("\n").some((line) => /^[A-Za-z_][\w-]*\s*:/.test(line));
      if (!hasAnyKey) {
        errors.push({ field: "body", message: "frontmatter has no key:value pairs" });
      }
    }
  }

  // M-08: warn (don't block) when LLM-generated body contains `!`...`` shell
  // tokens. The Telegram approval message surfaces these warnings so the
  // user sees the shell content before clicking [Save].
  if (SHELL_TOKEN_RE.test(body)) {
    warnings.push({
      field: "body",
      message: "body contains inline shell tokens (!`cmd`) — review carefully before approval",
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}

// Prompt lives in prompts/skill-distillation.md so it can be tuned without a
// code change. Resolved against this file's directory so the path is stable
// across cwd changes.
let cachedDistillationPrompt: string | undefined;
async function getDistillationPrompt(): Promise<string> {
  if (cachedDistillationPrompt !== undefined) return cachedDistillationPrompt;
  const path = resolve(import.meta.dir, "../prompts/skill-distillation.md");
  cachedDistillationPrompt = await Bun.file(path).text();
  return cachedDistillationPrompt;
}

export interface DistillResult {
  success: boolean;
  name?: string;
  description?: string;
  body?: string;
  skillId?: number;
  warnings?: string[];
  error?: string;
}

export async function distillSkill(
  sessionId: number,
  chatId: string,
  transcript: string,
): Promise<DistillResult> {
  const truncated = transcript.length > 16000
    ? "[…earlier truncated…]\n" + transcript.slice(-16000)
    : transcript;

  const systemPrompt = await getDistillationPrompt();
  const llmResult = await callAuxLlm(
    systemPrompt,
    `Transcript:\n${truncated}`,
    "skill_distillation",
  );

  if (!("content" in llmResult)) {
    return { success: false, error: llmResult.error };
  }

  const content = llmResult.content;
  const nameMatch = content.match(/^name:\s*(\S+)/m);
  const descMatch = content.match(/^description:\s*(.+)/m);

  if (!nameMatch || !descMatch) {
    return { success: false, error: "LLM output missing name or description" };
  }

  const name = nameMatch[1]!;
  // m-03: strip surrounding quotes — the prompt schema asks for
  // `description: "Use when …"`, which the LLM faithfully reproduces.
  // Without stripping, validateSkillInput's `startsWith("Use when")` check
  // fails on the literal `"` character.
  const description = descMatch[1]!.trim().replace(/^["']|["']$/g, "");
  const body = content;

  const validation = validateSkillInput(name, description, body);
  if (!validation.valid) {
    return { success: false, error: validation.errors.map((e) => e.message).join("; ") };
  }

  try {
    const [row] = await sql`
      INSERT INTO agent_created_skills (name, description, body, status, source_session_id, source_chat_id)
      VALUES (${name}, ${description}, ${body}, 'proposed', ${sessionId}, ${chatId})
      RETURNING id
    `;
    return {
      success: true,
      name,
      description,
      body,
      skillId: row.id,
      warnings: validation.warnings.map((w) => w.message),
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes("unique")) {
      return { success: false, error: "name already exists" };
    }
    return { success: false, error: String(err) };
  }
}

export async function listAgentSkills() {
  return sql`
    SELECT name, description, status, use_count, last_used_at, created_at
    FROM agent_created_skills
    WHERE status = 'active'
    ORDER BY last_used_at DESC
  `;
}

export async function approveSkill(skillId: number): Promise<boolean> {
  const result = await sql`
    UPDATE agent_created_skills
    SET status = 'active', approved_at = now()
    WHERE id = ${skillId} AND status = 'proposed'
    RETURNING id
  `;
  return result.length > 0;
}

export async function rejectSkill(skillId: number): Promise<boolean> {
  const result = await sql`
    UPDATE agent_created_skills
    SET status = 'rejected', rejected_at = now()
    WHERE id = ${skillId} AND status = 'proposed'
    RETURNING id
  `;
  return result.length > 0;
}