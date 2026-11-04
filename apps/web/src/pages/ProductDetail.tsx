import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, patch, request, type ProductDetail } from "../api";
import { useAuth } from "../auth";
import { Field } from "../components/Field";
import { focusMainIfLost, useFocusFirstInvalid } from "../focus";
import { TableWrap } from "../components/Grid";
import { Modal } from "../components/Modal";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { useToast } from "../components/Toast";
import { money, parseCents } from "../format";
import { useAsync } from "../useAsync";

export function ProductDetailPage() {
  const { productId = "" } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const product = useAsync((signal) => request<ProductDetail>(`/products/${productId}`, { signal }), productId);
  // Retiring a product removes the button that opened the dialog.
  useEffect(focusMainIfLost, [product.data?.is_active]);

  if (product.error) {
    if (product.error.status === 404 || product.error.status === 422) {
      return (
        <EmptyState pageTitle title="Product not found">
          <Link to="/products">Back to products</Link>
        </EmptyState>
      );
    }
    return <ErrorState error={product.error} onRetry={product.reload} />;
  }
  if (!product.data) return <Loading label="Loading product" />;
  const data = product.data;

  return (
    <>
      <header className="page-header">
        <div>
          <p className="crumb">
            <Link to="/products">Products</Link> / {data.sku}
          </p>
          <h1 data-testid="product-name">{data.name}</h1>
          <p className="muted">
            {data.sku} · {data.category}
            {!data.is_active && " · Retired"}
          </p>
        </div>
        <div className="actions">
          {can("products:write") && (
            <button type="button" className="button" onClick={() => setEditing(true)}>
              Edit product
            </button>
          )}
          {can("products:delete") && data.is_active && (
            <button type="button" className="button button-danger" onClick={() => setDeactivating(true)}>
              Retire product
            </button>
          )}
        </div>
      </header>
      <section className="stats" aria-label="Key figures">
        <div className="stat">
          <div className="stat-label">Unit price</div>
          <div className="stat-value" data-testid="product-price">
            {money(data.unit_price_cents)}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Total in stock</div>
          <div className="stat-value" data-testid="product-total-stock">
            {data.total_quantity}
          </div>
        </div>
      </section>
      {data.description && (
        <section className="panel">
          <h2>Description</h2>
          <p>{data.description}</p>
        </section>
      )}
      <section className="panel panel-flush" aria-labelledby="stock-heading">
        <h2 id="stock-heading" className="panel-title">
          Stock by warehouse
        </h2>
        <TableWrap testId="product-stock" label="Stock by warehouse">
          <thead>
            <tr>
              <th scope="col">Warehouse</th>
              <th scope="col" className="num">
                Quantity
              </th>
              <th scope="col" className="num">
                Reorder level
              </th>
            </tr>
          </thead>
          <tbody>
            {data.stock.map((row) => (
              <tr key={row.inventory_id}>
                <td>
                  {row.warehouse.code} · {row.warehouse.name}
                </td>
                <td className="num">{row.quantity}</td>
                <td className="num">{row.reorder_level}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </section>

      {editing && (
        <EditModal
          product={data}
          onClose={() => setEditing(false)}
          onSaved={() => {
            toast("success", "Product updated");
            setEditing(false);
            product.reload();
          }}
        />
      )}
      {deactivating && (
        <RetireModal
          productId={data.id}
          name={data.name}
          onClose={() => setDeactivating(false)}
          onDone={() => {
            toast("success", "Product retired");
            setDeactivating(false);
            product.reload();
          }}
        />
      )}
    </>
  );
}

function EditModal({ product, onClose, onSaved }: { product: ProductDetail; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(product.name);
  const [price, setPrice] = useState((product.unit_price_cents / 100).toFixed(2));
  const { formRef, focusFirstInvalid } = useFocusFirstInvalid();
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const cents = parseCents(price);
  const found = {
    name: name.trim() ? undefined : "Enter a name",
    price: cents === null ? "Enter a price such as 19.99" : undefined,
  };
  const errors: Partial<typeof found> = submitted ? found : {};

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setSubmitted(true);
    setError(undefined);
    if (found.name || cents === null) {
      focusFirstInvalid();
      return;
    }
    setBusy(true);
    try {
      await patch(`/products/${product.id}`, { name, unit_price_cents: cents });
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "The product could not be saved.");
      setBusy(false);
    }
  }

  return (
    <Modal title="Edit product" onClose={onClose} testId="edit-product-modal">
      <form ref={formRef} onSubmit={submit} noValidate>
        <Field label="Name" error={errors.name}>
          <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Unit price (CAD)" error={errors.price} hint="Existing orders keep the price they were placed at.">
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
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
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RetireModal({
  productId,
  name,
  onClose,
  onDone,
}: {
  productId: string;
  name: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    try {
      await request<void>(`/products/${productId}`, { method: "DELETE" });
      onDone();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "The product could not be retired.");
      setBusy(false);
    }
  }

  return (
    <Modal title="Retire product" onClose={onClose} testId="retire-product-modal">
      <p>{name} will no longer be available for new orders. Past orders are not affected.</p>
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>
          Keep product
        </button>
        <button type="button" className="button button-danger" aria-disabled={busy} onClick={confirm}>
          {busy ? "Retiring…" : "Retire product"}
        </button>
      </div>
    </Modal>
  );
}
