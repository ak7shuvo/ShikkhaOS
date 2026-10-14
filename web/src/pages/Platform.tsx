import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { Async, Button, Card, DataTable, ErrorBanner, Notice, SelectField, StatusBadge, TextField, useAction, useQuery, Spinner } from '../components/ui';
import { useI18n } from '../i18n';

interface Admin {
  admin: { id: string; email: string };
}
interface SchoolRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  db_mode: string;
  provisioning_step: string;
  provisioning_error: string | null;
  plan: string | null;
  period_end: string | null;
  access_level: string;
  subscription_status: string;
}
interface SubView {
  subscription: {
    status: string;
    period_start: string;
    period_end: string;
    grace_days: number;
    readonly_days: number;
    retention_days: number;
    legal_hold: boolean;
    entitlement: { level: string; status: string; full_access_until: string; read_only_until: string; retention_until: string };
  };
  payments: { reference: string; plan_code: string; amount_minor: number; currency: string; received_on: string; period_start: string; period_end: string }[];
}

/** Petra staff console. Separate sign-in and cookie from school users; never shares a session with a school. */
export function PlatformApp() {
  const { t, lang, setLang } = useI18n();
  const me = useQuery<Admin | null>(
    () => api.get<Admin>('/platform/auth/me').catch((e) => (e instanceof ApiError && e.status === 401 ? null : Promise.reject(e))),
    [],
  );
  if (me.loading) return <Spinner />;
  return (
    <div className="main">
      <div className="toolbar">
        <strong style={{ marginRight: 'auto' }}>{t('platform.console')}</strong>
        <select aria-label={t('common.language')} value={lang} onChange={(e) => setLang(e.target.value as 'en' | 'bn')} style={{ width: 'auto' }}>
          <option value="bn">বাংলা</option>
          <option value="en">English</option>
        </select>
        {me.data && (
          <Button
            small
            variant="secondary"
            onClick={() =>
              void api
                .post('/platform/auth/logout')
                .catch(() => undefined)
                .then(me.reload)
            }
          >
            {t('common.logout')}
          </Button>
        )}
      </div>
      {me.data ? <Schools /> : <PlatformLogin onDone={me.reload} />}
    </div>
  );
}

function PlatformLogin({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ email: '', password: '' });
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      await api.post('/platform/auth/login', f);
      onDone();
    });
  };
  return (
    <form className="card stack login" onSubmit={submit}>
      <h1>{t('platform.console')}</h1>
      <TextField
        label={t('common.email')}
        type="email"
        autoComplete="username"
        required
        value={f.email}
        onChange={(e) => setF({ ...f, email: e.target.value })}
      />
      <TextField
        label={t('common.password')}
        type="password"
        autoComplete="current-password"
        required
        value={f.password}
        onChange={(e) => setF({ ...f, password: e.target.value })}
      />
      {a.error ? <div className="banner banner-error">{t('login.invalid')}</div> : null}
      <Button type="submit" busy={a.busy}>
        {t('login.submit')}
      </Button>
    </form>
  );
}

function Schools() {
  const { t } = useI18n();
  const q = useQuery(() => api.get<{ items: SchoolRow[] }>('/platform/schools'), []);
  const [sel, setSel] = useState<SchoolRow | null>(null);
  const [f, setF] = useState({ slug: '', name: '', admin_email: '', admin_name: '', plan: 'monthly' });
  const a = useAction();
  const b = useAction();
  const [hint, setHint] = useState('');
  const register = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      const r = await api.post<{ next_step: string }>('/platform/schools', f);
      setHint(r.next_step);
      setF({ slug: '', name: '', admin_email: '', admin_name: '', plan: 'monthly' });
      q.reload();
    });
  };
  const toggle = (s: SchoolRow) =>
    void b.run(async () => {
      await api.patch(`/platform/schools/${s.id}/status`, { status: s.status === 'active' ? 'suspended' : 'active' });
      q.reload();
    });
  return (
    <div>
      <h1>{t('nav.platformSchools')}</h1>
      <Card>
        <Async q={q}>
          {(d) => (
            <DataTable
              caption={t('nav.platformSchools')}
              rows={d.items}
              rowKey={(s) => s.id}
              columns={[
                { header: t('common.code'), cell: (s) => s.slug },
                { header: t('common.name'), cell: (s) => s.name },
                { header: t('common.status'), cell: (s) => <StatusBadge status={s.status} /> },
                { header: t('platform.provisioning'), cell: (s) => `${s.db_mode} · ${s.provisioning_step}${s.provisioning_error ? ' ⚠' : ''}` },
                {
                  header: t('platform.license'),
                  cell: (s) => `${s.plan ?? '—'} · ${s.subscription_status} · ${s.access_level}${s.period_end ? ` · ${s.period_end}` : ''}`,
                },
                {
                  header: t('common.actions'),
                  cell: (s) => (
                    <div className="row">
                      <Button small variant="secondary" onClick={() => setSel(s)}>
                        {t('platform.manage')}
                      </Button>
                      {['active', 'suspended'].includes(s.status) && (
                        <Button small variant={s.status === 'active' ? 'danger' : 'secondary'} onClick={() => toggle(s)}>
                          {s.status === 'active' ? t('platform.suspend') : t('platform.activate')}
                        </Button>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          )}
        </Async>
        <ErrorBanner error={b.error} />
      </Card>
      {sel && <Subscription school={sel} onChanged={q.reload} />}
      <Card title={t('platform.createSchool')}>
        <form onSubmit={register} className="stack">
          <div className="grid">
            <TextField
              label={t('common.code')}
              required
              pattern="[a-z0-9][a-z0-9-]{1,40}"
              hint="a-z 0-9 -"
              value={f.slug}
              onChange={(e) => setF({ ...f, slug: e.target.value })}
            />
            <TextField label={t('common.name')} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <TextField label={t('platform.adminName')} required value={f.admin_name} onChange={(e) => setF({ ...f, admin_name: e.target.value })} />
            <TextField
              label={t('platform.adminEmail')}
              type="email"
              required
              value={f.admin_email}
              onChange={(e) => setF({ ...f, admin_email: e.target.value })}
            />
            <SelectField
              label={t('platform.plan')}
              value={f.plan}
              onChange={(e) => setF({ ...f, plan: e.target.value })}
              options={[
                { value: 'monthly', label: t('plan.monthly') },
                { value: 'annual', label: t('plan.annual') },
              ]}
            />
          </div>
          <ErrorBanner error={a.error} />
          {hint && <Notice>{hint}</Notice>}
          <Button type="submit" busy={a.busy}>
            {t('common.create')}
          </Button>
        </form>
      </Card>
    </div>
  );
}

function Subscription({ school, onChanged }: { school: SchoolRow; onChanged: () => void }) {
  const { t } = useI18n();
  const q = useQuery(() => api.get<SubView>(`/platform/schools/${school.id}/subscription`), [school.id]);
  const [p, setP] = useState({
    plan: 'monthly',
    amount_minor: '',
    currency: 'BDT',
    method: 'bank_transfer',
    reference: '',
    received_on: new Date().toISOString().slice(0, 10),
  });
  const a = useAction();
  const b = useAction();
  const [reason, setReason] = useState('');
  const pay = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      await api.post(`/platform/schools/${school.id}/subscription/payments`, { ...p, amount_minor: Math.round(Number(p.amount_minor) * 100) });
      q.reload();
      onChanged();
    });
  };
  const act = (path: string) =>
    void b.run(async () => {
      await api.post(`/platform/schools/${school.id}/subscription/${path}`, path === 'cancel' ? {} : { reason });
      setReason('');
      q.reload();
      onChanged();
    });
  return (
    <Card title={`${t('platform.license')} — ${school.name}`}>
      <Async q={q}>
        {(d) => (
          <>
            <p>
              <StatusBadge status={d.subscription.entitlement.status} /> {d.subscription.period_start} → <strong>{d.subscription.period_end}</strong> ·{' '}
              {t('platform.fullUntil')} {d.subscription.entitlement.full_access_until} · {t('platform.readOnlyUntil')}{' '}
              {d.subscription.entitlement.read_only_until} · {t('platform.retentionUntil')} {d.subscription.entitlement.retention_until}
              {d.subscription.legal_hold ? ` · ${t('platform.legalHold')}` : ''}
            </p>
            <DataTable
              caption={t('platform.payments')}
              rows={d.payments}
              empty={t('platform.noPayments')}
              rowKey={(x) => x.reference}
              columns={[
                { header: t('platform.reference'), cell: (x) => x.reference },
                { header: t('platform.plan'), cell: (x) => t(`plan.${x.plan_code}`) },
                { header: t('platform.amount'), cell: (x) => `${(x.amount_minor / 100).toFixed(2)} ${x.currency}` },
                { header: t('platform.period'), cell: (x) => `${x.period_start} → ${x.period_end}` },
              ]}
            />
          </>
        )}
      </Async>
      <form onSubmit={pay} className="stack">
        <h3>{t('platform.recordPayment')}</h3>
        <p className="muted">{t('platform.manualNote')}</p>
        <div className="grid">
          <SelectField
            label={t('platform.plan')}
            value={p.plan}
            onChange={(e) => setP({ ...p, plan: e.target.value })}
            options={[
              { value: 'monthly', label: t('plan.monthly') },
              { value: 'annual', label: t('plan.annual') },
            ]}
          />
          <TextField
            label={t('platform.amount')}
            type="number"
            min={0}
            step="0.01"
            required
            value={p.amount_minor}
            onChange={(e) => setP({ ...p, amount_minor: e.target.value })}
          />
          <TextField label="Currency" required pattern="[A-Z]{3}" value={p.currency} onChange={(e) => setP({ ...p, currency: e.target.value.toUpperCase() })} />
          <TextField label={t('platform.reference')} required value={p.reference} onChange={(e) => setP({ ...p, reference: e.target.value })} />
          <TextField
            label={t('platform.receivedOn')}
            type="date"
            required
            value={p.received_on}
            onChange={(e) => setP({ ...p, received_on: e.target.value })}
          />
        </div>
        <ErrorBanner error={a.error} />
        <Button type="submit" busy={a.busy}>
          {t('platform.recordPayment')}
        </Button>
      </form>
      <div className="stack">
        <TextField label={t('common.reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="row">
          <Button variant="danger" small disabled={reason.trim().length < 3} onClick={() => act('suspend')}>
            {t('platform.suspendSub')}
          </Button>
          <Button variant="secondary" small disabled={reason.trim().length < 3} onClick={() => act('reinstate')}>
            {t('platform.reinstate')}
          </Button>
          <Button variant="secondary" small onClick={() => act('cancel')}>
            {t('platform.cancelSub')}
          </Button>
        </div>
        <ErrorBanner error={b.error} />
      </div>
    </Card>
  );
}
