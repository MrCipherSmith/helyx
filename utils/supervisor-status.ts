/**
 * What the supervisor's 5-minute status broadcast decides.
 *
 * Each function returns state rather than a rendered line, because one of
 * these decisions — whether the operator is notified at all — used to be made
 * by grepping a rendered line for an emoji. A presentation detail should not
 * be able to switch alerting off by being restyled.
 */

export interface ContainerHealth {
  healthy: boolean;
  /** Why not, when not — shown to the operator beside the container name. */
  reason?: string;
}

/**
 * Classify a container from its `docker ps` status string.
 *
 * An **allowlist**, deliberately. The check this replaced rejected statuses
 * beginning with `exited` or `dead` and accepted everything else — against the
 * output of `docker ps` without `-a`, which never lists an exited or dead
 * container at all. The blacklist matched nothing that could appear, so every
 * listed container was painted green and the "🔴 docker container detected"
 * half of the notification condition had never once fired.
 *
 * What that hid is the states `docker ps` *does* list and that do mean
 * trouble: a crash loop reports `Restarting (…)`, a failing healthcheck
 * reports `Up … (unhealthy)`, and a frozen container reports `Up … (Paused)`.
 *
 * Inverting it also settles what happens to a status nobody anticipated:
 * unknown reads as a problem rather than as fine.
 */
export function classifyContainer(status: string): ContainerHealth {
  const s = status.trim();
  const lower = s.toLowerCase();

  if (!lower.startsWith("up")) {
    // Restarting, Created, Exited, Dead, Removing, or something new.
    return { healthy: false, reason: s.split(" ")[0] ?? s };
  }

  // An `Up` status may carry one parenthesised annotation, and only one value
  // of it means the container is actually serving. Listing the bad ones would
  // be a blacklist wearing an allowlist's name: docker also reports
  // `(health: starting)`, and whatever it adds next would pass unexamined.
  const annotation = s.match(/\(([^)]*)\)/)?.[1]?.trim().toLowerCase();
  if (annotation === undefined) return { healthy: true }; // no healthcheck defined
  if (annotation === "healthy") return { healthy: true };

  // `health: starting` is the deliberate cost of the rule above. A container
  // inside its healthcheck start period is not serving yet, and this broadcast
  // runs every five minutes — a start period long enough to be caught by it
  // twice is itself worth seeing.
  return { healthy: false, reason: annotation };
}

/**
 * Whether the docker listing itself can be trusted.
 *
 * The supervisor runs `docker ps … 2>/dev/null || true`, which turns a dead
 * daemon, a permissions problem, or a missing binary into an empty string —
 * and an empty list of containers is indistinguishable from "everything is
 * fine" once it reaches `hasProblems`. It is not fine: it means nobody is
 * watching.
 *
 * A host genuinely running no containers is the one false positive here, and
 * on a host running this supervisor that state is itself worth a look.
 */
export function dockerListingUsable(rawOutput: string): boolean {
  return rawOutput.split("\n").some((l) => l.includes("\t"));
}

/**
 * Which containers this supervisor is answerable for.
 *
 * The question had been open since the loop was written, and answering it is
 * what unblocks listing *stopped* containers at all. `docker ps` shows only
 * what is running, so a container that crashed does not appear as broken — it
 * simply vanishes, and a vanished container is indistinguishable from one that
 * was never there. `docker ps -a` shows it, at the price of also showing
 * everything else on the host.
 *
 * The scope, decided by the maintainer: helyx's own stack, and the containers
 * of projects running under it. Anything else on the machine belongs to someone
 * else, and reporting it would train the operator to ignore this alert.
 *
 * Matched on the compose project label's naming convention — `<project>-<service>-<n>` —
 * rather than on a substring, so a container called `my-helyx-experiment` is
 * not adopted by accident.
 */
export function isOurContainer(
  name: string,
  scope: { composeProject: string; projects: readonly string[] },
): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const owners = [scope.composeProject, ...scope.projects].filter((o) => o && o.trim());
  return owners.some((owner) => {
    const prefix = `${owner.trim()}-`;
    // `helyx-bot-1`, `helyx-postgres-1` — compose's own shape. The bare name is
    // accepted too, for a container started outside compose with `--name`.
    return trimmed === owner.trim() || trimmed.startsWith(prefix);
  });
}

/**
 * Read one line of `docker ps -a --format "{{.Names}}\t{{.Status}}"`.
 *
 * Returns null for a line that is not one — the shell runs the command with
 * `2>/dev/null || true`, so an error message can arrive where a listing was
 * expected.
 */
export function parseContainerLine(line: string): { name: string; status: string } | null {
  const tab = line.indexOf("\t");
  if (tab === -1) return null;
  const name = line.slice(0, tab).trim();
  const status = line.slice(tab + 1).trim();
  if (!name || !status) return null;
  return { name, status };
}

export interface SessionSnapshot {
  /** `active_status_messages.updated_at` in ms, or null when there is none. */
  asmUpdatedMs: number | null;
  pendingMsgs: number;
  /** `sessions.last_active` in ms, or null. */
  lastActiveMs: number | null;
  now: number;
}

export interface SessionState {
  icon: string;
  text: string;
}

/** A heartbeat this recent means Claude is mid-turn. */
const HEARTBEAT_FRESH_MS = 2 * 60 * 1000;
/** Activity this recent reads as "just now" rather than as idle. */
const RECENT_ACTIVITY_SEC = 60;

/**
 * The state shown for one session in the broadcast.
 *
 * The branch order is load-bearing and not obvious: a fresh heartbeat wins
 * over queued messages, so a session that is working *and* has a queue is
 * reported as working and says nothing about the queue. That is intended —
 * the queue is not stuck while Claude is mid-turn, and the queue summary
 * below the session list still counts it — but it is the kind of thing that
 * gets "fixed" by someone who has not noticed, so it is pinned by a test.
 */
export function classifySession(snap: SessionSnapshot): SessionState {
  const { asmUpdatedMs, pendingMsgs, lastActiveMs, now } = snap;

  if (asmUpdatedMs !== null && now - asmUpdatedMs < HEARTBEAT_FRESH_MS) {
    const elapsed = Math.floor((now - asmUpdatedMs) / 1000);
    return { icon: "🔄", text: `работает (heartbeat ${elapsed}s назад)` };
  }

  if (pendingMsgs > 0) {
    return { icon: "📨", text: `${pendingMsgs} сообщ. в очереди` };
  }

  const idleSec = lastActiveMs === null ? null : Math.floor((now - lastActiveMs) / 1000);

  if (idleSec !== null && idleSec < RECENT_ACTIVITY_SEC) {
    return { icon: "🟢", text: "активна только что" };
  }

  const idleStr = idleSec === null
    ? "?"
    : idleSec < 3600
      ? `${Math.floor(idleSec / 60)}m`
      : `${Math.floor(idleSec / 3600)}h`;
  return { icon: "⚪", text: `ожидание (idle ${idleStr})` };
}

/** The one-line queue verdict under the session list. */
export function summarizeQueue(pending: number, stuck: number): string {
  if (stuck > 0) return `⚠️ ${pending} pending, ${stuck} зависших`;
  if (pending > 0) return `📨 ${pending} pending`;
  return "✅ очередь пуста";
}

/**
 * Whether this broadcast should notify rather than edit silently.
 *
 * Takes the classified containers, not the rendered lines. The version this
 * replaced asked `dockerLines.some(l => l.startsWith("🔴"))`, which made the
 * choice of icon part of the alerting logic.
 */
export function hasProblems(input: {
  containers: readonly ContainerHealth[];
  stuckTotal: number;
  /** False when the docker listing could not be read — see `dockerListingUsable`. */
  dockerUsable?: boolean;
}): boolean {
  if (input.dockerUsable === false) return true;
  return input.stuckTotal > 0 || input.containers.some((c) => !c.healthy);
}
