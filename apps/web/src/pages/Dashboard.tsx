import { Link } from "react-router-dom";
import { ORDER_STATUSES, request, type DashboardSummary } from "../api";
import { useAuth } from "../auth";
import { TableWrap } from "../components/Grid";
import { EmptyState, ErrorState, Loading, StatusBadge } from "../components/States";
import { money, shortDate, titleCase } from "../format";
import { useAsync } from "../useAsync";

export function DashboardPage() {
  const { user } = useAuth();
  const { data, error, loading, reload } = useAsync(
    (signal) => request<DashboardSummary>("/dashboard/summary", { signal }),
    "dashboard",
  );

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">Welcome back, {user?.full_name}.</p>
        </div>
      </header>
      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && !data && <Loading />}
      {data && (
        <>
          <section className="stats" aria-label="Key figures">
            <Stat label="Total orders" value={String(data.total_orders)} testId="stat-total-orders" />
            <Stat label="Open orders" value={String(data.open_orders)} testId="stat-open-orders" />
            <Stat label="Settled revenue" value={money(data.settled_revenue_cents)} testId="stat-revenue" />
            <Stat label="Low stock lines" value={String(data.low_stock_count)} testId="stat-low-stock" />
          </section>
          <section className="panel" aria-labelledby="by-status">
            <h2 id="by-status">Orders by status</h2>
            <ul className="status-strip">
              {ORDER_STATUSES.map((status) => (
                <li key={status}>
                  <Link to={`/orders?status=${status}`}>
                    <span className="status-count">{data.orders_by_status[status] ?? 0}</span>
                    <span className="muted">{titleCase(status)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
          <section className="panel" aria-labelledby="recent">
            <h2 id="recent">Recent orders</h2>
            {data.recent_orders.length === 0 ? (
              <EmptyState title="No orders yet" />
            ) : (
              <TableWrap testId="recent-orders" label="Recent orders">
                <thead>
                  <tr>
                    <th scope="col">Order</th>
                    <th scope="col">Customer</th>
                    <th scope="col">Date</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="num">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent_orders.map((order) => (
                    <tr key={order.id}>
                      <td>
                        <Link to={`/orders/${order.id}`}>{order.order_number}</Link>
                      </td>
                      <td>{order.customer.name}</td>
                      <td>{shortDate(order.created_at)}</td>
                      <td>
                        <StatusBadge status={order.status} />
                      </td>
                      <td className="num">{money(order.total_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            )}
          </section>
        </>
      )}
    </>
  );
}

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" data-testid={testId}>
        {value}
      </div>
    </div>
  );
}
