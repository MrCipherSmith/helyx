/**
 * Custom fixtures that inject Authorization: Bearer header into all API requests.
 */
import { test as base, expect } from "@playwright/test";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const TOKEN_PATH = resolve(__dirname, "../.auth/token.txt");

function getToken(): string {
  if (process.env.TEST_JWT) return process.env.TEST_JWT;
  if (existsSync(TOKEN_PATH)) return readFileSync(TOKEN_PATH, "utf8").trim();
  throw new Error("No test JWT found. Run auth setup first.");
}

export const test = base.extend<{ authHeaders: Record<string, string> }>({
  // Playwright reads this destructuring pattern to decide which fixtures to
  // build; an empty one means "needs none". It has to stay literal.
  // eslint-disable-next-line no-empty-pattern
  authHeaders: async ({}, use) => {
    const token = getToken();
    await use({ Authorization: `Bearer ${token}` });
  },
});

export { expect };
