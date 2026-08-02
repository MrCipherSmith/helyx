/**
 * The checks that stand between an HTTP request and the filesystem, a shell,
 * or an identity.
 *
 * These live together rather than beside their call sites because that is how
 * the next person finds all of them. Each is the last thing that runs before
 * untrusted input becomes an action, and until now none was tested — one was
 * also wrong (see `containsPath`).
 */

import { join, resolve, sep } from "node:path";

/**
 * Whether `candidate` is `root` or lies inside it.
 *
 * The check this replaced was `candidate.startsWith(root)`, and a prefix test
 * is not a containment test: with a root of `/app/dashboard/dist`, the path
 * `/app/dashboard/dist-evil/secret` starts with the root and passes. It is a
 * sibling, not a child. The separator is what makes the difference, and both
 * paths must already be resolved for it to mean anything.
 */
export function containsPath(root: string, candidate: string): boolean {
  // Both sides are resolved here rather than assumed to be. Documenting the
  // requirement is not the same as meeting it: a caller reusing this with a
  // raw `/srv/dist/../secret` would otherwise be told it is contained, and a
  // root written with a trailing slash would not contain itself.
  if (!root) return false; // fail closed — resolve("") is the working directory
  const r = resolve(root);
  const c = resolve(candidate);
  if (c === r) return true;
  return c.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * Resolve a request path inside a static root, or `null` if it escapes.
 *
 * Both static handlers spelled this out separately, with slightly different
 * wording for the same intent. Returning `null` rather than throwing keeps the
 * caller's shape: an escape is answered exactly like a file that is not there,
 * which is also the right thing to tell whoever asked.
 */
export function resolveStaticPath(root: string, requestPath: string): string | null {
  if (!root) return null;
  const resolved = resolve(join(root, requestPath));
  return containsPath(root, resolved) ? resolved : null;
}

/**
 * The same check, then again against the path the filesystem actually reaches.
 *
 * `resolveStaticPath` is lexical: it answers what the string means, not where
 * it leads. A symlink planted inside the static root points outside it while
 * spelling a contained path, and `readFile` follows the link. Resolving the
 * link and containing that too closes the gap.
 *
 * `realpath` is a parameter so the escape can be tested without planting a
 * symlink; production passes `fs.promises.realpath`. A path that does not
 * exist has no real path — that is not an escape, so it falls back to the
 * lexical answer and the caller's own existence check handles it.
 */
export async function resolveStaticPathReal(
  root: string,
  requestPath: string,
  realpath: (p: string) => Promise<string>,
): Promise<string | null> {
  const lexical = resolveStaticPath(root, requestPath);
  if (lexical === null) return null;

  let real: string;
  try {
    real = await realpath(lexical);
  } catch {
    return lexical; // does not exist yet — nothing to follow
  }

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    realRoot = root; // the root itself is not a link
  }

  return containsPath(realRoot, real) ? lexical : null;
}

/**
 * A cookie's value from a `Cookie` header, or `undefined`.
 *
 * This is where the session token comes from on every authenticated request.
 * The value is rejoined on `=` because a JWT is base64 and may end in padding
 * — splitting and taking `[1]` would truncate it.
 */
export function parseCookieHeader(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const match = header.split(";").find((c) => c.trim().startsWith(`${name}=`));
  return match?.split("=").slice(1).join("=").trim();
}

/**
 * A git ref that is safe to interpolate into `git show <ref>:<path>`, or the
 * fallback when it is not.
 *
 * The allowlist is copied verbatim from the call site it replaced, including
 * the backslash before `-` inside the character class: without it the class
 * reads `_` through `/` as a range, which changes what the guard accepts and
 * — depending on the engine — is a SyntaxError. The repository's eslint config
 * carries a note about exactly this.
 */
const GIT_REF_RE = /^[a-zA-Z0-9._\-\/~^:]{1,200}$/;

export function sanitizeGitRef(raw: string | null | undefined, fallback = "HEAD"): string {
  return raw && GIT_REF_RE.test(raw) ? raw : fallback;
}

/**
 * Whether a repository-relative path may be passed to `git show`.
 *
 * This is a blacklist — it rejects any path containing `..` — and is kept as
 * it was rather than replaced, because what `git show <ref>:<path>` actually
 * accepts is a question with its own answer and its own tests. Named and
 * documented here so the next person can see it is a stand-in rather than a
 * containment check.
 */
export function isSafeRepoPath(path: string): boolean {
  return !path.includes("..");
}

/**
 * Rewrite a host path to where the container can see it.
 *
 * Prefix matching with the same separator rule as `containsPath`: a host
 * projects directory of `/home/dev/projects` must not claim
 * `/home/dev/projects-old`, which is a different tree.
 *
 * `hostHome` is the legacy mount kept during the transition, and it is
 * optional in a way that matters: unset means the fallback does not apply at
 * all, which is not the same as an empty string.
 */
export function hostToContainerPath(
  hostPath: string,
  dirs: { projectsDir?: string; hostHome?: string },
): string {
  // Trailing separators are stripped before comparing: a configured directory
  // written as `/home/dev/projects/` must still claim its children, and the
  // remainder below counts on the two spellings being the same length. A
  // directory of just `/` survives as itself rather than trimming to nothing.
  const trim = (d?: string): string | undefined => {
    if (!d) return undefined;
    const t = d.replace(/\/+$/, "");
    return t === "" ? "/" : t;
  };

  /** The part of `hostPath` below `dir`, or null when it is not below it. */
  const remainder = (dir: string): string | null => {
    if (dir === "/") return hostPath.startsWith("/") ? hostPath : null;
    if (hostPath === dir) return "";
    return hostPath.startsWith(dir + sep) ? hostPath.slice(dir.length) : null;
  };

  const projectsDir = trim(dirs.projectsDir);
  if (projectsDir) {
    const rest = remainder(projectsDir);
    if (rest !== null) return "/host-projects" + rest;
  }

  const hostHome = trim(dirs.hostHome);
  if (hostHome) {
    const rest = remainder(hostHome);
    if (rest !== null) return "/host-home" + rest;
  }

  return hostPath; // same path — a manual or non-Docker run
}
