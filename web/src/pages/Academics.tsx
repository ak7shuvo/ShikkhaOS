import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, Button, Card, DataTable, ErrorBanner, SelectField, TextField, useAction, useQuery } from '../components/ui';
import { useI18n } from '../i18n';

export interface Year {
  id: string;
  name: string;
  starts_on: string;
  ends_on: string;
  is_current: boolean;
}
export interface Klass {
  id: string;
  name: string;
  name_bn: string | null;
  sections: { id: string; name: string }[];
}
export interface Subject {
  id: string;
  code: string;
  name: string;
  name_bn: string | null;
}

export function Academics() {
  const { can } = useAuth();
  const { t } = useI18n();
  const manage = can('academic.manage');
  const years = useQuery(() => api.get<{ items: Year[] }>('/academic-years'), []);
  const classes = useQuery(() => api.get<{ items: Klass[] }>('/classes'), []);
  const subjects = useQuery(() => api.get<{ items: Subject[] }>('/subjects'), []);
  return (
    <div>
      <h1>{t('nav.academics')}</h1>
      <Card title={t('academics.years')}>
        <Async q={years}>
          {(d) => (
            <DataTable
              caption={t('academics.years')}
              rows={d.items}
              rowKey={(y) => y.id}
              columns={[
                {
                  header: t('common.name'),
                  cell: (y) => (
                    <>
                      {y.name} {y.is_current && <strong>· {t('academics.current')}</strong>}
                    </>
                  ),
                },
                { header: t('academics.starts'), cell: (y) => y.starts_on },
                { header: t('academics.ends'), cell: (y) => y.ends_on },
              ]}
            />
          )}
        </Async>
        {manage && <YearForm onSaved={years.reload} />}
      </Card>
      <Card title={t('academics.classes')}>
        <Async q={classes}>
          {(d) => (
            <DataTable
              caption={t('academics.classes')}
              rows={d.items}
              rowKey={(c) => c.id}
              columns={[
                { header: t('common.class'), cell: (c) => c.name },
                { header: t('common.section'), cell: (c) => c.sections.map((s) => s.name).join(', ') || '—' },
                ...(manage ? [{ header: t('common.actions'), cell: (c: Klass) => <SectionForm classId={c.id} onSaved={classes.reload} /> }] : []),
              ]}
            />
          )}
        </Async>
        {manage && <ClassForm onSaved={classes.reload} />}
      </Card>
      <Card title={t('academics.subjects')}>
        <Async q={subjects}>
          {(d) => (
            <DataTable
              caption={t('academics.subjects')}
              rows={d.items}
              rowKey={(s) => s.id}
              columns={[
                { header: t('common.code'), cell: (s) => s.code },
                { header: t('common.name'), cell: (s) => (s.name_bn ? `${s.name} / ${s.name_bn}` : s.name) },
              ]}
            />
          )}
        </Async>
        {manage && <SubjectForm onSaved={subjects.reload} />}
      </Card>
      {manage && <Assignments years={years.data?.items ?? []} classes={classes.data?.items ?? []} subjects={subjects.data?.items ?? []} />}
    </div>
  );
}

function YearForm({ onSaved }: { onSaved: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ name: '', starts_on: '', ends_on: '', is_current: false });
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      await api.post('/academic-years', f);
      setF({ name: '', starts_on: '', ends_on: '', is_current: false });
      onSaved();
    });
  };
  return (
    <form onSubmit={submit} className="stack">
      <div className="grid">
        <TextField label={t('common.name')} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <TextField label={t('academics.starts')} type="date" required value={f.starts_on} onChange={(e) => setF({ ...f, starts_on: e.target.value })} />
        <TextField label={t('academics.ends')} type="date" required value={f.ends_on} onChange={(e) => setF({ ...f, ends_on: e.target.value })} />
        <label className="row">
          <input
            type="checkbox"
            style={{ width: 'auto', minHeight: 0 }}
            checked={f.is_current}
            onChange={(e) => setF({ ...f, is_current: e.target.checked })}
          />{' '}
          {t('academics.current')}
        </label>
      </div>
      <ErrorBanner error={a.error} />
      <Button type="submit" busy={a.busy}>
        {t('common.create')}
      </Button>
    </form>
  );
}

function ClassForm({ onSaved }: { onSaved: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [order, setOrder] = useState('0');
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      await api.post('/classes', { name, level_order: Number(order) });
      setName('');
      onSaved();
    });
  };
  return (
    <form onSubmit={submit} className="stack">
      <div className="grid">
        <TextField label={t('common.class')} required value={name} onChange={(e) => setName(e.target.value)} />
        <TextField label="#" type="number" min={0} value={order} onChange={(e) => setOrder(e.target.value)} />
      </div>
      <ErrorBanner error={a.error} />
      <Button type="submit" busy={a.busy}>
        {t('common.create')}
      </Button>
    </form>
  );
}

function SectionForm({ classId, onSaved }: { classId: string; onSaved: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      await api.post(`/classes/${classId}/sections`, { name });
      setName('');
      onSaved();
    });
  };
  return (
    <form onSubmit={submit} className="row">
      <input
        aria-label={t('academics.addSection')}
        placeholder={t('common.section')}
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        style={{ width: 90 }}
      />
      <Button type="submit" small busy={a.busy}>
        {t('academics.addSection')}
      </Button>
      {a.error ? <ErrorBanner error={a.error} /> : null}
    </form>
  );
}

function SubjectForm({ onSaved }: { onSaved: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ code: '', name: '', name_bn: '' });
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      await api.post('/subjects', { code: f.code, name: f.name, ...(f.name_bn ? { name_bn: f.name_bn } : {}) });
      setF({ code: '', name: '', name_bn: '' });
      onSaved();
    });
  };
  return (
    <form onSubmit={submit} className="stack">
      <div className="grid">
        <TextField label={t('common.code')} required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        <TextField label={t('common.name')} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <TextField label={`${t('common.name')} (বাংলা)`} value={f.name_bn} onChange={(e) => setF({ ...f, name_bn: e.target.value })} />
      </div>
      <ErrorBanner error={a.error} />
      <Button type="submit" busy={a.busy}>
        {t('common.create')}
      </Button>
    </form>
  );
}

interface Assignment {
  id: string;
  teacher_name: string;
  class_id: string;
  section_id: string | null;
  subject_id: string;
}
function Assignments({ years, classes, subjects }: { years: Year[]; classes: Klass[]; subjects: Subject[] }) {
  const { t } = useI18n();
  const list = useQuery(() => api.get<{ items: Assignment[] }>('/teacher-assignments'), []);
  const members = useQuery(() => api.get<{ items: { user_id: string; full_name: string; role: string; status: string }[] }>('/school/members'), []);
  const [f, setF] = useState({ user_id: '', academic_year_id: '', class_id: '', section_id: '', subject_id: '' });
  const a = useAction();
  const sections = classes.find((c) => c.id === f.class_id)?.sections ?? [];
  const cname = (id: string) => classes.find((c) => c.id === id)?.name ?? '';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      await api.post('/teacher-assignments', { ...f, section_id: f.section_id || null });
      list.reload();
    });
  };
  return (
    <Card title={t('academics.assignments')}>
      <Async q={list}>
        {(d) => (
          <DataTable
            caption={t('academics.assignments')}
            rows={d.items}
            rowKey={(x) => x.id}
            columns={[
              { header: t('common.teacher'), cell: (x) => x.teacher_name },
              { header: t('common.class'), cell: (x) => cname(x.class_id) },
              {
                header: t('common.section'),
                cell: (x) => classes.find((c) => c.id === x.class_id)?.sections.find((s) => s.id === x.section_id)?.name ?? t('academics.allSections'),
              },
              { header: t('common.subject'), cell: (x) => subjects.find((s) => s.id === x.subject_id)?.name ?? '' },
            ]}
          />
        )}
      </Async>
      <form onSubmit={submit} className="stack">
        <div className="grid">
          <SelectField
            label={t('common.teacher')}
            required
            value={f.user_id}
            onChange={(e) => setF({ ...f, user_id: e.target.value })}
            options={(members.data?.items ?? [])
              .filter((m) => m.role === 'teacher' && m.status === 'active')
              .map((m) => ({ value: m.user_id, label: m.full_name }))}
          />
          <SelectField
            label={t('common.year')}
            required
            value={f.academic_year_id}
            onChange={(e) => setF({ ...f, academic_year_id: e.target.value })}
            options={years.map((y) => ({ value: y.id, label: y.name }))}
          />
          <SelectField
            label={t('common.class')}
            required
            value={f.class_id}
            onChange={(e) => setF({ ...f, class_id: e.target.value, section_id: '' })}
            options={classes.map((c) => ({ value: c.id, label: c.name }))}
          />
          <SelectField
            label={t('common.section')}
            value={f.section_id}
            placeholder={t('academics.allSections')}
            onChange={(e) => setF({ ...f, section_id: e.target.value })}
            options={sections.map((s) => ({ value: s.id, label: s.name }))}
          />
          <SelectField
            label={t('common.subject')}
            required
            value={f.subject_id}
            onChange={(e) => setF({ ...f, subject_id: e.target.value })}
            options={subjects.map((s) => ({ value: s.id, label: s.name }))}
          />
        </div>
        <ErrorBanner error={a.error} />
        <Button type="submit" busy={a.busy}>
          {t('common.create')}
        </Button>
      </form>
    </Card>
  );
}
