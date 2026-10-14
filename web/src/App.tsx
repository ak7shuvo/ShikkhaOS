import { useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
import { Button, Spinner } from './components/ui';
import { useI18n } from './i18n';
import { Academics } from './pages/Academics';
import { Dashboard } from './pages/Dashboard';
import { Exams } from './pages/Exams';
import { GuardianChild, GuardianHome } from './pages/Guardian';
import { Guardians } from './pages/Guardians';
import { Login, SchoolPicker } from './pages/Login';
import { Members } from './pages/Members';
import { PlatformSchools } from './pages/Platform';
import { ResultSheetPage, ResultSheets } from './pages/Results';
import { SchoolSettings } from './pages/School';
import { Students } from './pages/Students';
import { useQuery } from './components/ui';

interface SchoolInfo {
  name: string;
  name_bn: string | null;
  logo_url: string | null;
}

function Shell() {
  const { session, logout, can } = useAuth();
  const { t, lang, setLang } = useI18n();
  const [open, setOpen] = useState(false);
  const school = useQuery<SchoolInfo | null>(
    () => (session?.active_school_id && can('school.view') ? api.get<SchoolInfo>('/school') : Promise.resolve(null)),
    [session?.active_school_id],
  );
  if (!session) return null;

  const links: [string, string, boolean][] = [
    ['/', t('nav.dashboard'), true],
    ['/school', t('nav.school'), can('school.manage')],
    ['/members', t('nav.members'), can('members.manage')],
    ['/academics', t('nav.academics'), can('academic.view') && Boolean(session.active_school_id)],
    ['/students', t('nav.students'), can('students.view')],
    ['/guardians', t('nav.guardians'), can('academic.manage')],
    ['/exams', t('nav.exams'), can('academic.view')],
    ['/results', t('nav.results'), can('result.view') || can('marks.enter')],
    ['/my-children', t('nav.myChildren'), can('guardian.portal')],
    ['/platform/schools', t('nav.platformSchools'), can('platform.schools.manage')],
  ];
  const sname = school.data ? (lang === 'bn' && school.data.name_bn ? school.data.name_bn : school.data.name) : null;
  const active = session.memberships.find((m) => m.school_id === session.active_school_id);

  return (
    <div className="layout">
      <a className="skip" href="#main">
        {t('nav.skip')}
      </a>
      <div className="topbar">
        <strong>{t('app.name')}</strong>
        <Button variant="secondary" small aria-expanded={open} onClick={() => setOpen(!open)}>
          {t('nav.menu')}
        </Button>
      </div>
      <aside className={`sidebar${open ? ' open' : ''}`}>
        <div className="brand">
          {t('app.name')}
          <small>{t('app.tagline')}</small>
        </div>
        {session.active_school_id && (
          <div className="school-id" aria-label={t('school.active')}>
            {school.data?.logo_url && <img src={school.data.logo_url} alt="" />}
            <span>{sname ?? active?.school_name}</span>
          </div>
        )}
        <nav className="nav" aria-label="Main">
          {links
            .filter((l) => l[2])
            .map(([to, label]) => (
              <NavLink key={to} to={to} end={to === '/'} onClick={() => setOpen(false)}>
                {label}
              </NavLink>
            ))}
        </nav>
      </aside>
      <div>
        <div className="toolbar" style={{ padding: '.75rem 1.25rem 0' }}>
          <span className="muted">
            {session.user.full_name} ·{' '}
            {session.roles.map((r) => t(`role.${r}`)).join(', ') || (session.user.is_platform_admin ? t('role.platform_super_admin') : '')}
          </span>
          <label className="sr-only" htmlFor="lang">
            {t('common.language')}
          </label>
          <select
            id="lang"
            value={lang}
            onChange={(e) => {
              const l = e.target.value as 'en' | 'bn';
              setLang(l);
              api.patch('/auth/me', { language: l }).catch(() => undefined);
            }}
            style={{ width: 'auto' }}
          >
            <option value="bn">বাংলা</option>
            <option value="en">English</option>
          </select>
          <Button variant="secondary" small onClick={() => void logout()}>
            {t('common.logout')}
          </Button>
        </div>
        <main id="main" className="main">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/school" element={<SchoolSettings />} />
            <Route path="/members" element={<Members />} />
            <Route path="/academics" element={<Academics />} />
            <Route path="/students" element={<Students />} />
            <Route path="/guardians" element={<Guardians />} />
            <Route path="/exams" element={<Exams />} />
            <Route path="/results" element={<ResultSheets />} />
            <Route path="/results/:id" element={<ResultSheetPage />} />
            <Route path="/my-children" element={<GuardianHome />} />
            <Route path="/my-children/:id" element={<GuardianChild />} />
            <Route path="/platform/schools" element={<PlatformSchools />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export function App() {
  const { session, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!session) return <Login />;
  if (!session.active_school_id && !session.user.is_platform_admin) return <SchoolPicker />;
  return <Shell />;
}
