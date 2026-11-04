import { expect, type Locator, type Page, type Response } from "@playwright/test";
import { whileWaitingFor, type ApiMatch } from "../helpers/network";

const SORT_MARKS = /[▲▼↕]/g;

/** A data grid with sortable headers and pagination, identified by its test id. */
export class GridComponent {
  readonly table: Locator;
  readonly rows: Locator;
  readonly summary: Locator;

  constructor(
    private readonly page: Page,
    testId: string,
    rowTestId: string,
    private readonly listPath: string,
  ) {
    this.table = page.getByTestId(testId);
    this.rows = this.table.getByTestId(rowTestId);
    this.summary = page.getByTestId("pagination-summary");
  }

  private async columnIndex(header: string): Promise<number> {
    await expect(this.table).toBeVisible();
    const headers = await this.table.locator("thead th").allTextContents();
    const index = headers.findIndex((text) => text.replace(SORT_MARKS, "").trim() === header);
    if (index < 0) throw new Error(`No column "${header}" in: ${headers.join(", ")}`);
    return index;
  }

  /** Cells of one column, for web-first assertions such as toHaveText([...]). */
  async column(header: string): Promise<Locator> {
    return this.rows.locator(`td:nth-child(${(await this.columnIndex(header)) + 1})`);
  }

  row(text: string): Locator {
    return this.rows.filter({ hasText: text });
  }

  private list(params: Record<string, string>): ApiMatch {
    return { method: "GET", path: this.listPath, params };
  }

  async sortBy(header: string, field: string, direction: "asc" | "desc"): Promise<Response> {
    const response = await whileWaitingFor(this.page, this.list({ sort: field, direction }), () =>
      this.table.getByRole("button", { name: header, exact: false }).click(),
    );
    await expect(this.table.locator(`th[aria-sort="${direction === "asc" ? "ascending" : "descending"}"]`)).toContainText(header);
    return response;
  }

  async nextPage(expectedPage: number): Promise<void> {
    await whileWaitingFor(this.page, this.list({ page: String(expectedPage) }), () =>
      this.page.getByRole("button", { name: "Next", exact: true }).click(),
    );
  }

  async previousPage(expectedPage: number): Promise<void> {
    await whileWaitingFor(this.page, this.list({ page: String(expectedPage) }), () =>
      this.page.getByRole("button", { name: "Previous", exact: true }).click(),
    );
  }
}
