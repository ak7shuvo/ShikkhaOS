import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Async, Button, Card, DataTable, ErrorBanner, Notice, SelectField, TextField, useAction, useQuery } from '../components/ui';
import { useI18n } from '../i18n';

interface Guardian {
  id: string;
  user_id: string | null;
  full_name: string;
  phone: string | null;
}
interface Student {
  id: string;
  student_code: string;
  full_name: string;
}
interface Link {
  id: string;
  status: string;
}

export function Guardians() {
  const { t } = useI18n();
  const g = useQuery(() => api.get<{ items: Guardian[] }>('/guardians'), []);
  const s = useQuery(() => api.get<{ items: Student[] }>('/students'), []);
  const [f, setF] = useState({ full_name: '', phone: '', email: '', password: '' });
  const [l, setL] = useState({ student_id: '', guardian_id: '', relationship: '' });
  const [link, setLink] = useState<Link | null>(null);
  const a = useAction();
  const b = useAction();
  const c = useAction();
  const add = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      await api.post('/guardians', {
        full_name: f.full_name,
        ...(f.phone ? { phone: f.phone } : {}),
        ...(f.email ? { account: { email: f.email, initial_password: f.password } } : {}),
      });
      setF({ full_name: '', phone: '', email: '', password: '' });
      g.reload();
    });
  };
  const create = (e: FormEvent) => {
    e.preventDefault();
    void b.run(async () => setLink(await api.post<Link>(`/students/${l.student_id}/guardians`, { guardian_id: l.guardian_id, relationship: l.relationship })));
  };
  const students = Array.from(new Map((s.data?.items ?? []).map((x) => [x.id, x])).values());
  return (
    <div>
      <h1>{t('nav.guardians')}</h1>
      <Card>
        <Async q={g}>
          {(d) => (
            <DataTable
              caption={t('nav.guardians')}
              rows={d.items}
              rowKey={(x) => x.id}
              columns={[
                { header: t('common.name'), cell: (x) => x.full_name },
                { header: t('common.phone'), cell: (x) => x.phone ?? '—' },
              ]}
            />
          )}
        </Async>
      </Card>
      <Card title={t('guardians.add')}>
        <form onSubmit={add} className="stack">
          <div className="grid">
            <TextField label={t('common.name')} required value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} />
            <TextField label={t('common.phone')} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
            <TextField
              label={`${t('guardians.createAccount')} — ${t('common.email')}`}
              type="email"
              value={f.email}
              onChange={(e) => setF({ ...f, email: e.target.value })}
            />
            <TextField
              label={t('members.initialPassword')}
              type="password"
              autoComplete="new-password"
              minLength={10}
              required={Boolean(f.email)}
              value={f.password}
              onChange={(e) => setF({ ...f, password: e.target.value })}
            />
          </div>
          <ErrorBanner error={a.error} />
          <Button type="submit" busy={a.busy}>
            {t('common.create')}
          </Button>
        </form>
      </Card>
      <Card title={t('guardians.link')}>
        <form onSubmit={create} className="stack">
          <div className="grid">
            <SelectField
              label={t('nav.students')}
              required
              value={l.student_id}
              onChange={(e) => setL({ ...l, student_id: e.target.value })}
              options={students.map((x) => ({ value: x.id, label: `${x.student_code} · ${x.full_name}` }))}
            />
            <SelectField
              label={t('nav.guardians')}
              required
              value={l.guardian_id}
              onChange={(e) => setL({ ...l, guardian_id: e.target.value })}
              options={(g.data?.items ?? []).map((x) => ({ value: x.id, label: x.full_name }))}
            />
            <TextField label={t('guardians.relationship')} required value={l.relationship} onChange={(e) => setL({ ...l, relationship: e.target.value })} />
          </div>
          <ErrorBanner error={b.error} />
          <Button type="submit" busy={b.busy}>
            {t('common.create')}
          </Button>
        </form>
        {link && (
          <div className="row" style={{ marginTop: '.75rem' }}>
            <span>{t(`status.${link.status}`)}</span>
            {link.status === 'pending' && (
              <Button small onClick={() => void c.run(async () => setLink(await api.post<Link>(`/student-guardians/${link.id}/verify`)))} busy={c.busy}>
                {t('guardians.verify')}
              </Button>
            )}
            {link.status !== 'revoked' && (
              <Button
                small
                variant="danger"
                onClick={() => void c.run(async () => setLink(await api.post<Link>(`/student-guardians/${link.id}/revoke`)))}
                busy={c.busy}
              >
                {t('guardians.revoke')}
              </Button>
            )}
            {c.done && <Notice>{t('common.saved')}</Notice>}
            <ErrorBanner error={c.error} />
          </div>
        )}
      </Card>
    </div>
  );
}
