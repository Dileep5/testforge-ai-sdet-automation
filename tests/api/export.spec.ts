import { expect, test } from "../../framework/fixtures/api";
import { expectValidationError } from "../../framework/helpers/api-client";
import { parseCsv } from "../../framework/helpers/csv";
import { centsToDecimal } from "../../framework/helpers/money";

const COLUMNS = "order_number,created_at,customer_code,customer_name,warehouse_code,status,payment_status,line_count,subtotal_cents,tax_cents,total_cents,total";

test.describe("CSV export", { tag: "@api" }, () => {
  test("the response is a CSV attachment whose rows match the orders", async ({ asManager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ priceCents: 1999, stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 3 }] });
    await data.pay(order);
    const response = await asManager.api.send("GET", "/orders/export.csv", { params: { customer_id: customer.id } });

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("text/csv; charset=utf-8");
    expect(response.headers()["content-disposition"]).toBe('attachment; filename="orders.csv"');
    const text = await response.text();
    expect(text.split("\n")[0]).toBe(COLUMNS);
    const created = await asManager.api.order(order.id);
    const rows = parseCsv(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      order_number: order.order_number,
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/) as unknown as string,
      customer_code: customer.code,
      customer_name: customer.name,
      warehouse_code: "YYZ1",
      status: "PENDING",
      payment_status: "AUTHORIZED",
      line_count: "1",
      subtotal_cents: String(created.subtotal_cents),
      tax_cents: String(created.tax_cents),
      total_cents: String(created.total_cents),
      total: centsToDecimal(created.total_cents),
    });
    expect(Date.parse(rows[0]?.created_at ?? "")).toBe(Date.parse(created.created_at));
  });

  test("filters and sort apply, and no match still returns the header", async ({ asManager, data }) => {
    const customer = await data.customer();
    const cheap = await data.product({ priceCents: 100, stock: { YYZ1: 5 } });
    const dear = await data.product({ priceCents: 90000, stock: { YYZ1: 5 } });
    const a = await data.order({ customer, lines: [{ product: cheap, quantity: 1 }] });
    const b = await data.order({ customer, lines: [{ product: dear, quantity: 1 }] });
    await asManager.api.moveOrder(a.id, "CANCELLED");
    const exportRows = async (params: Record<string, string>) =>
      parseCsv(await (await asManager.api.send("GET", "/orders/export.csv", { params: { customer_id: customer.id, ...params } })).text());
    const numbers = (rows: Record<string, string>[]) => rows.map((row) => row.order_number);

    expect(numbers(await exportRows({ sort: "total_cents", direction: "asc" }))).toEqual([a.order_number, b.order_number]);
    expect(numbers(await exportRows({ sort: "total_cents", direction: "desc" }))).toEqual([b.order_number, a.order_number]);
    expect(numbers(await exportRows({ status: "CANCELLED" }))).toEqual([a.order_number]);
    const empty = await asManager.api.send("GET", "/orders/export.csv", { params: { customer_id: customer.id, status: "SHIPPED" } });
    expect(await empty.text()).toBe(`${COLUMNS}\n`);
  });

  test("formula-like customer names are neutralised for spreadsheets", async ({ asManager, data }) => {
    const customer = await data.customer(`=HYPERLINK("http://e2e.example","${data.namespace}")`);
    const product = await data.product({ stock: { YYZ1: 5 } });
    await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const text = await (await asManager.api.send("GET", "/orders/export.csv", { params: { customer_id: customer.id } })).text();
    const [row] = parseCsv(text);
    expect(row?.customer_name).toBe(`'${customer.name}`);
  });

  test("the export validates its query like the list does", async ({ asManager }) => {
    await expectValidationError(await asManager.api.send("GET", "/orders/export.csv", { params: { status: "LOST" } }), "query.status");
    await expectValidationError(await asManager.api.send("GET", "/orders/export.csv", { params: { sort: "secret" } }), "query.sort");
  });
});
