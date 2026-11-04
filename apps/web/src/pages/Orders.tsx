import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ApiError,
  ORDER_STATUSES,
  downloadFile,
  query,
  request,
  type Customer,
  type OrderSummary,
  type Page,
  type Warehouse,
} from "../api";
import { useAuth } from "../auth";
import { Field } from "../components/Field";
import { Pagination, SortHeader, TableWrap } from "../components/Grid";
import { EmptyState, ErrorState, Loading, StatusBadge } from "../components/States";
import { useToast } from "../components/Toast";
import { money, shortDate, titleCase } from "../format";
import { useAsync } from "../useAsync";

const FILTER_KEYS = ["q", "date_from", "date_to", "warehouse_id", "customer_id", "status"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type Filters = Record<FilterKey, string>;

const PAGE_SIZE = 15;

const keyOf = (filters: Filters) => FILTER_KEYS.map((key) => filters[key]).join("|");

export function OrdersPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const applied = Object.fromEntries(FILTER_KEYS.map((key) => [key, params.get(key) ?? ""])) as Filters;
  const [draft, setDraft] = useState<Filters>(applied);
  const [exporting, setExporting] = useState(false);

  const sort = params.get("sort") ?? "created_at";
  const direction = params.get("direction") ?? "desc";
  const page = Number(params.get("page") ?? 1);

  // Keep the form in step when filters change from outside it, e.g. the browser's back button.
  // URL updates commit as low-priority transitions, so one the form made itself can land after
  // the user has started typing again. Those are skipped, or they would wipe the new input.
  const filterKey = keyOf(applied);
  const lastSubmitted = useRef(filterKey);
  useEffect(() => {
    if (filterKey !== lastSubmitted.current) {
      lastSubmitted.current = filterKey;
      setDraft(applied);
    }
  }, [filterKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const qs = query({ ...applied, sort, direction, page, page_size: PAGE_SIZE });
  const orders = useAsync((signal) => request<Page<OrderSummary>>(`/orders${qs}`, { signal }), qs);
  const refs = useAsync(
    async (signal) => ({
      warehouses: await request<Warehouse[]>("/warehouses", { signal }),
      customers: await request<Customer[]>("/customers", { signal }),
    }),
    "refs",
  );

  function update(changes: Record<string, string | number | null>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, String(value));
    }
    setParams(next);
  }

  function applyFilters(event: FormEvent) {
    event.preventDefault();
    lastSubmitted.current = keyOf(draft);
    update({ ...draft, page: null });
  }

  function clearFilters() {
    const blank = Object.fromEntries(FILTER_KEYS.map((key) => [key, ""])) as Filters;
    lastSubmitted.current = keyOf(blank);
    setDraft(blank);
    update({ ...blank, page: null });
  }

  function onSort(field: string) {
    const flip = sort === field && direction === "asc" ? "desc" : "asc";
    update({ sort: field, direction: sort === field ? flip : "asc", page: null });
  }

  async function exportCsv() {
    setExporting(true);
    try {
      await downloadFile(`/orders/export.csv${query({ ...applied, sort, direction })}`, "orders.csv");
      toast("success", "Orders exported to CSV");
    } catch (cause) {
      toast("error", cause instanceof ApiError ? cause.message : "The export failed");
    } finally {
      setExporting(false);
    }
  }

  const sortProps = { sort, direction, onSort };
  const setDraftField = (key: FilterKey) => (event: { target: { value: string } }) =>
    setDraft({ ...draft, [key]: event.target.value });

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Orders</h1>
          <p className="muted">Dates are whole days in UTC.</p>
        </div>
        <div className="actions">
          <button type="button" className="button" onClick={exportCsv} disabled={exporting}>
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
          {can("orders:write") && (
            <Link className="button button-primary" to="/orders/new">
              New order
            </Link>
          )}
        </div>
      </header>

      <form className="filters panel" onSubmit={applyFilters} aria-label="Filter orders" data-testid="order-filters">
        <Field label="Order number">
          <input type="search" value={draft.q} onChange={setDraftField("q")} maxLength={40} />
        </Field>
        <Field label="From date">
          <input type="date" value={draft.date_from} onChange={setDraftField("date_from")} />
        </Field>
        <Field label="To date">
          <input type="date" value={draft.date_to} onChange={setDraftField("date_to")} />
        </Field>
        <Field label="Warehouse">
          <select value={draft.warehouse_id} onChange={setDraftField("warehouse_id")}>
            <option value="">All warehouses</option>
            {refs.data?.warehouses.map((warehouse) => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.code} · {warehouse.city}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Customer">
          <select value={draft.customer_id} onChange={setDraftField("customer_id")}>
            <option value="">All customers</option>
            {refs.data?.customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select value={draft.status} onChange={setDraftField("status")}>
            <option value="">All statuses</option>
            {ORDER_STATUSES.map((status) => (
              <option key={status} value={status}>
                {titleCase(status)}
              </option>
            ))}
          </select>
        </Field>
        <div className="filter-actions">
          <button type="submit" className="button button-primary">
            Apply filters
          </button>
          <button type="button" className="button" onClick={clearFilters}>
            Clear
          </button>
        </div>
      </form>

      <section className="panel panel-flush" aria-busy={orders.loading}>
        {orders.error && <ErrorState error={orders.error} onRetry={orders.reload} />}
        {orders.loading && !orders.data && <Loading label="Loading orders" />}
        {orders.data && !orders.error && orders.data.items.length === 0 && (
          <EmptyState title="No orders match these filters">Try widening the date range or clearing a filter.</EmptyState>
        )}
        {orders.data && !orders.error && orders.data.items.length > 0 && (
          <>
            <TableWrap testId="orders-grid" label="Orders">
              <thead>
                <tr>
                  <SortHeader label="Order" field="order_number" {...sortProps} />
                  <SortHeader label="Date" field="created_at" {...sortProps} />
                  <th scope="col">Customer</th>
                  <th scope="col">Warehouse</th>
                  <SortHeader label="Status" field="status" {...sortProps} />
                  <th scope="col">Payment</th>
                  <SortHeader label="Total" field="total_cents" align="right" {...sortProps} />
                </tr>
              </thead>
              <tbody>
                {orders.data.items.map((order) => (
                  <tr key={order.id} data-testid="order-row">
                    <td>
                      <Link to={`/orders/${order.id}`}>{order.order_number}</Link>
                    </td>
                    <td>{shortDate(order.created_at)}</td>
                    <td>{order.customer.name}</td>
                    <td>{order.warehouse.code}</td>
                    <td>
                      <StatusBadge status={order.status} />
                    </td>
                    <td>{order.payment_status ? <StatusBadge status={order.payment_status} /> : <span className="muted">None</span>}</td>
                    <td className="num">{money(order.total_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pagination
              page={orders.data.page}
              pages={orders.data.pages}
              total={orders.data.total}
              noun="order"
              onPage={(next) => update({ page: next })}
            />
          </>
        )}
      </section>
    </>
  );
}
