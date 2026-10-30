import React, { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SupportedLocale, TranslationDict, TranslationParams } from '../../../shared/i18n/types'
import type { CharacterInfo } from '../../../shared/types'
import zhCN from '../../../shared/i18n/locales/zh-CN.json'
import enUS from '../../../shared/i18n/locales/en-US.json'

const BUILTIN_LOCALES: Record<string, TranslationDict> = {
  'zh-CN': zhCN,
  'en-US': enUS,
  'en': enUS
}

export interface I18nContextValue {
  locale: string
  effectiveLocale: string
  setLocale: (next: SupportedLocale) => void
  t: (key: string, params?: TranslationParams) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function resolveEffectiveLocale(configured: string | undefined): string {
  if (configured && configured !== 'auto') {
    if (configured === 'en') return 'en-US'
    return configured
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language || 'zh-CN' : 'zh-CN'
  if (nav.toLowerCase().startsWith('zh')) return 'zh-CN'
  return 'en-US'
}

function getNestedValue(obj: any, path: string): string | undefined {
  const parts = path.split('.')
  let cur = obj
  for (const part of parts) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return typeof cur === 'string' ? cur : undefined
}

export function I18nProvider({
  language,
  onLanguageChange,
  children
}: {
  language?: string
  onLanguageChange?: (next: string) => void
  children: ReactNode
}) {
  const [currentLocale, setCurrentLocale] = useState<string>(language || 'auto')

  useEffect(() => {
    if (language) {
      setCurrentLocale(language)
    } else if (typeof window !== 'undefined' && window.moddeck?.bootstrap) {
      window.moddeck
        .bootstrap()
        .then((b) => {
          if (b?.settings?.ui?.language) setCurrentLocale(b.settings.ui.language)
        })
        .catch(() => {})
    }
  }, [language])

  useEffect(() => {
    if (typeof window !== 'undefined' && window.moddeck?.onStateChanged) {
      const unsub = window.moddeck.onStateChanged(() => {
        window.moddeck
          .bootstrap()
          .then((b) => {
            if (b?.settings?.ui?.language) setCurrentLocale(b.settings.ui.language)
          })
          .catch(() => {})
      })
      return () => {
        unsub()
      }
    }
    return undefined
  }, [])

  const effectiveLocale = useMemo(() => resolveEffectiveLocale(currentLocale), [currentLocale])

  const setLocale = (next: SupportedLocale) => {
    setCurrentLocale(next)
    if (onLanguageChange) {
      onLanguageChange(next)
    } else if (typeof window !== 'undefined' && window.moddeck?.saveSettings) {
      window.moddeck.saveSettings({ ui: { language: next } }).catch(() => {})
    }
  }

  const t = useMemo(() => {
    const activeDict = BUILTIN_LOCALES[effectiveLocale] || BUILTIN_LOCALES['en-US']
    const fallbackDict = BUILTIN_LOCALES['zh-CN']

    return (key: string, params?: TranslationParams): string => {
      let raw = getNestedValue(activeDict, key)
      if (raw === undefined) {
        raw = getNestedValue(fallbackDict, key)
      }
      if (raw === undefined) {
        return key
      }
      if (!params) return raw

      let result = raw
      for (const [k, v] of Object.entries(params)) {
        result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
      }
      return result
    }
  }, [effectiveLocale])

  return (
    <I18nContext.Provider value={{ locale: currentLocale, effectiveLocale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) {
    const effective = resolveEffectiveLocale('auto')
    const activeDict = BUILTIN_LOCALES[effective] || BUILTIN_LOCALES['zh-CN']
    return {
      locale: 'auto',
      effectiveLocale: effective,
      setLocale: () => undefined,
      t: (key: string, params?: TranslationParams) => {
        let raw = getNestedValue(activeDict, key) || key
        if (!params) return raw
        for (const [k, v] of Object.entries(params)) {
          raw = raw.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
        }
        return raw
      }
    }
  }
  return ctx
}

export function getLocaleCharacterName(char: CharacterInfo, effectiveLocale: string): string {
  if (effectiveLocale === 'zh-CN') {
    return char.displayName || char.folder
  }
  // In English / international locale:
  // If canonicalEnName is available, use it!
  if (char.canonicalEnName && char.canonicalEnName.trim()) {
    return char.canonicalEnName.trim()
  }
  return char.displayName || char.folder
}
