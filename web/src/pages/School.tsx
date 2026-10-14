import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { Async, Button, Card, DataTable, ErrorBanner, Notice, TextField, useAction, useQuery } from '../components/ui';
import { useI18n } from '../i18n';

interface School {
  name: string;
  name_bn: string | null;
  logo_url: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  license_status: string | null;
  license_plan: string | null;
  license_ends_on: string | null;
}
interface Policy {
  id: string;
  name: string;
  bands: { min_percent: number; grade: string; grade_point?: number }[];
  is_dev_sample: boolean;
}

export function SchoolSettings() {
  const { t } = useI18n();
  const q = useQuery(() => api.get<School>('/school'), []);
  const pol = useQuery(() => api.get<{ items: Policy[] }>('/school/grading-policies'), []);
  return (
    <div>
      <h1>{t('school.profile')}</h1>
      <Async q={q}>{(s) => <ProfileForm school={s} onSaved={q.reload} />}</Async>
      <Card title={t('school.grading')}>
        <p className="muted">{t('school.gradingNote')}</p>
        <Async q={pol}>
          {(d) => (
            <DataTable
              caption={t('school.grading')}
              rows={d.items}
              rowKey={(p) => p.id}
              columns={[
                {
                  header: t('common.name'),
                  cell: (p) => (
                    <>
                      {p.name} {p.is_dev_sample && <span className="muted">({t('school.devSample')})</span>}
                    </>
                  ),
                },
                {
                  header: t('school.bands'),
                  cell: (p) => p.bands.map((b) => `${b.min_percent}% → ${b.grade}${b.grade_point !== undefined ? ` (${b.grade_point})` : ''}`).join('; '),
                },
              ]}
            />
          )}
        </Async>
        <PolicyForm onSaved={pol.reload} />
      </Card>
    </div>
  );
}

function ProfileForm({ school, onSaved }: { school: School; onSaved: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({
    name: school.name,
    name_bn: school.name_bn ?? '',
    logo_url: school.logo_url ?? '',
    address: school.address ?? '',
    phone: school.phone ?? '',
    email: school.email ?? '',
  });
  useEffect(
    () =>
      setF({
        name: school.name,
        name_bn: school.name_bn ?? '',
        logo_url: school.logo_url ?? '',
        address: school.address ?? '',
        phone: school.phone ?? '',
        email: school.email ?? '',
      }),
    [school],
  );
  const a = useAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const nul = (v: string) => (v.trim() === '' ? null : v.trim());
    void a.run(async () => {
      await api.patch('/school', {
        name: f.name,
        name_bn: nul(f.name_bn),
        logo_url: nul(f.logo_url),
        address: nul(f.address),
        phone: nul(f.phone),
        email: nul(f.email),
      });
      onSaved();
    });
  };
  return (
    <Card title={t('school.profile')}>
      <form onSubmit={submit} className="stack">
        <div className="grid">
          <TextField label={t('common.name')} required value={f.name} onChange={set('name')} />
          <TextField label={`${t('common.name')} (বাংলা)`} value={f.name_bn} onChange={set('name_bn')} />
          <TextField label={t('common.logoUrl')} type="url" value={f.logo_url} onChange={set('logo_url')} />
          <TextField label={t('common.address')} value={f.address} onChange={set('address')} />
          <TextField label={t('common.phone')} value={f.phone} onChange={set('phone')} />
          <TextField label={t('common.email')} type="email" value={f.email} onChange={set('email')} />
        </div>
        <ErrorBanner error={a.error} />
        {a.done && <Notice>{t('common.saved')}</Notice>}
        <Button type="submit" busy={a.busy}>
          {t('common.save')}
        </Button>
      </form>
      <p className="muted">
        {t('school.license')}: {school.license_plan ?? '—'} · {school.license_status ?? '—'}
        {school.license_ends_on ? ` · ${school.license_ends_on}` : ''}
      </p>
    </Card>
  );
}

function PolicyForm({ onSaved }: { onSaved: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [bands, setBands] = useState([{ min: '0', grade: '', point: '' }]);
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      await api.post('/school/grading-policies', {
        name,
        bands: bands.map((b) => ({ min_percent: Number(b.min), grade: b.grade, ...(b.point !== '' ? { grade_point: Number(b.point) } : {}) })),
      });
      setName('');
      setBands([{ min: '0', grade: '', point: '' }]);
      onSaved();
    });
  };
  return (
    <form onSubmit={submit} className="stack">
      <h3>{t('school.addPolicy')}</h3>
      <TextField label={t('school.policyName')} required value={name} onChange={(e) => setName(e.target.value)} />
      {bands.map((b, i) => (
        <div className="grid" key={i}>
          <TextField
            label="min %"
            type="number"
            min={0}
            max={100}
            step="any"
            required
            value={b.min}
            onChange={(e) => setBands(bands.map((x, j) => (j === i ? { ...x, min: e.target.value } : x)))}
          />
          <TextField
            label={t('common.grade')}
            required
            value={b.grade}
            onChange={(e) => setBands(bands.map((x, j) => (j === i ? { ...x, grade: e.target.value } : x)))}
          />
          <TextField
            label="Point"
            type="number"
            step="any"
            value={b.point}
            onChange={(e) => setBands(bands.map((x, j) => (j === i ? { ...x, point: e.target.value } : x)))}
          />
        </div>
      ))}
      <div className="row">
        <Button variant="secondary" small onClick={() => setBands([...bands, { min: '', grade: '', point: '' }])}>
          +
        </Button>
        <Button type="submit" busy={a.busy}>
          {t('common.create')}
        </Button>
      </div>
      <ErrorBanner error={a.error} />
    </form>
  );
}
