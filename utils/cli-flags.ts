/**
 * Command-line flag parsing for the `helyx` CLI.
 *
 * Lives outside `cli.ts` because that file ends in a top-level `switch` on
 * `process.argv` and therefore cannot be imported by a test. This is the
 * parsing that decides what an unattended install actually installs
 * (`helyx setup --profile=minimal … < /dev/null`), and a mis-read flag there
 * does not fail — it quietly produces a different installation than the one
 * that was asked for.
 */

export type Flags = Record<string, string>;

/**
 * Parse `--key=value`, `--key value` and bare `--key` from an argument list.
 *
 * A bare flag becomes the string `"true"` rather than a boolean, because every
 * value in the map is a string and the callers test presence, not type.
 *
 * A value is only consumed for `--key value` when the next argument does not
 * itself start with `--`. That is what keeps `--force --profile minimal` from
 * reading `--profile` as the value of `--force`, at the cost of not accepting
 * a value that legitimately begins with two dashes.
 *
 * Anything not starting with `--` and not consumed as a value is ignored:
 * positional arguments are handled by the subcommand, not here.
 */
export function parseFlags(argv: readonly string[]): Flags {
  const out: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true"; // bare boolean flag
      }
    }
  }
  return out;
}

/**
 * A flag's value, or `undefined` when it was not given.
 *
 * An empty string counts as absent. `--token=` is a flag the operator started
 * to fill in and did not, and treating it as a present-but-empty value would
 * write an empty token into `.env` instead of falling back to the default.
 */
export function flagValue(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return v === undefined || v === "" ? undefined : v;
}
