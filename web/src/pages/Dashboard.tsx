import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, Card, StatusBadge, useQuery } from '../components/ui';
import { useI18n } from '../i18n';

interface Sheet {
  id: string;
  status: string;
  exam_name: string;
  subject_name: string;
  section_name: string;
  class_name: string;
}

function SheetsSummary() {
  const { can } = useAuth();
  const { t } = useI18n();
  const q = useQuery(() => api.get<{ items: Sheet[] }>('/result-sheets'), []);
  return (
    <Async q={q}>
      {(d) => {
        const reviewing = d.items.filter((s) => s.status === 'submitted' || s.status === 'under_review');
        const editable = d.items.filter((s) => s.status === 'draft' || s.status === 'returned');
        const list = can('result.review') ? reviewing : editable;
        return (
          <Card title={can('result.review') ? t('dash.pendingReview') : t('dash.myDrafts')}>
            {list.length === 0 ? (
              <p className="muted">{t('results.noSheets')}</p>
            ) : (
              <ul className="timeline">
                {list.map((s) => (
                  <li key={s.id}>
                    <Link to={`/results/${s.id}`}>
                      {s.exam_name} · {s.class_name}-{s.section_name} · {s.subject_name}
                    </Link>{' '}
                    <StatusBadge status={s.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        );
      }}
    </Async>
  );
}

export function Dashboard() {
  const { session, can } = useAuth();
  const { t } = useI18n();
  if (!session) return null;
  return (
    <div>
      <h1>{t('dash.welcome', { name: session.user.full_name })}</h1>
      {can('guardian.portal') && (
        <Card title={t('nav.myChildren')}>
          <Link to="/my-children">{t('nav.myChildren')}</Link>
        </Card>
      )}
      {(can('result.view') || can('marks.enter')) && session.active_school_id && <SheetsSummary />}
      {can('platform.schools.manage') && (
        <Card title={t('nav.platformSchools')}>
          <Link to="/platform/schools">{t('nav.platformSchools')}</Link>
        </Card>
      )}
    </div>
  );
}
