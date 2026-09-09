import { createContext, useContext, useState, useMemo } from 'react'
import { translations } from './translations'

const I18nContext = createContext(null)

export function I18nProvider({ children }) {
  const [lang, setLang] = useState(localStorage.getItem('cdn_lang') || 'en')

  const setLanguage = (l) => {
    setLang(l)
    localStorage.setItem('cdn_lang', l)
  }

  const t = useMemo(() => translations[lang] || translations.en, [lang])

  return (
    <I18nContext.Provider value={{ lang, setLanguage, t }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider')
  return ctx
}
