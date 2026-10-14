import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Button, Card, ErrorBanner, Notice, TextField, useAction } from '../components/ui';
import { useI18n } from '../i18n';

export function Account() {
  const { session } = useAuth();
  const { t } = useI18n();
  const [f, setF] = useState({ current_password: '', new_password: '' });
  const a = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void a.run(async () => {
      await api.post('/auth/change-password', f);
      setF({ current_password: '', new_password: '' });
    });
  };
  return (
    <div>
      <h1>{t('nav.account')}</h1>
      <Card>
        <p>
          {session?.user.full_name} · {session?.user.email}
        </p>
        <p className="muted">
          {t('school.active')}: {session?.school.name} ({session?.school.slug})
        </p>
      </Card>
      <Card title={t('account.changePassword')}>
        <form className="stack" onSubmit={submit}>
          <TextField
            label={t('account.current')}
            type="password"
            autoComplete="current-password"
            required
            value={f.current_password}
            onChange={(e) => setF({ ...f, current_password: e.target.value })}
          />
          <TextField
            label={t('account.new')}
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
            value={f.new_password}
            onChange={(e) => setF({ ...f, new_password: e.target.value })}
          />
          <p className="muted">{t('account.otherSessions')}</p>
          <ErrorBanner error={a.error} />
          {a.done && <Notice>{t('common.saved')}</Notice>}
          <Button type="submit" busy={a.busy}>
            {t('common.save')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
