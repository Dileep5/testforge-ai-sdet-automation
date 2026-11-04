import { parse } from "csv-parse/sync";

/** Parse with a real CSV parser, so quoting and embedded commas are handled as a spreadsheet would. */
export function parseCsv(text: string): Record<string, string>[] {
  return parse<Record<string, string>>(text, { columns: true, skip_empty_lines: true });
}

export function csvHeader(text: string): string[] {
  return (text.split("\n")[0] ?? "").split(",");
}
