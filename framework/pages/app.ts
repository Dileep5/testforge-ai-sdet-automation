import type { Page } from "@playwright/test";
import { NavigationComponent } from "../components/navigation";
import { AuditLogPage, UsersPage } from "./admin-pages";
import { DashboardPage } from "./dashboard-page";
import { InventoryPage } from "./inventory-page";
import { LoginPage } from "./login-page";
import { NewOrderPage } from "./new-order-page";
import { OrderDetailsPage } from "./order-details-page";
import { OrdersPage } from "./orders-page";
import { ProductDetailsPage, ProductsPage } from "./products-page";
import { SupportPage } from "./support-page";

/** Every page object for one browser page, so tests never construct them by hand. */
export class App {
  readonly nav: NavigationComponent;
  readonly login: LoginPage;
  readonly dashboard: DashboardPage;
  readonly orders: OrdersPage;
  readonly newOrder: NewOrderPage;
  readonly orderDetails: OrderDetailsPage;
  readonly products: ProductsPage;
  readonly productDetails: ProductDetailsPage;
  readonly inventory: InventoryPage;
  readonly users: UsersPage;
  readonly audit: AuditLogPage;
  readonly support: SupportPage;

  constructor(readonly page: Page) {
    this.nav = new NavigationComponent(page);
    this.login = new LoginPage(page);
    this.dashboard = new DashboardPage(page);
    this.orders = new OrdersPage(page);
    this.newOrder = new NewOrderPage(page);
    this.orderDetails = new OrderDetailsPage(page);
    this.products = new ProductsPage(page);
    this.productDetails = new ProductDetailsPage(page);
    this.inventory = new InventoryPage(page);
    this.users = new UsersPage(page);
    this.audit = new AuditLogPage(page);
    this.support = new SupportPage(page);
  }
}
