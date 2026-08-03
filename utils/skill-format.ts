/**
 * The skill file format — the parts more than one module has to agree about.
 *
 * A skill's name was validated in three places and its inline-shell token
 * recognised in two, each with its own copy of the pattern. Both belong to the
 * format itself rather than to any one reader: a rename prompt, a distiller
 * that writes skills and a loader that reads them are three views of the same
 * document.
 */

/**
 * What a skill may be called: lowercase, starting with a letter, up to 64
 * characters of letters, digits and hyphens.
 *
 * The shape is a directory name — skills are materialised as
 * `~/.claude/skills/agent-created/<name>/SKILL.md`, so the rule is also a
 * path-safety rule, which is why it forbids rather than escapes.
 */
const SKILL_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name);
}

/**
 * An inline-shell token: ``!`command` ``.
 *
 * Two readers care. The preprocessor expands these at load time; the distiller
 * warns when an LLM-written body contains one, since a generated skill that
 * runs shell is worth a human look before it is saved. If the syntax ever
 * moved, both would have to move together — which is the definition of a
 * shared format rather than a shared habit.
 */
export const INLINE_SHELL_TOKEN = /!`[^`\n]+`/;

/** The same token with capture and `g`, for expansion rather than detection. */
export function inlineShellTokens(): RegExp {
  // A fresh instance per call: a `g` regex carries `lastIndex`, and sharing one
  // between an expansion loop and anything else makes the second caller start
  // wherever the first stopped.
  return /!`([^`\n]+)`/g;
}
