import { Client } from "pg";
import { expect, test } from "../../framework/fixtures/api";
import { READONLY_DEV_DATABASE_URL, assertE2eDatabase } from "../../framework/config";
import { ReadOnlyDb } from "../../framework/helpers/database";

test.describe("these tests cannot change data they should not", { tag: "@database" }, () => {
  test("assertions run against the E2E database, as the SELECT-only role", async ({ db }) => {
    const [row] = await db.query<{ database: string; role: string; read_only: string }>(
      `SELECT current_database() AS database, current_user AS role, current_setting('default_transaction_read_only') AS read_only`,
    );
    expect(row).toEqual({ database: "testforge_e2e", role: "testforge_e2e_reader", read_only: "on" });
  });

  const writes = [
    `UPDATE warehouses SET name = 'changed'`,
    `DELETE FROM audit_logs`,
    `INSERT INTO customers (id, code, name, contact_email) VALUES (gen_random_uuid(), 'HACK', 'x', 'x@e2e.example')`,
    `TRUNCATE sessions`,
    `DROP TABLE orders`,
    `CREATE TABLE stray (id int)`,
  ];
  for (const sql of writes) {
    test(`even with read-only mode switched off, the role refuses: ${sql.split(" ").slice(0, 3).join(" ")}`, async () => {
      const db = await ReadOnlyDb.connect();
      try {
        await db.query(`SET default_transaction_read_only = off`);
        await expect(db.query(sql)).rejects.toThrow(/permission denied|must be owner/);
      } finally {
        await db.close();
      }
    });
  }

  test("the role cannot read the development database", async () => {
    const client = new Client({ connectionString: READONLY_DEV_DATABASE_URL });
    const query = async () => {
      await client.connect();
      return client.query(`SELECT count(*) FROM orders`);
    };
    // A CI machine has no development database at all, which is just as safe.
    await expect(query()).rejects.toThrow(/permission denied|does not exist/);
    await client.end();
  });

  test("the framework refuses any database not named for E2E", () => {
    const dev = "postgresql://testforge:testforge_local@127.0.0.1:55432/testforge";
    expect(() => assertE2eDatabase(dev)).toThrow(/must end in _e2e/);
    expect(() => assertE2eDatabase(`${dev}_test`)).toThrow(/must end in _e2e/);
    expect(() => assertE2eDatabase(`${dev}_e2e`)).not.toThrow();
  });
});
