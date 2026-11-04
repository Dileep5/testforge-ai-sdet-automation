import { expect, test } from "../../framework/fixtures";
import { expectApiError } from "../../framework/helpers/api-client";

const STAFF_LINKS = ["Dashboard", "Orders", "Products", "Inventory"];

test.describe("role-based access", { tag: "@regression" }, () => {
  test("each role sees the navigation for its permissions", { tag: "@smoke" }, async ({ admin, manager, viewer, buyer }) => {
    await admin.app.dashboard.goto();
    await admin.app.nav.expectLinks([...STAFF_LINKS, "Users", "Audit log"]);
    await manager.app.dashboard.goto();
    await manager.app.nav.expectLinks(STAFF_LINKS);
    await viewer.app.dashboard.goto();
    await viewer.app.nav.expectLinks(STAFF_LINKS);
    await buyer.app.dashboard.goto();
    await buyer.app.nav.expectLinks(STAFF_LINKS);
    await expect(buyer.app.nav.currentRole).toContainText(buyer.customer.name);
  });

  test("a manager is refused admin pages by both the UI and the API", { tag: "@critical" }, async ({ manager }) => {
    await manager.app.users.goto();
    await expect(manager.app.users.forbidden).toBeVisible();
    await expect(manager.app.users.table).toBeHidden();
    await expectApiError(await manager.api.send("GET", "/users"), 403, "FORBIDDEN");
    await expectApiError(await manager.api.send("GET", "/audit-logs"), 403, "FORBIDDEN");
  });

  test("a viewer has no write controls, and the API refuses the writes anyway", { tag: "@critical" }, async ({ viewer, data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 10 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const { app, api } = viewer;

    await app.orders.goto();
    await expect(app.orders.newOrderLink).toHaveCount(0);
    await app.page.goto("/orders/new");
    await expect(app.page.getByTestId("forbidden")).toBeVisible();

    await app.orderDetails.goto(order.id);
    await expect(app.orderDetails.actions).toHaveCount(0);
    await expect(app.orderDetails.paymentForm).toHaveCount(0);

    await app.productDetails.goto(product.id);
    await expect(app.productDetails.editButton).toHaveCount(0);
    await expect(app.productDetails.retireButton).toHaveCount(0);

    await app.inventory.goto();
    await app.inventory.search(product.sku);
    await expect(app.inventory.grid.row(product.sku)).toHaveCount(4);
    await expect(app.inventory.adjustButtons).toHaveCount(0);

    // Hidden buttons are not security. The same requests must fail at the backend.
    const row = product.stock.find((item) => item.warehouse.code === "YYZ1");
    const headers = { "Idempotency-Key": `viewer-${data.namespace}` };
    await expectApiError(await api.send("PATCH", `/orders/${order.id}/status`, { data: { status: "CANCELLED" } }), 403, "FORBIDDEN");
    await expectApiError(await api.send("POST", `/orders/${order.id}/payments`, { data: { method_token: "sim_success" }, headers }), 403, "FORBIDDEN");
    await expectApiError(await api.send("PATCH", `/inventory/${row?.inventory_id}`, { data: { quantity: 1, expected_version: 2, reason: "nope" } }), 403, "FORBIDDEN");
    await expectApiError(await api.send("DELETE", `/products/${product.id}`), 403, "FORBIDDEN");

    expect((await db.order(order.order_number)).status).toBe("PENDING");
    expect(await db.payments(order.id)).toHaveLength(0);
    expect(await db.stock(product.id, "YYZ1")).toBe(9);
    expect((await db.product(product.sku))?.is_active).toBe(true);
  });

  test("changing a user's role ends their open session immediately", { tag: "@critical" }, async ({ admin, signIn, data }) => {
    const created = await data.user("MANAGER");
    const target = await signIn(created);
    await target.app.orders.goto();
    await expect(target.app.orders.newOrderLink).toBeVisible();

    await admin.app.users.goto();
    await admin.app.users.changeRole(created.email, "VIEWER");
    await admin.app.users.toasts.expectSuccess("active sessions were ended");

    await target.app.nav.goTo("Products");
    await expect(target.app.login.sessionEnded).toBeVisible();
    await target.app.login.signIn(created);
    await expect(target.app.nav.currentRole).toHaveText("Viewer");
    await target.app.orders.goto();
    await expect(target.app.orders.newOrderLink).toHaveCount(0);
  });

  test("an admin creates a user who can sign in with the assigned role, and it is audited", async ({ admin, anon, data, db }) => {
    const email = `created-${data.namespace.toLowerCase()}@e2e.example`;
    const password = `Long-Passw0rd-${data.namespace}`;
    await admin.app.users.goto();
    await admin.app.users.createUser({ email, name: "Created By Admin", password, role: "MANAGER" });
    await expect(admin.app.users.row(email)).toContainText("Created By Admin");

    await anon.app.login.goto();
    await anon.app.login.signIn({ email, password });
    await expect(anon.app.nav.currentRole).toHaveText("Manager");

    const [row] = await db.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
    const audit = await db.audit(row?.id ?? "", "user.created");
    expect(audit[0]?.actor_email).toBe("admin@testforge.example");
    await admin.api.updateUser(row?.id ?? "", { is_active: false });
  });

  test("deactivating a user is audited against the admin who did it", async ({ admin, data, db }) => {
    const created = await data.user("VIEWER");
    await admin.app.users.goto();
    await admin.app.users.deactivate(created.email);
    await expect(admin.app.users.row(created.email)).toContainText("Inactive");

    const [entry] = await db.audit(created.user.id, "user.updated");
    expect(entry?.actor_email).toBe("admin@testforge.example");
    expect(entry?.details).toEqual({ is_active: "False" });

    // The audit page is a shared, moving list while other workers run, so check its shape only.
    await admin.app.audit.goto();
    await expect(admin.app.audit.table.locator("tbody tr")).toHaveCount(20);
    await expect(admin.app.page.getByTestId("pagination-summary")).toContainText("page 1 of");
  });
});

test.describe("customer-scoped viewer", { tag: "@regression" }, () => {
  test("sees only their own customer's orders, totals and export", { tag: ["@smoke", "@critical"] }, async ({ buyer, data }) => {
    const other = await data.customer();
    const product = await data.product({ priceCents: 1000, stock: { YYZ1: 50 } });
    const first = await data.order({ customer: buyer.customer, lines: [{ product, quantity: 1 }] });
    const second = await data.order({ customer: buyer.customer, lines: [{ product, quantity: 2 }] });
    const foreign = await data.order({ customer: other, lines: [{ product, quantity: 3 }] });
    const settledOrder = await data.advance(second, "SHIPPED");
    const { app } = buyer;

    await app.orders.goto();
    await expect(app.orders.grid.rows).toHaveCount(2);
    await expect(await app.orders.grid.column("Order")).toHaveText([second.order_number, first.order_number]);
    await expect(app.page.getByText(foreign.order_number)).toHaveCount(0);

    // The customer filter must offer only their own company.
    await expect(app.orders.customer.locator("option")).toHaveText(["All customers", buyer.customer.name]);

    const csv = await app.orders.exportCsv();
    expect(csv.text).toContain(first.order_number);
    expect(csv.text).toContain(second.order_number);
    expect(csv.text).not.toContain(foreign.order_number);

    await app.dashboard.goto();
    await expect(app.dashboard.totalOrders).toHaveText("2");
    await expect(app.dashboard.settledRevenue).toHaveText("$22.60");
    expect(settledOrder.total_cents).toBe(2260);
  });

  test("cannot open another customer's order by URL, and the API does not reveal it exists", { tag: "@critical" }, async ({ buyer, data }) => {
    const other = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const foreign = await data.order({ customer: other, lines: [{ product, quantity: 1 }] });
    const payment = await data.pay(foreign);
    const { app, api } = buyer;

    await app.page.goto(`/orders/${foreign.id}`);
    await expect(app.orderDetails.notFound).toContainText("Order not found");
    await expect(app.page.getByText(foreign.order_number)).toHaveCount(0);

    await expectApiError(await api.send("GET", `/orders/${foreign.id}`), 404, "NOT_FOUND");
    await expectApiError(await api.send("GET", `/orders/${foreign.id}/history`), 404, "NOT_FOUND");
    await expectApiError(await api.send("GET", `/orders/${foreign.id}/payments`), 404, "NOT_FOUND");
    await expectApiError(await api.send("GET", `/payments/${payment.id}`), 404, "NOT_FOUND");
  });

  test("filtering by another customer's id through the URL returns nothing", async ({ buyer, data }) => {
    const other = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    await data.order({ customer: other, lines: [{ product, quantity: 1 }] });
    await buyer.app.orders.goto(`?customer_id=${other.id}`);
    await expect(buyer.app.orders.emptyState).toBeVisible();
    const page = await buyer.api.listOrders({ customer_id: other.id });
    expect(page.total).toBe(0);
  });

  test("cannot reach order creation", async ({ buyer }) => {
    await buyer.app.orders.goto();
    await expect(buyer.app.orders.newOrderLink).toHaveCount(0);
    await buyer.app.page.goto("/orders/new");
    await expect(buyer.app.page.getByTestId("forbidden")).toBeVisible();
  });
});
