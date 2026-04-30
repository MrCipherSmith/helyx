// Phase C: ensure the distillation prompt file exists and is non-empty.

import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";

describe("prompts/skill-distillation.md", () => {
  test("exists and is non-empty", async () => {
    const path = resolve(import.meta.dir, "../../prompts/skill-distillation.md");
    const content = await Bun.file(path).text();
    expect(content.length).toBeGreaterThan(100);
    expect(content).toContain("skill-distillation aux");
  });
});
