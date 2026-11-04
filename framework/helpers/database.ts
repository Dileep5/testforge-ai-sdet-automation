import { createHash } from "node:crypto";
import { Client, types } from "pg";
import { DATABASE_URL, READONLY_DATABASE_URL, assertE2eDatabase } from "../config";

// BIGINT columns hold money in cents: read them as numbers, but never lose precision silently.
types.setTypeParser(types.builtins.INT8, (value) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`BIGINT ${value} does not fit a safe integer`);
  return parsed;
});

export interface OrderRow {
  id: string;
  order_number: string;
  status: string;
  subtotal_cents: number;
  tax_rate_bps: number;
  tax_cents: number;
  total_cents: number;
  created_by_email: string;
}

export interface OrderItemRow {
  sku: string;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
}

export interface PaymentRow {
  id: string;
  status: string;
  amount_cents: number;
  failure_reason: string | null;
  authorized_at: Date | null;
  settled_at: Date | null;
  voided_at: Date | null;
}

export interface AuditRow {
  action: string;
  actor_email: string | null;
  details: Record<string, unknown>;
}

/**
 * Checks what was actually persisted. The connection uses a SELECT-only role, so a verification
 * query cannot change data another worker depends on, or anything in another database.
 */
export class ReadOnlyDb {
  private constructor(private readonly client: Client) {}

  static async connect(): Promise<ReadOnlyDb> {
    assertE2eDatabase();
    const client = new Client({
      connectionString: READONLY_DATABASE_URL,
      options: "-c default_transaction_read_only=on -c timezone=UTC",
    });
    await client.connect();
    return new ReadOnlyDb(client);
  }

  close = () => this.client.end();

  async query<T extends object>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.client.query<T>(sql, params)).rows;
  }

  async order(orderNumber: string): Promise<OrderRow> {
    const [row] = await this.query<OrderRow>(
      `SELECT o.id, o.order_number, o.status, o.subtotal_cents, o.tax_rate_bps, o.tax_cents, o.total_cents,
              u.email AS created_by_email
         FROM orders o JOIN users u ON u.id = o.created_by_id
        WHERE o.order_number = $1`,
      [orderNumber],
    );
    if (!row) throw new Error(`Order ${orderNumber} is not in the database`);
    return row;
  }

  orderItems = (orderId: string) =>
    this.query<OrderItemRow>(
      `SELECT sku, quantity, unit_price_cents, line_total_cents FROM order_items WHERE order_id = $1 ORDER BY sku`,
      [orderId],
    );

  async countOrdersForCustomer(customerId: string): Promise<number> {
    const [row] = await this.query<{ count: number }>(`SELECT count(*) FROM orders WHERE customer_id = $1`, [customerId]);
    return row?.count ?? 0;
  }

  async stock(productId: string, warehouseCode: string): Promise<number> {
    const [row] = await this.query<{ quantity: number }>(
      `SELECT i.quantity FROM inventory i JOIN warehouses w ON w.id = i.warehouse_id
        WHERE i.product_id = $1 AND w.code = $2`,
      [productId, warehouseCode],
    );
    if (!row) throw new Error(`No inventory row for ${productId} at ${warehouseCode}`);
    return row.quantity;
  }

  payments = (orderId: string) =>
    this.query<PaymentRow>(
      `SELECT id, status, amount_cents, failure_reason, authorized_at, settled_at, voided_at
         FROM payments WHERE order_id = $1 ORDER BY created_at`,
      [orderId],
    );

  /** The earliest day with orders in the seeded history, and those orders, newest first. */
  async firstSeededDay(): Promise<{ day: string; numbers: string[] }> {
    const [row] = await this.query<{ day: string; numbers: string[] }>(
      `SELECT to_char(created_at, 'YYYY-MM-DD') AS day, array_agg(order_number ORDER BY created_at DESC) AS numbers
         FROM orders WHERE created_at < '2026-02-01' GROUP BY 1 ORDER BY 1 LIMIT 1`,
    );
    if (!row) throw new Error("Seed data has no January orders");
    return row;
  }

  async seededOrderNumbers(from: string, toExclusive: string): Promise<string[]> {
    const rows = await this.query<{ order_number: string }>(
      `SELECT order_number FROM orders WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at DESC`,
      [from, toExclusive],
    );
    return rows.map((row) => row.order_number);
  }

  async product(sku: string): Promise<{ id: string; unit_price_cents: number; is_active: boolean } | undefined> {
    const [row] = await this.query<{ id: string; unit_price_cents: number; is_active: boolean }>(
      `SELECT id, unit_price_cents, is_active FROM products WHERE sku = $1`,
      [sku],
    );
    return row;
  }

  audit = (entityId: string, action: string) =>
    this.query<AuditRow>(
      `SELECT a.action, u.email AS actor_email, a.details
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.entity_id = $1 AND a.action = $2 ORDER BY a.created_at`,
      [entityId, action],
    );
}

/**
 * The only write the framework makes outside the API: ages one session so expiry can be tested
 * without waiting. It is keyed to the calling test's own cookie, so it cannot affect other sessions.
 */
export async function expireSession(cookieValue: string): Promise<void> {
  assertE2eDatabase();
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(
      `UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1`,
      [createHash("sha256").update(cookieValue).digest("hex")],
    );
    if (result.rowCount !== 1) throw new Error(`Expected to expire 1 session, matched ${result.rowCount}`);
  } finally {
    await client.end();
  }
}
