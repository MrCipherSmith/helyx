# Spike Findings — Can `codex exec` Serve as a Tool-Decision Source?

Version: 1.0.0

## What was run

Three `codex exec --json -s read-only` calls against a throwaway scratch
directory (not this repository — a two-line `sample.txt` in an isolated git
init under the session scratchpad), 2026-08-09, `codex-cli 0.147.0`,
authenticated via the operator's existing ChatGPT login (`codex login
status` → "Logged in using ChatGPT", the same session `/codex_setup`
already established):

1. A plain question with no tool need.
2. A request that naturally requires reading a file.
3. A request that naturally requires writing a file, under `-s read-only`
   (so the sandbox should refuse the write).

Full JSONL streams and final-message files are not committed (throwaway
per `prd.md`'s own framing — "a throwaway spike script does not count as
the daemon"); the relevant excerpts are quoted below verbatim.

## Result: no — the answer this package needed is negative

**`codex exec`'s `--json` stream does not separate "decide to call a tool"
from "the tool already ran" in a way a proxy could intercept and hand to
Claude Code's own tool loop.** Three independent problems, each sufficient
on its own:

### 1. Execution happens before the proxy could veto it

Test 2's stream:

```json
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/usr/bin/zsh -lc \"sed -n '2p' sample.txt\"","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution",...,"aggregated_output":"line 2\n","exit_code":0,"status":"completed"}}
```

`item.started` does exist as a distinct event — but it names a command
already handed to a real shell; a proxy reading the stream sees it at the
same moment the shell does, not before. There is no confirmed hook where a
proxy could intercept that command, translate it into an Anthropic
`tool_use` block, wait for Claude Code's own tool result, and feed that
back in — the command has already run by the time anything downstream
could react.

### 2. The action model doesn't match Claude Code's tool schema

Every action observed is a raw shell command (`command_execution` running
`/usr/bin/zsh -lc "..."`), not a named, schema'd tool call. Claude Code's
own tool loop thinks in terms of `Read`, `Edit`, `Grep`, `Bash` — distinct
tools with distinct input schemas. Codex has one action: run a shell
command. Mapping `command_execution` onto Claude Code's tool set would mean
routing everything through a generic `Bash` tool and losing the
distinction Claude Code's own permission model and UI depend on — not a
clean translation, an approximation.

### 3. A blocked write degrades to unstructured prose, not a parseable intent

Test 3, the write attempt under `-s read-only`:

```json
{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"I couldn’t modify `sample.txt`: the workspace is mounted read-only and write approval is disabled. The intended addition is:\n\n```text\nline 3\n```"}}
```

No `command_execution` item was emitted for the write at all — Codex
reasoned about the sandbox constraint and never attempted the syscall, so
there is nothing here shaped like a `tool_use` block to translate: the
"intended edit" exists only inside a free-text `agent_message`,
recoverable only by parsing prose that has no documented, stable shape.
Confirmed unchanged on disk after the call.

### Side findings, both relevant to the risks already on record

- **Ambient config leaks into every call.** Both file-touching tests show
  Codex trying to read `.metaproject/index.md` on its own initiative — a
  convention from the operator's global Codex configuration, not from the
  prompt. A real proxy would need `--ignore-user-config` (or equivalent
  isolation) to get behaviour that depends only on what Claude Code sent,
  not on whatever the operator's Codex account carries globally.
- **Token overhead is large and grows every call.** `input_tokens` across
  the three tests: 32 161 → 96 847 → 129 961, for requests that carried a
  two-line file and one short instruction each. Confirms `prd.md`'s R3
  (latency/cost) with real numbers rather than a guess — each `codex exec`
  invocation appears to reload a substantial fixed context, on the same
  order of magnitude as Claude Code's own ~41k-token prompt noted
  elsewhere in this project's memory.

## Conclusion for `prd.md` / `specification.md`

FR5 and **Option B** (Codex as a tool-decision source) are not viable with
the CLI surface `codex exec` currently exposes. This is not "unverified
pending more research" any more — it is answered, negative, with evidence
above.

**Option A** (Codex as a delegated sub-agent — the whole turn handed to
Codex under `-s workspace-write`, its final text becomes the reply, no
real `tool_use` translation) remains the only path this spike leaves open,
exactly as `prd.md` §Recommendation described it in advance. Its cost and
ambient-config concerns are now measured rather than assumed. Whether that
reduced-fidelity design is still worth building is the operator's call —
nothing here decides it, and nothing was built beyond this spike per the
operator's own instruction ("я ещё подумаю, если что мы к ней вернёмся").
