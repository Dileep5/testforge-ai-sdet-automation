import { createHash } from "node:crypto";
import type { TestInfo } from "@playwright/test";
import type { ApiClient } from "../helpers/api-client";
import type { Credentials, Customer, OrderDetail, OrderStatus, Payment, PaymentToken, ProductDetail, Role, UserOut, Warehouse } from "../helpers/types";

export type WarehouseCode = "YYZ1" | "YVR1" | "YUL1" | "YYC1";

/** Seeded warehouses and their tax rates. Reference data that no test changes. */
export const TAX_BPS: Record<WarehouseCode, number> = { YYZ1: 1300, YVR1: 1200, YUL1: 1498, YYC1: 500 };

export interface ProductOptions {
  name?: string;
  category?: string;
  priceCents?: number;
  stock?: Partial<Record<WarehouseCode, number>>;
}

export interface OrderOptions {
  customer: Customer;
  warehouse?: WarehouseCode;
  lines: { product: ProductDetail; quantity: number }[];
}

export interface CreatedUser extends Credentials {
  user: UserOut;
}

/**
 * A namespace that is deterministic for a given test, browser, retry and repeat, and different for
 * every other. Names built from it can never collide between parallel workers.
 */
export function testNamespace(info: Pick<TestInfo, "testId" | "retry" | "repeatEachIndex">): string {
  return createHash("sha256")
    .update(`${info.testId}:${info.retry}:${info.repeatEachIndex}`)
    .digest("hex")
    .slice(0, 10)
    .toUpperCase();
}

/**
 * Creates each test's own records through the real API and remembers exactly what it created.
 * Cleanup only ever touches those ids, so it cannot affect another worker's data. Every run also
 * starts from a freshly seeded database, so anything left behind does not accumulate.
 */
export class TestData {
  private sequence = 0;
  private warehouses: Warehouse[] | undefined;
  private readonly cleanups: { label: string; run: () => Promise<void> }[] = [];

  constructor(
    private readonly api: ApiClient,
    readonly namespace: string,
  ) {}

  private next = () => ++this.sequence;

  async warehouse(code: WarehouseCode): Promise<Warehouse> {
    this.warehouses ??= await this.api.warehouses();
    const found = this.warehouses.find((warehouse) => warehouse.code === code);
    if (!found) throw new Error(`Seeded warehouse ${code} is missing`);
    return found;
  }

  async customer(name?: string): Promise<Customer> {
    const n = this.next();
    // Customers have no delete operation; the unique code keeps them out of every other test's way.
    return this.api.createCustomer({
      code: `C-${this.namespace}-${n}`,
      name: name ?? `Customer ${this.namespace} ${n}`,
      contact_email: `c${n}-${this.namespace.toLowerCase()}@e2e.example`,
    });
  }

  async product(options: ProductOptions = {}): Promise<ProductDetail> {
    const n = this.next();
    const sku = `E2E-${this.namespace}-${n}`;
    const product = await this.api.createProduct({
      sku,
      name: options.name ?? `Test Product ${this.namespace} ${n}`,
      category: options.category ?? "E2E",
      unit_price_cents: options.priceCents ?? 1999,
    });
    this.cleanups.push({ label: `retire ${sku}`, run: () => this.api.retireProduct(product.id) });
    const stock = options.stock ?? { YYZ1: 100 };
    for (const [code, quantity] of Object.entries(stock)) {
      const row = product.stock.find((item) => item.warehouse.code === code);
      if (!row) throw new Error(`Product ${sku} has no inventory row at ${code}`);
      await this.api.adjustInventory(row.inventory_id, quantity, row.version);
    }
    return this.api.product(product.id);
  }

  async order({ customer, warehouse = "YYZ1", lines }: OrderOptions): Promise<OrderDetail> {
    const order = await this.api.createOrder({
      customer_id: customer.id,
      warehouse_id: (await this.warehouse(warehouse)).id,
      items: lines.map((line) => ({ product_id: line.product.id, quantity: line.quantity })),
    });
    this.cleanups.push({ label: `release ${order.order_number}`, run: () => this.releaseOrder(order.id) });
    return order;
  }

  /** Return stock to the test's own product. Finished or settled orders stay as history. */
  private async releaseOrder(orderId: string): Promise<void> {
    const order = await this.api.order(orderId);
    const settled = order.payments.some((payment) => payment.status === "SETTLED");
    if (order.allowed_transitions.includes("CANCELLED") && !settled) {
      await this.api.moveOrder(orderId, "CANCELLED", "e2e cleanup");
    }
  }

  pay(order: OrderDetail, token: PaymentToken = "sim_success"): Promise<Payment> {
    return this.api.pay(order.id, token, `e2e-${this.namespace}-${this.next()}`);
  }

  /** Walk an order to a status through the real state machine, paying where the rules require it. */
  async advance(order: OrderDetail, status: OrderStatus): Promise<OrderDetail> {
    if (status === "PENDING") return order;
    if (status === "CANCELLED") return this.api.moveOrder(order.id, "CANCELLED");
    const payment = await this.pay(order);
    let current = await this.api.moveOrder(order.id, "CONFIRMED");
    if (status === "CONFIRMED") return current;
    await this.api.settle(payment.id);
    current = await this.api.moveOrder(order.id, "SHIPPED");
    return status === "SHIPPED" ? current : this.api.moveOrder(order.id, "DELIVERED");
  }

  async user(role: Role, customer?: Customer): Promise<CreatedUser> {
    const n = this.next();
    const email = `${role.toLowerCase()}-${this.namespace.toLowerCase()}-${n}@e2e.example`;
    const password = `E2E-Passw0rd-${this.namespace}`;
    const user = await this.api.createUser({
      email,
      password,
      role,
      full_name: `${role[0]}${role.slice(1).toLowerCase()} ${this.namespace} ${n}`,
      ...(customer ? { customer_id: customer.id } : {}),
    });
    this.cleanups.push({ label: `deactivate ${email}`, run: () => this.deactivateUser(user.id) });
    return { user, email, password };
  }

  private async deactivateUser(id: string): Promise<void> {
    await this.api.updateUser(id, { is_active: false });
  }

  /** Runs newest first, so orders release their stock before their products are retired. */
  async cleanup(): Promise<string[]> {
    const failures: string[] = [];
    for (const { label, run } of this.cleanups.reverse()) {
      try {
        await run();
      } catch (error) {
        failures.push(`${label}: ${String(error)}`);
      }
    }
    return failures;
  }
}
