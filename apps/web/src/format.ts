/** Display helpers. Amounts stay integer cents everywhere; they only become text here. */

const groupDigits = (value: number) => value.toLocaleString("en-CA");

export function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100);
  const remainder = String(absolute % 100).padStart(2, "0");
  return `${sign}$${groupDigits(dollars)}.${remainder}`;
}

/** Same half-up integer formula as the API, so the preview always matches the saved total. */
export function taxCents(subtotalCents: number, taxRateBps: number): number {
  return Math.floor((subtotalCents * taxRateBps + 5000) / 10000);
}

/** Parse "12.50" into 1250 from its digits, without going through a float. */
export function parseCents(text: string): number | null {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

export function percent(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

// Dates are shown in UTC because order date filters are whole UTC days.
const dateFormat = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" });
const dateTimeFormat = new Intl.DateTimeFormat("en-CA", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export const shortDate = (iso: string) => dateFormat.format(new Date(iso));
export const dateTime = (iso: string) => `${dateTimeFormat.format(new Date(iso))} UTC`;

export function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase().replace(/_/g, " ");
}
