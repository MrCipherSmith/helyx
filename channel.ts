// Load project .env so TTS/API keys are available when running as stdio MCP
import { join } from "path";
const envPath = join(import.meta.dirname, ".env");
try {
  const text = await Bun.file(envPath).text();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    // Don't override vars already set in the host shell
    if (!(key in process.env)) process.env[key] = val;
  }
} catch { /* no .env — fine */ }

// Shim — logic moved to channel/ modules
import "./channel/index.ts";
