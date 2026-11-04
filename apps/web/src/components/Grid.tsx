import type { ReactNode } from "react";

interface SortHeaderProps {
  label: string;
  field: string;
  sort: string;
  direction: string;
  onSort: (field: string) => void;
  align?: "right";
}

export function SortHeader({ label, field, sort, direction, onSort, align }: SortHeaderProps) {
  const active = sort === field;
  return (
    <th
      scope="col"
      className={align === "right" ? "num" : undefined}
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button type="button" className="sort-button" onClick={() => onSort(field)}>
        {label}
        <span aria-hidden="true" className="sort-mark">
          {active ? (direction === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );
}

interface PaginationProps {
  page: number;
  pages: number;
  total: number;
  noun: string;
  onPage: (page: number) => void;
}

export function Pagination({ page, pages, total, noun, onPage }: PaginationProps) {
  // aria-disabled, not disabled: reaching the last page must not drop focus from the Next button just pressed.
  const atStart = page <= 1;
  const atEnd = page >= pages;
  return (
    <nav className="pagination" aria-label="Pagination" data-testid="pagination">
      <span data-testid="pagination-summary">
        {total} {noun}
        {total === 1 ? "" : "s"} · page {Math.min(page, Math.max(pages, 1))} of {Math.max(pages, 1)}
      </span>
      <div className="pagination-buttons">
        <button type="button" className="button button-small" aria-disabled={atStart} onClick={() => atStart || onPage(page - 1)}>
          Previous
        </button>
        <button type="button" className="button button-small" aria-disabled={atEnd} onClick={() => atEnd || onPage(page + 1)}>
          Next
        </button>
      </div>
    </nav>
  );
}

export function TableWrap({ children, testId, label }: { children: ReactNode; testId: string; label: string }) {
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label={`${label} table`}>
      <table data-testid={testId}>{children}</table>
    </div>
  );
}
