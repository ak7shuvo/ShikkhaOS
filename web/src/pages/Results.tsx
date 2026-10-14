import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, Button, Card, DataTable, ErrorBanner, Notice, SelectField, StatusBadge, TextField, useAction, useQuery } from '../components/ui';
import { useI18n } from '../i18n';
import type { Klass, Subject } from './Academics';

interface SheetRow {
  id: string;
  exam_name: string;
  subject_name: string;
  section_name: string;
  class_name: string;
  status: string;
  revision: number;
}
interface Exam {
  id: string;
  name: string;
  class_id: string;
  subjects: { subject_id: string }[];
}

export function ResultSheets() {
  const { can } = useAuth();
  const { t } = useI18n();
  const nav = useNavigate();
  const q = useQuery(() => api.get<{ items: SheetRow[] }>('/result-sheets'), []);
  const exams = useQuery(() => api.get<{ items: Exam[] }>('/exams'), []);
  const classes = useQuery(() => api.get<{ items: Klass[] }>('/classes'), []);
  const subjects = useQuery(() => api.get<{ items: Subject[] }>('/subjects'), []);
  const [f, setF] = useState({ exam_id: '', subject_id: '', section_id: '' });
  const a = useAction();
  const exam = exams.data?.items.find((e) => e.id === f.exam_id);
  const open = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      const r = await api.post<{ id: string }>('/result-sheets', f);
      nav(`/results/${r.id}`);
    });
  };
  return (
    <div>
      <h1>{t('nav.results')}</h1>
      <Card>
        <Async q={q}>
          {(d) => (
            <DataTable
              caption={t('nav.results')}
              empty={t('results.noSheets')}
              rows={d.items}
              rowKey={(s) => s.id}
              columns={[
                { header: t('common.exam'), cell: (s) => <Link to={`/results/${s.id}`}>{s.exam_name}</Link> },
                { header: t('common.class'), cell: (s) => `${s.class_name}-${s.section_name}` },
                { header: t('common.subject'), cell: (s) => s.subject_name },
                { header: t('common.status'), cell: (s) => <StatusBadge status={s.status} /> },
              ]}
            />
          )}
        </Async>
      </Card>
      {can('marks.enter') && (
        <Card title={t('results.open')}>
          <form onSubmit={open} className="stack">
            <div className="grid">
              <SelectField
                label={t('common.exam')}
                required
                value={f.exam_id}
                onChange={(e) => setF({ exam_id: e.target.value, subject_id: '', section_id: '' })}
                options={(exams.data?.items ?? []).map((x) => ({ value: x.id, label: x.name }))}
              />
              <SelectField
                label={t('common.subject')}
                required
                value={f.subject_id}
                onChange={(e) => setF({ ...f, subject_id: e.target.value })}
                options={(exam?.subjects ?? []).map((s) => ({
                  value: s.subject_id,
                  label: subjects.data?.items.find((x) => x.id === s.subject_id)?.name ?? '',
                }))}
              />
              <SelectField
                label={t('common.section')}
                required
                value={f.section_id}
                onChange={(e) => setF({ ...f, section_id: e.target.value })}
                options={(classes.data?.items.find((c) => c.id === exam?.class_id)?.sections ?? []).map((s) => ({ value: s.id, label: s.name }))}
              />
            </div>
            <ErrorBanner error={a.error} />
            <Button type="submit" busy={a.busy}>
              {t('results.open')}
            </Button>
          </form>
        </Card>
      )}
    </div>
  );
}

interface MarkRow {
  enrollment_id: string;
  obtained: number | null;
  is_absent: boolean;
  row_version: number;
  roll_no: number;
  full_name: string;
  student_code: string;
}
interface Sheet {
  id: string;
  status: string;
  revision: number;
  row_version: number;
  max_marks: number;
  editable: boolean;
  marks: MarkRow[];
}
interface History {
  events: { id: string; revision: number; action: string; reason: string | null; created_at: string; actor_name: string }[];
}

const ACTIONS: { path: string; perm: string; from: string[]; reason: boolean; variant?: 'danger' | 'secondary' }[] = [
  { path: 'submit', perm: 'result.submit', from: ['draft', 'returned'], reason: false },
  { path: 'start-review', perm: 'result.review', from: ['submitted'], reason: false },
  { path: 'approve', perm: 'result.review', from: ['under_review'], reason: false },
  { path: 'return', perm: 'result.review', from: ['under_review'], reason: true, variant: 'danger' },
  { path: 'publish', perm: 'result.publish', from: ['approved'], reason: false },
  { path: 'correction', perm: 'result.correct', from: ['published'], reason: true, variant: 'secondary' },
];

export function ResultSheetPage() {
  const { id } = useParams();
  const { t } = useI18n();
  const q = useQuery(() => api.get<Sheet>(`/result-sheets/${id}`), [id]);
  const h = useQuery(() => api.get<History>(`/result-sheets/${id}/history`), [id]);
  const reload = () => {
    q.reload();
    h.reload();
  };
  return (
    <div>
      <p>
        <Link to="/results">← {t('nav.results')}</Link>
      </p>
      <Async q={q}>{(s) => <SheetBody sheet={s} reload={reload} />}</Async>
      <Card title={t('results.history')}>
        <Async q={h}>
          {(d) => (
            <ol className="timeline">
              {d.events.map((e) => (
                <li key={e.id}>
                  <strong>{t(`results.event.${e.action}`)}</strong> · {t('results.revision', { n: e.revision })} · {t('results.by', { name: e.actor_name })} ·{' '}
                  <time dateTime={e.created_at}>{new Date(e.created_at).toLocaleString()}</time>
                  {e.reason && (
                    <div className="muted">
                      {t('common.reason')}: {e.reason}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </Async>
      </Card>
    </div>
  );
}

function SheetBody({ sheet, reload }: { sheet: Sheet; reload: () => void }) {
  const { can } = useAuth();
  const { t } = useI18n();
  const [draft, setDraft] = useState<Record<string, { obtained: string; absent: boolean }>>({});
  useEffect(
    () =>
      setDraft(Object.fromEntries(sheet.marks.map((m) => [m.enrollment_id, { obtained: m.obtained === null ? '' : String(m.obtained), absent: m.is_absent }]))),
    [sheet],
  );
  const save = useAction();
  const act = useAction();
  const [pending, setPending] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const canEdit = sheet.editable && can('marks.enter');

  const saveMarks = () =>
    void save.run(async () => {
      await api.put(`/result-sheets/${sheet.id}/marks`, {
        entries: sheet.marks.map((m) => {
          const d = draft[m.enrollment_id];
          return {
            enrollment_id: m.enrollment_id,
            expected_version: m.row_version,
            is_absent: d?.absent ?? false,
            obtained: d?.absent || d?.obtained === '' || d === undefined ? null : Number(d.obtained),
          };
        }),
      });
      reload();
    });
  const run = (path: string, withReason: boolean) =>
    void act.run(async () => {
      await api.post(`/result-sheets/${sheet.id}/${path}`, { expected_version: sheet.row_version, ...(withReason ? { reason } : {}) });
      setPending(null);
      setReason('');
      reload();
    });
  const available = ACTIONS.filter((a) => a.from.includes(sheet.status) && can(a.perm));

  return (
    <Card title={`${t('results.marks')} — ${t('results.revision', { n: sheet.revision })}`} actions={<StatusBadge status={sheet.status} />}>
      {!canEdit && <p className="muted">{t('results.locked')}</p>}
      <div className="table-wrap">
        <table>
          <caption className="sr-only">{t('results.marks')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('common.roll')}</th>
              <th scope="col">{t('common.name')}</th>
              <th scope="col">
                {t('common.obtained')} / {sheet.max_marks}
              </th>
              <th scope="col">{t('common.absent')}</th>
            </tr>
          </thead>
          <tbody>
            {sheet.marks.map((m) => {
              const d = draft[m.enrollment_id] ?? { obtained: '', absent: false };
              return (
                <tr key={m.enrollment_id}>
                  <td>{m.roll_no}</td>
                  <td>{m.full_name}</td>
                  <td>
                    <input
                      aria-label={`${t('common.obtained')}: ${m.full_name}`}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      max={sheet.max_marks}
                      step="0.01"
                      disabled={!canEdit || d.absent}
                      value={d.obtained}
                      onChange={(e) => setDraft({ ...draft, [m.enrollment_id]: { ...d, obtained: e.target.value } })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`${t('common.absent')}: ${m.full_name}`}
                      type="checkbox"
                      style={{ width: 'auto', minHeight: 0 }}
                      disabled={!canEdit}
                      checked={d.absent}
                      onChange={(e) => setDraft({ ...draft, [m.enrollment_id]: { obtained: '', absent: e.target.checked } })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ErrorBanner error={save.error} />
      {save.done && <Notice>{t('common.saved')}</Notice>}
      {canEdit && (
        <div className="row" style={{ marginTop: '.75rem' }}>
          <Button onClick={saveMarks} busy={save.busy}>
            {t('results.saveMarks')}
          </Button>
        </div>
      )}
      <div className="row" style={{ marginTop: '.75rem' }}>
        {available.map((a) =>
          a.reason ? (
            <Button key={a.path} variant={a.variant ?? 'primary'} onClick={() => setPending(a.path)}>
              {t(`results.action.${a.path}`)}
            </Button>
          ) : (
            <Button key={a.path} onClick={() => run(a.path, false)} busy={act.busy}>
              {t(`results.action.${a.path}`)}
            </Button>
          ),
        )}
      </div>
      {pending && (
        <div className="stack" style={{ marginTop: '.75rem' }}>
          <TextField label={t('results.reasonPrompt')} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="row">
            <Button onClick={() => run(pending, true)} busy={act.busy} disabled={reason.trim().length < 3}>
              {t('results.confirm')}
            </Button>
            <Button variant="secondary" onClick={() => setPending(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}
      <ErrorBanner error={act.error} />
    </Card>
  );
}
