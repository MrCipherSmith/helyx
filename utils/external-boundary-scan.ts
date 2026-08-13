/**
 * Scanning the boundary with the external world — adoption area A1.
 *
 * Five places send helyx content to, or receive it from, a service the operator
 * does not control (see docs/requirements/keryx-adoption-2026-08-12/, §A1):
 *
 *   E1  remote text-to-speech (Yandex / Groq / OpenAI)   utils/tts.ts
 *   E2  transcription (Groq)                              utils/transcribe.ts   (posture, not payload)
 *   E3  auxiliary LLM (DeepSeek / OpenRouter)             utils/aux-llm-client.ts
 *   E4  reviewer models                                  services/reviewer-service.ts
 *   E5  session provider                                 claude/client.ts
 *
 * This module is the one place that talks to the scanner. It spawns
 * `keryx security check-output --json --target external`, feeds the payload on
 * stdin, and reads the verdict from the *parsed JSON* — never from the exit code,
 * because keryx exits 0 even when it blocks (verified against v0.2.28 on
 * 2026-08-13; see the flow's keryx-cli-contract.md). Two invariants hold across
 * every crossing:
 *
 *   1. A finding must never cost the operator a message. Every crossing has a
 *      local fallback (E1 → piper) or is simply skipped and reported at its call
 *      site (E3/E4/E5). No operator path — no `reply` — is a crossing, so nothing
 *      here can ever withhold one.
 *   2. The operator channel is not scanned. It is absent from this module by
 *      design and a test asserts channel/tools.ts and mcp/tools.ts never reach it.
 *
 * The functions that make a decision (`runScan`, `outboundBlocks`,
 * `redactForInbound`, `redactSpans`) take their policy and their spawner as
 * arguments so they can be tested without a real `keryx` on PATH and without a
 * network.
 */

import { CONFIG } from "../config.ts";
import { logger } from "../logger.ts";

// ── Crossing identity ───────────────────────────────────────────────────────

export type CrossingId =
  | "E1-remote-tts"
  | "E2-transcription"
  | "E3-aux-llm"
  | "E4-reviewers"
  | "E5-session-provider";

/** Which directions of a crossing are scanned. `inbound` is the injection surface. */
export type ScanDirection = "both" | "outbound" | "inbound" | "off";

/** What a blocking finding does. Every value is satisfiable without an operator message. */
export type OnFinding = "fallback" | "redact" | "skip-crossing" | "warn";

/** What a scan that cannot run does. There is deliberately no "proceed". */
export type OnScanFailure = "fallback" | "skip-crossing";

export interface CrossingConfig {
  scan: ScanDirection;
  onFinding: OnFinding;
  /** The local alternative used when onFinding is "fallback". Null → skip instead. */
  localFallback: string | null;
}

export interface BoundaryPosture {
  /** Whether remote speech synthesis may be used at all. Visibility, not a gate. */
  remoteTtsOptIn: boolean;
  /** Whether operator voice audio may leave for a remote transcriber. */
  remoteTranscriptionOptIn: boolean;
  /** A posture nobody can see is not a posture. Fixed true. */
  reportInStatus: true;
}

export interface BoundaryPolicy {
  enabled: boolean;
  /** How the scanner is invoked. Must include --json and --target external. */
  command: string[];
  timeoutMs: number;
  onScanFailure: OnScanFailure;
  crossings: Record<CrossingId, CrossingConfig>;
  posture: BoundaryPosture;
}

// ── The verdict, as keryx returns it and helyx consumes it ──────────────────

export interface ScanFindingLocation {
  line: number;
  column: number;
  /** Byte offsets into the payload — redaction operates on the UTF-8 buffer. */
  start: number;
  end: number;
}

export interface ScanFinding {
  id: string;
  policyId: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: string; // secret | pii | prompt-injection | egress | …
  action: string;
  confidence?: number;
  redactedPreview?: string;
  location?: ScanFindingLocation;
  target?: string;
  remediation?: string;
  hash?: string;
}

export interface ScanVerdict {
  gate: "pass" | "needs-approval" | "fail";
  action: "allow" | "warn" | "redact" | "block" | "require-approval";
  findings: ScanFinding[];
  /** Full redacted body — present on block/redact, absent on warn. */
  redacted?: string;
}

/**
 * The result of asking the scanner. `ok:false` is the single "scan unavailable"
 * shape that a missing binary, a spawn failure, a timeout, or unparseable output
 * all collapse to — and that every crossing treats as a block with its fallback.
 */
export type ScanResult = { ok: true; verdict: ScanVerdict } | { ok: false; reason: string };

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Injectable so tests never spawn a real process. Feeds `payload` on stdin. */
export type SpawnScanner = (argv: string[], payload: string, timeoutMs: number) => Promise<SpawnResult>;

/** Injectable binary probe, mirroring reviewer-service's WhichClaude seam. */
export type WhichBinary = (bin: string) => string | null;

// ── Defaults ────────────────────────────────────────────────────────────────

/**
 * The operational defaults for the five crossings. Shape and enum values conform
 * to schemas/external-boundary-policy.schema.json (proven by a test); the
 * per-crossing choices here follow the specification's intent: E1 falls back to
 * piper, E3/E4 skip and report, E5 redacts, E2 is posture-only.
 */
export const DEFAULT_BOUNDARY_POLICY: BoundaryPolicy = {
  enabled: true,
  command: ["keryx", "security", "check-output", "--json", "--target", "external"],
  timeoutMs: 3000,
  onScanFailure: "fallback",
  crossings: {
    "E1-remote-tts": { scan: "outbound", onFinding: "fallback", localFallback: "piper" },
    "E2-transcription": { scan: "off", onFinding: "skip-crossing", localFallback: null },
    "E3-aux-llm": { scan: "both", onFinding: "skip-crossing", localFallback: null },
    "E4-reviewers": { scan: "both", onFinding: "skip-crossing", localFallback: null },
    // E5 is specified but not yet wired to a call site. It is set "off" rather
    // than "both" on purpose: a crossing configured to scan with nothing calling
    // its guard is a control that silently does nothing while looking enabled —
    // the exact trap A1 exists to avoid. Wiring E5 (the session hot path, where
    // scanning the operator's own turns to their own model needs its own UX
    // decision) is a follow-up; until then the policy tells the truth.
    "E5-session-provider": { scan: "off", onFinding: "redact", localFallback: null },
  },
  posture: { remoteTtsOptIn: false, remoteTranscriptionOptIn: false, reportInStatus: true },
};

let cachedPolicy: BoundaryPolicy | null = null;

/**
 * The policy the running process uses: the defaults, with the two operator knobs
 * from the environment applied. Cached, because the environment does not change
 * mid-process and the crossings read it on a hot-ish path.
 */
export function boundaryPolicy(): BoundaryPolicy {
  if (cachedPolicy) return cachedPolicy;
  cachedPolicy = {
    ...DEFAULT_BOUNDARY_POLICY,
    enabled: CONFIG.EXTERNAL_BOUNDARY_SCAN_ENABLED,
    timeoutMs: CONFIG.EXTERNAL_BOUNDARY_SCAN_TIMEOUT_MS,
  };
  return cachedPolicy;
}

/** Test seam: forget the cached policy so a changed environment is re-read. */
export function resetBoundaryPolicyCache(): void {
  cachedPolicy = null;
}

// ── The spawner ─────────────────────────────────────────────────────────────

/**
 * The real scanner call, mirroring reviewer-service's spawnCodex: bounded, and
 * the subprocess is killed rather than abandoned. Raced, not merely killed —
 * a wrapper process can outlive `kill()` while still holding the pipes, so
 * awaiting the reads could block past the timeout it was meant to enforce.
 */
const spawnKeryxScanner: SpawnScanner = async (argv, payload, timeoutMs) => {
  const proc = Bun.spawn(argv, {
    stdin: new TextEncoder().encode(payload),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const expired = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`keryx scan timed out after ${timeoutMs}ms`)), timeoutMs + 2_000).unref?.();
  });

  try {
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
      expired,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
};

// ── The scan ────────────────────────────────────────────────────────────────

/**
 * Run one scan. Returns the parsed verdict, or the single "scan unavailable"
 * result on any failure. The exit code is read but never acted on — the verdict
 * lives in the JSON, and keryx exits 0 even when it blocks.
 */
export async function runScan(
  payload: string,
  policy: BoundaryPolicy = boundaryPolicy(),
  spawn: SpawnScanner = spawnKeryxScanner,
  which: WhichBinary = (bin) => Bun.which(bin),
): Promise<ScanResult> {
  if (!policy.enabled) {
    return { ok: true, verdict: { gate: "pass", action: "allow", findings: [] } };
  }

  const bin = policy.command[0];
  if (which(bin) === null) {
    return { ok: false, reason: `scanner binary not found: ${bin}` };
  }

  let res: SpawnResult;
  try {
    res = await spawn(policy.command, payload, policy.timeoutMs);
  } catch (err) {
    return { ok: false, reason: `scan spawn failed: ${String(err).slice(0, 200)}` };
  }

  // Deliberately ignore res.exitCode. keryx exits 0 even on `block`; the verdict
  // is only ever in the parsed JSON (A1.8).
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { ok: false, reason: "scan output was not JSON" };
  }

  const verdict = normalizeVerdict(parsed);
  if (!verdict) return { ok: false, reason: "scan output missing gate/action" };
  return { ok: true, verdict };
}

/** Validate and narrow the parsed JSON into a ScanVerdict, or null if malformed. */
export function normalizeVerdict(parsed: unknown): ScanVerdict | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.gate !== "string" || typeof o.action !== "string") return null;
  const findings = Array.isArray(o.findings) ? (o.findings as ScanFinding[]) : [];
  const verdict: ScanVerdict = {
    gate: o.gate as ScanVerdict["gate"],
    action: o.action as ScanVerdict["action"],
    findings,
  };
  if (typeof o.redacted === "string") verdict.redacted = o.redacted;
  return verdict;
}

// ── Decisions ───────────────────────────────────────────────────────────────

/**
 * Whether an outbound crossing must be withheld. A scan that could not run is a
 * block (its findings are unknown, so it fails closed). A verdict blocks when the
 * gate failed or the action is block/require-approval — a `warn` (e.g. a
 * prompt-injection pattern in our own outbound prompt) does not withhold, it is
 * recorded. The caller does the crossing-specific fallback.
 */
export function outboundBlocks(result: ScanResult): boolean {
  if (!result.ok) return true;
  const v = result.verdict;
  if (v.gate === "fail") return true;
  return v.action === "block" || v.action === "require-approval";
}

export interface InboundDecision {
  /** False only when the scan itself could not run — untrusted content is not fed. */
  accept: boolean;
  /** The content to feed onward: the original, the redacted form, or null on refusal. */
  text: string | null;
  redacted: boolean;
  reason?: string;
}

/**
 * What to do with content coming back from an external service before it reaches
 * a session or memory. Any finding — including a `warn`-level prompt injection,
 * which carries no top-level `redacted` body — causes redaction, because
 * untrusted external text with an injection pattern must not reach the session
 * verbatim (A1.5). A scan that could not run refuses the content rather than
 * passing it unscanned.
 */
export function redactForInbound(payload: string, result: ScanResult): InboundDecision {
  if (!result.ok) return { accept: false, text: null, redacted: false, reason: result.reason };
  const v = result.verdict;
  if (v.findings.length === 0) return { accept: true, text: payload, redacted: false };
  const text = v.redacted ?? redactSpans(payload, v.findings);
  return { accept: true, text, redacted: true };
}

/**
 * Replace each finding's byte span with a placeholder. Operates on the UTF-8
 * buffer because keryx's `location.start`/`end` are byte offsets, not UTF-16
 * indices — a Cyrillic payload would be redacted at the wrong place otherwise.
 * Findings with no usable location redact the whole payload, which is the safe
 * direction to fail.
 */
export function redactSpans(payload: string, findings: ScanFinding[], placeholder = "[REDACTED]"): string {
  const spans = findings
    .map((f) => f.location)
    .filter(
      (l): l is ScanFindingLocation =>
        !!l && Number.isInteger(l.start) && Number.isInteger(l.end) && l.end > l.start && l.start >= 0,
    )
    .sort((a, b) => a.start - b.start);

  if (spans.length === 0) return placeholder;

  const bytes = Buffer.from(payload, "utf8");
  const marker = Buffer.from(placeholder, "utf8");
  const out: Buffer[] = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.start < cursor) continue; // overlapping span already covered
    out.push(bytes.subarray(cursor, Math.min(s.start, bytes.length)));
    out.push(marker);
    cursor = Math.min(s.end, bytes.length);
  }
  out.push(bytes.subarray(cursor));
  return Buffer.concat(out).toString("utf8");
}

// ── Thin per-call-site guards ───────────────────────────────────────────────

export interface OutboundGuard {
  /** Whether it is safe to make the external call. */
  cross: boolean;
  result: ScanResult;
  /** Why the crossing was withheld, for the call site to report. */
  reason?: string;
}

/**
 * The outbound half a crossing calls before it sends. Respects the crossing's
 * configured direction (an `inbound`/`off` crossing always crosses), runs the
 * scan, and reports whether it is safe to proceed. It never throws and never
 * withholds an operator message — no operator path calls this.
 */
export async function guardOutbound(
  payload: string,
  crossing: CrossingId,
  policy: BoundaryPolicy = boundaryPolicy(),
  spawn: SpawnScanner = spawnKeryxScanner,
): Promise<OutboundGuard> {
  const cfg = policy.crossings[crossing];
  if (!policy.enabled || cfg.scan === "off" || cfg.scan === "inbound") {
    return { cross: true, result: { ok: true, verdict: { gate: "pass", action: "allow", findings: [] } } };
  }
  const result = await runScan(payload, policy, spawn);
  if (outboundBlocks(result)) {
    const reason = result.ok ? `blocked: ${result.verdict.action}` : `scan unavailable: ${result.reason}`;
    logger.warn({ crossing, reason }, "external-boundary: outbound crossing withheld");
    return { cross: false, result, reason };
  }
  return { cross: true, result };
}

/**
 * The inbound half a crossing calls before it feeds returned content into a
 * session or memory. Respects the crossing's direction, scans as untrusted, and
 * hands back either the content, its redacted form, or a refusal.
 */
export async function guardInbound(
  payload: string,
  crossing: CrossingId,
  policy: BoundaryPolicy = boundaryPolicy(),
  spawn: SpawnScanner = spawnKeryxScanner,
): Promise<InboundDecision> {
  const cfg = policy.crossings[crossing];
  if (!policy.enabled || cfg.scan === "off" || cfg.scan === "outbound") {
    return { accept: true, text: payload, redacted: false };
  }
  const result = await runScan(payload, policy, spawn);
  const decision = redactForInbound(payload, result);
  if (!decision.accept || decision.redacted) {
    logger.warn(
      { crossing, redacted: decision.redacted, accepted: decision.accept, reason: decision.reason },
      "external-boundary: inbound content held or redacted",
    );
  }
  return decision;
}

// ── Posture ─────────────────────────────────────────────────────────────────

export interface RemotePosture {
  /** Remote speech synthesis is reachable with the current configuration. */
  remoteTts: boolean;
  /** The operator's voice can leave for a remote transcriber. */
  remoteTranscription: boolean;
}

/**
 * Which remote services are active, derived from configuration without reading a
 * network or a secret's value — knowable at process start. "Remote" TTS means the
 * provider resolves to yandex/openai/groq (piper/kokoro are local; "auto" is a
 * local-first fallback chain and is reported as not-committed-to-remote).
 * Transcription is remote when a Groq key is present, since transcribe.ts tries
 * Groq first. Kept here so the status surface and the policy share one source.
 */
export function remotePosture(
  ttsProvider: string = CONFIG.TTS_PROVIDER,
  groqKey: string = CONFIG.GROQ_API_KEY,
): RemotePosture {
  const remoteTts = ttsProvider === "yandex" || ttsProvider === "openai" || ttsProvider === "groq";
  return { remoteTts, remoteTranscription: groqKey !== "" };
}
