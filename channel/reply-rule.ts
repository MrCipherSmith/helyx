/**
 * The one rule this whole channel rests on, written down in one place.
 *
 * A session reaches the operator through the `reply` tool and through nothing
 * else: the terminal it writes into is a tmux window on a host nobody is
 * looking at. Every session that has ever "gone silent after answering" was a
 * session that answered in the terminal.
 *
 * Until now the rule was nowhere. `arena` hung on it and its CLAUDE.md is
 * about models; `vantage-frontend` (34 KB of project rules) and
 * `vantage-backend` (10 KB) never mention `reply` either, and neither does the
 * global one — they work because the model guesses right, which is not a
 * mechanism. The tool's description was a single line ("Send a message to a
 * Telegram chat") that says what it does and not that it is the only way out.
 *
 * So it is stated three times, on three different paths into the model's
 * context, and this file is what keeps those three from drifting apart:
 *
 *  - `CHANNEL_INSTRUCTIONS` — the MCP server's instructions, which the client
 *    puts in the system prompt before the session has done anything at all.
 *  - `REPLY_TOOL_DESCRIPTION` — read every time the tool list is.
 *  - `REPLY_RULE_NOTE` — in front of every message the operator sends, which
 *    is the only one of the three that cannot be summarised away.
 */

/** What the MCP client is told about this server before the first turn. */
export const CHANNEL_INSTRUCTIONS = [
  "helyx-channel connects this session to a human operator in Telegram.",
  "",
  "The operator does not see your terminal. The `reply` tool is the only thing that reaches them:",
  "text you print at the end of a turn stays on a tmux pane on the host and is read by nobody.",
  "A turn that ends without calling `reply` leaves the operator watching a status message that",
  "never resolves — and the answer they were waiting for exists only in a log.",
  "",
  "So: answer with `reply`, ask with `reply`, and say so with `reply` when the work will take a",
  "while. Put the whole answer inside the call — code blocks and tables included. A reply of 300",
  "characters or more is also spoken aloud automatically; you never have to arrange that.",
].join("\n");

/** The `reply` tool's own description. */
export const REPLY_TOOL_DESCRIPTION = [
  "Send a message to the operator in Telegram — the ONLY channel they read.",
  "Anything you write in the terminal instead of here never reaches them, so every answer,",
  "question and progress note goes through this tool before the turn ends.",
].join(" ");

/** The line in front of every message delivered to the session. */
export const REPLY_RULE_NOTE =
  "[Channel system: the operator reads only what you send with the `reply` tool — " +
  "terminal text never reaches them. Answer with `reply` before this turn ends.]\n";
