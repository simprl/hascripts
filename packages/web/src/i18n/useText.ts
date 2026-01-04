import { createContext, useContext } from "react";
import { en } from "./en";
import type { TextContextValue } from "./TextProvider";

const TextContext = createContext<TextContextValue>({
  text: en,
  lang: "en",
  setLang: () => {}
});

export const useText = () => useContext(TextContext).text;
export const useLanguage = () => {
  const { lang, setLang } = useContext(TextContext);
  return { lang, setLang };
};

export { TextContext };
