import { expect, type APIRequestContext, type APIResponse } from "@playwright/test";
import type {
  Customer,
  Dashboard,
  InventoryRow,
  OrderDetail,
  OrderHistoryEntry,
  OrderStatus,
  OrderSummary,
  Page,
  Payment,
  PaymentToken,
  ProductDetail,
  ProductSummary,
  Role,
  SessionUser,
  UserOut,
  Warehouse,
} from "./types";

type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Query = Record<string, string | number | boolean>;
interface CallOptions {
  data?: unknown;
  headers?: Record<string, string>;
  params?: Query;
}

export const PREFIX = "/api/v1";

/** Called with every response, so a fixture can check all traffic against the API contract. */
export type ResponseObserver = (method: Method, path: string, response: APIResponse) => Promise<void>;

/** Typed access to the real API. Used for test setup and for verifying results outside the UI. */
export class ApiClient {
  constructor(
    readonly request: APIRequestContext,
    private readonly observer?: ResponseObserver,
  ) {}

  /** For negative checks: returns the response whatever its status. */
  async send(method: Method, path: string, options: CallOptions = {}): Promise<APIResponse> {
    const response = await this.request.fetch(`${PREFIX}${path}`, { method, ...options });
    await this.observer?.(method, `${PREFIX}${path}`, response);
    return response;
  }

  private async json<T>(method: Method, path: string, options: CallOptions = {}): Promise<T> {
    const response = await this.send(method, path, options);
    if (!response.ok()) {
      throw new Error(`${method} ${path} returned ${response.status()}: ${await response.text()}`);
    }
    return (response.status() === 204 ? undefined : await response.json()) as T;
  }

  me = () => this.json<SessionUser>("GET", "/auth/me");
  logout = () => this.json<void>("POST", "/auth/logout");
  dashboard = () => this.json<Dashboard>("GET", "/dashboard/summary");
  warehouses = () => this.json<Warehouse[]>("GET", "/warehouses");
  customers = () => this.json<Customer[]>("GET", "/customers");
  categories = () => this.json<string[]>("GET", "/products/categories");
  users = () => this.json<UserOut[]>("GET", "/users");
  user = (id: string) => this.json<UserOut>("GET", `/users/${id}`);
  products = (params: Query = {}) => this.json<Page<ProductSummary>>("GET", "/products", { params });
  inventory = (params: Query = {}) => this.json<Page<InventoryRow>>("GET", "/inventory", { params });
  inventoryRow = (id: string) => this.json<InventoryRow>("GET", `/inventory/${id}`);
  updateProduct = (id: string, data: Record<string, unknown>) => this.json<ProductDetail>("PATCH", `/products/${id}`, { data });
  orderHistory = (id: string) => this.json<OrderHistoryEntry[]>("GET", `/orders/${id}/history`);
  orderPayments = (id: string) => this.json<Payment[]>("GET", `/orders/${id}/payments`);
  payment = (id: string) => this.json<Payment>("GET", `/payments/${id}`);

  createCustomer = (data: { code: string; name: string; contact_email: string }) =>
    this.json<Customer>("POST", "/customers", { data });

  createUser = (data: { email: string; full_name: string; password: string; role: Role; customer_id?: string }) =>
    this.json<UserOut>("POST", "/users", { data });
  updateUser = (id: string, data: { role?: Role; is_active?: boolean }) =>
    this.json<UserOut>("PATCH", `/users/${id}`, { data });

  createProduct = (data: { sku: string; name: string; category: string; unit_price_cents: number }) =>
    this.json<ProductDetail>("POST", "/products", { data });
  product = (id: string) => this.json<ProductDetail>("GET", `/products/${id}`);
  retireProduct = (id: string) => this.json<void>("DELETE", `/products/${id}`);

  adjustInventory = (id: string, quantity: number, expectedVersion: number, reason = "e2e setup") =>
    this.json<InventoryRow>("PATCH", `/inventory/${id}`, {
      data: { quantity, expected_version: expectedVersion, reason },
    });

  createOrder = (data: {
    customer_id: string;
    warehouse_id: string;
    items: { product_id: string; quantity: number }[];
    notes?: string;
  }) => this.json<OrderDetail>("POST", "/orders", { data });
  order = (id: string) => this.json<OrderDetail>("GET", `/orders/${id}`);
  listOrders = (params: Query) =>
    this.json<Page<OrderSummary>>("GET", "/orders", { params });
  moveOrder = (id: string, status: OrderStatus, note = "") =>
    this.json<OrderDetail>("PATCH", `/orders/${id}/status`, { data: { status, note } });

  pay = (orderId: string, token: PaymentToken, idempotencyKey: string) =>
    this.json<Payment>("POST", `/orders/${orderId}/payments`, {
      data: { method_token: token },
      headers: { "Idempotency-Key": idempotencyKey },
    });
  settle = (paymentId: string) => this.json<Payment>("POST", `/payments/${paymentId}/settle`);
}

/** Assert an error response uses the API's standard envelope with the expected code. */
export async function expectApiError(response: APIResponse, status: number, code: string): Promise<void> {
  expect(response.status(), await response.text()).toBe(status);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe(code);
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details: Record<string, unknown>[];
  request_id: string;
}

/** Like expectApiError, and returns the error for further assertions. */
export async function readApiError(response: APIResponse, status: number, code: string): Promise<ApiErrorBody> {
  await expectApiError(response, status, code);
  return ((await response.json()) as { error: ApiErrorBody }).error;
}

/** Assert a 422 that names the fields at fault, so a request rejected for another reason does not pass. */
export async function expectValidationError(response: APIResponse, ...fields: string[]): Promise<void> {
  const error = await readApiError(response, 422, "VALIDATION_ERROR");
  const reported = error.details.map((detail) => String(detail.field));
  for (const field of fields) {
    expect(reported.some((item) => item === field || item.startsWith(`${field}.`)), `${field} in ${reported.join(", ")}`).toBe(true);
  }
}
