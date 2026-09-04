/**
 * What the /projects keyboard says about each project.
 *
 * The provider and the model used to live in the text line, as a `· Name/model`
 * tail hanging off the path — readable, but not next to the controls it
 * describes, and printed only when the project was on something other than
 * stock Claude. So the one project the operator most needed to identify at a
 * glance, the misconfigured one, looked identical to a default one.
 *
 * They are buttons now: a second row under each action row, provider on the
 * left beneath Stop/Start and model on the right beneath the gear. These
 * assert the pairing holds — including for a pending project, which has no
 * settled state to report and therefore gets no rows at all.
 */

import { describe, test, expect } from "bun:test";
import { renderProjectsMessage, configLabels, type ProjectListItem } from "../../bot/commands/projects.ts";
import type { ProviderSelection } from "../../services/project-service.ts";

function project(over: Partial<ProjectListItem> = {}): ProjectListItem {
  return { id: 1, name: "helyx", path: "/home/altsay/bots/helyx", session_status: null, ...over };
}

/**
 * The rows as [label, callback_data] pairs.
 *
 * grammy's builder opens a fresh row on `.row()`, so a keyboard that ends with
 * one carries a trailing empty array — as every keyboard in this command
 * already did before the info rows existed. It is not a row the operator sees;
 * dropping it here keeps the assertions about what is rendered.
 */
function rows(keyboard: { inline_keyboard: readonly (readonly { text: string; callback_data?: string }[])[] }) {
  return keyboard.inline_keyboard
    .filter((row) => row.length > 0)
    .map((row) => row.map((b) => [b.text, b.callback_data ?? ""]));
}

const CONFIGURED: ProviderSelection = { providerId: 7, providerName: "GLM (Z.ai)", model: "glm-5.2" };

describe("renderProjectsMessage", () => {
  test("a configured project gets two rows of controls (a 🧹 Clear row while active), and its config in the text", () => {
    // The info row was tried and taken out again: two buttons share a row's
    // width, and `glm-5.2` survives that but `deepseek-v4-pro` does not. The
    // text line has the full width, and provider and model are read rather
    // than pressed. 🧹 Clear context gets its own row for the same reason —
    // its label is long enough to risk truncating Stop/Start's if the two
    // shared a row.
    const { text, keyboard } = renderProjectsMessage(
      [project({ id: 3, session_status: "active" })],
      new Map([[3, CONFIGURED]]),
      new Map(),
    );

    expect(rows(keyboard)).toEqual([
      [["⏹ Stop helyx", "proj:stop:3"], ["⚙️", "pmchg:3:prov"]],
      [["🧹 Clear context", "proj:clearctx:3"]],
    ]);
    expect(text).toContain("GLM (Z.ai) / glm-5.2");
  });

  test("a project with no provider row reads as Claude on its default model", () => {
    const { text, keyboard } = renderProjectsMessage([project({ id: 4 })], new Map(), new Map());

    expect(rows(keyboard)).toEqual([
      [["▶️ Start helyx", "proj:start:4"], ["⚙️", "pmchg:4:prov"]],
    ]);
    // Spelled out, not left blank: "what is this running on" is the question
    // the line exists to answer, and an empty answer is how it fails.
    expect(text).toContain("Claude / default");
  });

  test("a provider without a model still names the provider", () => {
    const selection: ProviderSelection = { providerId: 7, providerName: "Ollama", model: null };
    const { text } = renderProjectsMessage([project({ id: 5 })], new Map([[5, selection]]), new Map());

    expect(text).toContain("Ollama / default");
  });

  test("nothing renders an info button any more", () => {
    // The `pminf:` handler stays — a /projects message already in the chat
    // still carries those buttons and outlives this deploy, and a callback
    // nobody handles leaves Telegram spinning on it. But nothing emits one.
    const { keyboard } = renderProjectsMessage([project({ id: 3 })], new Map([[3, CONFIGURED]]), new Map());

    for (const row of rows(keyboard)) {
      for (const [, data] of row) expect(data.startsWith("pminf:")).toBe(false);
    }
  });

  test("a pending project gets no rows — its settled state is not known yet", () => {
    const { text, keyboard } = renderProjectsMessage(
      [project({ id: 3 })],
      new Map([[3, CONFIGURED]]),
      new Map([[3, "start"]]),
    );

    // Refresh is there because something is pending — but no controls for the
    // project itself, and no line claiming a config it may be about to change.
    expect(rows(keyboard)).toEqual([[["🔄 Refresh", "proj:refresh"]]]);
    expect(text).toContain("⏳▶️ helyx");
  });

  test("the text line carries the provider and the model", () => {
    const { text } = renderProjectsMessage(
      [project({ id: 3, session_status: "active" })],
      new Map([[3, CONFIGURED]]),
      new Map(),
    );

    // The whole line, not its pieces: the separator and the order are what make
    // it readable at a glance, and asserting the parts would pass on a line
    // that had them in any arrangement.
    expect(text).toContain("🟢 helyx  (/home/altsay/bots/helyx)  ·  GLM (Z.ai) / glm-5.2");
  });

  test("the fresh view offers Start All only when more than one project is stopped", () => {
    const two = [project({ id: 1, name: "a" }), project({ id: 2, name: "b" })];
    const one = [project({ id: 1, name: "a" }), project({ id: 2, name: "b", session_status: "active" })];

    const withAll = rows(renderProjectsMessage(two, new Map(), new Map(), "fresh").keyboard);
    const withoutAll = rows(renderProjectsMessage(one, new Map(), new Map(), "fresh").keyboard);

    expect(withAll.at(-1)).toEqual([["▶️ Start All", "proj:start_all"]]);
    expect(withoutAll.flat().map(([label]) => label)).not.toContain("▶️ Start All");
  });

  test("the fresh view offers Refresh only while something is pending", () => {
    const projects = [project({ id: 1 }), project({ id: 2, name: "b" })];

    const idle = rows(renderProjectsMessage(projects, new Map(), new Map(), "fresh").keyboard);
    const busy = rows(
      renderProjectsMessage(projects, new Map(), new Map([[2, "start"]]), "fresh").keyboard,
    );

    expect(idle.flat().map(([label]) => label)).not.toContain("🔄 Refresh");
    expect(busy.at(-1)).toEqual([["🔄 Refresh", "proj:refresh"]]);
  });

  test("the in-place re-render always offers Refresh and never Start All", () => {
    const two = [project({ id: 1, name: "a" }), project({ id: 2, name: "b" })];
    const got = rows(renderProjectsMessage(two, new Map(), new Map(), "rerender").keyboard);

    expect(got.at(-1)).toEqual([["🔄 Refresh", "proj:refresh"]]);
    expect(got.flat().map(([label]) => label)).not.toContain("▶️ Start All");
  });

  test("every project pending leaves Refresh as the only row", () => {
    const got = rows(
      renderProjectsMessage([project({ id: 1 })], new Map(), new Map([[1, "stop"]]), "rerender")
        .keyboard,
    );

    expect(got).toEqual([[["🔄 Refresh", "proj:refresh"]]]);
  });

  test("several projects keep their rows paired, in order", () => {
    const { keyboard } = renderProjectsMessage(
      [
        project({ id: 1, name: "a", session_status: "active" }),
        project({ id: 2, name: "b" }),
      ],
      new Map([[1, CONFIGURED]]),
      new Map(),
    );

    // One row per project, in order, plus a's extra 🧹 row since it's active —
    // b stays a single row since it's not.
    const got = rows(keyboard);
    expect(got.length).toBe(3);
    expect(got[0]).toEqual([["⏹ Stop a", "proj:stop:1"], ["⚙️", "pmchg:1:prov"]]);
    expect(got[1]).toEqual([["🧹 Clear context", "proj:clearctx:1"]]);
    expect(got[2]).toEqual([["▶️ Start b", "proj:start:2"], ["⚙️", "pmchg:2:prov"]]);
  });
});

describe("configLabels", () => {
  test("a missing selection reads as stock Claude", () => {
    expect(configLabels(undefined)).toEqual({ provider: "Claude", model: "default" });
  });

  test("blank columns fall back rather than render an empty button", () => {
    // Telegram rejects the whole message over one empty label, not just the button.
    expect(configLabels({ providerId: 7, providerName: "   ", model: "" }))
      .toEqual({ provider: "Claude", model: "default" });
  });

  test("real values pass through untrimmed of meaning", () => {
    expect(configLabels({ providerId: 7, providerName: "GLM (Z.ai)", model: "glm-5.2" }))
      .toEqual({ provider: "GLM (Z.ai)", model: "glm-5.2" });
  });
});
