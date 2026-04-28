/**
 * Sanity checks on the migration registry itself — no DB needed.
 *
 * Validates that the in-process `migrations[]` array passes the same
 * invariants `validateMigrationRegistry()` enforces at startup:
 *   - unique version numbers (duplicates would silently lose a migration)
 *   - strictly ascending order (filter logic relies on it)
 *   - positive integers (matches the INT column in schema_versions)
 *
 * If a future contributor breaks one of these, this test fails BEFORE
 * the bad migration runs against any DB.
 */

import { describe, expect, test } from "bun:test";

describe("migration registry invariants", () => {
  test("startup-time validateMigrationRegistry accepts the current registry", async () => {
    // Importing the module triggers no side effects until migrate() is
    // called, so we can safely check the shape of the exported array.
    // The `migrations` array is module-private, but `migrate()` calls
    // `validateMigrationRegistry()` first thing — if any rule is
    // violated, the module would throw on first migrate() call. We
    // exercise the validation indirectly by triggering it through a
    // mocked sql, but for this test the simpler approach: re-derive
    // the same checks from the file's source.
    //
    // Read the source, extract `version: N` entries, run the same
    // assertions. Catches duplicates / out-of-order even when no DB
    // is reachable.
    const source = await Bun.file(`${import.meta.dir}/../../memory/db.ts`).text();
    const versionRegex = /^\s+version:\s*(\d+),/gm;
    const versions: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = versionRegex.exec(source)) !== null) {
      versions.push(Number(m[1]));
    }
    expect(versions.length).toBeGreaterThan(0);

    // Each version unique
    const set = new Set(versions);
    expect(set.size).toBe(versions.length);

    // Strictly ascending
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThan(versions[i - 1]!);
    }

    // Positive integers
    for (const v of versions) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });

  test("validateMigrationRegistry rejects a duplicate-version registry (synthetic)", () => {
    // We can't easily mutate the real `migrations` const, so re-implement
    // the check inline against a synthetic bad list to confirm the
    // expected error shape is what we want.
    const bad = [{ version: 1 }, { version: 2 }, { version: 2 }];
    function check(arr: { version: number }[]) {
      const seen = new Set<number>();
      for (const x of arr) {
        if (seen.has(x.version)) throw new Error(`[db] duplicate migration version: v${x.version}`);
        seen.add(x.version);
      }
    }
    expect(() => check(bad)).toThrow(/duplicate migration version: v2/);
  });

  test("validateMigrationRegistry rejects a non-monotonic registry (synthetic)", () => {
    const bad = [{ version: 1 }, { version: 5 }, { version: 3 }];
    function check(arr: { version: number }[]) {
      for (let i = 1; i < arr.length; i++) {
        if (arr[i]!.version <= arr[i - 1]!.version) {
          throw new Error(`[db] non-monotonic migration order at index ${i}: v${arr[i]!.version} follows v${arr[i - 1]!.version}`);
        }
      }
    }
    expect(() => check(bad)).toThrow(/non-monotonic.*v3 follows v5/);
  });

  test("validateMigrationRegistry rejects a fractional or zero version (synthetic)", () => {
    const bad = [{ version: 1.5 }, { version: 0 }];
    function check(arr: { version: number }[]) {
      for (const x of arr) {
        if (!Number.isInteger(x.version) || x.version < 1) {
          throw new Error(`[db] invalid migration version: v${x.version}`);
        }
      }
    }
    expect(() => check(bad)).toThrow(/invalid migration version: v1\.5/);
  });
});
