/**
 * Parse Claude Code session JSONL files to extract accurate Anthropic API usage.
 *
 * Files live at: HOST_CLAUDE_CONFIG/projects/<slug>/<session-id>.jsonl
 * Each assistant message entry contains: model, usage.input_tokens,
 * usage.cache_creation_input_tokens, usage.cache_read_input_tokens, usage.output_tokens
 */

import { readdir, open } from "fs/promises";
import { join } from "path";

export interface ClaudeModelUsage {
  model: string;
  requests: number;
  input_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface ClaudeCodeUsageSummary {
  byModel: ClaudeModelUsage[];
  total_requests: number;
  total_input: number;
  total_cache_creation: number;
  total_cache_read: number;
  total_output: number;
  total_cost_usd: number;
  scanned_files: number;
}

// Prices per million tokens [input, cacheWrite, cacheRead, output]
const ANTHROPIC_PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-4-6":        [15.0, 18.75, 1.50, 75.0],
  "claude-opus-4-5":        [15.0, 18.75, 1.50, 75.0],
  "claude-sonnet-4-6":      [3.0,  3.75,  0.30, 15.0],
  "claude-sonnet-4-5":      [3.0,  3.75,  0.30, 15.0],
  "claude-sonnet-4-20250514": [3.0, 3.75,  0.30, 15.0],
  "claude-haiku-4-5":       [0.80, 1.0,   0.08, 4.0],
  "claude-haiku-4-5-20251001": [0.80, 1.0, 0.08, 4.0],
};

function calcCost(model: string, inp: number, cacheCreate: number, cacheRead: number, out: number): number {
  const prices = ANTHROPIC_PRICES[model] ?? ANTHROPIC_PRICES["claude-sonnet-4-6"];
  return (
    (inp / 1_000_000) * prices[0] +
    (cacheCreate / 1_000_000) * prices[1] +
    (cacheRead / 1_000_000) * prices[2] +
    (out / 1_000_000) * prices[3]
  );
}

/**
 * Aggregate Claude Code usage from all JSONL session files under projectsDir.
 * @param projectsDir  HOST_CLAUDE_CONFIG/projects/
 * @param cutoffMs     Only include entries with ts >= cutoffMs (0 = all time)
 */
export async function getClaudeCodeUsage(
  projectsDir: string,
  cutoffMs = 0,
): Promise<ClaudeCodeUsageSummary> {
  const modelMap = new Map<string, Omit<ClaudeModelUsage, "model" | "cost_usd">>();
  let scannedFiles = 0;

  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return { byModel: [], total_requests: 0, total_input: 0, total_cache_creation: 0, total_cache_read: 0, total_output: 0, total_cost_usd: 0, scanned_files: 0 };
  }

  for (const slug of projectDirs) {
    const projectPath = join(projectsDir, slug);
    let files: string[];
    try {
      files = (await readdir(projectPath)).filter((f) => f.endsWith(".jsonl"));
    } catch { continue; }

    for (const fname of files) {
      const filePath = join(projectPath, fname);
      scannedFiles++;

      try {
        const text = await Bun.file(filePath).text();
        for (const line of text.split("\n")) {
          if (!line.trim() || !line.includes('"assistant"')) continue;
          let entry: any;
          try { entry = JSON.parse(line); } catch { continue; }

          if (entry.type !== "assistant") continue;
          const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
          if (cutoffMs > 0 && ts > 0 && ts < cutoffMs) continue;

          // Usage and model are nested under entry.message
          const msg = entry.message ?? entry;
          const model: string = msg.model ?? entry.model ?? "unknown";
          const usage = msg.usage ?? entry.usage;
          if (!usage) continue;

          const inp = Number(usage.input_tokens ?? 0);
          const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0);
          const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
          const out = Number(usage.output_tokens ?? 0);
          if (inp + out === 0) continue;

          if (!modelMap.has(model)) {
            modelMap.set(model, { requests: 0, input_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, output_tokens: 0 });
          }
          const m = modelMap.get(model)!;
          m.requests++;
          m.input_tokens += inp;
          m.cache_creation_tokens += cacheCreate;
          m.cache_read_tokens += cacheRead;
          m.output_tokens += out;
        }
      } catch { continue; }
    }
  }

  const byModel: ClaudeModelUsage[] = [];
  let totalReq = 0, totalIn = 0, totalCC = 0, totalCR = 0, totalOut = 0, totalCost = 0;

  for (const [model, m] of modelMap) {
    const cost = calcCost(model, m.input_tokens, m.cache_creation_tokens, m.cache_read_tokens, m.output_tokens);
    byModel.push({ model, ...m, cost_usd: cost });
    totalReq += m.requests;
    totalIn += m.input_tokens;
    totalCC += m.cache_creation_tokens;
    totalCR += m.cache_read_tokens;
    totalOut += m.output_tokens;
    totalCost += cost;
  }

  byModel.sort((a, b) => b.requests - a.requests);

  return {
    byModel,
    total_requests: totalReq,
    total_input: totalIn,
    total_cache_creation: totalCC,
    total_cache_read: totalCR,
    total_output: totalOut,
    total_cost_usd: totalCost,
    scanned_files: scannedFiles,
  };
}
