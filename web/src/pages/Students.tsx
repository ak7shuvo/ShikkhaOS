import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, Button, Card, DataTable, ErrorBanner, SelectField, TextField, useAction, useQuery } from '../components/ui';
import { useI18n } from '../i18n';
import type { Klass, Year } from './Academics';

interface Student {
  id: string;
  student_code: string;
  full_name: string;
  status: string;
  enrollment_id: string | null;
  class_id: string | null;
  section_id: string | null;
  roll_no: number | null;
}

export function Students() {
  const { can } = useAuth();
  const { t } = useI18n();
  const q = useQuery(() => api.get<{ items: Student[] }>('/students'), []);
  const years = useQuery(() => api.get<{ items: Year[] }>('/academic-years'), []);
  const classes = useQuery(() => api.get<{ items: Klass[] }>('/classes'), []);
  const [f, setF] = useState({ student_code: '', full_name: '' });
  const [en, setEn] = useState({ student_id: '', academic_year_id: '', class_id: '', section_id: '', roll_no: '' });
  const a = useAction();
  const b = useAction();
  const manage = can('academic.manage');
  const add = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      await api.post('/students', f);
      setF({ student_code: '', full_name: '' });
      q.reload();
    });
  };
  const enrol = (e: FormEvent) => {
    e.preventDefault();
    void b.run(async () => {
      await api.post(`/students/${en.student_id}/enrollments`, {
        academic_year_id: en.academic_year_id,
        class_id: en.class_id,
        section_id: en.section_id,
        roll_no: Number(en.roll_no),
      });
      q.reload();
    });
  };
  const cls = classes.data?.items ?? [];
  return (
    <div>
      <h1>{t('nav.students')}</h1>
      <Card>
        <Async q={q}>
          {(d) => (
            <DataTable
              caption={t('nav.students')}
              rows={d.items}
              rowKey={(s) => `${s.id}-${s.enrollment_id}`}
              columns={[
                { header: t('students.code'), cell: (s) => s.student_code },
                { header: t('common.name'), cell: (s) => s.full_name },
                {
                  header: t('common.class'),
                  cell: (s) => {
                    const c = cls.find((x) => x.id === s.class_id);
                    return c ? `${c.name}-${c.sections.find((x) => x.id === s.section_id)?.name ?? ''}` : t('students.notEnrolled');
                  },
                },
                { header: t('common.roll'), cell: (s) => s.roll_no ?? '—' },
              ]}
            />
          )}
        </Async>
      </Card>
      {manage && (
        <>
          <Card title={t('students.add')}>
            <form onSubmit={add} className="stack">
              <div className="grid">
                <TextField label={t('students.code')} required value={f.student_code} onChange={(e) => setF({ ...f, student_code: e.target.value })} />
                <TextField label={t('common.name')} required value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} />
              </div>
              <ErrorBanner error={a.error} />
              <Button type="submit" busy={a.busy}>
                {t('common.create')}
              </Button>
            </form>
          </Card>
          <Card title={t('students.enroll')}>
            <form onSubmit={enrol} className="stack">
              <div className="grid">
                <SelectField
                  label={t('nav.students')}
                  required
                  value={en.student_id}
                  onChange={(e) => setEn({ ...en, student_id: e.target.value })}
                  options={(q.data?.items ?? []).map((s) => ({ value: s.id, label: `${s.student_code} · ${s.full_name}` }))}
                />
                <SelectField
                  label={t('common.year')}
                  required
                  value={en.academic_year_id}
                  onChange={(e) => setEn({ ...en, academic_year_id: e.target.value })}
                  options={(years.data?.items ?? []).map((y) => ({ value: y.id, label: y.name }))}
                />
                <SelectField
                  label={t('common.class')}
                  required
                  value={en.class_id}
                  onChange={(e) => setEn({ ...en, class_id: e.target.value, section_id: '' })}
                  options={cls.map((c) => ({ value: c.id, label: c.name }))}
                />
                <SelectField
                  label={t('common.section')}
                  required
                  value={en.section_id}
                  onChange={(e) => setEn({ ...en, section_id: e.target.value })}
                  options={(cls.find((c) => c.id === en.class_id)?.sections ?? []).map((s) => ({ value: s.id, label: s.name }))}
                />
                <TextField
                  label={t('common.roll')}
                  type="number"
                  min={1}
                  required
                  value={en.roll_no}
                  onChange={(e) => setEn({ ...en, roll_no: e.target.value })}
                />
              </div>
              <ErrorBanner error={b.error} />
              <Button type="submit" busy={b.busy}>
                {t('common.create')}
              </Button>
            </form>
          </Card>
        </>
      )}
    </div>
  );
}
