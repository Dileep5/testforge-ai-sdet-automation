import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, patch, query, request, type InventoryRow, type Page, type Warehouse } from "../api";
import { useAuth } from "../auth";
import { Field } from "../components/Field";
import { Pagination, SortHeader, TableWrap } from "../components/Grid";
import { Modal } from "../components/Modal";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { useToast } from "../components/Toast";
import { useAsync } from "../useAsync";

export function InventoryPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [editing, setEditing] = useState<InventoryRow>();

  const q = params.get("q") ?? "";
  const warehouseId = params.get("warehouse_id") ?? "";
  const lowStock = params.get("low_stock") === "true";
  const sort = params.get("sort") ?? "sku";
  const direction = params.get("direction") ?? "asc";
  const page = Number(params.get("page") ?? 1);

  const qs = query({ q, warehouse_id: warehouseId, low_stock: lowStock || null, sort, direction, page, page_size: 15 });
  const rows = useAsync((signal) => request<Page<InventoryRow>>(`/inventory${qs}`, { signal }), qs);
  const warehouses = useAsync((signal) => request<Warehouse[]>("/warehouses", { signal }), "warehouses");
  const canEdit = can("inventory:write");

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

  const sortProps = { sort, direction, onSort };

  return (
    <>
      <header className="page-header">
        <h1>Inventory</h1>
      </header>
      <div className="filters panel" data-testid="inventory-filters">
        <form
          className="search-form"
          role="search"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            update({ q: search.trim(), page: null });
          }}
        >
          <Field label="Search name or SKU">
            <input type="search" value={search} maxLength={100} onChange={(e) => setSearch(e.target.value)} />
          </Field>
          <button type="submit" className="button">
            Search
          </button>
        </form>
        <Field label="Warehouse">
          <select value={warehouseId} onChange={(e) => update({ warehouse_id: e.target.value, page: null })}>
            <option value="">All warehouses</option>
            {warehouses.data?.map((warehouse) => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.code} · {warehouse.city}
              </option>
            ))}
          </select>
        </Field>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={lowStock}
            onChange={(e) => update({ low_stock: e.target.checked ? "true" : null, page: null })}
          />
          Low stock only
        </label>
      </div>

      <section className="panel panel-flush" aria-busy={rows.loading}>
        {rows.error && <ErrorState error={rows.error} onRetry={rows.reload} />}
        {rows.loading && !rows.data && <Loading label="Loading inventory" />}
        {rows.data && !rows.error && rows.data.items.length === 0 && (
          <EmptyState title="No inventory records found">Try a different search or filter.</EmptyState>
        )}
        {rows.data && !rows.error && rows.data.items.length > 0 && (
          <>
            <TableWrap testId="inventory-grid" label="Inventory">
              <thead>
                <tr>
                  <SortHeader label="SKU" field="sku" {...sortProps} />
                  <SortHeader label="Product" field="name" {...sortProps} />
                  <th scope="col">Warehouse</th>
                  <SortHeader label="Quantity" field="quantity" align="right" {...sortProps} />
                  <th scope="col">Level</th>
                  {canEdit && <th scope="col">Action</th>}
                </tr>
              </thead>
              <tbody>
                {rows.data.items.map((row) => (
                  <tr key={row.id} data-testid="inventory-row">
                    <td>{row.product.sku}</td>
                    <td>
                      <Link to={`/products/${row.product.id}`}>{row.product.name}</Link>
                    </td>
                    <td>{row.warehouse.code}</td>
                    <td className="num" data-testid="inventory-quantity">
                      {row.quantity}
                    </td>
                    <td>
                      {row.quantity === 0 ? (
                        <span className="badge badge-red">Out of stock</span>
                      ) : row.quantity <= row.reorder_level ? (
                        <span className="badge badge-amber">Low</span>
                      ) : (
                        <span className="badge badge-green">OK</span>
                      )}
                    </td>
                    {canEdit && (
                      <td>
                        <button
                          type="button"
                          className="button button-small"
                          aria-label={`Adjust ${row.product.sku} at ${row.warehouse.code}`}
                          onClick={() => setEditing(row)}
                        >
                          Adjust
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pagination
              page={rows.data.page}
              pages={rows.data.pages}
              total={rows.data.total}
              noun="record"
              onPage={(next) => update({ page: next })}
            />
          </>
        )}
      </section>

      {editing && (
        <AdjustModal
          row={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(saved) => {
            toast("success", `${saved.product.sku} at ${saved.warehouse.code} is now ${saved.quantity}`);
            setEditing(undefined);
            rows.reload();
          }}
          onConflict={rows.reload}
        />
      )}
    </>
  );
}

function AdjustModal({
  row,
  onClose,
  onSaved,
  onConflict,
}: {
  row: InventoryRow;
  onClose: () => void;
  onSaved: (saved: InventoryRow) => void;
  onConflict: () => void;
}) {
  const [quantity, setQuantity] = useState(String(row.quantity));
  const [reason, setReason] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const value = Number(quantity);
  const found = {
    quantity:
      quantity.trim() === "" || !Number.isInteger(value) || value < 0
        ? "Enter a whole number, zero or more"
        : undefined,
    reason: reason.trim().length < 3 ? "Enter a reason of at least 3 characters" : undefined,
  };
  const errors: Partial<typeof found> = submitted ? found : {};

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setError(undefined);
    if (found.quantity || found.reason) return;
    setBusy(true);
    try {
      const saved = await patch<InventoryRow>(`/inventory/${row.id}`, {
        quantity: value,
        expected_version: row.version,
        reason: reason.trim(),
      });
      onSaved(saved);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "VERSION_CONFLICT") onConflict();
      setError(cause instanceof ApiError ? cause.message : "The inventory could not be updated.");
      setBusy(false);
    }
  }

  return (
    <Modal title={`Adjust ${row.product.sku} at ${row.warehouse.code}`} onClose={onClose} testId="adjust-inventory-modal">
      <form onSubmit={submit} noValidate>
        <p className="muted">{row.product.name}</p>
        <Field label="New quantity" error={errors.quantity}>
          <input type="number" min={0} step={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        <Field label="Reason" error={errors.reason} hint="Saved in the audit log.">
          <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {error && (
          <div className="alert alert-error" role="alert" data-testid="adjust-error">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? "Saving…" : "Save quantity"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
