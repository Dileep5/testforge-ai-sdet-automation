import type { components } from "./api-types";

type Schemas = components["schemas"];
export type SessionUser = Schemas["SessionUserOut"];
export type UserRow = Schemas["UserOut"];
export type Role = Schemas["Role"];
export type Customer = Schemas["CustomerOut"];
export type Warehouse = Schemas["WarehouseOut"];
export type Product = Schemas["ProductOut"];
export type ProductDetail = Schemas["ProductDetailOut"];
export type InventoryRow = Schemas["InventoryOut"];
export type OrderSummary = Schemas["OrderSummaryOut"];
export type OrderDetail = Schemas["OrderDetailOut"];
export type OrderStatus = Schemas["OrderStatus"];
export type Payment = Schemas["PaymentOut"];
export type PaymentStatus = Schemas["PaymentStatus"];
export type HistoryEntry = Schemas["OrderHistoryEntry"];
export type AuditEntry = Schemas["AuditLogOut"];
export type DashboardSummary = Schemas["DashboardSummary"];
export type ChatResponse = Schemas["ChatResponse"];

export const ORDER_STATUSES: OrderStatus[] = [
  "PENDING",
  "CONFIRMED",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
];

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

export type ErrorDetail = Record<string, unknown>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: ErrorDetail[] = [],
  ) {
    super(message);
  }
}

const SESSION_CODES = new Set(["NOT_AUTHENTICATED", "INVALID_SESSION", "SESSION_EXPIRED"]);

let onSessionLost: (code: string) => void = () => {};

export function setSessionLostHandler(handler: (code: string) => void): void {
  onSessionLost = handler;
}

async function send(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: "same-origin" });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError(0, "NETWORK_ERROR", "The server could not be reached. Check your connection and try again.");
  }
  if (response.ok) return response;

  let code = "UNEXPECTED_RESPONSE";
  let message = `The server responded with an error (${response.status}).`;
  let details: ErrorDetail[] = [];
  try {
    const body = (await response.json()) as { error: { code: string; message: string; details: ErrorDetail[] } };
    ({ code, message, details } = body.error);
  } catch {
    // A proxy or server error without our JSON envelope: keep the generic message.
  }
  if (response.status === 401 && SESSION_CODES.has(code)) onSessionLost(code);
  throw new ApiError(response.status, code, message, details);
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await send(path, init);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export function post<T>(path: string, body?: unknown, headers?: HeadersInit): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
  });
}

export function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

export async function downloadFile(path: string, filename: string): Promise<void> {
  const blob = await (await send(path)).blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Every stock row at a warehouse, in SKU order. This walks a cursor rather than offset pages, because
 * a product added or retired mid-read would shift offsets and repeat or skip rows.
 */
export async function fetchWarehouseStock(warehouseId: string, signal?: AbortSignal): Promise<InventoryRow[]> {
  const pageSize = 100;
  const rows: InventoryRow[] = [];
  for (;;) {
    const last = rows.at(-1)?.id;
    const params = { warehouse_id: warehouseId, sort: "id", after_id: last, page_size: pageSize };
    const { items } = await request<Page<InventoryRow>>(`/inventory${query(params)}`, { signal });
    rows.push(...items);
    if (items.length < pageSize) {
      return rows.sort((a, b) => a.product.sku.localeCompare(b.product.sku));
    }
  }
}

/** Build a query string, leaving out blank values. */
export function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
