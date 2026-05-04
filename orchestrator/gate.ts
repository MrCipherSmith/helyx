import type postgres from "postgres";
import { buildCorrectionPrompt, loadStateMatrix, validateMatrixArtifact } from "./matrix.ts";
import { getOrCreateRun, markRunStatus, recordValidationFailure } from "./store.ts";

export type ReplyGateResult =
  | { kind: "allow"; mode: "disabled" | "valid" | "warn" }
  | { kind: "config_error"; message: string }
  | { kind: "blocked"; correction: string; attempt: number; maxAttempts: number }
  | { kind: "exhausted"; attempt: number; maxAttempts: number };

export async function validateReplyGate(params: {
  sql: postgres.Sql;
  sessionId: number | null;
  chatId: string;
  projectPath: string | null | undefined;
  text: string;
}): Promise<ReplyGateResult> {
  if (!params.projectPath) return { kind: "allow", mode: "disabled" };

  let matrix;
  try {
    matrix = await loadStateMatrix(params.projectPath);
  } catch (err: any) {
    return {
      kind: "config_error",
      message: err?.message ?? "State Matrix configuration is invalid",
    };
  }

  if (!matrix || matrix.mode === "disabled") return { kind: "allow", mode: "disabled" };

  const validation = validateMatrixArtifact({
    type: "reply",
    text: params.text,
    sessionId: params.sessionId,
    chatId: params.chatId,
    projectPath: params.projectPath,
  }, matrix);

  const run = await getOrCreateRun({
    sql: params.sql,
    sessionId: params.sessionId,
    chatId: params.chatId,
    projectPath: params.projectPath,
    artifactType: "reply",
    matrix,
  });

  if (!validation.isValid && matrix.mode === "warn") {
    await markRunStatus({ sql: params.sql, run, status: "valid", phase: "warn" });
    return { kind: "allow", mode: "warn" };
  }

  if (validation.isValid) {
    await markRunStatus({ sql: params.sql, run, status: "valid", phase: "reply_valid" });
    return { kind: "allow", mode: "valid" };
  }

  const failedRun = await recordValidationFailure({ sql: params.sql, run, validation });
  const attempt = failedRun?.attempt ?? 1;
  const maxAttempts = failedRun?.maxAttempts ?? matrix.maxCorrectionAttempts;

  if (attempt >= maxAttempts) {
    await markRunStatus({ sql: params.sql, run: failedRun, status: "failed", phase: "exhausted" });
    return { kind: "exhausted", attempt, maxAttempts };
  }

  return {
    kind: "blocked",
    attempt,
    maxAttempts,
    correction: buildCorrectionPrompt({
      validation,
      attempt,
      maxAttempts,
      artifactType: "reply",
    }),
  };
}

