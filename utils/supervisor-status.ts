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
export interface ContainerIdentity {
  name: string;
  /** `com.docker.compose.project`, empty for a container started outside compose. */
  composeProject: string;
  status: string;
}

export function isOurContainer(
  container: ContainerIdentity,
  scope: { composeProject: string; projects: readonly string[] },
): boolean {
  const owners = [scope.composeProject, ...scope.projects]
    .map((o) => o?.trim())
    .filter((o): o is string => Boolean(o));
  if (owners.length === 0) return false;

  // The label is the only thing that actually proves ownership. A name prefix
  // does not: a project registered as `api` would otherwise adopt an unrelated
  // `api-worker-1`, and `docker ps -a` now lists stopped foreign containers too.
  const label = container.composeProject.trim();
  if (label) return owners.includes(label);

  // No label: started outside compose, with an explicit name. Exact match only,
  // for the same reason.
  return owners.includes(container.name.trim());
}

/**
 * The compose project name for an installation directory.
 *
 * Compose derives its default from the directory it runs in — lowercased, with
 * anything outside [a-z0-9_-] dropped. Assuming the literal "helyx" excluded
 * every installation living anywhere else: the listing came back fine, nothing
 * in it was recognised as ours, and an empty set of owned containers reads as a
 * healthy one.
 */
export function composeProjectFor(directory: string, override?: string): string {
  if (override?.trim()) return override.trim();
  const base = directory.replace(/\/+$/, "").split("/").pop() ?? "";
  // Docker's rule for a project name. `services/project-service.ts` carries the
  // same character class for tmux window names — deliberately not shared: the
  // two sets coincide today because Docker and tmux happen to agree, and they
  // are owned by different systems. If Docker widened its rule, sharing this
  // would silently widen tmux's too. `bun run dupes` reports the pair; this
  // comment is the answer to it.
  return base.toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

/**
 * Read one line of `docker ps -a --format "{{.Names}}\t{{.Status}}"`.
 *
 * Returns null for a line that is not one — the shell runs the command with
 * `2>/dev/null || true`, so an error message can arrive where a listing was
 * expected.
 */
export function parseContainerLine(line: string): ContainerIdentity | null {
  const parts = line.split("\t");
  if (parts.length < 3) return null;
  const composeProject = (parts[0] ?? "").trim();
  const name = (parts[1] ?? "").trim();
  const status = parts.slice(2).join("\t").trim();
  if (!name || !status) return null;
  return { name, composeProject, status };
}

/** Running a shell command, so the listing below can be tested without Docker. */
export type RunShell = (cmd: string) => Promise<{ ok: boolean; output: string }>;

/**
 * `-a`, and the compose project label first — see `isOurContainer` for why the
 * label rather than the name, and `dockerListingUsable` for why the errors are
 * swallowed.
 */
export const DOCKER_LIST_COMMAND =
  `docker ps -a --format '{{.Label "com.docker.compose.project"}}\t{{.Names}}\t{{.Status}}' 2>/dev/null || true`;

export interface OwnedContainer extends ContainerIdentity {
  health: ContainerHealth;
}

export interface OwnedListing {
  /** False when the output cannot be trusted — a dead daemon reads as an empty host. */
  usable: boolean;
  containers: OwnedContainer[];
}

/**
 * Which of this host's containers are ours, and what state each is in.
 *
 * The one place that asks Docker. It exists because the question was being
 * asked twice: the status broadcast ran `docker ps -a` and the health analyst's
 * snapshot ran `docker ps`, so the analyst was judging system health from a
 * list that structurally could not contain a dead container — the exact defect
 * flow 004 had already fixed thirty lines away.
 *
 * Two call sites answering the same question with different commands is not a
 * bug that gets fixed by correcting one of them. Rendering is what the
 * consumers are entitled to differ about, and rendering is all they still do.
 */
export async function listOwnedContainers(
  runShell: RunShell,
  scope: { composeProject: string; projects: readonly string[] },
): Promise<OwnedListing> {
  const result = await runShell(DOCKER_LIST_COMMAND);
  const usable = dockerListingUsable(result.output);

  const containers: OwnedContainer[] = [];
  for (const line of result.output.split("\n").filter(Boolean)) {
    const parsed = parseContainerLine(line);
    if (!parsed) continue;
    if (!isOurContainer(parsed, scope)) continue;
    containers.push({ ...parsed, health: classifyContainer(parsed.status) });
  }

  return { usable, containers };
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
