import type { ReactNode } from "react";
import type { ApiError, OrderStatus, PaymentStatus } from "../api";
import { titleCase } from "../format";

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="state" role="status" data-testid="loading">
      <span className="spinner" aria-hidden="true" />
      {label}…
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state state-empty" data-testid="empty-state">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <div className="alert alert-error" role="alert" data-testid="error-state">
      <span>{error.message}</span>
      {onRetry && (
        <button type="button" className="button button-small" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

const STATUS_TONES: Record<OrderStatus | PaymentStatus, string> = {
  PENDING: "amber",
  CONFIRMED: "blue",
  SHIPPED: "violet",
  DELIVERED: "green",
  CANCELLED: "grey",
  AUTHORIZED: "blue",
  SETTLED: "green",
  DECLINED: "red",
  TIMED_OUT: "amber",
  VOIDED: "grey",
};

export function StatusBadge({ status }: { status: OrderStatus | PaymentStatus }) {
  return (
    <span className={`badge badge-${STATUS_TONES[status]}`} data-testid="status-badge">
      {titleCase(status)}
    </span>
  );
}
