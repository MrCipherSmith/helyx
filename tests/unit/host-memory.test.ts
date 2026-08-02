import { describe, test, expect } from "bun:test";
import {
  parseCgroupV2Max,
  parseCgroupV1Limit,
  parseMemTotal,
  presetsThatFit,
} from "../../utils/host-memory.ts";

/**
 * How much memory the setup wizard thinks this host has, and which local model
 * presets it therefore offers. Getting it wrong is invisible at setup time:
 * the wizard reports success and the model fails at first use.
 */

const GB = 1024;

describe("parseCgroupV2Max", () => {
  test("reads a byte limit as MB", () => {
    expect(parseCgroupV2Max("2147483648\n")).toBe(2 * GB);
  });

  test("the literal max means no answer, not unlimited", () => {
    // "No limit set here" — the caller must fall through to the next source
    // rather than conclude the host has infinite memory.
    expect(parseCgroupV2Max("max")).toBeNull();
    expect(parseCgroupV2Max("  max \n")).toBeNull();
  });

  test("empty or unparseable content yields null", () => {
    expect(parseCgroupV2Max("")).toBeNull();
    expect(parseCgroupV2Max("\n")).toBeNull();
    expect(parseCgroupV2Max("garbage")).toBeNull();
  });

  test("zero and negative values yield null", () => {
    expect(parseCgroupV2Max("0")).toBeNull();
    expect(parseCgroupV2Max("-1")).toBeNull();
  });

  test("rounds down rather than up", () => {
    // A limit half a megabyte over must not be reported as the next MB.
    expect(parseCgroupV2Max(String(1048576 + 524288))).toBe(1);
  });
});

describe("parseCgroupV1Limit", () => {
  test("reads a byte limit as MB", () => {
    expect(parseCgroupV1Limit("4294967296")).toBe(4 * GB);
  });

  test("rejects the unlimited sentinel", () => {
    // cgroup v1 does not say "unlimited" — it reports a number near 2^63.
    // Read literally that is petabytes, and every preset would look like it fits.
    expect(parseCgroupV1Limit("9223372036854771712")).toBeNull();
    expect(parseCgroupV1Limit("1000000000000000")).toBeNull(); // exactly 1e15
  });

  test("a large but plausible limit is accepted", () => {
    expect(parseCgroupV1Limit(String(1e15 - 1048576))).not.toBeNull();
  });

  test("zero, negative and unparseable yield null", () => {
    expect(parseCgroupV1Limit("0")).toBeNull();
    expect(parseCgroupV1Limit("-1")).toBeNull();
    expect(parseCgroupV1Limit("")).toBeNull();
  });
});

describe("parseMemTotal", () => {
  const meminfo = [
    "MemTotal:       16316360 kB",
    "MemFree:         1234567 kB",
    "MemAvailable:    9876543 kB",
  ].join("\n");

  test("reads MemTotal, which is in kB", () => {
    expect(parseMemTotal(meminfo)).toBe(Math.floor(16316360 / 1024));
  });

  test("matches MemTotal specifically, not MemAvailable", () => {
    const reordered = ["MemAvailable:    9876543 kB", "MemTotal:       16316360 kB"].join("\n");
    expect(parseMemTotal(reordered)).toBe(Math.floor(16316360 / 1024));
  });

  test("a file without MemTotal yields null", () => {
    expect(parseMemTotal("MemFree: 100 kB")).toBeNull();
    expect(parseMemTotal("")).toBeNull();
  });

  test("the line must be anchored — a similar key does not match", () => {
    expect(parseMemTotal("SwapMemTotal:   999 kB")).toBeNull();
  });
});

describe("presetsThatFit", () => {
  const presets = [
    { id: "tiny", ramMb: 2500 },
    { id: "small", ramMb: 4500 },
    { id: "heavy", ramMb: 12000 },
  ];

  test("unknown memory offers everything", () => {
    // Hiding options because detection failed would be worse than showing one
    // that turns out not to fit; the wizard warns in that case.
    expect(presetsThatFit(presets, null).map((p) => p.id)).toEqual(["tiny", "small", "heavy"]);
  });

  test("offers only what fits", () => {
    expect(presetsThatFit(presets, 5000).map((p) => p.id)).toEqual(["tiny", "small"]);
  });

  test("a preset needing exactly the available memory fits", () => {
    expect(presetsThatFit(presets, 4500).map((p) => p.id)).toEqual(["tiny", "small"]);
  });

  test("one megabyte short excludes it", () => {
    expect(presetsThatFit(presets, 4499).map((p) => p.id)).toEqual(["tiny"]);
  });

  test("a host too small for anything gets an empty list", () => {
    expect(presetsThatFit(presets, 512)).toEqual([]);
  });

  test("order is preserved", () => {
    expect(presetsThatFit(presets, 99999).map((p) => p.id)).toEqual(["tiny", "small", "heavy"]);
  });

  test("the unknown-memory result is a copy, not the caller's array", () => {
    const result = presetsThatFit(presets, null);
    result.pop();
    expect(presets).toHaveLength(3);
  });
});
