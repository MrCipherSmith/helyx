/**
 * Reading how much memory this host can actually give a model, and deciding
 * which local presets fit in it.
 *
 * The parsing is here rather than in `cli.ts` because the wizard's answer is
 * invisible until it is wrong: offering a preset the host cannot serve is a
 * failure that surfaces at first use, long after setup reported success.
 *
 * The three sources are tried in order of how specific they are — a container
 * limit beats what the kernel says the machine has.
 */

/** Bytes per MB used throughout. Matches what the wizard prints. */
const MB = 1048576;

/**
 * cgroup v2 `memory.max`.
 *
 * The literal `max` means no limit, which is not the same as "no information":
 * it means fall through to the next source rather than report unlimited.
 */
export function parseCgroupV2Max(raw: string): number | null {
  const v = raw.trim();
  if (!v || v === "max") return null;
  const n = parseInt(v, 10);
  return n > 0 ? Math.floor(n / MB) : null;
}

/**
 * cgroup v1 `memory.limit_in_bytes`.
 *
 * When unlimited, cgroup v1 does not say so — it reports a sentinel near
 * 2^63, which would otherwise be read as several petabytes of available
 * memory and make every preset look like it fits.
 */
export function parseCgroupV1Limit(raw: string): number | null {
  const n = parseInt(raw.trim(), 10);
  return n > 0 && n < 1e15 ? Math.floor(n / MB) : null;
}

/** `MemTotal` from `/proc/meminfo`, which is reported in kB. */
export function parseMemTotal(raw: string): number | null {
  const m = raw.match(/^MemTotal:\s+(\d+) kB/m);
  return m?.[1] ? Math.floor(parseInt(m[1], 10) / 1024) : null;
}

/**
 * The presets a host with `memMb` of memory can serve.
 *
 * Unknown memory returns everything: hiding options because detection failed
 * would be worse than showing one that turns out not to fit, and the wizard
 * warns in that case rather than guessing.
 */
export function presetsThatFit<T extends { ramMb: number }>(
  presets: readonly T[],
  memMb: number | null,
): T[] {
  return memMb === null ? [...presets] : presets.filter((p) => p.ramMb <= memMb);
}
