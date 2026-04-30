// Tests for the shared skill_view handler — Phase C extends Phase A's tests:
// B-06 (path traversal), FR-A-10 fast-path log, FR-C-6 lazy on-disk write,
// FR-C-7 use_count increment.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSkillView } from "../../utils/skill-handlers.ts";

class FakeSql {
  pgRows: Array<{ name: string; description: string; body: string }> = [];
  updateCount = 0;
  logRows: Array<{ skill_name: string; shell_count: number; errors_count: number }> = [];

  call = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> & { catch: any } => {
    const sqlText = strings.join("?");
    if (sqlText.includes("FROM agent_created_skills")) {
      const name = values[0] as string;
      const p = Promise.resolve(this.pgRows.filter((r) => r.name === name)) as Promise<unknown[]> & { catch: any };
      return p;
    }
    if (sqlText.includes("UPDATE agent_created_skills")) {
      this.updateCount++;
    }
    if (sqlText.includes("INSERT INTO skill_preprocess_log")) {
      this.logRows.push({
        skill_name: values[0] as string,
        shell_count: values[2] as number,
        errors_count: values[3] as number,
      });
    }
    const p = Promise.resolve([]) as Promise<unknown[]> & { catch: any };
    return p;
  };
}

function makeSqlContext(fake: FakeSql) {
  return { sql: fake.call };
}

let testDir: string;
let originalSkillsDir: string | undefined;

beforeEach(async () => {
  testDir = join(tmpdir(), `helyx-skill-handlers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
  originalSkillsDir = process.env.CLAUDE_SKILLS_DIR;
  process.env.CLAUDE_SKILLS_DIR = testDir;
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  if (originalSkillsDir === undefined) {
    delete process.env.CLAUDE_SKILLS_DIR;
  } else {
    process.env.CLAUDE_SKILLS_DIR = originalSkillsDir;
  }
});

describe("handleSkillView — name validation (B-06)", () => {
  test("rejects path-traversal name", async () => {
    const fake = new FakeSql();
    const result = await handleSkillView("../../etc/passwd", makeSqlContext(fake));
    expect(JSON.parse(result).error).toBe("invalid skill name");
    expect(fake.pgRows.length).toBe(0);
  });

  test("rejects uppercase / underscore", async () => {
    const fake = new FakeSql();
    const result = await handleSkillView("Bad_Name", makeSqlContext(fake));
    expect(JSON.parse(result).error).toBe("invalid skill name");
  });

  test("rejects empty / non-string", async () => {
    const fake = new FakeSql();
    expect(JSON.parse(await handleSkillView(undefined, makeSqlContext(fake))).error).toBe("invalid skill name");
    expect(JSON.parse(await handleSkillView("", makeSqlContext(fake))).error).toBe("invalid skill name");
  });

  test("accepts valid kebab-case", async () => {
    const fake = new FakeSql();
    const result = await handleSkillView("git-state", makeSqlContext(fake));
    expect(JSON.parse(result).error).toBe("skill not found");
  });
});

describe("handleSkillView — fast-path log policy (FR-A-10)", () => {
  test("filesystem skill with no shell tokens does NOT log", async () => {
    await mkdir(join(testDir, "static"), { recursive: true });
    await Bun.write(join(testDir, "static", "SKILL.md"), "# static body, no tokens");
    const fake = new FakeSql();
    const result = await handleSkillView("static", makeSqlContext(fake));
    expect(JSON.parse(result).body).toBe("# static body, no tokens");
    expect(fake.logRows.length).toBe(0);
  });

  test("filesystem skill with shell tokens logs once", async () => {
    await mkdir(join(testDir, "withshell"), { recursive: true });
    await Bun.write(
      join(testDir, "withshell", "SKILL.md"),
      "Today: !`echo hello`",
    );
    const fake = new FakeSql();
    const result = await handleSkillView("withshell", makeSqlContext(fake));
    expect(JSON.parse(result).body).toContain("hello");
    expect(fake.logRows.length).toBe(1);
    expect(fake.logRows[0].shell_count).toBe(1);
  });
});

describe("handleSkillView — agent-created skill on-disk write (FR-C-6)", () => {
  test("writes SKILL.md atomically on first read, increments use_count", async () => {
    const fake = new FakeSql();
    fake.pgRows.push({
      name: "agent-x",
      description: "Use when test",
      body: "# agent body, no tokens",
    });

    const result = await handleSkillView("agent-x", makeSqlContext(fake));
    expect(JSON.parse(result).name).toBe("agent-x");
    expect(fake.updateCount).toBe(1); // FR-C-7

    // FR-C-6: file materialized under agent-created/<name>/SKILL.md
    const filePath = join(testDir, "agent-created", "agent-x", "SKILL.md");
    const fileStat = await stat(filePath);
    expect(fileStat.size).toBeGreaterThan(0);
    const content = await Bun.file(filePath).text();
    expect(content).toBe("# agent body, no tokens");
  });

  test("does not log preprocess row when agent body has no tokens (FR-A-10)", async () => {
    const fake = new FakeSql();
    fake.pgRows.push({ name: "agent-y", description: "Use when test", body: "no tokens here" });
    await handleSkillView("agent-y", makeSqlContext(fake));
    expect(fake.logRows.length).toBe(0);
  });
});
