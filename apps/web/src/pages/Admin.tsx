import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { ApiError, patch, post, query, request, type AuditEntry, type Page, type Role, type UserRow } from "../api";
import { useAuth } from "../auth";
import { Field } from "../components/Field";
import { useFocusFirstInvalid } from "../focus";
import { Pagination, TableWrap } from "../components/Grid";
import { Modal } from "../components/Modal";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { useToast } from "../components/Toast";
import { dateTime, titleCase } from "../format";
import { useAsync } from "../useAsync";

const ROLES: Role[] = ["ADMIN", "MANAGER", "VIEWER"];

export function UsersPage() {
  const { user: me } = useAuth();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const users = useAsync((signal) => request<UserRow[]>("/users", { signal }), "users");

  async function change(user: UserRow, changes: { role?: Role; is_active?: boolean }) {
    try {
      await patch(`/users/${user.id}`, changes);
      toast("success", `${user.full_name} updated. Their active sessions were ended.`);
    } catch (cause) {
      toast("error", cause instanceof ApiError ? cause.message : "The user could not be updated.");
    }
    users.reload();
  }

  return (
    <>
      <header className="page-header">
        <h1>Users</h1>
        <button type="button" className="button button-primary" onClick={() => setCreating(true)}>
          New user
        </button>
      </header>
      <section className="panel panel-flush" aria-busy={users.loading}>
        {users.error && <ErrorState error={users.error} onRetry={users.reload} />}
        {users.loading && !users.data && <Loading label="Loading users" />}
        {users.data && (
          <TableWrap testId="users-grid" label="Users">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Customer</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {users.data.map((user) => {
                const self = user.id === me?.id;
                return (
                  <tr key={user.id} data-testid="user-row">
                    <td>{user.full_name}</td>
                    <td>{user.email}</td>
                    <td>{user.customer?.name ?? <span className="muted">Internal</span>}</td>
                    <td>
                      <select
                        aria-label={`Role for ${user.full_name}`}
                        value={user.role}
                        disabled={self || user.customer !== null}
                        onChange={(e) => change(user, { role: e.target.value as Role })}
                      >
                        {ROLES.map((role) => (
                          <option key={role} value={role}>
                            {titleCase(role)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <span className={`badge ${user.is_active ? "badge-green" : "badge-grey"}`}>
                        {user.is_active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="button button-small"
                        disabled={self}
                        onClick={() => change(user, { is_active: !user.is_active })}
                      >
                        {user.is_active ? "Deactivate" : "Reactivate"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}
      </section>
      {creating && (
        <NewUserModal
          onClose={() => setCreating(false)}
          onCreated={(user) => {
            toast("success", `User ${user.email} created`);
            setCreating(false);
            users.reload();
          }}
        />
      )}
    </>
  );
}

function NewUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: (user: UserRow) => void }) {
  const [form, setForm] = useState({ email: "", full_name: "", password: "", role: "VIEWER" });
  const { formRef, focusFirstInvalid } = useFocusFirstInvalid();
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm({ ...form, [key]: event.target.value });

  const found = {
    email: /^\S+@\S+\.\S+$/.test(form.email) ? undefined : "Enter a valid email address",
    full_name: form.full_name.trim() ? undefined : "Enter a name",
    password: form.password.length >= 12 ? undefined : "Use at least 12 characters",
  };
  const errors: Partial<typeof found> = submitted ? found : {};

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setSubmitted(true);
    setError(undefined);
    if (Object.values(found).some(Boolean)) {
      focusFirstInvalid();
      return;
    }
    setBusy(true);
    try {
      onCreated(await post<UserRow>("/users", form));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "The user could not be created.");
      setBusy(false);
    }
  }

  return (
    <Modal title="New user" onClose={onClose} testId="new-user-modal">
      <form ref={formRef} onSubmit={submit} noValidate>
        <Field label="Email" error={errors.email}>
          <input type="email" autoComplete="off" value={form.email} onChange={set("email")} />
        </Field>
        <Field label="Full name" error={errors.full_name}>
          <input value={form.full_name} maxLength={200} onChange={set("full_name")} />
        </Field>
        <Field label="Password" error={errors.password}>
          <input type="password" autoComplete="new-password" value={form.password} onChange={set("password")} />
        </Field>
        <Field label="Role">
          <select value={form.role} onChange={set("role")}>
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {titleCase(role)}
              </option>
            ))}
          </select>
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
            {busy ? "Creating…" : "Create user"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function AuditPage() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") ?? 1);
  const qs = query({ page, page_size: 20 });
  const entries = useAsync((signal) => request<Page<AuditEntry>>(`/audit-logs${qs}`, { signal }), qs);

  return (
    <>
      <header className="page-header">
        <h1>Audit log</h1>
      </header>
      <section className="panel panel-flush" aria-busy={entries.loading}>
        {entries.error && <ErrorState error={entries.error} onRetry={entries.reload} />}
        {entries.loading && !entries.data && <Loading label="Loading audit log" />}
        {entries.data && entries.data.items.length === 0 && <EmptyState title="No audit entries yet" />}
        {entries.data && entries.data.items.length > 0 && (
          <>
            <TableWrap testId="audit-grid" label="Audit log">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">Action</th>
                  <th scope="col">Entity</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {entries.data.items.map((entry) => (
                  <tr key={entry.id}>
                    <td>{dateTime(entry.created_at)}</td>
                    <td>{entry.actor_email ?? <span className="muted">Unknown</span>}</td>
                    <td>{entry.action}</td>
                    <td>{entry.entity_type}</td>
                    <td className="details-cell">{JSON.stringify(entry.details)}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
            <Pagination
              page={entries.data.page}
              pages={entries.data.pages}
              total={entries.data.total}
              noun="entry"
              onPage={(next) => setParams({ page: String(next) })}
            />
          </>
        )}
      </section>
    </>
  );
}
