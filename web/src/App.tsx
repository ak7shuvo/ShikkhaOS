import { useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
import { Button, Spinner, Warning } from './components/ui';
import { useI18n } from './i18n';
import { Academics } from './pages/Academics';
import { Dashboard } from './pages/Dashboard';
import { Exams } from './pages/Exams';
import { GuardianChild, GuardianHome } from './pages/Guardian';
import { Guardians } from './pages/Guardians';
import { Login } from './pages/Login';
import { Account, ForcedPasswordChange } from './pages/Account';
import { PlatformApp } from './pages/Platform';
import { applyBranding } from './branding';
import { Members } from './pages/Members';
import { ResultSheetPage, ResultSheets } from './pages/Results';
import { SchoolSettings } from './pages/School';
import { Students } from './pages/Students';
import { useQuery } from './components/ui';
import { useEffect } from 'react';

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
  useEffect(() => applyBranding(session?.branding ?? null), [session?.branding]);
  if (!session) return null;
  if (session.user.credential_change_required) return <ForcedPasswordChange />;

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
    ['/account', t('nav.account'), true],
  ];
  const sname = session.branding?.display_name ?? (school.data ? (lang === 'bn' && school.data.name_bn ? school.data.name_bn : school.data.name) : null);
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
            {(session.branding?.logo_url ?? school.data?.logo_url) && <img src={(session.branding?.logo_url ?? school.data?.logo_url) as string} alt="" />}
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
            {session.user.full_name} · {session.roles.map((r) => t(`role.${r}`)).join(', ')}
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
          {session.entitlement.warning && (
            <Warning>
              {session.entitlement.level === 'grace' && t('sub.grace', { date: session.entitlement.full_access_until })}
              {session.entitlement.level === 'read_only' && t('sub.readonly', { date: session.entitlement.read_only_until })}
            </Warning>
          )}
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
            <Route path="/account" element={<Account />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function Blocked() {
  const { session, logout } = useAuth();
  const { t } = useI18n();
  if (!session) return null;
  return (
    <div className="login">
      <h1>{t('blocked.title')}</h1>
      <div className="banner banner-error" role="alert">
        {t('blocked.body', { date: session.entitlement.retention_until })}
      </div>
      <Button variant="secondary" onClick={() => void logout()}>
        {t('common.logout')}
      </Button>
    </div>
  );
}

export function App() {
  const { session, loading, logout } = useAuth();
  const { t } = useI18n();
  if (window.location.pathname.startsWith('/platform')) return <PlatformApp />;
  if (loading) return <Spinner />;
  if (!session) return <Login />;
  if (session.entitlement.level === 'blocked') return <Blocked />;
  if (!session.active_school_id) {
    return (
      <div className="login">
        <p className="muted">{t('school.noneActive')}</p>
        <Button variant="secondary" onClick={() => void logout()}>
          {t('common.logout')}
        </Button>
      </div>
    );
  }
  return <Shell />;
}
