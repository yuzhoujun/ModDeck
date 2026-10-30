export type SupportedLocale = 'auto' | 'zh-CN' | 'en-US' | (string & {})

export interface LocaleOption {
  code: string
  label: string
}

export type TranslationParams = Record<string, string | number>

export type TranslationDict = Record<string, any>
