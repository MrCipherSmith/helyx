# Field Trial — What The Hardware Actually Does

Version: 1.0.0
Run: 2026-08-07 19:05–19:44, project `arena` bound to the local provider,
model `geekom-model-1` (qwen3:14b), CPU-only host.

The translation works. The hardware does not carry it. Both halves of that
sentence are measured, and this file exists so the second half is not
rediscovered by the next person who turns the flag on.

## What was verified working

Direct calls through the proxy, before handing the session over:

| Check | Result |
|---|---|
| `GET /v1/models` | Returns the host's models; `parseModelsResponse()` parses them |
| `POST /v1/messages`, non-streaming, one tool | `tool_use` block with `stop_reason: "tool_use"`, 30 s for a trivial turn |
| `POST /v1/messages`, streaming, Cyrillic output | Event order correct, "Привет!" intact across deltas |
| `options.num_ctx` | `ollama ps` reports `ctx=40960` — the model's real window, not the server default |

The last row is the requirement from §4.1 of the PRD working as specified. Left
out, the window would have been the server default and every prompt silently
truncated.

## What the real session showed

`arena` was restarted on the provider and given one message. The numbers come
from `journalctl -u ollama`:

```
slot print_timing: prompt processing, n_tokens = 2048, progress = 0.05, t =  97.37 s / 21.03 tok/s
slot print_timing: prompt processing, n_tokens = 4096, progress = 0.10, t = 210.75 s / 19.44 tok/s
```

Three facts follow directly.

**1. The prompt is ~41 000 tokens.** 4096 tokens is 10 % of it. That is Claude
Code's system prompt, its tool definitions, the MCP tools from `helyx-channel`,
and the session-context block helyx injects at startup.

**2. It does not fit.** The model's context window is 40 960. The prompt is at
or over it before the user has typed anything, so part of the instructions is
truncated away — a model that cannot be told all of its own rules.

**3. Reading it takes ~35 minutes.** At 19–21 tokens/second of prompt
processing, before the first output token, on every turn whose prefix has
shifted.

And then the finding that settles it, from the session's own display:

```
✻ Request timed out. · Retrying in 0s · attempt 10/10
```

**Claude Code times out long before the model can answer, and retries.** Each
retry starts the prompt evaluation again from zero. So the practical outcome is
not "slow" — it is a retry loop that never produces a turn while holding
`llama-server` at ~760 % CPU and the host at load average 9. Every other session
on the machine gets slower for nothing.

## Conclusion

The feature is correct and stays. It is not usable with Claude Code on this
host, and the reason is arithmetic rather than anything a change to this code
could fix:

- **Prompt size vs window** — no proxy setting moves a 41 000-token prompt into
  a 40 960-token window. A model with a 128 k window would fit it, and on a CPU
  would read it even more slowly. That is trading the problem for itself.
- **Prompt-eval speed vs the client's timeout** — 19 tok/s is CPU-bound. Prompt
  evaluation is the part a GPU accelerates by one to two orders of magnitude,
  which is what would move this from unusable to merely slow.

`OLLAMA_PROXY_ENABLED` is back to `false` and `arena` is back on its previous
provider. The flag is where the work is preserved: when there is a GPU, this
becomes a one-line change and the translation is already tested.

## What this corrects in the PRD

§7 said the local model is "an offline fallback and an experiment", not a daily
driver. That was right in direction and too generous in degree. On this hardware
it is not a fallback either — a fallback answers eventually, and this does not
answer at all. The risk table's first row predicted the window would be tight;
the measurement is that it is already exceeded.
