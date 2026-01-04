import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { en } from "./en";
import { ru } from "./ru";
import { TextContext } from "./useText";

export const LANGUAGES = [
  { key: "en", label: "English" },
  { key: "ru", label: "Русский" }
] as const;

const texts = { en, ru };
const languageKeys = new Set(LANGUAGES.map((lang) => lang.key));
export type LangKey = (typeof LANGUAGES)[number]["key"];
export type TextContextValue = {
  text: (typeof texts)[LangKey];
  lang: LangKey;
  setLang: (lang: LangKey) => void;
};

const STORAGE_KEY = "lazystrap.lang";

export const TextProvider = ({ children }: { children: ReactNode }) => {
  const [lang, setLang] = useState<LangKey>(() => {
    if (typeof window === "undefined") return "en";
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && languageKeys.has(stored as LangKey)) return stored as LangKey;
    return "en";
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // ignore storage errors
    }
  }, [lang]);

  const value = useMemo(() => ({ text: texts[lang], lang, setLang }), [lang]);

  return <TextContext.Provider value={value}>{children}</TextContext.Provider>;
};
