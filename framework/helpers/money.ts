/**
 * The framework's own money arithmetic, written independently of the application so that a bug in
 * the app's calculation cannot also hide in the expected value. Integer cents only.
 */
export interface LineExpectation {
  quantity: number;
  unitPriceCents: number;
}

export interface Totals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

export function expectedTotals(lines: LineExpectation[], taxRateBps: number): Totals {
  const subtotalCents = lines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0);
  // BigInt keeps this exact and makes it impossible for a float to slip in. Half-up rounding.
  const taxCents = Number((BigInt(subtotalCents) * BigInt(taxRateBps) + 5000n) / 10000n);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

/** "$1,234.50" to 123450, from the digits alone and with no float involved. */
export function parseMoney(text: string): number {
  const match = /^\$((?:\d{1,3})(?:,\d{3})*)\.(\d{2})$/.exec(text.trim());
  if (!match?.[1] || !match[2]) throw new Error(`Not a money value: "${text}"`);
  return Number(match[1].replaceAll(",", "")) * 100 + Number(match[2]);
}

/** 123450 to "1234.50": the plain decimal format used by the CSV export. */
export function centsToDecimal(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
