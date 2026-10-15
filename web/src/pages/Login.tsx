import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Branding } from '../api';
import { useAuth } from '../auth';
import { applyBranding, FIXED_SCHOOL } from '../branding';
import { Button, TextField, useAction } from '../components/ui';
import { useI18n } from '../i18n';

const stored = (): string => {
  try {
    return localStorage.getItem('school') ?? '';
  } catch {
    return '';
  }
};

export function Login() {
  const { login } = useAuth();
  const { t, lang, setLang } = useI18n();
  const [school, setSchool] = useState(FIXED_SCHOOL || stored());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [brand, setBrand] = useState<Branding | null>(null);
  const a = useAction();

  // Public, non-sensitive branding lookup by slug (display name, colours, logo).
  useEffect(() => {
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(school)) {
      setBrand(null);
      applyBranding(null);
      return;
    }
    let live = true;
    const h = setTimeout(() => {
      api
        .get<Branding>(`/public/branding/${school}`)
        .then((b) => live && (setBrand(b), applyBranding(b)))
        .catch(() => live && (setBrand(null), applyBranding(null)));
    }, 300);
    return () => {
      live = false;
      clearTimeout(h);
    };
  }, [school]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    try {
      localStorage.setItem('school', school);
    } catch {
      /* storage unavailable */
    }
    void a.run(() => login(school.trim().toLowerCase(), email, password));
  };
  const err =
    a.error instanceof ApiError && a.error.status === 401
      ? new ApiError(401, 'LOGIN', t('login.invalid'))
      : a.error instanceof ApiError && a.error.status === 429
        ? new ApiError(429, 'LOGIN', t('login.rate'))
        : a.error;
  return (
    <div className="login">
      {brand?.logo_url && <img src={brand.logo_url} alt="" style={{ maxHeight: 64 }} />}
      <h1>{brand?.display_name ?? t('app.name')}</h1>
      <p className="muted">{t('app.tagline')}</p>
      <form className="card stack" onSubmit={submit}>
        <h2>{t('login.title')}</h2>
        {!FIXED_SCHOOL && (
          <TextField
            label={t('login.school')}
            hint={t('login.schoolHint')}
            required
            autoCapitalize="none"
            autoComplete="organization"
            value={school}
            onChange={(e) => setSchool(e.target.value)}
          />
        )}
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
            {err instanceof ApiError && err.code === 'LOGIN'
              ? err.message
              : err instanceof ApiError && err.code.startsWith('SUBSCRIPTION')
                ? t(`error.${err.code}`)
                : t('common.error')}
            {err instanceof ApiError && err.code === 'SUBSCRIPTION_BLOCKED' && (err.details as { retention_until?: string } | undefined)?.retention_until
              ? ` (${t('blocked.retention', { date: (err.details as { retention_until: string }).retention_until })})`
              : ''}
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
