import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, Button, Card, DataTable, ErrorBanner, SelectField, TextField, useAction, useQuery } from '../components/ui';
import { useI18n } from '../i18n';
import type { Klass, Subject, Year } from './Academics';

interface Exam {
  id: string;
  name: string;
  academic_year_id: string;
  class_id: string;
  grading_policy_id: string | null;
  subjects: { subject_id: string; max_marks: number; pass_marks: number }[];
}

export function Exams() {
  const { can } = useAuth();
  const { t } = useI18n();
  const q = useQuery(() => api.get<{ items: Exam[] }>('/exams'), []);
  const years = useQuery(() => api.get<{ items: Year[] }>('/academic-years'), []);
  const classes = useQuery(() => api.get<{ items: Klass[] }>('/classes'), []);
  const subjects = useQuery(() => api.get<{ items: Subject[] }>('/subjects'), []);
  const policies = useQuery(
    () => (can('academic.view') ? api.get<{ items: { id: string; name: string }[] }>('/school/grading-policies') : Promise.resolve({ items: [] })),
    [],
  );
  const [f, setF] = useState({ name: '', academic_year_id: '', class_id: '', grading_policy_id: '' });
  const [rows, setRows] = useState([{ subject_id: '', max_marks: '100', pass_marks: '0' }]);
  const a = useAction();
  const sname = (id: string) => subjects.data?.items.find((s) => s.id === id)?.name ?? '';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      await api.post('/exams', {
        ...f,
        grading_policy_id: f.grading_policy_id || null,
        subjects: rows.map((r) => ({ subject_id: r.subject_id, max_marks: Number(r.max_marks), pass_marks: Number(r.pass_marks) })),
      });
      setF({ name: '', academic_year_id: '', class_id: '', grading_policy_id: '' });
      setRows([{ subject_id: '', max_marks: '100', pass_marks: '0' }]);
      q.reload();
    });
  };
  return (
    <div>
      <h1>{t('nav.exams')}</h1>
      <Card>
        <Async q={q}>
          {(d) => (
            <DataTable
              caption={t('nav.exams')}
              rows={d.items}
              rowKey={(x) => x.id}
              columns={[
                { header: t('common.exam'), cell: (x) => x.name },
                { header: t('common.class'), cell: (x) => classes.data?.items.find((c) => c.id === x.class_id)?.name ?? '' },
                { header: t('common.year'), cell: (x) => years.data?.items.find((y) => y.id === x.academic_year_id)?.name ?? '' },
                { header: t('exams.subjects'), cell: (x) => x.subjects.map((s) => `${sname(s.subject_id)} (${s.max_marks})`).join(', ') },
              ]}
            />
          )}
        </Async>
      </Card>
      {can('exams.manage') && (
        <Card title={t('exams.add')}>
          <form onSubmit={submit} className="stack">
            <div className="grid">
              <TextField label={t('common.name')} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              <SelectField
                label={t('common.year')}
                required
                value={f.academic_year_id}
                onChange={(e) => setF({ ...f, academic_year_id: e.target.value })}
                options={(years.data?.items ?? []).map((y) => ({ value: y.id, label: y.name }))}
              />
              <SelectField
                label={t('common.class')}
                required
                value={f.class_id}
                onChange={(e) => setF({ ...f, class_id: e.target.value })}
                options={(classes.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))}
              />
              <SelectField
                label={t('exams.policy')}
                value={f.grading_policy_id}
                placeholder={t('exams.noPolicy')}
                onChange={(e) => setF({ ...f, grading_policy_id: e.target.value })}
                options={(policies.data?.items ?? []).map((p) => ({ value: p.id, label: p.name }))}
              />
            </div>
            <h3>{t('exams.subjects')}</h3>
            {rows.map((r, i) => (
              <div className="grid" key={i}>
                <SelectField
                  label={t('common.subject')}
                  required
                  value={r.subject_id}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, subject_id: e.target.value } : x)))}
                  options={(subjects.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))}
                />
                <TextField
                  label={t('common.maxMarks')}
                  type="number"
                  min={1}
                  step="0.01"
                  required
                  value={r.max_marks}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, max_marks: e.target.value } : x)))}
                />
                <TextField
                  label={t('common.passMarks')}
                  type="number"
                  min={0}
                  step="0.01"
                  required
                  value={r.pass_marks}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, pass_marks: e.target.value } : x)))}
                />
              </div>
            ))}
            <div className="row">
              <Button variant="secondary" small onClick={() => setRows([...rows, { subject_id: '', max_marks: '100', pass_marks: '0' }])}>
                {t('exams.addSubject')}
              </Button>
              <Button type="submit" busy={a.busy}>
                {t('common.create')}
              </Button>
            </div>
            <ErrorBanner error={a.error} />
          </form>
        </Card>
      )}
    </div>
  );
}
