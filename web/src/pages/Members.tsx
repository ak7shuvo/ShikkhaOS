import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Async, Button, Card, DataTable, ErrorBanner, SelectField, StatusBadge, TextField, useAction, useQuery } from '../components/ui';
import { useI18n } from '../i18n';

interface Member {
  id: string;
  role: string;
  status: string;
  email: string;
  full_name: string;
}
const ROLES = ['school_admin', 'principal', 'exam_controller', 'teacher', 'guardian'];

export function Members() {
  const { t } = useI18n();
  const q = useQuery(() => api.get<{ items: Member[] }>('/school/members'), []);
  const [f, setF] = useState({ full_name: '', email: '', initial_password: '', role: '' });
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      await api.post('/school/members', f);
      setF({ full_name: '', email: '', initial_password: '', role: '' });
      q.reload();
    });
  };
  const setStatus = (id: string, status: string) =>
    void a.run(async () => {
      await api.patch(`/school/members/${id}`, { status });
      q.reload();
    });
  return (
    <div>
      <h1>{t('nav.members')}</h1>
      <Card>
        <Async q={q}>
          {(d) => (
            <DataTable
              caption={t('nav.members')}
              rows={d.items}
              rowKey={(m) => m.id}
              columns={[
                { header: t('common.name'), cell: (m) => m.full_name },
                { header: t('common.email'), cell: (m) => m.email },
                { header: t('common.role'), cell: (m) => t(`role.${m.role}`) },
                { header: t('common.status'), cell: (m) => <StatusBadge status={m.status} /> },
                {
                  header: t('common.actions'),
                  cell: (m) =>
                    m.status === 'active' ? (
                      <Button small variant="danger" onClick={() => setStatus(m.id, 'suspended')}>
                        {t('status.suspended')}
                      </Button>
                    ) : (
                      <Button small variant="secondary" onClick={() => setStatus(m.id, 'active')}>
                        {t('status.active')}
                      </Button>
                    ),
                },
              ]}
            />
          )}
        </Async>
      </Card>
      <Card title={t('members.add')}>
        <form onSubmit={submit} className="stack">
          <div className="grid">
            <TextField label={t('members.fullName')} required value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} />
            <TextField label={t('common.email')} type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            <TextField
              label={t('members.initialPassword')}
              type="password"
              minLength={10}
              required
              autoComplete="new-password"
              value={f.initial_password}
              onChange={(e) => setF({ ...f, initial_password: e.target.value })}
            />
            <SelectField
              label={t('common.role')}
              required
              value={f.role}
              onChange={(e) => setF({ ...f, role: e.target.value })}
              options={ROLES.map((r) => ({ value: r, label: t(`role.${r}`) }))}
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
