import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, post, query, request, type Page, type Product, type ProductDetail } from "../api";
import { useAuth } from "../auth";
import { Field } from "../components/Field";
import { useFocusFirstInvalid } from "../focus";
import { Pagination, SortHeader, TableWrap } from "../components/Grid";
import { Modal } from "../components/Modal";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { useToast } from "../components/Toast";
import { money, parseCents } from "../format";
import { useAsync } from "../useAsync";

export function ProductsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [creating, setCreating] = useState(false);

  const q = params.get("q") ?? "";
  const category = params.get("category") ?? "";
  const inStock = params.get("in_stock") ?? "";
  const sort = params.get("sort") ?? "name";
  const direction = params.get("direction") ?? "asc";
  const page = Number(params.get("page") ?? 1);

  const qs = query({ q, category, in_stock: inStock, sort, direction, page, page_size: 12 });
  const products = useAsync((signal) => request<Page<Product>>(`/products${qs}`, { signal }), qs);
  const categories = useAsync((signal) => request<string[]>("/products/categories", { signal }), "categories");

  function update(changes: Record<string, string | number | null>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, String(value));
    }
    setParams(next);
  }

  function onSort(field: string) {
    const flip = sort === field && direction === "asc" ? "desc" : "asc";
    update({ sort: field, direction: sort === field ? flip : "asc", page: null });
  }

  function applySearch(event: FormEvent) {
    event.preventDefault();
    update({ q: search.trim(), page: null });
  }

  const sortProps = { sort, direction, onSort };

  return (
    <>
      <header className="page-header">
        <h1>Products</h1>
        {can("products:write") && (
          <button type="button" className="button button-primary" onClick={() => setCreating(true)}>
            New product
          </button>
        )}
      </header>

      <div className="filters panel" data-testid="product-filters">
        <form className="search-form" role="search" onSubmit={applySearch}>
          <Field label="Search name or SKU">
            <input type="search" value={search} maxLength={100} onChange={(e) => setSearch(e.target.value)} />
          </Field>
          <button type="submit" className="button">
            Search
          </button>
        </form>
        <Field label="Category">
          <select value={category} onChange={(e) => update({ category: e.target.value, page: null })}>
            <option value="">All categories</option>
            {categories.data?.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </Field>
        <Field label="Availability">
          <select value={inStock} onChange={(e) => update({ in_stock: e.target.value, page: null })}>
            <option value="">Any</option>
            <option value="true">In stock</option>
            <option value="false">Out of stock</option>
          </select>
        </Field>
      </div>

      <section className="panel panel-flush" aria-busy={products.loading}>
        {products.error && <ErrorState error={products.error} onRetry={products.reload} />}
        {products.loading && !products.data && <Loading label="Loading products" />}
        {products.data && !products.error && products.data.items.length === 0 && (
          <EmptyState title="No products found">Try a different search or filter.</EmptyState>
        )}
        {products.data && !products.error && products.data.items.length > 0 && (
          <>
            <TableWrap testId="products-grid" label="Products">
              <thead>
                <tr>
                  <SortHeader label="SKU" field="sku" {...sortProps} />
                  <SortHeader label="Name" field="name" {...sortProps} />
                  <SortHeader label="Category" field="category" {...sortProps} />
                  <SortHeader label="Unit price" field="unit_price_cents" align="right" {...sortProps} />
                  <th scope="col" className="num">
                    In stock
                  </th>
                </tr>
              </thead>
              <tbody>
                {products.data.items.map((product) => (
                  <tr key={product.id} data-testid="product-row">
                    <td>{product.sku}</td>
                    <td>
                      <Link to={`/products/${product.id}`}>{product.name}</Link>
                    </td>
                    <td>{product.category}</td>
                    <td className="num">{money(product.unit_price_cents)}</td>
                    <td className="num">{product.total_quantity}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pagination
              page={products.data.page}
              pages={products.data.pages}
              total={products.data.total}
              noun="product"
              onPage={(next) => update({ page: next })}
            />
          </>
        )}
      </section>

      {creating && (
        <NewProductModal
          onClose={() => setCreating(false)}
          onCreated={(product) => {
            toast("success", `Product ${product.sku} created`);
            navigate(`/products/${product.id}`);
          }}
        />
      )}
    </>
  );
}

function NewProductModal({ onClose, onCreated }: { onClose: () => void; onCreated: (p: ProductDetail) => void }) {
  const [form, setForm] = useState({ sku: "", name: "", category: "", price: "", description: "" });
  const { formRef, focusFirstInvalid } = useFocusFirstInvalid();
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm({ ...form, [key]: event.target.value });

  const cents = parseCents(form.price);
  const found = {
    sku: /^[A-Z0-9-]{3,32}$/.test(form.sku) ? undefined : "Use 3 to 32 capital letters, digits or hyphens",
    name: form.name.trim() ? undefined : "Enter a name",
    category: form.category.trim() ? undefined : "Enter a category",
    price: cents === null ? "Enter a price such as 19.99" : undefined,
  };
  const errors: Partial<typeof found> = submitted ? found : {};

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setSubmitted(true);
    setError(undefined);
    if (Object.values(found).some(Boolean) || cents === null) {
      focusFirstInvalid();
      return;
    }
    setBusy(true);
    try {
      const product = await post<ProductDetail>("/products", {
        sku: form.sku,
        name: form.name,
        category: form.category,
        description: form.description,
        unit_price_cents: cents,
      });
      onCreated(product);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "The product could not be created.");
      setBusy(false);
    }
  }

  return (
    <Modal title="New product" onClose={onClose} testId="new-product-modal">
      <form ref={formRef} onSubmit={submit} noValidate>
        <Field label="SKU" error={errors.sku}>
          <input value={form.sku} onChange={set("sku")} maxLength={32} />
        </Field>
        <Field label="Name" error={errors.name}>
          <input value={form.name} onChange={set("name")} maxLength={200} />
        </Field>
        <Field label="Category" error={errors.category}>
          <input value={form.category} onChange={set("category")} maxLength={80} />
        </Field>
        <Field label="Unit price (CAD)" error={errors.price}>
          <input inputMode="decimal" value={form.price} onChange={set("price")} />
        </Field>
        <Field label="Description">
          <textarea rows={2} maxLength={2000} value={form.description} onChange={set("description")} />
        </Field>
        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" aria-disabled={busy}>
            {busy ? "Creating…" : "Create product"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
