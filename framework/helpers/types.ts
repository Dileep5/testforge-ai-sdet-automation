import type { components } from "../../apps/web/src/api-types";

/** Generated from the API's OpenAPI spec, so API changes surface as framework compile errors. */
type Schemas = components["schemas"];
export type SessionUser = Schemas["SessionUserOut"];
export type UserOut = Schemas["UserOut"];
export type Role = Schemas["Role"];
export type Customer = Schemas["CustomerOut"];
export type Warehouse = Schemas["WarehouseOut"];
export type ProductDetail = Schemas["ProductDetailOut"];
export type InventoryRow = Schemas["InventoryOut"];
export type OrderSummary = Schemas["OrderSummaryOut"];
export type OrderDetail = Schemas["OrderDetailOut"];
export type OrderStatus = Schemas["OrderStatus"];
export type Payment = Schemas["PaymentOut"];
export type PaymentToken = Schemas["PaymentCreate"]["method_token"];
export type Dashboard = Schemas["DashboardSummary"];

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

export interface Credentials {
  email: string;
  password: string;
}
