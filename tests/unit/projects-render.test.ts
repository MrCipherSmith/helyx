/**
 * What the /projects keyboard says about each project.
 *
 * Telegram stacks every project's buttons together below one shared text
 * block, so a wall of "⏹"/"⚙️"/"🧹" with more than a couple of projects reads
 * as an undifferentiated mess (screenshot-reported, 2026-09-04). Each project
 * now gets a header row — status emoji + name, tapping it answers the same
 * provider/model toast `pminf:` always has — followed by one compact row of
 * icon-only controls. These assert that pairing holds, including for a
 * pending project, which has no settled state to report and therefore gets no
 * rows at all.
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
  test("a configured active project gets a header row plus one icon-only control row, and its config in the text", () => {
    const { text, keyboard } = renderProjectsMessage(
      [project({ id: 3, session_status: "active" })],
      new Map([[3, CONFIGURED]]),
      new Map(),
    );

    expect(rows(keyboard)).toEqual([
      [["🟢 helyx", "pminf:3"]],
      [["⏹", "proj:stop:3"], ["⚙️", "pmchg:3:prov"], ["🧹", "proj:clearctx:3"]],
    ]);
    expect(text).toContain("GLM (Z.ai) / glm-5.2");
  });

  test("a project with no provider reads as Claude on its default model", () => {
    const { text, keyboard } = renderProjectsMessage([project({ id: 4 })], new Map(), new Map());

    expect(rows(keyboard)).toEqual([
      [["⚪ helyx", "pminf:4"]],
      [["▶️", "proj:start:4"], ["⚙️", "pmchg:4:prov"]],
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

  test("every settled project gets an info header button naming it", () => {
    const { keyboard } = renderProjectsMessage([project({ id: 3 })], new Map([[3, CONFIGURED]]), new Map());

    const headers = rows(keyboard).flat().filter(([, data]) => data.startsWith("pminf:"));
    expect(headers).toEqual([["⚪ helyx", "pminf:3"]]);
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

    // Each project gets a header row (name + status) then one control row —
    // a's is ⏹/⚙️/🧹, b's is ▶️/⚙️ — in project order.
    const got = rows(keyboard);
    expect(got.length).toBe(4);
    expect(got[0]).toEqual([["🟢 a", "pminf:1"]]);
    expect(got[1]).toEqual([["⏹", "proj:stop:1"], ["⚙️", "pmchg:1:prov"], ["🧹", "proj:clearctx:1"]]);
    expect(got[2]).toEqual([["⚪ b", "pminf:2"]]);
    expect(got[3]).toEqual([["▶️", "proj:start:2"], ["⚙️", "pmchg:2:prov"]]);
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
