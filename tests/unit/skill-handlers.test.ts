// Tests for the shared skill_view handler — Phase C extends Phase A's tests:
// B-06 (path traversal), FR-A-10 fast-path log, FR-C-6 lazy on-disk write,
// FR-C-7 use_count increment.
//
// The hand-rolled FakeSql this file used to carry now lives in
// tests/fixtures/fake-sql.ts, shared with the permission-lifecycle tests.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSkillView } from "../../utils/skill-handlers.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";

interface SkillRow {
  name: string;
  description: string;
  body: string;
}

/**
 * A fake database that answers the skill lookup from `rows` and records
 * everything else.
 *
 * The lookup filters by the interpolated name rather than returning the seed
 * unconditionally: `handleSkillView` is supposed to ask for the skill it was
 * given, and a fake that ignores the parameter would pass a handler that asked
 * for the wrong one.
 */
function makeDb(rows: SkillRow[] = []): FakeSql {
  const db = new FakeSql();
  db.program("FROM agent_created_skills", {
    rows: (values) => rows.filter((r) => r.name === values[0]),
  });
  return db;
}

function ctx(db: FakeSql) {
  return { sql: db.sql };
}

/** The `skill_preprocess_log` inserts, unpacked into the columns they carry. */
function logRows(db: FakeSql) {
  return db.matching("INSERT INTO skill_preprocess_log").map((q) => ({
    skill_name: q.values[0] as string,
    shell_count: q.values[2] as number,
    errors_count: q.values[3] as number,
  }));
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
    const db = makeDb();
    const result = await handleSkillView("../../etc/passwd", ctx(db));
    expect(JSON.parse(result).error).toBe("invalid skill name");
    // Rejected before the database is touched at all — the point of validating
    // first is that a traversal name never reaches a query.
    expect(db.queries).toHaveLength(0);
  });

  test("rejects uppercase / underscore", async () => {
    const db = makeDb();
    const result = await handleSkillView("Bad_Name", ctx(db));
    expect(JSON.parse(result).error).toBe("invalid skill name");
    expect(db.queries).toHaveLength(0);
  });

  test("rejects empty / non-string", async () => {
    const db = makeDb();
    expect(JSON.parse(await handleSkillView(undefined, ctx(db))).error).toBe("invalid skill name");
    expect(JSON.parse(await handleSkillView("", ctx(db))).error).toBe("invalid skill name");
    expect(db.queries).toHaveLength(0);
  });

  test("accepts valid kebab-case", async () => {
    const db = makeDb();
    const result = await handleSkillView("git-state", ctx(db));
    expect(JSON.parse(result).error).toBe("skill not found");
  });
});

describe("handleSkillView — fast-path log policy (FR-A-10)", () => {
  test("filesystem skill with no shell tokens does NOT log", async () => {
    await mkdir(join(testDir, "static"), { recursive: true });
    await Bun.write(join(testDir, "static", "SKILL.md"), "# static body, no tokens");
    const db = makeDb();
    const result = await handleSkillView("static", ctx(db));
    expect(JSON.parse(result).body).toBe("# static body, no tokens");
    expect(logRows(db)).toHaveLength(0);
  });

  test("filesystem skill with shell tokens logs once", async () => {
    await mkdir(join(testDir, "withshell"), { recursive: true });
    await Bun.write(
      join(testDir, "withshell", "SKILL.md"),
      "Today: !`echo hello`",
    );
    const db = makeDb();
    const result = await handleSkillView("withshell", ctx(db));
    expect(JSON.parse(result).body).toContain("hello");
    expect(logRows(db)).toHaveLength(1);
    expect(logRows(db)[0]!.shell_count).toBe(1);
  });
});

describe("handleSkillView — agent-created skill on-disk write (FR-C-6)", () => {
  test("writes SKILL.md atomically on first read, increments use_count", async () => {
    const db = makeDb([
      { name: "agent-x", description: "Use when test", body: "# agent body, no tokens" },
    ]);

    const result = await handleSkillView("agent-x", ctx(db));
    expect(JSON.parse(result).name).toBe("agent-x");
    expect(db.count("UPDATE agent_created_skills")).toBe(1); // FR-C-7

    // FR-C-6: file materialized under agent-created/<name>/SKILL.md
    const filePath = join(testDir, "agent-created", "agent-x", "SKILL.md");
    const fileStat = await stat(filePath);
    expect(fileStat.size).toBeGreaterThan(0);
    const content = await Bun.file(filePath).text();
    expect(content).toBe("# agent body, no tokens");
  });

  test("does not log preprocess row when agent body has no tokens (FR-A-10)", async () => {
    const db = makeDb([{ name: "agent-y", description: "Use when test", body: "no tokens here" }]);
    await handleSkillView("agent-y", ctx(db));
    expect(logRows(db)).toHaveLength(0);
  });
});
