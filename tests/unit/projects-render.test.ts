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
import { renderProjectsMessage, type ProjectListItem } from "../../bot/commands/projects.ts";
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
  test("a configured project gets an action row and an info row beneath it", () => {
    const { keyboard } = renderProjectsMessage(
      [project({ id: 3, session_status: "active" })],
      new Map([[3, CONFIGURED]]),
      new Map(),
    );

    expect(rows(keyboard)).toEqual([
      [["⏹ Stop helyx", "proj:stop:3"], ["⚙️", "pmchg:3:prov"]],
      [["GLM (Z.ai)", "pminf:3"], ["glm-5.2", "pminf:3"]],
    ]);
  });

  test("a project with no provider row reads as Claude on its default model", () => {
    const { keyboard } = renderProjectsMessage([project({ id: 4 })], new Map(), new Map());

    expect(rows(keyboard)).toEqual([
      [["▶️ Start helyx", "proj:start:4"], ["⚙️", "pmchg:4:prov"]],
      [["Claude", "pminf:4"], ["default", "pminf:4"]],
    ]);
  });

  test("a provider without a model still names the provider", () => {
    const selection: ProviderSelection = { providerId: 7, providerName: "Ollama", model: null };
    const { keyboard } = renderProjectsMessage([project({ id: 5 })], new Map([[5, selection]]), new Map());

    expect(rows(keyboard)[1]).toEqual([["Ollama", "pminf:5"], ["default", "pminf:5"]]);
  });

  test("the info buttons carry a callback that cannot change anything", () => {
    const { keyboard } = renderProjectsMessage([project({ id: 3 })], new Map([[3, CONFIGURED]]), new Map());

    for (const [, data] of rows(keyboard)[1]!) {
      expect(data).toBe("pminf:3");
      // Not the picker prefix — tapping the label must not open provider/model selection.
      expect(data.startsWith("pmchg:")).toBe(false);
      expect(data.startsWith("pmsel:")).toBe(false);
    }
  });

  test("a pending project gets no rows — its settled state is not known yet", () => {
    const { text, keyboard } = renderProjectsMessage(
      [project({ id: 3 })],
      new Map([[3, CONFIGURED]]),
      new Map([[3, "start"]]),
    );

    expect(rows(keyboard)).toEqual([]);
    expect(text).toContain("⏳▶️ helyx");
  });

  test("the text lines no longer repeat the provider or the model", () => {
    const { text } = renderProjectsMessage(
      [project({ id: 3, session_status: "active" })],
      new Map([[3, CONFIGURED]]),
      new Map(),
    );

    expect(text).toContain("🟢 helyx  (/home/altsay/bots/helyx)");
    expect(text).not.toContain("·");
    expect(text).not.toContain("GLM (Z.ai)");
    expect(text).not.toContain("glm-5.2");
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

    const got = rows(keyboard);
    expect(got.length).toBe(4);
    expect(got[1]).toEqual([["GLM (Z.ai)", "pminf:1"], ["glm-5.2", "pminf:1"]]);
    expect(got[3]).toEqual([["Claude", "pminf:2"], ["default", "pminf:2"]]);
  });
});
