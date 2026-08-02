import { describe, test, expect } from "bun:test";
import {
  windowName,
  parseWindowNames,
  partitionByWindow,
} from "../../sessions/tmux-windows.ts";

/**
 * `helyx up` decides which windows still need starting. The version this
 * replaced asked `tmux has-session -t sess:name`, which resolves the window by
 * prefix — "goodai" matched the existing "goodai-base" window, so that project
 * was reported as already running and never started. These tests pin the exact
 * match, since the failure was silent: the wrong answer looked like success.
 */

const project = (name: string) => ({ name, path: `/home/dev/${name}` });

describe("parseWindowNames", () => {
  test("reads one window per line", () => {
    expect(parseWindowNames("helyx\nkeryx\ngoodai-base")).toEqual(
      new Set(["helyx", "keryx", "goodai-base"]),
    );
  });

  test("a trailing newline does not become an empty window name", () => {
    const names = parseWindowNames("helyx\nkeryx\n");
    expect(names.has("")).toBe(false);
    expect(names.size).toBe(2);
  });

  test("no windows at all is an empty set, not a set holding one blank", () => {
    expect(parseWindowNames("")).toEqual(new Set());
    expect(parseWindowNames("\n\n  \n")).toEqual(new Set());
  });

  test("surrounding whitespace is stripped", () => {
    expect(parseWindowNames("  helyx  \n\tkeryx\t")).toEqual(new Set(["helyx", "keryx"]));
  });
});

describe("partitionByWindow", () => {
  test("a name that is a prefix of an existing window still counts as missing", () => {
    // The regression: "goodai-base" is running, "goodai" is not.
    const { running, toStart } = partitionByWindow(
      [project("goodai")],
      new Set(["goodai-base"]),
    );
    expect(running).toEqual([]);
    expect(toStart.map(windowName)).toEqual(["goodai"]);
  });

  test("a name that an existing window is a prefix of also counts as missing", () => {
    const { toStart } = partitionByWindow(
      [project("goodai-base")],
      new Set(["goodai"]),
    );
    expect(toStart.map(windowName)).toEqual(["goodai-base"]);
  });

  test("an exact match counts as running", () => {
    const { running, toStart } = partitionByWindow(
      [project("goodai")],
      new Set(["goodai", "goodai-base"]),
    );
    expect(running.map(windowName)).toEqual(["goodai"]);
    expect(toStart).toEqual([]);
  });

  test("both halves keep the order the projects were given in", () => {
    const projects = ["a", "b", "c", "d"].map(project);
    const { running, toStart } = partitionByWindow(projects, new Set(["b", "d"]));
    expect(running.map(windowName)).toEqual(["b", "d"]);
    expect(toStart.map(windowName)).toEqual(["a", "c"]);
  });

  test("nothing running means everything is to start", () => {
    const projects = ["a", "b"].map(project);
    const { running, toStart } = partitionByWindow(projects, new Set());
    expect(running).toEqual([]);
    expect(toStart).toHaveLength(2);
  });

  test("no projects yields two empty halves", () => {
    expect(partitionByWindow([], new Set(["helyx"]))).toEqual({ running: [], toStart: [] });
  });

  test("windows with no project are ignored rather than reported", () => {
    // A window opened by hand, or one left behind by a removed project.
    const { running, toStart } = partitionByWindow([project("helyx")], new Set(["helyx", "scratch"]));
    expect(running.map(windowName)).toEqual(["helyx"]);
    expect(toStart).toEqual([]);
  });

  test("matching is case-sensitive, as tmux window names are", () => {
    const { toStart } = partitionByWindow([project("Helyx")], new Set(["helyx"]));
    expect(toStart.map(windowName)).toEqual(["Helyx"]);
  });

  test("the returned projects are the caller's objects, paths intact", () => {
    const p = project("helyx");
    const { toStart } = partitionByWindow([p], new Set());
    expect(toStart[0]).toBe(p);
    expect(toStart[0]!.path).toBe("/home/dev/helyx");
  });
});
