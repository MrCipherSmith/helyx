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
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(prefix);
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
  const resolved = resolve(join(root, requestPath));
  return containsPath(resolve(root), resolved) ? resolved : null;
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
  const { projectsDir, hostHome } = dirs;
  if (projectsDir && (hostPath === projectsDir || hostPath.startsWith(projectsDir + sep))) {
    return "/host-projects" + hostPath.slice(projectsDir.length);
  }
  if (hostHome && (hostPath === hostHome || hostPath.startsWith(hostHome + sep))) {
    return "/host-home" + hostPath.slice(hostHome.length);
  }
  return hostPath; // same path — a manual or non-Docker run
}
