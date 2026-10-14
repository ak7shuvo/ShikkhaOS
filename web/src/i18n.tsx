import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { bn } from './locales/bn';
import { en } from './locales/en';

export type Lang = 'en' | 'bn';
const dicts = { en, bn } as const;

interface I18n {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}
const Ctx = createContext<I18n>({ lang: 'en', setLang: () => {}, t: (k) => k });

export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  let s: string = (dicts[lang] as Record<string, string>)[key] ?? (dicts.en as Record<string, string>)[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

export function I18nProvider({ children, initial }: { children: ReactNode; initial?: Lang }) {
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      const saved = localStorage.getItem('lang');
      if (saved === 'en' || saved === 'bn') return saved;
    } catch {
      /* storage unavailable */
    }
    return initial ?? 'bn';
  });
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem('lang', l);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return <Ctx.Provider value={{ lang, setLang, t: (k, v) => translate(lang, k, v) }}>{children}</Ctx.Provider>;
}
export const useI18n = () => useContext(Ctx);
