import { createContext, useContext, useState, useMemo, useCallback } from 'react'
import translations from './translations'

const LanguageContext = createContext(null)

function detectDefaultLang() {
  const saved = localStorage.getItem('lang')
  if (saved === 'pt' || saved === 'en') return saved
  // Sem preferência salva: tenta adivinhar pelo idioma do navegador,
  // com fallback pra português (público majoritário desta plataforma).
  const nav = (navigator.language || 'pt').toLowerCase()
  return nav.startsWith('pt') ? 'pt' : 'en'
}

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(detectDefaultLang)

  const setLang = useCallback((next) => {
    setLangState(next)
    localStorage.setItem('lang', next)
  }, [])

  const t = useCallback((key, vars) => {
    const dict = translations[lang] || translations.pt
    let str = dict[key] ?? translations.pt[key] ?? key
    if (vars) {
      Object.entries(vars).forEach(([k, v]) => {
        str = str.replaceAll(`{${k}}`, v)
      })
    }
    return str
  }, [lang])

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t])

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  )
}

// Uso: const { t, lang, setLang } = useTranslation()
export function useTranslation() {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useTranslation precisa estar dentro de <LanguageProvider>')
  return ctx
}
