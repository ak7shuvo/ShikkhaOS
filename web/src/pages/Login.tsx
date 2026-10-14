import { useState, type FormEvent } from 'react';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { Button, ErrorBanner, TextField, useAction } from '../components/ui';
import { useI18n } from '../i18n';

export function Login() {
  const { login } = useAuth();
  const { t, lang, setLang } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(() => login(email, password));
  };
  const err =
    a.error instanceof ApiError && a.error.status === 401
      ? new ApiError(401, 'LOGIN', t('login.invalid'))
      : a.error instanceof ApiError && a.error.status === 429
        ? new ApiError(429, 'LOGIN', t('login.rate'))
        : a.error;
  return (
    <div className="login">
      <h1>{t('app.name')}</h1>
      <p className="muted">{t('app.tagline')}</p>
      <form className="card stack" onSubmit={submit}>
        <h2>{t('login.title')}</h2>
        <TextField label={t('common.email')} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextField
          label={t('common.password')}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {err ? (
          <div className="banner banner-error" role="alert">
            {err instanceof ApiError && err.code === 'LOGIN' ? err.message : t('common.error')}
          </div>
        ) : null}
        <Button type="submit" busy={a.busy}>
          {t('login.submit')}
        </Button>
      </form>
      <button type="button" className="btn btn-secondary btn-small" onClick={() => setLang(lang === 'bn' ? 'en' : 'bn')}>
        {lang === 'bn' ? 'English' : 'বাংলা'}
      </button>
    </div>
  );
}

/** Shown to multi-school users until they choose one of THEIR OWN memberships (server re-validates). */
export function SchoolPicker() {
  const { session, switchSchool, logout } = useAuth();
  const { t } = useI18n();
  const a = useAction();
  if (!session) return null;
  const schools = [...new Map(session.memberships.map((m) => [m.school_id, m.school_name])).entries()];
  return (
    <div className="login">
      <h1>{t('school.choose')}</h1>
      <p className="muted">{schools.length ? t('school.chooseHelp') : t('school.noneActive')}</p>
      <ErrorBanner error={a.error} />
      <div className="stack">
        {schools.map(([id, name]) => (
          <Button key={id} variant="secondary" onClick={() => void a.run(() => switchSchool(id))} busy={a.busy}>
            {name}
          </Button>
        ))}
        <Button variant="secondary" small onClick={() => void logout()}>
          {t('common.logout')}
        </Button>
      </div>
    </div>
  );
}
