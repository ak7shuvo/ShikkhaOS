import type { Branding } from './api';

/** Applies a school's colours as CSS variables. Server-validated hex values only; anything else is ignored. */
export function applyBranding(b: Pick<Branding, 'primary_color' | 'accent_color' | 'display_name'> | null): void {
  const root = document.documentElement;
  const ok = (c: string | undefined) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : null);
  const p = ok(b?.primary_color);
  const a = ok(b?.accent_color);
  if (p) root.style.setProperty('--brand', p);
  else root.style.removeProperty('--brand');
  if (a) root.style.setProperty('--brand-dark', a);
  else root.style.removeProperty('--brand-dark');
  const name = b?.display_name ?? (import.meta.env.VITE_APP_NAME as string | undefined);
  document.title = name ? `${name} — ShikkhaOS` : 'ShikkhaOS';
}

/** The school a branded build is locked to (VITE_SCHOOL_SLUG), if any. */
export const FIXED_SCHOOL = (import.meta.env.VITE_SCHOOL_SLUG as string | undefined) ?? '';
