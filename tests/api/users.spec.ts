import { expect, test } from "../../framework/fixtures/api";
import { expectValidationError, readApiError } from "../../framework/helpers/api-client";
import type { UserOut } from "../../framework/helpers/types";

const PASSWORD = "E2E-Long-Password-1";

test.describe("users and customers", { tag: "@api" }, () => {
  test("an admin can create, read, list and update a user", async ({ asAdmin, data }) => {
    const email = `${data.unique("user").toLowerCase()}@e2e.example`;
    const response = await asAdmin.api.send("POST", "/users", {
      data: { email: email.toUpperCase(), full_name: "  Padded Name  ", password: PASSWORD, role: "MANAGER" },
    });
    expect(response.status()).toBe(201);
    const created = (await response.json()) as UserOut;
    data.adopt(`deactivate ${email}`, async () => void (await asAdmin.api.updateUser(created.id, { is_active: false })));
    expect(created).toMatchObject({ email, full_name: "Padded Name", role: "MANAGER", is_active: true, customer: null });
    expect(await asAdmin.api.user(created.id)).toEqual(created);
    expect((await asAdmin.api.users()).map((user) => user.id)).toContain(created.id);
    const updated = (await (
      await asAdmin.api.send("PATCH", `/users/${created.id}`, { data: { full_name: "New Name", role: "VIEWER" } })
    ).json()) as UserOut;
    expect(updated).toMatchObject({ full_name: "New Name", role: "VIEWER" });
  });

  test("a duplicate email conflicts regardless of case", async ({ asAdmin, data }) => {
    const existing = await data.user("VIEWER");
    const response = await asAdmin.api.send("POST", "/users", {
      data: { email: existing.email.toUpperCase(), full_name: "Copy", password: PASSWORD, role: "VIEWER" },
    });
    await readApiError(response, 409, "DUPLICATE_EMAIL");
  });

  const invalidUsers: { name: string; change: Record<string, unknown>; field: string }[] = [
    { name: "a short password", change: { password: "elevenchars" }, field: "body.password" },
    { name: "an unknown role", change: { role: "ROOT" }, field: "body.role" },
    { name: "a malformed email", change: { email: "nope" }, field: "body.email" },
    { name: "a blank name", change: { full_name: "   " }, field: "body.full_name" },
    { name: "a malformed customer id", change: { customer_id: "x" }, field: "body.customer_id" },
    { name: "an unknown field", change: { is_superuser: true }, field: "body.is_superuser" },
  ];
  for (const { name, change, field } of invalidUsers) {
    test(`creating a user rejects ${name}`, async ({ asAdmin, data }) => {
      const body = { email: `${data.unique("u").toLowerCase()}@e2e.example`, full_name: "Name", password: PASSWORD, role: "VIEWER" };
      await expectValidationError(await asAdmin.api.send("POST", "/users", { data: { ...body, ...change } }), field);
    });
  }

  test("customer accounts must be Viewers and reference a real customer", async ({ asAdmin, data }) => {
    const customer = await data.customer();
    const body = { full_name: "Name", password: PASSWORD };
    const send = (change: Record<string, unknown>) =>
      asAdmin.api.send("POST", "/users", { data: { ...body, email: `${data.unique("u").toLowerCase()}@e2e.example`, ...change } });
    await readApiError(await send({ role: "MANAGER", customer_id: customer.id }), 422, "VALIDATION_ERROR");
    await readApiError(await send({ role: "VIEWER", customer_id: "00000000-0000-4000-8000-000000000000" }), 422, "INVALID_REFERENCE");
  });

  test("an unknown user is 404 and a malformed id is 422", async ({ asAdmin }) => {
    await readApiError(await asAdmin.api.send("GET", "/users/00000000-0000-4000-8000-000000000000"), 404, "NOT_FOUND");
    await expectValidationError(await asAdmin.api.send("GET", "/users/not-a-uuid"), "path.user_id");
    await readApiError(await asAdmin.api.send("PATCH", "/users/00000000-0000-4000-8000-000000000000", { data: {} }), 404, "NOT_FOUND");
  });

  test("an admin cannot change their own role or active status", async ({ asAdmin }) => {
    for (const data of [{ role: "VIEWER" }, { is_active: false }]) {
      await readApiError(await asAdmin.api.send("PATCH", `/users/${asAdmin.user.id}`, { data }), 409, "SELF_MODIFICATION");
    }
  });

  test("customers: create validates, duplicates conflict, and the list includes the new one", async ({ asAdmin, data }) => {
    const created = await data.customer();
    expect((await asAdmin.api.customers()).map((customer) => customer.id)).toContain(created.id);
    const body = { code: created.code, name: "Copy", contact_email: "copy@e2e.example" };
    await readApiError(await asAdmin.api.send("POST", "/customers", { data: body }), 409, "DUPLICATE_CUSTOMER");
    await expectValidationError(await asAdmin.api.send("POST", "/customers", { data: { ...body, code: "lower case" } }), "body.code");
    await expectValidationError(await asAdmin.api.send("POST", "/customers", { data: { code: "X1" } }), "body.name", "body.contact_email");
  });

  test("warehouses and roles can be read", async ({ asViewer }) => {
    const warehouses = await asViewer.api.warehouses();
    expect(warehouses.map((warehouse) => warehouse.code)).toEqual(["YUL1", "YVR1", "YYC1", "YYZ1"]);
    const one = warehouses[0];
    expect(await (await asViewer.api.send("GET", `/warehouses/${one?.id}`)).json()).toEqual(one);
    await readApiError(await asViewer.api.send("GET", "/warehouses/00000000-0000-4000-8000-000000000000"), 404, "NOT_FOUND");
    const roles = (await (await asViewer.api.send("GET", "/roles")).json()) as { name: string; permissions: string[] }[];
    expect(roles.map((role) => role.name)).toEqual(["ADMIN", "MANAGER", "VIEWER"]);
    expect(roles.find((role) => role.name === "VIEWER")?.permissions).toEqual([]);
  });
});
