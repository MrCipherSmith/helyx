import { describe, test, expect } from "bun:test";
import {
  containsPath,
  resolveStaticPath,
  parseCookieHeader,
  sanitizeGitRef,
  isSafeRepoPath,
  hostToContainerPath,
} from "../../utils/request-guards.ts";

/**
 * The checks between an HTTP request and the filesystem, a shell, or an
 * identity. None of these were tested before, and one was wrong: the static
 * handlers contained requests with `startsWith`, which admits a sibling
 * directory that happens to share a prefix with the root.
 */

const ROOT = "/app/dashboard/dist";

describe("containsPath", () => {
  test("the root itself is contained", () => {
    expect(containsPath(ROOT, ROOT)).toBe(true);
  });

  test("a child is contained", () => {
    expect(containsPath(ROOT, `${ROOT}/index.html`)).toBe(true);
  });

  test("a nested child is contained", () => {
    expect(containsPath(ROOT, `${ROOT}/assets/app-abc123.js`)).toBe(true);
  });

  test("a sibling sharing a prefix is NOT contained", () => {
    // The bug this function exists to fix. `startsWith` says yes here.
    expect(containsPath(ROOT, "/app/dashboard/dist-evil/secret")).toBe(false);
    expect(`/app/dashboard/dist-evil/secret`.startsWith(ROOT)).toBe(true);
  });

  test("a name that merely extends the last segment is NOT contained", () => {
    expect(containsPath(ROOT, "/app/dashboard/distribution")).toBe(false);
  });

  test("the parent is not contained", () => {
    expect(containsPath(ROOT, "/app/dashboard")).toBe(false);
  });

  test("an unrelated path is not contained", () => {
    expect(containsPath(ROOT, "/etc/passwd")).toBe(false);
  });

  test("a root given with a trailing separator behaves the same", () => {
    expect(containsPath(`${ROOT}/`, `${ROOT}/index.html`)).toBe(true);
    expect(containsPath(`${ROOT}/`, "/app/dashboard/dist-evil/x")).toBe(false);
  });
});

describe("resolveStaticPath", () => {
  test("an ordinary asset resolves inside the root", () => {
    expect(resolveStaticPath(ROOT, "/assets/app.js")).toBe(`${ROOT}/assets/app.js`);
  });

  test("the root path itself resolves", () => {
    expect(resolveStaticPath(ROOT, "/")).toBe(ROOT);
  });

  test("traversal into a prefix-sharing sibling is refused", () => {
    // Demonstrated escape, now a regression test:
    //   "/../dist-evil/secret" -> /app/dashboard/dist-evil/secret
    // which startsWith(ROOT) and used to be served.
    expect(resolveStaticPath(ROOT, "/../dist-evil/secret")).toBeNull();
  });

  test("traversal out of the tree is refused", () => {
    expect(resolveStaticPath(ROOT, "/../../etc/passwd")).toBeNull();
    expect(resolveStaticPath(ROOT, "/../../../../../../etc/shadow")).toBeNull();
  });

  test("traversal that lands back inside is allowed", () => {
    // Nothing wrong with a path that wanders and returns.
    expect(resolveStaticPath(ROOT, "/assets/../index.html")).toBe(`${ROOT}/index.html`);
  });

  test("an encoded-looking segment is not special — it is just a name", () => {
    // Decoding is the caller's job; this function must not double-decode.
    expect(resolveStaticPath(ROOT, "/%2e%2e/dist-evil")).toBe(`${ROOT}/%2e%2e/dist-evil`);
  });
});

describe("parseCookieHeader", () => {
  test("finds the cookie", () => {
    expect(parseCookieHeader("token=abc123", "token")).toBe("abc123");
  });

  test("finds it among others", () => {
    expect(parseCookieHeader("theme=dark; token=abc123; lang=ru", "token")).toBe("abc123");
  });

  test("an absent header yields undefined", () => {
    expect(parseCookieHeader(undefined, "token")).toBeUndefined();
    expect(parseCookieHeader("", "token")).toBeUndefined();
  });

  test("an absent cookie yields undefined", () => {
    expect(parseCookieHeader("theme=dark", "token")).toBeUndefined();
  });

  test("a value containing = survives intact", () => {
    // A JWT is base64 and may carry padding; splitting and taking [1] truncates it.
    expect(parseCookieHeader("token=a.b.c==", "token")).toBe("a.b.c==");
  });

  test("a cookie whose name merely starts with the wanted name is not matched", () => {
    expect(parseCookieHeader("tokenizer=nope", "token")).toBeUndefined();
  });

  test("a cookie whose name ends with the wanted name is not matched", () => {
    expect(parseCookieHeader("xtoken=nope", "token")).toBeUndefined();
  });

  test("surrounding whitespace is tolerated", () => {
    expect(parseCookieHeader("  token=abc123  ", "token")).toBe("abc123");
    expect(parseCookieHeader("a=1;   token=abc123", "token")).toBe("abc123");
  });

  test("an empty value comes back as an empty string, not undefined", () => {
    expect(parseCookieHeader("token=", "token")).toBe("");
  });
});

describe("sanitizeGitRef", () => {
  test("accepts an ordinary ref", () => {
    expect(sanitizeGitRef("HEAD")).toBe("HEAD");
    expect(sanitizeGitRef("main")).toBe("main");
    expect(sanitizeGitRef("origin/main")).toBe("origin/main");
    expect(sanitizeGitRef("v1.54.0")).toBe("v1.54.0");
    expect(sanitizeGitRef("HEAD~3")).toBe("HEAD~3");
    expect(sanitizeGitRef("HEAD^")).toBe("HEAD^");
  });

  test("accepts an underscore", () => {
    // The character the escaped `-` in the class protects: unescaped, the
    // class reads `_` through `/` as a range and the guard changes meaning.
    expect(sanitizeGitRef("feature_branch")).toBe("feature_branch");
  });

  test("accepts a hyphen", () => {
    expect(sanitizeGitRef("flow/003-request-guards")).toBe("flow/003-request-guards");
  });

  test("falls back on shell metacharacters", () => {
    expect(sanitizeGitRef("HEAD; rm -rf /")).toBe("HEAD");
    expect(sanitizeGitRef("$(whoami)")).toBe("HEAD");
    expect(sanitizeGitRef("a`b`")).toBe("HEAD");
    expect(sanitizeGitRef("a b")).toBe("HEAD");
  });

  test("falls back on null and empty input", () => {
    expect(sanitizeGitRef(null)).toBe("HEAD");
    expect(sanitizeGitRef(undefined)).toBe("HEAD");
    expect(sanitizeGitRef("")).toBe("HEAD");
  });

  test("enforces the 200-character limit", () => {
    expect(sanitizeGitRef("a".repeat(200))).toBe("a".repeat(200));
    expect(sanitizeGitRef("a".repeat(201))).toBe("HEAD");
  });

  test("uses the caller's fallback when given one", () => {
    expect(sanitizeGitRef("bad ref", "main")).toBe("main");
  });
});

describe("isSafeRepoPath", () => {
  test("accepts an ordinary path", () => {
    expect(isSafeRepoPath("src/index.ts")).toBe(true);
    expect(isSafeRepoPath("README.md")).toBe(true);
  });

  test("rejects traversal", () => {
    expect(isSafeRepoPath("../etc/passwd")).toBe(false);
    expect(isSafeRepoPath("src/../../secret")).toBe(false);
  });

  test("rejects a dotted filename too — it is a blacklist, not a parser", () => {
    // Documented behaviour, not an endorsement: `a..b` is a legal filename and
    // is refused. Replacing this with real containment needs its own flow.
    expect(isSafeRepoPath("weird..name.txt")).toBe(false);
  });

  test("a single dot segment is allowed", () => {
    expect(isSafeRepoPath("./src/index.ts")).toBe(true);
  });
});

describe("hostToContainerPath", () => {
  const PROJECTS = "/home/dev/projects";
  const HOME = "/home/dev";

  test("rewrites a path under the projects dir", () => {
    expect(hostToContainerPath(`${PROJECTS}/helyx`, { projectsDir: PROJECTS }))
      .toBe("/host-projects/helyx");
  });

  test("rewrites the projects dir itself", () => {
    expect(hostToContainerPath(PROJECTS, { projectsDir: PROJECTS })).toBe("/host-projects");
  });

  test("does NOT rewrite a sibling sharing a prefix", () => {
    // /home/dev/projects-old is a different tree; the old prefix test claimed it.
    expect(hostToContainerPath("/home/dev/projects-old/x", { projectsDir: PROJECTS }))
      .toBe("/home/dev/projects-old/x");
  });

  test("falls back to the legacy host-home mount", () => {
    expect(hostToContainerPath("/home/dev/other/repo", { projectsDir: PROJECTS, hostHome: HOME }))
      .toBe("/host-home/other/repo");
  });

  test("an unset legacy mount leaves the path alone", () => {
    // Unset is not the same as empty: without HOST_HOME the fallback must not apply.
    expect(hostToContainerPath("/home/dev/other/repo", { projectsDir: PROJECTS }))
      .toBe("/home/dev/other/repo");
    expect(hostToContainerPath("/home/dev/other/repo", { projectsDir: PROJECTS, hostHome: "" }))
      .toBe("/home/dev/other/repo");
  });

  test("the projects dir wins over the home fallback", () => {
    expect(hostToContainerPath(`${PROJECTS}/helyx`, { projectsDir: PROJECTS, hostHome: HOME }))
      .toBe("/host-projects/helyx");
  });

  test("an unrelated path is returned unchanged", () => {
    expect(hostToContainerPath("/opt/thing", { projectsDir: PROJECTS, hostHome: HOME }))
      .toBe("/opt/thing");
  });
});
