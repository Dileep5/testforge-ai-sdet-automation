import { TAX_BPS, testNamespace } from "../../framework/factories/test-data";
import { expect, test } from "../../framework/fixtures";
import { parseCsv } from "../../framework/helpers/csv";
import { centsToDecimal, expectedTotals, parseMoney } from "../../framework/helpers/money";

// Guards on the framework itself. If these helpers were wrong, every test using them could be too.
test.describe("framework helpers", { tag: "@regression" }, () => {
  test("database helper cannot write", async ({ db }) => {
    await expect(db.query("UPDATE warehouses SET name = 'changed'")).rejects.toThrow(/read-only transaction/);
  });

  test("money parsing is exact and rejects anything that is not money", () => {
    expect(parseMoney("$1,234.50")).toBe(123450);
    expect(parseMoney("$0.07")).toBe(7);
    expect(parseMoney("$12,345,678.90")).toBe(1234567890);
    for (const bad of ["1.00", "$1.5", "$1,23.00", "$", "NaN"]) {
      expect(() => parseMoney(bad), bad).toThrow(/Not a money value/);
    }
    expect(centsToDecimal(7)).toBe("0.07");
    expect(centsToDecimal(123450)).toBe("1234.50");
  });

  test("expected totals round half-up with integers", () => {
    // 3 x 19.99 + 7 x 3.33 = 83.28; 13% is 10.8264, which rounds to 10.83.
    const lines = [
      { quantity: 3, unitPriceCents: 1999 },
      { quantity: 7, unitPriceCents: 333 },
    ];
    expect(expectedTotals(lines, TAX_BPS.YYZ1)).toEqual({ subtotalCents: 8328, taxCents: 1083, totalCents: 9411 });
    // Exactly half a cent rounds up.
    expect(expectedTotals([{ quantity: 1, unitPriceCents: 50 }], 100).taxCents).toBe(1);
    expect(expectedTotals([{ quantity: 1, unitPriceCents: 49 }], 100).taxCents).toBe(0);
  });

  test("namespaces are stable for one attempt and differ between attempts and tests", () => {
    const base = { testId: "abc", retry: 0, repeatEachIndex: 0 };
    expect(testNamespace(base)).toBe(testNamespace({ ...base }));
    const others = [{ ...base, retry: 1 }, { ...base, repeatEachIndex: 1 }, { ...base, testId: "abd" }];
    expect(new Set([base, ...others].map(testNamespace)).size).toBe(4);
  });

  test("cleanup touches only what the test itself created", async ({ data, setupApi, db }) => {
    const seeded = await db.product("FAS-1001");
    const mine = await data.product();
    const failures = await data.cleanup();
    expect(failures).toEqual([]);
    expect((await db.product(mine.sku))?.is_active).toBe(false);
    expect((await db.product("FAS-1001"))?.is_active).toBe(seeded?.is_active);
    expect((await setupApi.me()).email).toBe("admin@testforge.example");
  });

  test("CSV parser handles quoted commas", () => {
    expect(parseCsv('a,b\n"x, y",2\n')).toEqual([{ a: "x, y", b: "2" }]);
  });
});
