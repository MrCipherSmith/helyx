# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A grant issued for fingerprint `container/all/brief`, presented for an action whose re-derived fingerprint is `sessions/all/brief`, is refused, and the refusal names both fingerprints.
- AC2: An operator grant is single-use — a second presentation of the same grantId is refused with a distinct reason from AC1.
- AC3: A grant presented after its `expiresAt` is refused.
- AC4: A restart requiring approval with no live approver reachable resolves to deny, never to allow, and never holds the restart lease while waiting.
- AC5: `claimRestart` is still called and still refuses a second concurrent restart naming the holder and the age of the lease; a test proves the fingerprint gate did not replace the lease.
- AC6: The confirmation text shown before the operator answers names the half, the scope and the downtime in words, and the exact sentence shown is persisted on the grant as `statedTo`.
- AC7: The fingerprint used at execution time is re-derived from the action about to run; a test proves a fingerprint supplied alongside the request is ignored.
- AC8: The standing-grant mechanism exists and is tested — a `kind: "standing"` grant authorizes repeated actions within its own fingerprint and records each use as an autonomous action with the actor and the authorizing operator.
- AC9: A standing grant holder is refused when the re-derived fingerprint is `container/*`, `both/*`, or `sessions/all/*` — three separate refusals — and refused when it holds no grant at all.
- AC10: A standing grant is not consumed by use — two successive uses both succeed — while an operator grant's second use fails.
- AC11: The `bun cli.ts bounce` path in `cli.ts` no longer proceeds silently while a Telegram-triggered restart holds the lease.
- AC12: Grant records validate against `docs/requirements/keryx-adoption-2026-08-12/schemas/action-approval-grant.schema.json`, including the `kind` discriminator, both `issuedBy` shapes, and a `container:<name>` scope.
- AC13: `bun test` passes, `tsc --noEmit` passes, and lint passes; no pre-existing test is weakened or skipped to achieve this.
- AC14: `scripts/tmux-watchdog.ts` performs no unattended restart. It alerts, exactly as it did before this flow. A test asserts the watchdog issues no restart command and holds no standing grant at runtime.
- AC15: All eight teardown-capable admin commands are gated — `bounce`, `host_restart`, `full_restart`, `docker_restart`, `docker_restart_all`, `tmux_stop`, `channel_kill`, `proj_stop` — each with the fingerprint given in specification.md §A2 "The complete mapping".
- AC16: `tmux_stop` and `proj_stop` carry `downtime: "full"`, not `brief`, because nothing brings them back on its own.
- AC17: `docker_restart` of a single named container uses scope `container:<name>`, and a grant for one container does not authorize restarting another.
- AC18: The three bring-up commands `stack_up`, `tmux_start` and `proj_start` remain ungated, and a test pins that `stack_up` in particular needs no approval — it is the documented recovery path when the stack is half-down.
- AC19: A test enumerates the `case` labels in `scripts/admin-daemon.ts` and fails if a teardown-capable command exists that is neither gated nor on the stated exemption list, so a command added later cannot silently skip the gate.
