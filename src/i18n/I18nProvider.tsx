import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { log } from '../utils/logger'
import { JA_MESSAGES, loadMessages, localeTag, type Locale, type Messages } from './messages'

interface I18nValue {
  /** いま画面に出している辞書の言語（選んだ言語の読み込みが済むまでは `'ja'`）。 */
  locale: Locale
  messages: Messages
}

const I18nContext = createContext<I18nValue>({ locale: 'ja', messages: JA_MESSAGES })

/**
 * 画面の言語を配る。`locale` の辞書を読み、読めたら差し替える。読めるまでと読めなかったときは日本語で出す
 * （画面を空にしない）。`<html lang>` も、いま出している辞書の言語に合わせる。
 */
export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  // 初めは日本語で描く。ほかの言語は読み込みが済んでから差し替える。
  // 値は言語が変わったときだけ作り直す（memo した部品を、言語と関係ない描き直しで起こさない）
  const [value, setValue] = useState<I18nValue>({ locale: 'ja', messages: JA_MESSAGES })
  // 読めなかった言語。日本語へ戻したことで効果が走り直しても、同じ言語を読み直さない（ログも 1 回で済ませる）
  const [failedLocale, setFailedLocale] = useState<Locale | null>(null)

  useEffect(() => {
    if (locale === value.locale || locale === failedLocale) return
    let cancelled = false
    loadMessages(locale).then(
      (messages) => { if (!cancelled) setValue({ locale, messages }) },
      (err) => {
        log.error(`[i18n] 言語「${locale}」の辞書を読めず、日本語で出す`, err)
        if (cancelled) return
        setFailedLocale(locale)
        // 直前の言語（読めていた別の言語）のまま残さず、日本語へ戻す
        // 既に日本語なら同じ値を保つ（配る値を作り直して、言語と関係ない描き直しを起こさない）
        setValue((prev) => (prev.locale === 'ja' ? prev : { locale: 'ja', messages: JA_MESSAGES }))
      },
    )
    return () => { cancelled = true }
  }, [locale, value.locale, failedLocale])

  useEffect(() => {
    document.documentElement.lang = localeTag(value.locale)
  }, [value.locale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/** いまの言語の辞書。 */
export function useMessages(): Messages {
  return useContext(I18nContext).messages
}

/** いま画面に出している辞書の言語。 */
export function useLocale(): Locale {
  return useContext(I18nContext).locale
}
