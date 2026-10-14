import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { ApiError } from '../api';
import { useI18n } from '../i18n';

export function Spinner() {
  const { t } = useI18n();
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" /> {t('common.loading')}
    </div>
  );
}

export function useErrorMessage() {
  const { t } = useI18n();
  return (e: unknown): string => {
    if (e instanceof ApiError) {
      const key = `error.${e.code}`;
      const msg = t(key);
      return msg === key ? e.message : msg;
    }
    return t('common.error');
  };
}

export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  if (!error) return null;
  return (
    <div className="banner banner-error" role="alert">
      <span>{msg(error)}</span>
      {onRetry && (
        <button type="button" className="btn btn-small" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="banner banner-ok" role="status">
      {children}
    </div>
  );
}

export function EmptyState({ children }: { children?: ReactNode }) {
  const { t } = useI18n();
  return <div className="empty">{children ?? t('common.empty')}</div>;
}

export function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const key = `status.${status}`;
  const label = t(key);
  return <span className={`badge badge-${status}`}>{label === key ? status : label}</span>;
}

export function Button({
  busy,
  variant = 'primary',
  small,
  ...p
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; variant?: 'primary' | 'secondary' | 'danger'; small?: boolean }) {
  return (
    <button
      type="button"
      {...p}
      disabled={p.disabled || busy}
      aria-busy={busy}
      className={`btn btn-${variant}${small ? ' btn-small' : ''} ${p.className ?? ''}`}
    />
  );
}

export function Field({ label, children, hint }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <small>{hint}</small>}
    </div>
  );
}

export function TextField({ label, hint, ...p }: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      {(id) => <input id={id} {...p} />}
    </Field>
  );
}

export function SelectField({
  label,
  options,
  placeholder,
  ...p
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string; options: { value: string; label: string }[]; placeholder?: string }) {
  const { t } = useI18n();
  return (
    <Field label={label}>
      {(id) => (
        <select id={id} {...p}>
          <option value="">{placeholder ?? t('common.select')}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
}

/** Responsive table: scrolls horizontally on narrow screens, with a caption for assistive tech. */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  empty,
}: {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (r: T) => string;
  empty?: ReactNode;
}) {
  if (rows.length === 0) return <EmptyState>{empty}</EmptyState>;
  return (
    <div className="table-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.header} scope="col">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)}>
              {columns.map((c) => (
                <td key={c.header} data-label={c.header}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function useQuery<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const run = useCallback(() => {
    setLoading(true);
    setError(null);
    loader()
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  }, deps);
  useEffect(run, [run]);
  return { data, error, loading, reload: run };
}

/** Wraps a query result with the standard loading / error states. */
export function Async<T>({ q, children }: { q: { data: T | null; error: unknown; loading: boolean; reload: () => void }; children: (d: T) => ReactNode }) {
  if (q.loading && !q.data) return <Spinner />;
  if (q.error) return <ErrorBanner error={q.error} onRetry={q.reload} />;
  if (!q.data) return null;
  return <>{children(q.data)}</>;
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await fn();
      setDone(true);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, done, run };
}
