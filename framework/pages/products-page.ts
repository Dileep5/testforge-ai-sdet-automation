import { expect, type Locator } from "@playwright/test";
import { GridComponent } from "../components/grid";
import { ModalComponent } from "../components/modal";
import { whileWaitingFor } from "../helpers/network";
import { BasePage } from "./base-page";

export class ProductsPage extends BasePage {
  readonly grid = new GridComponent(this.page, "products-grid", "product-row", "/products");
  readonly newProductModal = new ModalComponent(this.page, "new-product-modal");

  get newProductButton(): Locator {
    return this.page.getByRole("button", { name: "New product" });
  }
  get emptyState(): Locator {
    return this.page.getByTestId("empty-state");
  }

  async goto(): Promise<void> {
    await whileWaitingFor(this.page, { method: "GET", path: "/products" }, async () => {
      await this.page.goto("/products");
    });
  }

  async search(text: string): Promise<void> {
    await this.page.getByLabel("Search name or SKU").fill(text);
    await whileWaitingFor(this.page, { method: "GET", path: "/products", params: { q: text } }, () =>
      this.page.getByRole("button", { name: "Search", exact: true }).click(),
    );
  }

  async filterCategory(category: string): Promise<void> {
    await whileWaitingFor(this.page, { method: "GET", path: "/products", params: { category } }, () =>
      this.page.getByLabel("Category").selectOption(category).then(() => undefined),
    );
  }

  async filterAvailability(label: "In stock" | "Out of stock"): Promise<void> {
    const value = label === "In stock" ? "true" : "false";
    await whileWaitingFor(this.page, { method: "GET", path: "/products", params: { in_stock: value } }, () =>
      this.page.getByLabel("Availability").selectOption({ label }).then(() => undefined),
    );
  }

  async fillNewProduct(fields: { sku: string; name: string; category: string; price: string }): Promise<void> {
    await this.newProductButton.click();
    await this.newProductModal.field("SKU").fill(fields.sku);
    await this.newProductModal.field("Name").fill(fields.name);
    await this.newProductModal.field("Category").fill(fields.category);
    await this.newProductModal.field("Unit price (CAD)").fill(fields.price);
  }

  async submitNewProduct(): Promise<void> {
    await whileWaitingFor(this.page, { method: "POST", path: "/products" }, () =>
      this.newProductModal.button("Create product").click(),
    );
  }
}

export class ProductDetailsPage extends BasePage {
  readonly editModal = new ModalComponent(this.page, "edit-product-modal");
  readonly retireModal = new ModalComponent(this.page, "retire-product-modal");

  get name(): Locator {
    return this.page.getByTestId("product-name");
  }
  get price(): Locator {
    return this.page.getByTestId("product-price");
  }
  get totalStock(): Locator {
    return this.page.getByTestId("product-total-stock");
  }
  get stockRows(): Locator {
    return this.page.getByTestId("product-stock").locator("tbody tr");
  }
  get editButton(): Locator {
    return this.page.getByRole("button", { name: "Edit product" });
  }
  get retireButton(): Locator {
    return this.page.getByRole("button", { name: "Retire product" });
  }

  async goto(productId: string): Promise<void> {
    await this.page.goto(`/products/${productId}`);
    await expect(this.name).toBeVisible();
  }

  async changePrice(price: string): Promise<void> {
    await this.editButton.click();
    await this.editModal.field("Unit price (CAD)").fill(price);
    await whileWaitingFor(this.page, { method: "PATCH", path: /^\/products\/[^/]+$/ }, () =>
      this.editModal.button("Save changes").click(),
    );
  }

  async retire(): Promise<void> {
    await this.retireButton.click();
    await whileWaitingFor(this.page, { method: "DELETE", path: /^\/products\/[^/]+$/ }, () =>
      this.retireModal.button("Retire product").click(),
    );
  }
}
