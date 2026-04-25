import { describe, test, expect } from "bun:test";
import type { DecomposeOptions, DecomposeResult } from "../../agents/orchestrator.ts";

describe("decomposeTask: types and contract", () => {
  test("DecomposeOptions accepts all expected fields", () => {
    const opts: DecomposeOptions = {
      modelProfileId: 1,
      modelProfileName: "deepseek-default",
      maxSubtasks: 5,
      minSubtasks: 2,
      systemPrompt: "custom",
    };
    expect(opts.modelProfileId).toBe(1);
  });

  test("DecomposeOptions all fields optional", () => {
    const opts: DecomposeOptions = {};
    expect(opts).toEqual({});
  });

  test("DecomposeResult shape — minimal required fields", () => {
    const stub: DecomposeResult = {
      parentTask: {
        id: 1,
        agentInstanceId: null,
        parentTaskId: null,
        title: "x",
        description: null,
        status: "pending",
        payload: {},
        result: null,
        priority: 0,
        createdAt: new Date(),
        startedAt: null,
        completedAt: null,
        updatedAt: new Date(),
      },
      subtasks: [],
      rawLlmResponse: "{}",
      attempts: 1,
    };
    expect(stub.attempts).toBe(1);
  });

  test("orchestrator.decomposeTask is a function", async () => {
    const mod = await import("../../agents/orchestrator.ts");
    expect(typeof mod.orchestrator.decomposeTask).toBe("function");
  });

  test("decomposeTask rejects when task id is not found", async () => {
    const mod = await import("../../agents/orchestrator.ts");
    await expect(mod.orchestrator.decomposeTask(999999999)).rejects.toThrow(/not found/);
  });
});

describe("decomposeTask: JSON parsing patterns (verifies markdown-fence handling logic)", () => {
  // These tests demonstrate the same parsing logic used in decomposeTask:
  // strip ```json or ``` fences, then JSON.parse, then schema validate.

  function stripFences(text: string): string {
    let t = text.trim();
    if (t.startsWith("```json")) t = t.slice(7);
    else if (t.startsWith("```")) t = t.slice(3);
    if (t.endsWith("```")) t = t.slice(0, -3);
    return t.trim();
  }

  test("plain JSON passes through unchanged", () => {
    const input = '{"subtasks":[{"title":"a"}]}';
    expect(stripFences(input)).toBe(input);
  });

  test("strips ```json...``` fences", () => {
    const input = '```json\n{"subtasks":[]}\n```';
    expect(stripFences(input)).toBe('{"subtasks":[]}');
  });

  test("strips ``` (no language tag) fences", () => {
    const input = '```\n{"subtasks":[]}\n```';
    expect(stripFences(input)).toBe('{"subtasks":[]}');
  });

  test("trims surrounding whitespace", () => {
    const input = '   \n  {"subtasks":[]}  \n  ';
    expect(stripFences(input)).toBe('{"subtasks":[]}');
  });

  test("malformed JSON after fence strip throws on parse", () => {
    const input = '```json\nthis is not json\n```';
    const stripped = stripFences(input);
    expect(() => JSON.parse(stripped)).toThrow();
  });
});

describe("decomposeTask: zod schema enforcement (mirrors orchestrator's DecompositionSchema)", () => {
  // Re-import zod and re-declare the schema in test to verify expected behavior.
  // This is intentional duplication — verifies the contract the LLM must satisfy.
  test("rejects empty subtasks array", async () => {
    const { z } = await import("zod");
    const Schema = z.object({
      subtasks: z.array(z.object({ title: z.string().min(1).max(200) })).min(1).max(20),
    });
    expect(() => Schema.parse({ subtasks: [] })).toThrow();
  });

  test("rejects subtask without title", async () => {
    const { z } = await import("zod");
    const Schema = z.object({
      subtasks: z.array(z.object({ title: z.string().min(1).max(200) })).min(1).max(20),
    });
    expect(() => Schema.parse({ subtasks: [{}] })).toThrow();
  });

  test("rejects subtask with title > 200 chars", async () => {
    const { z } = await import("zod");
    const Schema = z.object({
      subtasks: z.array(z.object({ title: z.string().min(1).max(200) })).min(1).max(20),
    });
    expect(() => Schema.parse({ subtasks: [{ title: "x".repeat(201) }] })).toThrow();
  });

  test("rejects subtasks count > 20", async () => {
    const { z } = await import("zod");
    const Schema = z.object({
      subtasks: z.array(z.object({ title: z.string().min(1).max(200) })).min(1).max(20),
    });
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ title: `task ${i}` }));
    expect(() => Schema.parse({ subtasks: tooMany })).toThrow();
  });

  test("accepts well-formed subtask with all fields", async () => {
    const { z } = await import("zod");
    const Schema = z.object({
      subtasks: z.array(z.object({
        title: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        capabilities: z.array(z.string()).default([]),
        priority: z.number().int().min(0).max(10).default(0),
      })).min(1).max(20),
    });
    const valid = {
      subtasks: [
        { title: "Implement OAuth", description: "...", capabilities: ["code"], priority: 5 },
      ],
    };
    expect(() => Schema.parse(valid)).not.toThrow();
  });
});
