import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ApiError,
  post,
  query,
  request,
  type Customer,
  type ErrorDetail,
  type InventoryRow,
  type OrderDetail,
  type Page,
  type Warehouse,
} from "../api";
import { Field } from "../components/Field";
import { ErrorState, Loading } from "../components/States";
import { useToast } from "../components/Toast";
import { money, percent, taxCents } from "../format";
import { useAsync } from "../useAsync";

interface Line {
  key: number;
  productId: string;
  quantity: string;
}

interface FormErrors {
  customer?: string;
  warehouse?: string;
  lines?: Record<number, { product?: string; quantity?: string }>;
}

export function NewOrderPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [customerId, setCustomerId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([{ key: 1, productId: "", quantity: "1" }]);
  const [nextKey, setNextKey] = useState(2);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);

  const refs = useAsync(
    async (signal) => ({
      customers: await request<Customer[]>("/customers", { signal }),
      warehouses: await request<Warehouse[]>("/warehouses", { signal }),
    }),
    "refs",
  );
  const stock = useAsync(
    (signal) =>
      warehouseId
        ? request<Page<InventoryRow>>(`/inventory${query({ warehouse_id: warehouseId, page_size: 100 })}`, { signal })
        : Promise.resolve(undefined),
    warehouseId,
  );

  const warehouse = refs.data?.warehouses.find((item) => item.id === warehouseId);
  const stockByProduct = useMemo(
    () => new Map(stock.data?.items.map((row) => [row.product.id, row]) ?? []),
    [stock.data],
  );

  const subtotal = lines.reduce((sum, line) => {
    const row = stockByProduct.get(line.productId);
    const quantity = Number(line.quantity);
    return row && Number.isInteger(quantity) && quantity > 0 ? sum + quantity * row.product.unit_price_cents : sum;
  }, 0);
  const tax = warehouse ? taxCents(subtotal, warehouse.tax_rate_bps) : 0;

  function updateLine(key: number, changes: Partial<Line>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...changes } : line)));
  }

  function addLine() {
    setLines((current) => [...current, { key: nextKey, productId: "", quantity: "1" }]);
    setNextKey(nextKey + 1);
  }

  function validate(): FormErrors {
    const found: FormErrors = {};
    if (!customerId) found.customer = "Choose a customer";
    if (!warehouseId) found.warehouse = "Choose a warehouse";
    const lineErrors: NonNullable<FormErrors["lines"]> = {};
    for (const line of lines) {
      const row = stockByProduct.get(line.productId);
      const quantity = Number(line.quantity);
      const item: { product?: string; quantity?: string } = {};
      if (!line.productId) item.product = "Choose a product";
      if (!Number.isInteger(quantity) || quantity <= 0) item.quantity = "Enter a whole number above zero";
      else if (row && quantity > row.quantity) item.quantity = `Only ${row.quantity} available at this warehouse`;
      if (item.product || item.quantity) lineErrors[line.key] = item;
    }
    if (Object.keys(lineErrors).length) found.lines = lineErrors;
    return found;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found = validate();
    setSubmitted(true);
    setSubmitError(undefined);
    if (found.customer || found.warehouse || found.lines) return;
    setBusy(true);
    try {
      const order = await post<OrderDetail>("/orders", {
        customer_id: customerId,
        warehouse_id: warehouseId,
        notes,
        items: lines.map((line) => ({ product_id: line.productId, quantity: Number(line.quantity) })),
      });
      toast("success", `Order ${order.order_number} created`);
      navigate(`/orders/${order.id}`);
    } catch (cause) {
      setSubmitError(cause instanceof ApiError ? cause : new ApiError(0, "UNKNOWN", "The order could not be created."));
      stock.reload();
    } finally {
      setBusy(false);
    }
  }

  if (refs.error) return <ErrorState error={refs.error} onRetry={refs.reload} />;
  if (!refs.data) return <Loading />;

  const chosen = new Set(lines.map((line) => line.productId));
  // Derived from current values after the first submit, so a fixed field clears immediately.
  const errors = submitted ? validate() : {};

  return (
    <>
      <header className="page-header">
        <div>
          <p className="crumb">
            <Link to="/orders">Orders</Link> / New
          </p>
          <h1>New order</h1>
        </div>
      </header>
      <form onSubmit={submit} noValidate className="order-form" aria-label="New order">
        <div className="order-form-main">
          <section className="panel form-grid">
            <Field label="Customer" error={errors.customer}>
              <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">Select a customer</option>
                {refs.data.customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Warehouse" error={errors.warehouse}>
              <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                <option value="">Select a warehouse</option>
                {refs.data.warehouses.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.code} · {item.city} ({percent(item.tax_rate_bps)} tax)
                  </option>
                ))}
              </select>
            </Field>
          </section>

          <section className="panel" aria-labelledby="lines-heading">
            <h2 id="lines-heading">Line items</h2>
            {!warehouseId && <p className="muted">Choose a warehouse to see available products.</p>}
            {stock.error && <ErrorState error={stock.error} onRetry={stock.reload} />}
            <ol className="lines">
              {lines.map((line, index) => {
                const row = stockByProduct.get(line.productId);
                const quantity = Number(line.quantity);
                const lineTotal =
                  row && Number.isInteger(quantity) && quantity > 0 ? quantity * row.product.unit_price_cents : 0;
                return (
                  <li key={line.key} className="line" data-testid="order-line">
                    <Field label={`Product for line ${index + 1}`} error={errors.lines?.[line.key]?.product}>
                      <select
                        value={line.productId}
                        disabled={!warehouseId}
                        onChange={(e) => updateLine(line.key, { productId: e.target.value })}
                      >
                        <option value="">Select a product</option>
                        {stock.data?.items.map((item) => (
                          <option
                            key={item.product.id}
                            value={item.product.id}
                            disabled={chosen.has(item.product.id) && item.product.id !== line.productId}
                          >
                            {item.product.sku} · {item.product.name} ({money(item.product.unit_price_cents)}, {item.quantity} in stock)
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={`Quantity for line ${index + 1}`} error={errors.lines?.[line.key]?.quantity}>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        inputMode="numeric"
                        value={line.quantity}
                        onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                      />
                    </Field>
                    <div className="line-total">
                      <span className="muted">Line total</span>
                      <strong data-testid="line-total">{money(lineTotal)}</strong>
                    </div>
                    <button
                      type="button"
                      className="button button-small button-quiet"
                      disabled={lines.length === 1}
                      aria-label={`Remove line ${index + 1}`}
                      onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))}
                    >
                      Remove
                    </button>
                  </li>
                );
              })}
            </ol>
            <button type="button" className="button button-small" onClick={addLine} disabled={lines.length >= 50}>
              Add line
            </button>
          </section>

          <section className="panel">
            <Field label="Notes" hint="Optional. Visible to everyone who can see this order.">
              <textarea rows={3} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </section>
        </div>

        <aside className="panel order-summary" aria-label="Order total">
          <h2>Summary</h2>
          <dl className="totals">
            <dt>Subtotal</dt>
            <dd data-testid="preview-subtotal">{money(subtotal)}</dd>
            <dt>Tax{warehouse ? ` (${percent(warehouse.tax_rate_bps)})` : ""}</dt>
            <dd data-testid="preview-tax">{money(tax)}</dd>
            <dt className="totals-grand">Total</dt>
            <dd className="totals-grand" data-testid="preview-total">
              {money(subtotal + tax)}
            </dd>
          </dl>
          {submitError && (
            <div className="alert alert-error" role="alert" data-testid="order-error">
              <span>{submitError.message}</span>
              {submitError.code === "INSUFFICIENT_STOCK" && (
                <ul>
                  {submitError.details.map((detail: ErrorDetail) => (
                    <li key={String(detail.product_id)}>
                      {String(detail.sku)}: requested {String(detail.requested)}, available {String(detail.available)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <button type="submit" className="button button-primary button-block" disabled={busy}>
            {busy ? "Creating…" : "Create order"}
          </button>
        </aside>
      </form>
    </>
  );
}
