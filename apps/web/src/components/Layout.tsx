import { useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { titleCase } from "../format";
import { useToast } from "./Toast";

const LINKS = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/orders", label: "Orders" },
  { to: "/products", label: "Products" },
  { to: "/inventory", label: "Inventory" },
  { to: "/support", label: "Support" },
  { to: "/admin/users", label: "Users", permission: "users:manage" },
  { to: "/admin/audit", label: "Audit log", permission: "audit:read" },
];

export function Layout() {
  const { user, logout, can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const { pathname } = useLocation();
  const main = useRef<HTMLElement>(null);

  // Client-side navigation does not reset focus, so move it for keyboard and screen reader users.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    main.current?.focus();
  }, [pathname]);

  async function handleLogout() {
    try {
      await logout();
      navigate("/login");
    } catch {
      toast("error", "Could not sign out on the server. Please try again.");
    }
  }

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            T
          </span>
          TestForge
        </div>
        <nav aria-label="Main" data-testid="main-nav">
          {LINKS.filter((link) => !link.permission || can(link.permission)).map((link) => (
            <NavLink key={link.to} to={link.to} end={link.end} className="nav-link">
              {link.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-user">
          <div className="user-name" data-testid="current-user">
            {user?.full_name}
          </div>
          <div className="user-role" data-testid="current-role">
            {user && titleCase(user.role)}
            {user?.customer && ` · ${user.customer.name}`}
          </div>
          <button type="button" className="button button-small button-sidebar" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </aside>
      <main id="main" ref={main} tabIndex={-1} className="content">
        <Outlet />
      </main>
    </div>
  );
}
