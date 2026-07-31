# Spec: Status Message UX Improvements

**Version:** 2.0  
**Date:** 2026-06-29  
**Status:** Implemented — verified against the code on 2026-07-31  
**Target:** `channel/status.ts`, `channel/poller.ts`, `channel/tools.ts`, `channel/permissions.ts`

### Verification, 2026-07-31

All six improvements shipped in `dbdf0be` — "feat(status): implement status UX improvements
(SU-1 through SU-6) (#36)". The document was left at `Draft — pending review`.

Checked individually in `channel/status.ts`: `computeSignature` with the early return on a
matching `lastSentSignature` (SU-1); `chooseSpinnerInterval` and the recursive `scheduleTick`
with `state.timer = setTimeout(...)` and `clearTimeout` on delete, no `clearInterval` left
(SU-2); `detectPhase`, `PHASE_LABEL` and `StatusExtras` (SU-3); `accumulateTurnActivity`
(SU-4); `pendingImmediateEdit` (SU-5); `nextEditDelay = 30_000` on a 429 or exhausted
deadline (SU-6). Every new `StatusState` field from Section 4 is present and `timer` is typed
`setTimeout`.

---

## 1. Background and Motivation

The current status message system in Helyx has several known weaknesses identified through code analysis of `channel/status.ts`:

1. **Slow spinner cadence** — 15-second `setInterval` means the UI looks frozen for short tasks.
2. **No content-hash dedup** — `editTelegramMessage` is called even when the formatted text is identical to what was last sent, generating "message is not modified" errors that are silently swallowed (line 592).
3. **No activity phase label** — user sees only a Braille spinner + elapsed time + raw tmux output, with no indication of *what kind* of work is happening.
4. **No per-turn tool counter** — no indication of how much work Claude has done in the current turn.
5. **Concurrent edit race** — `updateStatus()` calls `editStatusMessage()` directly without checking `editInFlight`, which the timer callback sets (lines 473–479). If the timer fires while `updateStatus()` is awaiting, both issue a concurrent `editTelegramMessage` for the same message ID.
6. **429 backoff gap** — when `editTelegramMessage` returns a 429 error after exhausting its 60s budget, the status timer doesn't know to wait longer before the next tick; it reschedules at the fixed 15s interval and may immediately retry into another 429.

**Reference inspiration:** `grinev/opencode-telegram-bot` uses signature-based dedup, throttled streaming, and a `CompactProgressStreamer` with activity phase text. The patterns below are adapted to Helyx's tmux-polling model and `StatusManager` class — not copied verbatim.

---

## 2. Scope

### In scope
- [SU-1] Content signature deduplication for status edits
- [SU-2] Adaptive spinner frequency (active vs. idle)
- [SU-3] Activity phase label in status text
- [SU-4] Per-turn tool invocation counter
- [SU-5] Concurrent edit guard for `updateStatus()`
- [SU-6] 429 backoff coordination for status edits

### Out of scope
- Pinned message approach (Helyx uses bottom-of-chat status, not pinned)
- Multi-part streaming messages
- DB schema changes (all state additions are in-memory only)
- Forum mode changes (existing forum-mode logic preserved as-is)
- `channel/telegram.ts` changes

---

## 3. Improvements

### SU-1 — Content Signature Deduplication

**Problem:** `editStatusMessage()` (line 581) sends a Telegram edit every 15 seconds regardless of whether the content changed. `editTelegramMessage` is called, Telegram returns "message is not modified", the error is swallowed silently (line 592). This wastes API quota.

**Solution:** Compute a lightweight signature of the formatted text before calling `editTelegramMessage`. Skip the API call if the signature matches the last successfully-sent signature.

**New field in `StatusState`:**
```typescript
lastSentSignature: string | null;   // signature of last text sent to Telegram; null after send/creation
```
Initialize to `null` in `sendStatusMessage()` at state creation (alongside existing fields at line ~462).

**Signature function** (add as standalone helper in `channel/status.ts`, outside the class — it is pure):
```typescript
function computeSignature(text: string): string {
  // FNV-1a 32-bit — fast, no external deps, sufficient for dedup
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}
```

**Integration in `editStatusMessage()`** — the full revised method body, replacing lines 581–595:

```typescript
private async editStatusMessage(state: StatusState): Promise<void> {
  const token = this.ctx.token();
  if (!token) return;

  const elapsed = formatElapsed(Date.now() - state.startedAt);
  const key = state.threadId ? `${state.chatId}:${state.threadId}` : state.chatId;
  const tokens = this.lastTokenInfo.get(key);
  const tokenStr = tokens ? ` · ↓ ${tokens}` : "";
  // SU-3: compute phase extras (turnToolCount/fileCount already exist from Step 0 + SU-4)
  const phase = detectPhase(state.stage);
  const extras: StatusExtras = {
    phaseEmoji: phase ? PHASE_LABEL[phase] : undefined,  // undefined → no emoji for empty stage
    toolCount: state.turnToolCount,
    fileCount: state.turnFileCount,
  };

  // SU-1: compute signature from CONTENT ONLY, excluding the spinner icon.
  // The spinner icon always changes on each call (spinnerFrame increments below),
  // so including it in the signature would make dedup permanently inert.
  // Signature captures: stage + elapsed + tokens + paneSnapshot + phase + toolCount + fileCount.
  // Dedup fires when updateStatus() is called multiple times within the same second
  // with identical content, preventing redundant Telegram API calls.
  const contentForSig = formatStatusText(state.stage, elapsed, tokenStr, state.paneSnapshot, undefined, extras);
  const sig = computeSignature(contentForSig);
  if (sig === state.lastSentSignature) {
    channelLogger.debug({ messageId: state.messageId }, "editStatusMessage: skipping redundant edit");
    return;
  }

  // Content changed — advance spinner and compose final text with the live icon
  state.spinnerFrame = (state.spinnerFrame + 1) % SPINNER_FRAMES.length;
  const spinnerIcon = getSpinnerIcon(state.spinnerFrame, state.lastUpdateAt);
  const text = formatStatusText(state.stage, elapsed, tokenStr, state.paneSnapshot, spinnerIcon, extras);

  const res = await editTelegramMessage(token, state.chatId, state.messageId, text, { parse_mode: "HTML" });
  if (!res.ok && !res.errorBody?.includes("message is not modified")) {
    channelLogger.warn({ error: res.errorBody, messageId: state.messageId }, "editStatusMessage failed");
  }
  if (res.ok) {
    state.lastSentSignature = sig;
  }
  // SU-6: back off if rate-limited (see SU-6 section)
  // "telegramRequest 429 deadline exceeded" is the actual error body produced by telegram.ts
  // when the 60s retry budget is exhausted. "Too Many Requests" is consumed internally.
  if (!res.ok && (res.errorBody?.includes("429") || res.errorBody?.includes("deadline exceeded"))) {
    state.nextEditDelay = 30_000;
  }
}
```

**Why signature excludes spinner:** `formatStatusText()` (line 85) embeds the spinner icon in `header`. If the sig were computed from the full rendered text, `spinnerFrame++` would guarantee a unique sig on every call — making dedup permanently inert. By computing the sig from the content rendered with `spinnerIcon = undefined` (defaults to `SPINNER_FRAMES[0]`, a stable placeholder), the sig reflects actual content changes. The spinner is then applied to the final text sent to Telegram.

**Expected impact:** Eliminates redundant `editTelegramMessage` calls when `editStatusMessage()` is invoked sequentially (not concurrently) with identical content. The operative scenario: two non-in-flight `updateStatus()` calls arrive within the same second with the same stage text — `formatElapsed()` returns the same string, extras are identical, signature matches, second call is skipped. Note: concurrent burst calls (arriving while `editInFlight = true`) are handled by SU-5's `pendingImmediateEdit` buffer and never reach `editStatusMessage()` at all — SU-1 dedup is orthogonal to SU-5. Timer-driven ticks (every 3–15s) always advance `elapsed` by at least one second, so their signatures always differ — dedup does not suppress them (correct behaviour: ticks must go through to advance the spinner). Net effect: cleaner logs, no "message is not modified" noise from same-second sequential updates. Also consolidates SU-3 and SU-6 logic into one method body.

---

### SU-2 — Adaptive Spinner Frequency

**Problem:** The 15s `setInterval` fires even when Claude is actively producing output (visible in the file monitor every 2s). Fast tasks — under 30 seconds — get zero or one spinner update.

**Solution:** Replace the `setInterval` in `sendStatusMessage()` with a recursive `setTimeout` loop. After each tick, compute the next delay based on recent monitor activity.

**Structural change required:** The current timer is `setInterval` (line 472, types at line 38). This must be replaced with `setTimeout` to allow per-tick delay adjustment. The `clearInterval` call in `deleteStatusMessage()` (line ~631) must also be updated to `clearTimeout`. This is the only structural change in SU-2.

**New constants** (add near existing `SPINNER_STALE_MS` constant):
```typescript
const SPINNER_INTERVAL_ACTIVE_MS = 3_000;   // when monitor has been active recently
const SPINNER_INTERVAL_IDLE_MS   = 15_000;  // when no monitor activity for >IDLE_THRESHOLD_MS
const IDLE_THRESHOLD_MS          = 12_000;  // switch to idle after 12s of silence
```

**New private method** `chooseSpinnerInterval(state: StatusState): number`:
```typescript
private chooseSpinnerInterval(state: StatusState): number {
  const key = state.threadId
    ? `${state.chatId}:${state.threadId}`
    : state.chatId;
  const lastActivity = this.lastMonitorActivity.get(key) ?? 0;
  return (Date.now() - lastActivity) < IDLE_THRESHOLD_MS
    ? SPINNER_INTERVAL_ACTIVE_MS
    : SPINNER_INTERVAL_IDLE_MS;
}
```

**Note on key format:** `lastMonitorActivity` is keyed by `this.stateKey(chatId)` in `updateStatus()` (line 542–546), which returns `${forum.chatId}:${forum.threadId}` in forum mode. The key computed above (`state.threadId ? \`...\` : state.chatId`) matches the format used in `editStatusMessage()` (line 587) and is equivalent.

**Timer setup in `sendStatusMessage()`:**

Replace ONLY the `setInterval` block (lines 472–481) with the `scheduleTick` function definition — **do not include the initial `scheduleTick(key)` call here**:

```typescript
const scheduleTick = (key: string): void => {
  const state = this.activeStatus.get(key);
  if (!state) return;
  const delay = state.nextEditDelay ?? this.chooseSpinnerInterval(state);
  state.nextEditDelay = null;
  state.timer = setTimeout(async () => {
    if (state.editInFlight) {
      scheduleTick(key);
      return;
    }
    state.editInFlight = true;
    try {
      await this.refreshPaneSnapshot(state).catch(() => {});
      await this.editStatusMessage(state);
      // SU-5: drain any pending stage update buffered during in-flight edit
      if (state.pendingImmediateEdit) {
        state.pendingImmediateEdit = false;
        await this.editStatusMessage(state);
      }
    } finally {
      state.editInFlight = false;
    }
    scheduleTick(key);
  }, delay);
};
```

Then place the **initial `scheduleTick(key)` call AFTER `this.activeStatus.set(key, state)`** (line 489). This is critical: `scheduleTick` does `this.activeStatus.get(key)` on its first line — if called before the map is populated, it returns `undefined`, exits immediately, and the spinner never starts.

```typescript
// line 489 (existing):
this.activeStatus.set(key, state);
// ADD immediately after:
scheduleTick(key);
```

**`deleteStatusMessage()`:** Replace `clearInterval(state.timer)` (line ~631) with `clearTimeout(state.timer)`.

**Expected impact:** For an 8-second task, user sees 2–3 updates (at 3s, 6s) instead of zero. For a 2-minute thinking task, the interval self-stretches to 15s after 12s of silence.

---

### SU-3 — Activity Phase Label

**Problem:** The status text shows only a Braille spinner + elapsed time + raw tmux output. The user cannot tell at a glance whether Claude is thinking, reading files, running shell commands, etc.

**Solution:** Parse the current `state.stage` value to classify the current activity, then surface a short emoji label alongside the spinner on the first line. The phase is computed in `editStatusMessage()` where `state` is available, and passed to `formatStatusText()` via a new optional `extras` parameter.

**New type and phase map** (standalone, outside class):
```typescript
type ActivityPhase = 'thinking' | 'reading' | 'writing' | 'running' | 'searching' | 'waiting';

// Returns null for empty/whitespace stage so no emoji is shown (acceptance criterion SU-3).
//
// Note on stage format: all tool-call lines from tmux-monitor.ts start with "● ":
//   "● $ command"           — Bash (tmux-monitor.ts line 107)
//   "● Read: filename"      — file read (line 111)
//   "● Write: filename"     — file write (line 111)
//   "● MCP: toolname"       — MCP call (line 115)
//   "● AgentType: desc"     — agent call (line 103)
//   "● toolname..."         — generic tool (line 117)
// Non-tool stage text (custom messages, "Thinking...", etc.) does NOT start with "● ".
function detectPhase(stage: string): ActivityPhase | null {
  const s = stage.trim().toLowerCase();
  if (!s) return null;
  if (s.includes('permission') || s.includes('approve') || s.includes('waiting')) return 'waiting';

  // stage is multi-line: spinner line first, most recent tool line last.
  // Find the last "● " line to classify the current tool call.
  const lastBulletLine = s.split('\n').filter(l => l.startsWith('● ')).at(-1) ?? '';
  if (lastBulletLine) {
    if (lastBulletLine.startsWith('● $'))                                              return 'running';   // Bash
    if (lastBulletLine.includes('● read'))                                             return 'reading';
    if (lastBulletLine.includes('● write') || lastBulletLine.includes('● edit') || lastBulletLine.includes('● creat')) return 'writing';
    if (lastBulletLine.includes('grep') || lastBulletLine.includes('search') || lastBulletLine.includes('find') || lastBulletLine.includes('● mcp')) return 'searching';
    return 'running';  // MCP, Agent, generic tool → running
  }

  // Non-tool stage text (custom messages)
  if (s.includes('write') || s.includes('edit') || s.includes('creat')) return 'writing';
  if (s.includes('read'))                                                  return 'reading';
  if (s.includes('bash') || s.includes('execut') || s.includes('run'))   return 'running';
  if (s.includes('grep') || s.includes('search') || s.includes('find'))  return 'searching';
  return 'thinking';
}

const PHASE_LABEL: Record<ActivityPhase, string> = {
  thinking:  '🧠',
  reading:   '📖',
  writing:   '✏️',
  running:   '⚡',
  searching: '🔍',
  waiting:   '💬',
};
```

**New `StatusExtras` type** (standalone, outside class):
```typescript
interface StatusExtras {
  phaseEmoji?: string;
  toolCount?: number;
  fileCount?: number;
}
```

**`formatStatusText()` signature change** — add optional 6th parameter:
```typescript
function formatStatusText(
  stage: string,
  elapsed: string,
  tokens: string,
  paneSnapshot?: string | null,
  spinnerIcon?: string,
  extras?: StatusExtras,        // NEW
): string {
```

**First-line change in `formatStatusText()`:**
Current: `const header = \`${icon} <i>${elapsed}${tokens}</i>\`;`  
New:
```typescript
const phase = extras?.phaseEmoji ? ` ${extras.phaseEmoji}` : '';
const header = `${icon} <i>${elapsed}${tokens}</i>${phase}`;
```

**Footer and return replacement in `formatStatusText()`:**

The function has two `return` statements (line 105: pane-snapshot path; line 108: ternary for multiline vs. single-line). Both must include the footer. Replace from the `if (paneSnapshot …)` block to the end of the function:

```typescript
// Compute footer once; empty string if no tool activity yet
const footer = (extras?.toolCount ?? 0) > 0
  ? `\n🔧 ${extras!.toolCount} tools · ${extras!.fileCount ?? 0} files`
  : '';

// Path 1 — pane snapshot early return (must include footer)
if (paneSnapshot && paneSnapshot.trim()) {
  const paneLines = paneSnapshot.trim().split("\n").slice(-6);
  const paneText = escapeHtml(paneLines.join("\n"));
  return `${header}\n${stageBody}\n<blockquote><tg-spoiler>🖥 ${paneText}</tg-spoiler></blockquote>${footer}`;
}

// Path 2/3 — preserve existing single-line compact vs multi-line distinction
return normalized.includes("\n")
  ? `${header}\n${stageBody}${footer}`
  : `${header}${stageBody}${footer}`;
```

This preserves the existing single-line compact layout (`${header}${stageBody}` with no `\n`) while adding the footer to all three paths, including the paneSnapshot path where tool activity is most informative.

**Call site in `editStatusMessage()`:** SU-3's types are used inside the full `editStatusMessage()` replacement body specified in SU-1 (see SU-1 section, "Integration in editStatusMessage()"). Do not add a separate call site here — apply SU-1's full method body after SU-3's types are in place. The correct null-safe usage (per implementation order, SU-3 → SU-1) is:
```typescript
const phase = detectPhase(state.stage);
const extras: StatusExtras = {
  phaseEmoji: phase ? PHASE_LABEL[phase] : undefined,  // null-safe — phase is ActivityPhase | null
  toolCount: state.turnToolCount,
  fileCount: state.turnFileCount,
};
```

**Expected impact:** User sees 📖 vs. ⚡ vs. 🧠 at a glance without reading the stage text.

---

### SU-4 — Per-Turn Tool Invocation Counter

**Problem:** For multi-step tasks, the user cannot tell how much work has been done in the current turn.

**Solution:** Track tool invocations and distinct files in `StatusState`. Increment inside `updateStatus()` by pattern-matching the `stage` string, following the same pattern as `accumulateStats()` (line 561). Display counts in the status footer via `StatusExtras` (wired in SU-3).

**New fields in `StatusState`:**
```typescript
turnToolCount: number;        // tool calls observed this turn; reset at state creation
turnFileCount: number;        // distinct files touched this turn
turnFilePaths: Set<string>;   // backing Set for dedup
```
Initialize all three at state creation in `sendStatusMessage()` alongside existing fields.

**New private method** `accumulateTurnActivity(state: StatusState, stage: string): void`:
```typescript
private accumulateTurnActivity(state: StatusState, stage: string): void {
  // stage is multi-line: spinner line first (oldest), then tool lines below (newer).
  // Use the LAST "● " line — the most recent tool call in the block.
  // Pattern: "● $ command" (Bash), "● Read: file", "● MCP: tool", "● AgentType: desc", "● tool..."
  const lastToolLine = stage.split('\n').filter(l => l.startsWith('●')).at(-1);
  if (!lastToolLine) return;
  // Dedup: skip if this is the same tool line we already counted on the previous poll.
  // The same "● Read: file.ts" line persists across multiple updateStatus() calls while
  // surrounding lines (spinner text, sub-output) change — without this guard it would be
  // double-counted every poll tick.
  if (lastToolLine === state.lastCountedToolLine) return;
  state.lastCountedToolLine = lastToolLine;
  state.turnToolCount++;
  // Extract filename from file-operation lines (e.g. "● Read: src/channel/status.ts")
  const fileMatch = lastToolLine.match(/●\s+(?:Read|Write|Edit|Create):\s*([^\s\n]+\.[a-zA-Z]{1,8})/i);
  if (fileMatch) {
    state.turnFilePaths.add(fileMatch[1]);
    state.turnFileCount = state.turnFilePaths.size;
  }
}
```

**Integration in `updateStatus()`:** The call to `this.accumulateTurnActivity(state, stage)` is **already included in SU-5's full `updateStatus()` replacement body** (Section 3, SU-5). Per Section 6, SU-4 comes before SU-5. When implementing SU-4, add **only the `accumulateTurnActivity` private method** — do NOT add the call to `updateStatus()` separately. SU-5 completely replaces `updateStatus()`, so any manual call added to the method during SU-4 would be overwritten when SU-5 is applied; add only the method definition here.

Counters reset automatically on the next user message because `sendStatusMessage()` creates a fresh `StatusState` object (lines 458–471) — no explicit reset needed.

**Expected impact:** "🔧 14 tools · 5 files" grows incrementally in the status footer during long tool chains.

---

### SU-5 — Concurrent Edit Guard for `updateStatus()`

**Problem:** `updateStatus()` calls `this.editStatusMessage(state)` directly (line 558) without checking `editInFlight`. The timer callback sets `state.editInFlight = true` while awaiting `refreshPaneSnapshot + editStatusMessage`. If `updateStatus()` fires concurrently (e.g., from the permission handler in `permissions.ts`), two `editTelegramMessage` calls run in parallel for the same `messageId`, creating a race.

Note: `updateStatus()` is already immediate — it does not go through the 15-second timer. The guard is needed only to prevent the parallel-API-call race.

**Solution:** When `editInFlight` is true, buffer the stage update and let the timer's cleanup path drain it after the in-flight call completes.

**New field in `StatusState`:**
```typescript
pendingImmediateEdit: boolean;  // set by updateStatus when editInFlight=true
```
Initialize to `false` at state creation.

**Modified `updateStatus()`:**
```typescript
async updateStatus(chatId: string, stage: string): Promise<void> {
  const key = this.stateKey(chatId);
  this.accumulateStats(key, stage);
  this.lastMonitorActivity.set(key, Date.now());
  const state = this.activeStatus.get(key);
  if (!state) {
    // No active status — monitor keeps running (post-reply continuation tracking).
    // Do NOT create a new orphan status message here.
    return;
  }
  this.accumulateTurnActivity(state, stage);  // SU-4
  this.resetResponseGuard(chatId);
  state.lastUpdateAt = Date.now();
  state.stage = stage;

  if (state.editInFlight) {
    // Timer is currently awaiting an editTelegramMessage — buffer the new stage;
    // the timer's finally block drains it via pendingImmediateEdit.
    state.pendingImmediateEdit = true;
    return;
  }
  // Acquire the guard so the timer cannot fire a concurrent edit while we await.
  state.editInFlight = true;
  try {
    await this.editStatusMessage(state);
  } finally {
    state.editInFlight = false;
  }
}
```

**Why `updateStatus` must set `editInFlight`:** Without this, `updateStatus` checks `editInFlight` before calling `editStatusMessage` (guarding timer→updateStatus direction), but the timer can still fire and call `editStatusMessage` concurrently while `updateStatus` is mid-await (the updateStatus→timer direction is unguarded). Setting `editInFlight = true` in `updateStatus` makes the guard bidirectional.

**Drain logic in timer tick** (already shown in SU-2's `scheduleTick` body):
```typescript
if (state.pendingImmediateEdit) {
  state.pendingImmediateEdit = false;
  await this.editStatusMessage(state);
}
```

**Additional guard — `sendStatusMessage()` fast-path** (lines 412–417). The existing fast-path calls `editStatusMessage` without checking `editInFlight`, creating the same race. Replace lines 412–417 with:
```typescript
if (existing) {
  existing.stage = `${prefix}${stage}`;
  existing.startedAt = Date.now();
  existing.lastUpdateAt = Date.now();
  if (existing.editInFlight) {
    existing.pendingImmediateEdit = true;
  } else {
    existing.editInFlight = true;
    try {
      await this.editStatusMessage(existing);
    } finally {
      existing.editInFlight = false;
    }
  }
  return null;
}
```

**Expected impact:** Eliminates concurrent `editTelegramMessage` calls for the same message in all three paths: timer→updateStatus, updateStatus→timer, and sendStatusMessage fast-path→timer.

---

### SU-6 — 429 Backoff Coordination for Status Edits

**Problem:** When `editTelegramMessage` returns `ok: false` with a 429 error (which happens when `telegramRequest` exhausts its 60s budget without succeeding), the status timer reschedules at the default interval from SU-2 (`SPINNER_INTERVAL_ACTIVE_MS` or `SPINNER_INTERVAL_IDLE_MS`) and may immediately retry into another 429.

Note: `telegramRequest` handles 429 internally by sleeping up to the 60s budget. A 429 visible to `editStatusMessage` means the budget was exhausted before Telegram accepted the request — an unusual but possible scenario under heavy load.

**Solution:** When `editStatusMessage()` detects a 429 response, set a one-tick delay override on the state. SU-2's `scheduleTick` reads and consumes this override.

**New field in `StatusState`:**
```typescript
nextEditDelay: number | null;  // one-shot delay override for SU-6; consumed by scheduleTick
```
Initialize to `null` at state creation.

**Detection and storage in `editStatusMessage()`** — add after the existing `if (!res.ok ...)` warning block:
```typescript
// "Too Many Requests" is consumed internally by telegramRequest; the actual
// errorBody surface is "telegramRequest 429 deadline exceeded (method: editMessageText)".
if (!res.ok && (res.errorBody?.includes("429") || res.errorBody?.includes("deadline exceeded"))) {
  state.nextEditDelay = 30_000;  // back off 30s after rate-limit exhaustion
}
```

**Note:** SU-6 logic is already embedded in SU-1's full `editStatusMessage()` body. If SU-1 is applied as a full method replacement (recommended), no separate change for SU-6 is needed — just verify the `nextEditDelay` assignment is present.

**Consumption in `scheduleTick()`** (SU-2's timer loop):
```typescript
const delay = state.nextEditDelay ?? this.chooseSpinnerInterval(state);
state.nextEditDelay = null;
```

No changes to `channel/telegram.ts` are required. The 429 detection uses `res.errorBody` which is already returned by `editTelegramMessage`.

**Expected impact:** After a 429, the status edit path backs off 30 seconds before retrying, instead of immediately retrying at 3–15s.

---

## 4. `StatusState` Interface — Complete Reference

Showing all fields after this spec is implemented. Bold = new additions.

```typescript
interface StatusState {
  // --- EXISTING (unchanged) ---
  chatId: string;                                      // NOTE: string, not number
  threadId?: number;                                   // forum topic ID; undefined in DM mode
  messageId: number;
  startedAt: number;
  stage: string;
  paneSnapshot: string | null;                         // NOTE: nullable
  paneSnapshotAt: number | null;
  dbHeartbeatTimer: ReturnType<typeof setInterval> | null;
  spinnerFrame: number;
  lastUpdateAt: number;
  editInFlight: boolean;

  // --- MODIFIED (SU-2) — type changes from setInterval to setTimeout ---
  timer: ReturnType<typeof setTimeout> | null;         // was setInterval; SU-2 changes to setTimeout

  // --- NEW (SU-1) ---
  lastSentSignature: string | null;    // null at creation only; updated to sig after each successful edit

  // --- NEW (SU-4) ---
  turnToolCount: number;
  turnFileCount: number;
  turnFilePaths: Set<string>;
  lastCountedToolLine: string | null;  // last "● ..." line counted; deduplicates repeated polls

  // --- NEW (SU-5) ---
  pendingImmediateEdit: boolean;

  // --- NEW (SU-6) ---
  nextEditDelay: number | null;
}
```

After SU-2 is implemented, `timer` type changes from `ReturnType<typeof setInterval>` to `ReturnType<typeof setTimeout>` — update the interface accordingly.

---

## 5. Files to Modify

| File | Changes |
|------|---------|
| `channel/status.ts` | All 6 improvements. New fields in `StatusState`; new helpers: `computeSignature()`, `detectPhase()`, `PHASE_LABEL`, `StatusExtras`, `accumulateTurnActivity()`, `chooseSpinnerInterval()`; modify `sendStatusMessage()` (init new fields, replace setInterval with scheduleTick), `editStatusMessage()` (signature dedup, phase/counter extras), `updateStatus()` (editInFlight guard), `deleteStatusMessage()` (clearInterval → clearTimeout), `formatStatusText()` (extras param, phase + footer). |
| `channel/tools.ts` | No new call sites needed — the `status.deleteStatusMessage()` calls (lines 372, 431, 443) remain unchanged. |
| `channel/permissions.ts` | No changes — `this.status.updateStatus(chatId, shortDesc)` at line 231 is already immediate. |
| `channel/poller.ts` | No changes required by this spec. |

**`channel/telegram.ts`: no changes.**

---

## 6. Implementation Order

**Step 0 — Add all new `StatusState` fields first (prerequisite).**  
Before implementing any SU, add every new field from Section 4 to the `StatusState` interface in `channel/status.ts`, and initialize them all in the state-creation block inside `sendStatusMessage()`. This ensures TypeScript compiles at every subsequent step:

```typescript
// In StatusState interface — add all new fields:
lastSentSignature: string | null;      // SU-1
turnToolCount: number;                 // SU-4
turnFileCount: number;                 // SU-4
turnFilePaths: Set<string>;            // SU-4
lastCountedToolLine: string | null;    // SU-4
pendingImmediateEdit: boolean;         // SU-5
nextEditDelay: number | null;          // SU-6

// In sendStatusMessage() state-creation block (alongside existing fields ~line 462):
lastSentSignature: null,
turnToolCount: 0,
turnFileCount: 0,
turnFilePaths: new Set(),
lastCountedToolLine: null,
pendingImmediateEdit: false,
nextEditDelay: null,
```

Then implement SUs in this order:

1. **SU-3** (phase label infrastructure) — **must come first**. Adds `StatusExtras`, `detectPhase`, `PHASE_LABEL` (standalone helpers outside the class) and updates `formatStatusText()` signature and body. SU-1's full `editStatusMessage()` body references all three — they must exist before SU-1 compiles.
2. **SU-1** (signature dedup + SU-6 baked in) — replace `editStatusMessage()` with the full method body from SU-1's section. This body already includes SU-3 phase computation and SU-6 429 backoff — no separate SU-6 step needed.
3. **SU-2** (adaptive frequency + setInterval→setTimeout) — replace timer setup; all new fields exist from Step 0.
4. **SU-4** (tool counter — method only) — add `accumulateTurnActivity` private method. **Must come before SU-5** because SU-5's `updateStatus()` body calls `this.accumulateTurnActivity()`.
5. **SU-5** (concurrent edit guard) — replace `updateStatus()` body; `accumulateTurnActivity` exists from step 4.

**SU-6 note:** 429 backoff is embedded in SU-1's full `editStatusMessage()` body (step 2). Verify the `state.nextEditDelay` assignment is present; the SU-2 `scheduleTick` already reads it.

Each SU is independently deployable once Step 0 and the steps before it are done. Step 0 has no runtime effect — all new fields initialize to zero/null/false.

---

## 7. Acceptance Criteria

| ID | Criterion |
|----|-----------|
| SU-1 | Zero "message is not modified" errors in logs during normal idle operation |
| SU-1 | A debug log "skipping redundant edit" (or equivalent) fires at least once during a 60s idle period |
| SU-2 | Status message updates within 5s of file-monitor activity during a task < 30s total |
| SU-2 | Edit interval returns to ≥15s after 12s of no monitor activity |
| SU-2 | `deleteStatusMessage()` correctly cancels the timer (no dangling tick after delete) |
| SU-3 | Status first line shows 📖 when stage contains "Read:", 🧠 when stage is "Thinking..." |
| SU-3 | Phase emoji does not appear when `stage` is empty |
| SU-4 | Footer "🔧 N tools · M files" appears and increments during a multi-tool task |
| SU-4 | Counter resets to 0 for the next incoming user message (new StatusState is created) |
| SU-5 | No concurrent `editTelegramMessage` calls for the same `messageId` visible in logs |
| SU-5 | `updateStatus()` called while timer is in-flight does not cause a Telegram API race |
| SU-6 | After a 429 response in `editStatusMessage()`, the next tick delay is 30s, not 3–15s |

---

## 8. Non-Goals and Constraints

- **Do not add a pinned message** — Helyx uses bottom-of-chat status. A pinned message conflicts with existing message flow.
- **Do not change the spinner character set** — Braille spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) is the current brand element.
- **Do not change DB schema** — All new state is in-memory only; recovery from restart reinitializes `StatusState` from DB without these ephemeral fields.
- **Do not introduce external dependencies** — `computeSignature()` is implemented inline with FNV-1a (no `crypto` import).
- **Maintain forum mode compatibility** — All key lookups use `state.threadId ? \`${state.chatId}:${state.threadId}\` : state.chatId`, matching the pattern already in `editStatusMessage()` line 587.
- **Do not change `channel/telegram.ts`** — SU-6 uses `res.errorBody` already returned by `editTelegramMessage`.
