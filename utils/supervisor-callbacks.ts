/**
 * The `sup:` inline-button protocol, in one place.
 *
 * The supervisor builds these strings and `handleSupervisorCallback` takes them
 * apart, and until now each side spelled the format out for itself. That is how
 * the restart button spent its life throwing "project <n> not found": the
 * builder put a session id where the handler read a project id, and nothing
 * connected the two well enough to notice. Sharing the codec makes the ids
 * named at both ends and lets the round trip be tested.
 */

const SESSION_PROBLEM_PREFIX = "session_problem:";

/** Dedup / acknowledgement key for a project-level session problem. */
export function sessionProblemKey(project: string): string {
  return `${SESSION_PROBLEM_PREFIX}${project}`;
}

/**
 * The project a `session_problem:` key refers to.
 *
 * The recovery loop used `key.replace("session_problem:", "")`, which is
 * unanchored and replaces the first occurrence wherever it sits — a project
 * whose name contains the prefix would come back mangled. Anchoring it also
 * keeps the pair of functions visibly inverse.
 */
export function projectFromSessionProblemKey(key: string): string {
  return key.startsWith(SESSION_PROBLEM_PREFIX)
    ? key.slice(SESSION_PROBLEM_PREFIX.length)
    : key;
}

/** "🔄 Перезапустить" — `enqueueRestart` takes a **project** id. */
export function restartCallbackData(projectId: number): string {
  return `sup:restart_session:${projectId}`;
}

/** "📋 Показать лог" — pane capture, also keyed by **project**. */
export function paneCallbackData(projectId: number): string {
  return `sup:pane:${projectId}`;
}

/** "📬 Принудительно доставить" — queue forwarding, keyed by **session**. */
export function forceDeliverCallbackData(sessionId: number): string {
  return `sup:force_deliver:${sessionId}`;
}

/**
 * "🔇 Заглушить на 1 ч".
 *
 * The trailing id is not read back — it is there so two alerts about the same
 * project produce distinct callback payloads. The key is what matters, and it
 * must come out of `parseSupervisorCallback` byte-identical to the
 * `sessionProblemKey` the alert was deduplicated under, or the mute silently
 * mutes nothing.
 */
export function ackCallbackData(project: string, id: number): string {
  return `sup:ack:${sessionProblemKey(project)}:${id}`;
}

/**
 * "🔄 Запустить вручную" — emitted by `scripts/run-cli.sh` when the restart cap
 * trips, so this one payload is built in shell rather than here. Keyed by
 * **project**, like the other restart paths.
 */
export function startByPidCallbackData(projectId: number): string {
  return `sup:start_by_pid:${projectId}`;
}

export type SupervisorCallback =
  | { action: "restart_session" | "pane" | "start_by_pid"; projectId: number }
  | { action: "force_deliver"; sessionId: number }
  | { action: "ack"; key: string }
  | { action: "ignore" | "bounce" | "noop" }
  | { action: "unknown"; raw: string };

const ACK_PREFIX = "sup:ack:";

/**
 * Take a `sup:` payload apart.
 *
 * The ack key is everything between the prefix and the final colon rather than
 * a fixed two segments, so a project whose name contains a colon still mutes
 * the alert it came from instead of producing a key that matches nothing.
 */
export function parseSupervisorCallback(data: string): SupervisorCallback {
  const parts = data.split(":");
  const action = parts[1] ?? "";

  switch (action) {
    case "restart_session":
    case "pane":
    case "start_by_pid":
      return { action, projectId: parseInt(parts[2] ?? "0", 10) || 0 };
    case "force_deliver":
      return { action, sessionId: parseInt(parts[2] ?? "0", 10) || 0 };
    case "ack": {
      const rest = data.slice(ACK_PREFIX.length);
      const cut = rest.lastIndexOf(":");
      return { action, key: cut === -1 ? rest : rest.slice(0, cut) };
    }
    case "ignore":
    case "bounce":
    case "noop":
      return { action };
    default:
      return { action: "unknown", raw: data };
  }
}
