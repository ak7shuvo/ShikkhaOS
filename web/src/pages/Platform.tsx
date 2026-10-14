import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Async, Button, Card, DataTable, ErrorBanner, StatusBadge, TextField, useAction, useQuery } from '../components/ui';
import { useI18n } from '../i18n';

interface School {
  id: string;
  code: string;
  name: string;
  status: string;
  license_status: string | null;
  plan: string | null;
  ends_on: string | null;
}

export function PlatformSchools() {
  const { t } = useI18n();
  const q = useQuery(() => api.get<{ items: School[] }>('/platform/schools'), []);
  const [f, setF] = useState({ code: '', name: '', admin_email: '', admin_name: '', admin_password: '' });
  const a = useAction();
  const b = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      await api.post('/platform/schools', {
        code: f.code,
        name: f.name,
        admin: { email: f.admin_email, full_name: f.admin_name, initial_password: f.admin_password },
      });
      setF({ code: '', name: '', admin_email: '', admin_name: '', admin_password: '' });
      q.reload();
    });
  };
  const setStatus = (id: string, status: string) =>
    void b.run(async () => {
      await api.patch(`/platform/schools/${id}/status`, { status });
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
                { header: t('common.code'), cell: (s) => s.code },
                { header: t('common.name'), cell: (s) => s.name },
                { header: t('common.status'), cell: (s) => <StatusBadge status={s.status} /> },
                { header: t('platform.license'), cell: (s) => `${s.plan ?? '—'} · ${s.license_status ?? '—'}${s.ends_on ? ` · ${s.ends_on}` : ''}` },
                {
                  header: t('common.actions'),
                  cell: (s) =>
                    s.status === 'active' ? (
                      <Button small variant="danger" onClick={() => setStatus(s.id, 'suspended')}>
                        {t('platform.suspend')}
                      </Button>
                    ) : (
                      <Button small variant="secondary" onClick={() => setStatus(s.id, 'active')}>
                        {t('platform.activate')}
                      </Button>
                    ),
                },
              ]}
            />
          )}
        </Async>
        <ErrorBanner error={b.error} />
      </Card>
      <Card title={t('platform.createSchool')}>
        <form onSubmit={submit} className="stack">
          <div className="grid">
            <TextField
              label={t('common.code')}
              required
              pattern="[a-z0-9][a-z0-9-]{1,40}"
              hint="a-z 0-9 -"
              value={f.code}
              onChange={(e) => setF({ ...f, code: e.target.value })}
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
            <TextField
              label={t('members.initialPassword')}
              type="password"
              minLength={10}
              required
              autoComplete="new-password"
              value={f.admin_password}
              onChange={(e) => setF({ ...f, admin_password: e.target.value })}
            />
          </div>
          <ErrorBanner error={a.error} />
          <Button type="submit" busy={a.busy}>
            {t('common.create')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
