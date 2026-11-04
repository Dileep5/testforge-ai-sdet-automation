import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ApiError,
  patch,
  post,
  request,
  type HistoryEntry,
  type OrderDetail,
  type OrderStatus,
  type Payment,
} from "../api";
import { useAuth } from "../auth";
import { Field } from "../components/Field";
import { focusMainIfLost } from "../focus";
import { TableWrap } from "../components/Grid";
import { Modal } from "../components/Modal";
import { EmptyState, ErrorState, Loading, StatusBadge } from "../components/States";
import { useToast } from "../components/Toast";
import { dateTime, money, percent, titleCase } from "../format";
import { useAsync } from "../useAsync";

const ACTION_LABELS: Record<OrderStatus, string> = {
  PENDING: "Mark pending",
  CONFIRMED: "Confirm order",
  SHIPPED: "Mark shipped",
  DELIVERED: "Mark delivered",
  CANCELLED: "Cancel order",
};

const SCENARIOS = [
  { token: "sim_success", label: "Simulated: approved" },
  { token: "sim_declined", label: "Simulated: declined" },
  { token: "sim_timeout", label: "Simulated: gateway timeout" },
];

const OUTCOME_MESSAGES: Record<string, string> = {
  AUTHORIZED: "Payment authorized",
  DECLINED: "Payment was declined. No funds were captured; you can try again.",
  TIMED_OUT: "The payment gateway timed out. No funds were captured; you can try again.",
};

/**
 * A random version 4 UUID. crypto.randomUUID exists only on HTTPS and localhost, while
 * getRandomValues is available everywhere, so a payment also works over plain HTTP.
 */
function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function OrderDetailPage() {
  const { orderId = "" } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const [pending, setPending] = useState<OrderStatus>();

  const order = useAsync((signal) => request<OrderDetail>(`/orders/${orderId}`, { signal }), orderId);
  const history = useAsync(
    (signal) => request<HistoryEntry[]>(`/orders/${orderId}/history`, { signal }),
    orderId,
  );

  // Status and payment changes remove the buttons and form that had focus.
  useEffect(focusMainIfLost, [order.data?.status, order.data?.payment_status]);

  function refresh() {
    order.reload();
    history.reload();
  }

  if (order.error) {
    if (order.error.status === 404 || order.error.status === 422) {
      return (
        <EmptyState pageTitle title="Order not found">
          It may not exist, or you may not have access to it. <Link to="/orders">Back to orders</Link>
        </EmptyState>
      );
    }
    return <ErrorState error={order.error} onRetry={refresh} />;
  }
  if (!order.data) return <Loading label="Loading order" />;

  const data = order.data;
  const canWrite = can("orders:write");
  const hasLivePayment = data.payments.some((p) => p.status === "AUTHORIZED" || p.status === "SETTLED");
  const payable = (data.status === "PENDING" || data.status === "CONFIRMED") && !hasLivePayment;

  return (
    <>
      <header className="page-header">
        <div>
          <p className="crumb">
            <Link to="/orders">Orders</Link> / {data.order_number}
          </p>
          <h1 className="title-with-badge">
            <span data-testid="order-number">{data.order_number}</span>
            <span data-testid="order-status">
              <StatusBadge status={data.status} />
            </span>
          </h1>
          <p className="muted">
            {data.customer.name} · {data.warehouse.code} {data.warehouse.name} · created {dateTime(data.created_at)} by{" "}
            {data.created_by_name}
          </p>
        </div>
        {canWrite && data.allowed_transitions.length > 0 && (
          <div className="actions" data-testid="order-actions">
            {data.allowed_transitions.map((status) => (
              <button
                key={status}
                type="button"
                className={status === "CANCELLED" ? "button button-danger" : "button button-primary"}
                onClick={() => setPending(status)}
              >
                {ACTION_LABELS[status]}
              </button>
            ))}
          </div>
        )}
      </header>

      <div className="detail-grid">
        <section className="panel panel-flush" aria-labelledby="items-heading">
          <h2 id="items-heading" className="panel-title">
            Line items
          </h2>
          <TableWrap testId="order-items" label="Line items">
            <thead>
              <tr>
                <th scope="col">SKU</th>
                <th scope="col">Product</th>
                <th scope="col" className="num">
                  Qty
                </th>
                <th scope="col" className="num">
                  Unit price
                </th>
                <th scope="col" className="num">
                  Line total
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id}>
                  <td>{item.sku}</td>
                  <td>{item.product_name}</td>
                  <td className="num">{item.quantity}</td>
                  <td className="num">{money(item.unit_price_cents)}</td>
                  <td className="num">{money(item.line_total_cents)}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </section>

        <aside className="panel" aria-label="Order total">
          <h2>Totals</h2>
          <dl className="totals">
            <dt>Subtotal</dt>
            <dd data-testid="order-subtotal">{money(data.subtotal_cents)}</dd>
            <dt>Tax ({percent(data.tax_rate_bps)})</dt>
            <dd data-testid="order-tax">{money(data.tax_cents)}</dd>
            <dt className="totals-grand">Total</dt>
            <dd className="totals-grand" data-testid="order-total">
              {money(data.total_cents)}
            </dd>
          </dl>
          {data.notes && (
            <>
              <h3>Notes</h3>
              <p className="notes">{data.notes}</p>
            </>
          )}
        </aside>

        <section className="panel panel-flush" aria-labelledby="payments-heading">
          <h2 id="payments-heading" className="panel-title">
            Payments
          </h2>
          {canWrite && payable && (
            <PaymentForm
              orderId={data.id}
              onDone={(payment) => {
                const message = OUTCOME_MESSAGES[payment.status] ?? "Payment recorded";
                toast(payment.status === "AUTHORIZED" ? "success" : "error", message);
                refresh();
              }}
            />
          )}
          {data.payments.length === 0 ? (
            <EmptyState title="No payments yet" />
          ) : (
            <TableWrap testId="payments-grid" label="Payments">
              <thead>
                <tr>
                  <th scope="col">Attempted</th>
                  <th scope="col">Status</th>
                  <th scope="col">Reason</th>
                  <th scope="col" className="num">
                    Amount
                  </th>
                  {canWrite && <th scope="col">Action</th>}
                </tr>
              </thead>
              <tbody>
                {data.payments.map((payment) => (
                  <tr key={payment.id} data-testid="payment-row">
                    <td>{dateTime(payment.created_at)}</td>
                    <td>
                      <StatusBadge status={payment.status} />
                    </td>
                    <td>{payment.failure_reason ? titleCase(payment.failure_reason) : <span className="muted">None</span>}</td>
                    <td className="num">{money(payment.amount_cents)}</td>
                    {canWrite && (
                      <td>
                        {payment.status === "AUTHORIZED" && (
                          <SettleButton
                            paymentId={payment.id}
                            onDone={() => {
                              toast("success", "Payment settled");
                              refresh();
                            }}
                            onError={(message) => toast("error", message)}
                          />
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </section>

        <section className="panel" aria-labelledby="history-heading">
          <h2 id="history-heading">History</h2>
          {history.error && <ErrorState error={history.error} onRetry={history.reload} />}
          <ol className="timeline" data-testid="order-history">
            {history.data?.map((entry, index) => (
              <li key={`${entry.created_at}-${index}`}>
                <strong>{describe(entry)}</strong>
                <span className="muted">
                  {entry.actor_name ?? "System"} · {dateTime(entry.created_at)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {pending && (
        <StatusModal
          orderId={data.id}
          status={pending}
          onClose={() => setPending(undefined)}
          onDone={() => {
            toast("success", `Order moved to ${titleCase(pending)}`);
            setPending(undefined);
            refresh();
          }}
        />
      )}
    </>
  );
}

function describe(entry: HistoryEntry): string {
  if (entry.action === "order.status_changed") {
    const { from, to, note } = entry.details as { from: string; to: string; note?: string };
    return `Status changed from ${titleCase(from)} to ${titleCase(to)}${note ? `: ${note}` : ""}`;
  }
  return titleCase(entry.action.replace(".", " "));
}

function PaymentForm({ orderId, onDone }: { orderId: string; onDone: (payment: Payment) => void }) {
  const [token, setToken] = useState("sim_success");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // Kept until the server gives an answer, so retrying after a lost response cannot double-charge.
  const attemptKey = useRef<{ token: string; key: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    if (attemptKey.current?.token !== token) {
      attemptKey.current = { token, key: newIdempotencyKey() };
    }
    try {
      const payment = await post<Payment>(
        `/orders/${orderId}/payments`,
        { method_token: token },
        { "Idempotency-Key": attemptKey.current.key },
      );
      attemptKey.current = null;
      onDone(payment);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status !== 0) attemptKey.current = null;
      setError(cause instanceof ApiError ? cause.message : "The payment could not be submitted.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="payment-form" onSubmit={submit} aria-label="Run simulated payment" data-testid="payment-form">
      <Field label="Simulated outcome" hint="Simulation only. No card details and no real money.">
        <select value={token} onChange={(e) => setToken(e.target.value)}>
          {SCENARIOS.map((scenario) => (
            <option key={scenario.token} value={scenario.token}>
              {scenario.label}
            </option>
          ))}
        </select>
      </Field>
      <button type="submit" className="button button-primary" aria-disabled={busy}>
        {busy ? "Processing…" : "Run payment"}
      </button>
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}

function SettleButton({
  paymentId,
  onDone,
  onError,
}: {
  paymentId: string;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function settle() {
    if (busy) return;
    setBusy(true);
    try {
      await post<Payment>(`/payments/${paymentId}/settle`);
      onDone();
    } catch (cause) {
      onError(cause instanceof ApiError ? cause.message : "The payment could not be settled.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" className="button button-small" aria-disabled={busy} onClick={settle}>
      {busy ? "Settling…" : "Settle"}
    </button>
  );
}

function StatusModal({
  orderId,
  status,
  onClose,
  onDone,
}: {
  orderId: string;
  status: OrderStatus;
  onClose: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await patch<OrderDetail>(`/orders/${orderId}/status`, { status, note });
      onDone();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "The status could not be changed.");
      setBusy(false);
    }
  }

  return (
    <Modal title={ACTION_LABELS[status]} onClose={onClose} testId="status-modal">
      <form onSubmit={submit}>
        {status === "CANCELLED" && <p>Cancelling returns this order's stock to the warehouse and voids any authorization.</p>}
        <Field label="Note" hint="Optional. Saved in the order history.">
          <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {error && (
          <div className="alert alert-error" role="alert" data-testid="status-error">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Keep as is
          </button>
          <button type="submit" className={`button ${status === "CANCELLED" ? "button-danger" : "button-primary"}`} aria-disabled={busy}>
            {busy ? "Saving…" : ACTION_LABELS[status]}
          </button>
        </div>
      </form>
    </Modal>
  );
}
