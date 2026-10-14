import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { Async, Card, DataTable, EmptyState, useQuery } from '../components/ui';
import { useI18n } from '../i18n';

interface Child {
  id: string;
  student_code: string;
  full_name: string;
  relationship: string;
}
interface Profile {
  id: string;
  student_code: string;
  full_name: string;
  enrollments: { id: string; academic_year: string; class_name: string; section_name: string; roll_no: number }[];
}
interface Result {
  exam_id: string;
  exam_name: string;
  subject_name: string;
  obtained: number | null;
  max_marks: number;
  is_absent: boolean;
  grade: string | null;
}

export function GuardianHome() {
  const { t } = useI18n();
  const q = useQuery(() => api.get<{ items: Child[] }>('/guardian/students'), []);
  return (
    <div>
      <h1>{t('nav.myChildren')}</h1>
      <Async q={q}>
        {(d) =>
          d.items.length === 0 ? (
            <EmptyState>{t('guardian.noChildren')}</EmptyState>
          ) : (
            <div className="grid">
              {d.items.map((c) => (
                <Card key={c.id} title={c.full_name}>
                  <p className="muted">
                    {c.student_code} · {c.relationship}
                  </p>
                  <Link to={`/my-children/${c.id}`}>{t('guardian.results')}</Link>
                </Card>
              ))}
            </div>
          )
        }
      </Async>
    </div>
  );
}

export function GuardianChild() {
  const { id } = useParams();
  const { t } = useI18n();
  const p = useQuery(() => api.get<Profile>(`/guardian/students/${id}`), [id]);
  const r = useQuery(() => api.get<{ items: Result[] }>(`/guardian/students/${id}/results`), [id]);
  const ex = useQuery(() => api.get<{ items: { id: string; name: string; academic_year: string }[] }>(`/guardian/students/${id}/exams`), [id]);
  return (
    <div>
      <p>
        <Link to="/my-children">← {t('nav.myChildren')}</Link>
      </p>
      <Async q={p}>
        {(s) => (
          <>
            <h1>{s.full_name}</h1>
            <Card title={t('guardian.enrollments')}>
              <DataTable
                caption={t('guardian.enrollments')}
                rows={s.enrollments}
                rowKey={(e) => e.id}
                columns={[
                  { header: t('common.year'), cell: (e) => e.academic_year },
                  { header: t('common.class'), cell: (e) => e.class_name },
                  { header: t('common.section'), cell: (e) => e.section_name },
                  { header: t('common.roll'), cell: (e) => e.roll_no },
                ]}
              />
            </Card>
          </>
        )}
      </Async>
      <Card title={t('guardian.exams')}>
        <Async q={ex}>
          {(d) => (
            <DataTable
              caption={t('guardian.exams')}
              rows={d.items}
              rowKey={(e) => e.id}
              columns={[
                { header: t('common.exam'), cell: (e) => e.name },
                { header: t('common.year'), cell: (e) => e.academic_year },
              ]}
            />
          )}
        </Async>
      </Card>
      <Card title={t('guardian.results')}>
        <Async q={r}>
          {(d) => (
            <DataTable
              caption={t('guardian.results')}
              empty={t('guardian.noResults')}
              rows={d.items}
              rowKey={(x) => `${x.exam_id}-${x.subject_name}`}
              columns={[
                { header: t('common.exam'), cell: (x) => x.exam_name },
                { header: t('common.subject'), cell: (x) => x.subject_name },
                { header: t('common.obtained'), cell: (x) => (x.is_absent ? t('common.absent') : `${x.obtained} / ${x.max_marks}`) },
                { header: t('common.grade'), cell: (x) => x.grade ?? '—' },
              ]}
            />
          )}
        </Async>
      </Card>
    </div>
  );
}
