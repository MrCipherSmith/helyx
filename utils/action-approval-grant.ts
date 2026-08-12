/**
 * A2 — approval bound to an action.
 *
 * `claimRestart` (`utils/restart-lease.ts`) answers one question: is another
 * restart already running? It says nothing about whether the one about to run
 * is the one anybody agreed to — which is exactly the gap `CLAUDE.md` records
 * twice: an agent asked "перезапускаю?", got "да", and restarted the half the
 * operator was not asking about, leaving the other half dead with nothing
 * saying so.
 *
 * This module is the fix, and it is deliberately small: a fingerprint over
 * what the operator would actually notice (`half` / `scope` / `downtime`, not
 * the command string), and a grant that authorizes exactly one fingerprint,
 * once. See docs/requirements/keryx-adoption-2026-08-12/specification.md §A2
 * and policies.md §P-2 for the design this implements; grant records shaped
 * by `toApprovalGrant` validate against
 * schemas/action-approval-grant.schema.json — a test, not this module, does
 * that validation, because the requirements package "owns no runtime code"
 * (specification.md, Storage structure) and nothing here should reach into
 * `docs/requirements/` to prove its own homework.
 *
 * ## Why the store is Postgres, not a file
 *
 * `restart-lease.ts` uses a file because its two writers — the admin daemon
 * and the host ingress — both run on the host and share a filesystem. A grant
 * is issued by the bot, which answers a Telegram tap from inside its
 * container, and is spent by the admin daemon, which runs on the host. They
 * share nothing but Postgres, so that is where the grant lives — the same
 * database `admin_commands` and `permission_requests` already use for exactly
 * this kind of cross-process handoff.
 */

import type postgres from "postgres";

// ---------------------------------------------------------------------------
// The fingerprint
// ---------------------------------------------------------------------------

export type Half = "container" | "sessions" | "both";
export type Downtime = "none" | "brief" | "full";

export interface ActionFingerprint {
  half: Half;
  /** `"all"`, an absolute project path, or `container:<name>` for one named container. */
  scope: string;
  downtime: Downtime;
}

/** An action as the gate sees it: a command name and the payload it carries. */
export interface RestartAction {
  command: string;
  payload?: Record<string, unknown>;
}

/**
 * The one place a command maps to `half`/`scope`/`downtime`.
 *
 * **Corrected 2026-08-12.** The first version of this function gated only the
 * three commands that take the restart lease (`bounce`, `host_restart`,
 * `full_restart`) — a control over three of the eight commands in
 * `scripts/admin-daemon.ts` that can take part of the system down, arrived at
 * by mistaking "takes the lease" for "needs approval". They are different
 * questions (P-2.6): mutual exclusion and approval. This now covers every
 * teardown-capable command per specification.md §A2 "The complete mapping";
 * `scripts/restart-gate.ts` names the three exemptions (`stack_up`,
 * `tmux_start`, `proj_start` — bring-up only, by decision) and the commands
 * outside the fingerprint model entirely (`restart_admin_daemon`,
 * `tmux_send_keys`, `supervisor_ack`).
 *
 * `downtime` is `full`, not `brief`, for `tmux_stop` and `proj_stop`: nothing
 * brings them back on its own — the exact distinction `CLAUDE.md` warns about.
 *
 * Never reads a `fingerprint` field from `action.payload`, even if one is
 * present — P-2.5 requires the fingerprint to be re-derived from the action
 * about to run, never trusted from something that travelled alongside it.
 */
export function fingerprintOf(action: RestartAction): ActionFingerprint | null {
  const payload = action.payload ?? {};
  switch (action.command) {
    case "bounce":
      // `bun cli.ts bounce` — kills and restarts every tmux window. The
      // operator's Claude Code session is briefly gone and comes back.
      return { half: "sessions", scope: "all", downtime: "brief" };

    case "host_restart":
      // The other half of `bounce`: the same session bounce, plus the admin
      // daemon (and the supervisor it carries) restarting alongside it. The
      // operator-visible effect is the same brief session interruption —
      // the daemon restart is invisible to the tmux windows it manages.
      return { half: "sessions", scope: "all", downtime: "brief" };

    case "full_restart":
      // Rebuilds the bot container, then bounces every session — both halves,
      // and the docker build alone can run for minutes, so the whole
      // operation is `full` downtime rather than `brief`.
      return { half: "both", scope: "all", downtime: "full" };

    case "docker_restart": {
      // One named container, not the container half — a grant for
      // `helyx-postgres-1` must not authorize restarting `helyx-bot-1`. `null`
      // when the container name is missing: structural safety before policy
      // (adopted property #4) — a malformed action has nothing to gate.
      const container = typeof payload.container === "string" && payload.container ? payload.container : null;
      if (!container) return null;
      return { half: "container", scope: `container:${container}`, downtime: "brief" };
    }

    case "docker_restart_all":
      return { half: "container", scope: "all", downtime: "brief" };

    case "tmux_stop":
      // Kills the tmux session and starts nothing back up — `full`, because
      // nothing brings it back on its own until `tmux_start`/`bounce` does.
      return { half: "sessions", scope: "all", downtime: "full" };

    case "channel_kill":
      // Kills the channel.ts MCP subprocesses; Claude Code respawns them —
      // `brief`, the session itself never stops.
      return { half: "sessions", scope: "all", downtime: "brief" };

    case "proj_stop": {
      // `scope` must be the absolute project path, never the bare name — the
      // spec's own fingerprint table (§A2 "The fingerprint") says `scope` is
      // `"all"`, an absolute project path, or `container:<name>`, and two
      // different projects can share a `name`. **Corrected 2026-08-12**: this
      // used to fall back to `payload.name` when `path` was absent, which
      // would let a grant for one project's stop authorize another project's
      // stop if the two happened to share a name. `null` when there is no
      // path: structural safety before policy (adopted property #4) — a
      // malformed action has nothing to gate.
      const path = typeof payload.path === "string" && payload.path ? payload.path : null;
      if (!path) return null;
      // `full`, not `brief` — nothing restarts a stopped project's session
      // until a human presses Start (or a limit clears and a queue path
      // re-enqueues `proj_start`). Corrected from the first version of this
      // mapping, which had it `brief`.
      return { half: "sessions", scope: path, downtime: "full" };
    }

    default:
      // Includes the three bring-up commands (`stack_up`, `tmux_start`,
      // `proj_start`, exempt by decision — see scripts/restart-gate.ts) and
      // everything outside the fingerprint model (`restart_admin_daemon`,
      // `tmux_send_keys`, `supervisor_ack`).
      return null;
  }
}

/** `half/scope/downtime`, for a refusal to name what it is refusing. */
export function describeFingerprint(fp: ActionFingerprint): string {
  return `${fp.half}/${fp.scope}/${fp.downtime}`;
}

export function fingerprintsEqual(a: ActionFingerprint, b: ActionFingerprint): boolean {
  return a.half === b.half && a.scope === b.scope && a.downtime === b.downtime;
}

/**
 * The sentence the operator sees before they answer — persisted verbatim as
 * `statedTo` so a disputed restart can be reconstructed from what was
 * actually asked, not from what the code meant (schema, `statedTo`).
 */
export function confirmationText(fp: ActionFingerprint): string {
  const halfText =
    fp.half === "container"
      ? "контейнер бота"
      : fp.half === "both"
        ? "контейнер бота и все сессии"
        : fp.scope === "all"
          ? "все сессии (tmux/Claude Code)"
          : `сессию проекта ${fp.scope}`;

  const downtimeText =
    fp.downtime === "none"
      ? "Простоя не будет."
      : fp.downtime === "brief"
        ? "Кратковременно станет недоступно."
        : "Может занять несколько минут; всё будет недоступно.";

  return `Перезапустить ${halfText}. ${downtimeText}`;
}

// ---------------------------------------------------------------------------
// The grant, as the schema describes it
// ---------------------------------------------------------------------------

export type GrantKind = "operator" | "standing";

export type IssuedBy =
  | { kind: "operator"; userId: number }
  | { kind: "standing"; actor: string; authorizedBy: number };

/** Exactly the schema's shape — nothing implementation-internal leaks into this. */
export interface ApprovalGrant {
  grantId: string;
  kind: GrantKind;
  fingerprint: ActionFingerprint;
  requestId: string | null;
  issuedAt: string;
  expiresAt: string | null;
  consumedAt: string | null;
  issuedBy: number | { actor: string; authorizedBy: number };
  statedTo?: string;
}

/** A grant row, plus the implementation-internal fields the schema does not know about. */
export interface GrantRow extends ApprovalGrant {
  pendingCommand: string | null;
  pendingPayload: Record<string, unknown>;
}

/** How long an operator grant lives before it is spent whether or not it was used. */
export const OPERATOR_GRANT_TTL_MS = 3 * 60_000;

function randomGrantId(): string {
  return `g_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

interface DbGrantRow {
  grant_id: string;
  kind: GrantKind;
  half: Half;
  scope: string;
  downtime: Downtime;
  request_id: string | null;
  issued_at: Date | string;
  expires_at: Date | string | null;
  consumed_at: Date | string | null;
  issued_by_user_id: number | string | null;
  issued_by_actor: string | null;
  issued_by_authorized_by: number | string | null;
  stated_to: string | null;
  pending_command: string | null;
  pending_payload: unknown;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToGrant(row: DbGrantRow): GrantRow {
  const issuedBy: ApprovalGrant["issuedBy"] =
    row.kind === "standing"
      ? { actor: row.issued_by_actor ?? "", authorizedBy: Number(row.issued_by_authorized_by ?? 0) }
      : Number(row.issued_by_user_id ?? 0);

  const pendingPayload = typeof row.pending_payload === "string"
    ? JSON.parse(row.pending_payload)
    : (row.pending_payload as Record<string, unknown> | null) ?? {};

  return {
    grantId: row.grant_id,
    kind: row.kind,
    fingerprint: { half: row.half, scope: row.scope, downtime: row.downtime },
    requestId: row.request_id,
    issuedAt: toIso(row.issued_at)!,
    expiresAt: toIso(row.expires_at),
    consumedAt: toIso(row.consumed_at),
    issuedBy,
    ...(row.stated_to ? { statedTo: row.stated_to } : {}),
    pendingCommand: row.pending_command,
    pendingPayload,
  };
}

/** The schema-shaped view — strips the implementation-internal `pending*` fields. */
export function toApprovalGrant(row: GrantRow): ApprovalGrant {
  const { pendingCommand: _pendingCommand, pendingPayload: _pendingPayload, ...grant } = row;
  return grant;
}

// ---------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------

export interface IssueOperatorGrantParams {
  fingerprint: ActionFingerprint;
  issuedBy: number;
  pendingCommand: string;
  pendingPayload?: Record<string, unknown>;
  requestId?: string | null;
  statedTo?: string;
  ttlMs?: number;
  now?: Date;
}

/**
 * Create an unconsumed operator grant, awaiting the operator's confirming tap.
 *
 * `issuedAt` is when this is called — which is the moment the operator's
 * first tap asked to see what the action means, not the confirming tap. The
 * schema's own wording ("when the operator pressed the button") is satisfied
 * either way: pressing *a* button is what creates the grant, and pressing the
 * second one (`grant:go:<id>`) is what presents it. Recorded in
 * DECISIONS_I_MADE — the alternative (issuing nothing until the second tap)
 * needs a second, separate "pending request" concept this package does not
 * otherwise need.
 */
export async function issueOperatorGrant(
  sql: postgres.Sql,
  params: IssueOperatorGrantParams,
): Promise<GrantRow> {
  const now = params.now ?? new Date();
  const grantId = randomGrantId();
  const expiresAt = new Date(now.getTime() + (params.ttlMs ?? OPERATOR_GRANT_TTL_MS));
  const statedTo = params.statedTo ?? confirmationText(params.fingerprint);

  const [row] = await sql<DbGrantRow[]>`
    INSERT INTO action_approval_grants
      (grant_id, kind, half, scope, downtime, request_id, issued_at, expires_at,
       issued_by_user_id, stated_to, pending_command, pending_payload)
    VALUES
      (${grantId}, 'operator', ${params.fingerprint.half}, ${params.fingerprint.scope}, ${params.fingerprint.downtime},
       ${params.requestId ?? null}, ${now}, ${expiresAt},
       ${params.issuedBy}, ${statedTo}, ${params.pendingCommand}, ${sql.json((params.pendingPayload ?? {}) as any)})
    RETURNING *
  `;
  return rowToGrant(row!);
}

export interface IssueStandingGrantParams {
  fingerprint: ActionFingerprint;
  actor: string;
  authorizedBy: number;
  statedTo?: string;
  now?: Date;
}

/**
 * Declare a standing grant for an autonomous actor — narrow by construction,
 * per P-2.3a. Re-issuing the same actor+fingerprint replaces the row's
 * metadata rather than accumulating duplicates (see the unique index in the
 * migration).
 *
 * **Corrected 2026-08-12.** `grant_id` itself now stays put across a
 * re-issue. It used to be rewritten to a fresh id on every conflict, which
 * breaks the moment the grant has ever been used: `autonomous_actions.grant_id`
 * is a foreign key with no `ON UPDATE CASCADE` (deliberately — rewriting a
 * historical row to point at a new id would falsify the audit log), so
 * updating the referenced key fails once a row references it. Re-issuing a
 * standing grant for the same actor+fingerprint is the realistic case, not
 * the edge case, so this can't be a rare failure. The generated `grantId` this
 * call computes is discarded on conflict; the row keeps the one it already
 * had.
 */
export async function issueStandingGrant(
  sql: postgres.Sql,
  params: IssueStandingGrantParams,
): Promise<GrantRow> {
  const now = params.now ?? new Date();
  const grantId = randomGrantId();
  const statedTo = params.statedTo ?? confirmationText(params.fingerprint);

  const [row] = await sql<DbGrantRow[]>`
    INSERT INTO action_approval_grants
      (grant_id, kind, half, scope, downtime, request_id, issued_at, expires_at,
       issued_by_actor, issued_by_authorized_by, stated_to, pending_command, pending_payload)
    VALUES
      (${grantId}, 'standing', ${params.fingerprint.half}, ${params.fingerprint.scope}, ${params.fingerprint.downtime},
       NULL, ${now}, NULL,
       ${params.actor}, ${params.authorizedBy}, ${statedTo}, NULL, '{}')
    ON CONFLICT (issued_by_actor, half, scope, downtime) WHERE kind = 'standing'
    DO UPDATE SET
      issued_at = EXCLUDED.issued_at,
      issued_by_authorized_by = EXCLUDED.issued_by_authorized_by,
      stated_to = EXCLUDED.stated_to
    RETURNING *
  `;
  return rowToGrant(row!);
}

/**
 * Push an unconsumed operator grant's expiry forward, from the confirming
 * tap rather than the first one — F4/the 2026-08-12 review.
 *
 * `expiresAt` used to run only from `issueOperatorGrant` (the first tap,
 * which only asks to see the fingerprint), so a confirmed restart queued
 * behind a slow command (`docker_restart` at `timeout 240`, a build inside
 * `full_restart`, …) could expire before the daemon ever got to it — an
 * approval the operator gave, refused minutes later with nothing saying so.
 * `bot/commands/restart-grant.ts` calls this at `grant:go:<id>` — the
 * confirming tap — so the TTL now answers two separate questions at two
 * separate times: "did the operator answer the prompt in time" (checked
 * before this runs, against the original `expiresAt`) and "did the daemon
 * get to the approved action in time" (this grant's new window). A grant
 * that is already consumed or expired is left alone — this only extends a
 * grant still capable of being spent.
 */
export async function extendGrantForExecution(
  sql: postgres.Sql,
  grantId: string,
  ttlMs: number = OPERATOR_GRANT_TTL_MS,
  now: Date = new Date(),
): Promise<void> {
  const expiresAt = new Date(now.getTime() + ttlMs);
  await sql`
    UPDATE action_approval_grants
    SET expires_at = ${expiresAt}
    WHERE grant_id = ${grantId} AND kind = 'operator' AND consumed_at IS NULL
      AND (expires_at IS NULL OR expires_at > ${now})
  `;
}

/** Read a grant by id, or null. Carries the internal `pending*` fields for the bot's use. */
export async function getGrant(sql: postgres.Sql, grantId: string): Promise<GrantRow | null> {
  const [row] = await sql<DbGrantRow[]>`SELECT * FROM action_approval_grants WHERE grant_id = ${grantId}`;
  return row ? rowToGrant(row) : null;
}

/** Spend an unconfirmed grant without ever letting it authorize anything. */
export async function cancelGrant(sql: postgres.Sql, grantId: string, now: Date = new Date()): Promise<void> {
  await sql`
    UPDATE action_approval_grants SET consumed_at = ${now}
    WHERE grant_id = ${grantId} AND kind = 'operator' AND consumed_at IS NULL
  `;
}

// ---------------------------------------------------------------------------
// Presenting — the execution-time check
// ---------------------------------------------------------------------------

export type PresentResult =
  | { ok: true; grant: ApprovalGrant }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "mismatch"; grantedFingerprint: ActionFingerprint; actionFingerprint: ActionFingerprint }
  | { ok: false; reason: "consumed" }
  | { ok: false; reason: "expired" };

/**
 * The one function that decides whether a grant authorizes the action about
 * to run.
 *
 * `actionFingerprint` must be derived by the caller from the action it is
 * about to execute — never from anything the request carried alongside the
 * grant id (P-2.5). This function does not derive it; it only compares.
 *
 * A standing grant is never consumed here — that exemption is what
 * "standing" means (P-2.2 / schema `consumedAt`). Recording its use as an
 * autonomous action is the caller's job (`recordAutonomousAction`), because
 * only the caller knows who the actor is and who authorized it — this
 * function is generic over both grant kinds.
 *
 * An operator grant is consumed atomically: the `UPDATE ... WHERE
 * consumed_at IS NULL` either claims it or it does not, so two concurrent
 * presentations of the same grant cannot both succeed.
 */
export async function presentGrant(
  sql: postgres.Sql,
  grantId: string,
  actionFingerprint: ActionFingerprint,
  now: Date = new Date(),
): Promise<PresentResult> {
  const [row] = await sql<DbGrantRow[]>`SELECT * FROM action_approval_grants WHERE grant_id = ${grantId}`;
  if (!row) return { ok: false, reason: "not-found" };

  const grantedFingerprint: ActionFingerprint = { half: row.half, scope: row.scope, downtime: row.downtime };
  if (!fingerprintsEqual(grantedFingerprint, actionFingerprint)) {
    return { ok: false, reason: "mismatch", grantedFingerprint, actionFingerprint };
  }

  if (row.kind === "standing") {
    return { ok: true, grant: toApprovalGrant(rowToGrant(row)) };
  }

  // Operator kind: single-use and short-lived.
  if (row.consumed_at) return { ok: false, reason: "consumed" };
  if (row.expires_at && now.getTime() > new Date(row.expires_at).getTime()) {
    return { ok: false, reason: "expired" };
  }

  const [claimed] = await sql<DbGrantRow[]>`
    UPDATE action_approval_grants SET consumed_at = ${now}
    WHERE grant_id = ${grantId}
      AND consumed_at IS NULL
      AND (expires_at IS NULL OR expires_at > ${now})
    RETURNING *
  `;
  if (!claimed) {
    // Lost the race, or expired in the gap between the read above and this
    // update — read back once more to say which.
    const [fresh] = await sql<DbGrantRow[]>`SELECT expires_at, consumed_at FROM action_approval_grants WHERE grant_id = ${grantId}`;
    if (fresh?.expires_at && now.getTime() > new Date(fresh.expires_at).getTime()) {
      return { ok: false, reason: "expired" };
    }
    return { ok: false, reason: "consumed" };
  }
  return { ok: true, grant: toApprovalGrant(rowToGrant(claimed)) };
}

// ---------------------------------------------------------------------------
// Autonomous actors — standing grants
// ---------------------------------------------------------------------------

export type AutonomousAuthorization =
  | { ok: true; grant: ApprovalGrant }
  | { ok: false; reason: "no-standing-grant" };

/**
 * No approver reachable → deny (P-2.3), except for an actor holding a
 * standing grant scoped to exactly this fingerprint (P-2.3a). There is no
 * partial match: `sessions/all/brief` does not authorize
 * `sessions/<path>/brief` and a `container` or `both` fingerprint never
 * matches a standing grant at all, because the unique index that backs
 * standing grants is keyed on the exact triple.
 */
export async function authorizeAutonomousAction(
  sql: postgres.Sql,
  actor: string,
  fingerprint: ActionFingerprint,
): Promise<AutonomousAuthorization> {
  const [row] = await sql<DbGrantRow[]>`
    SELECT * FROM action_approval_grants
    WHERE kind = 'standing' AND issued_by_actor = ${actor}
      AND half = ${fingerprint.half} AND scope = ${fingerprint.scope} AND downtime = ${fingerprint.downtime}
    LIMIT 1
  `;
  if (!row) return { ok: false, reason: "no-standing-grant" };
  const grant = toApprovalGrant(rowToGrant(row));
  await recordAutonomousAction(sql, {
    grantId: grant.grantId,
    actor,
    authorizedBy: typeof grant.issuedBy === "object" ? grant.issuedBy.authorizedBy : 0,
    fingerprint,
  });
  return { ok: true, grant };
}

export interface AutonomousActionEntry {
  grantId: string;
  actor: string;
  authorizedBy: number;
  fingerprint: ActionFingerprint;
  at?: Date;
}

/** Append-only: what restarted itself, on whose authority, and when. */
export async function recordAutonomousAction(sql: postgres.Sql, entry: AutonomousActionEntry): Promise<void> {
  await sql`
    INSERT INTO autonomous_actions (grant_id, actor, authorized_by, half, scope, downtime, acted_at)
    VALUES (${entry.grantId}, ${entry.actor}, ${entry.authorizedBy},
            ${entry.fingerprint.half}, ${entry.fingerprint.scope}, ${entry.fingerprint.downtime}, ${entry.at ?? new Date()})
  `;
}
