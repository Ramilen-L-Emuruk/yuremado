import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { log } from '../utils/logger'
import { JA_MESSAGES, loadMessages, localeTag, type Locale, type Messages } from './messages'

interface I18nValue {
  /** いま画面に出している辞書の言語（選んだ言語の読み込みが済むまでは、その前の言語）。 */
  locale: Locale
  messages: Messages
}

const I18nContext = createContext<I18nValue>({ locale: 'ja', messages: JA_MESSAGES })

/**
 * 出す言語を変える口。配り役の外（テストや部品単体の描画）では何もしない。
 * 値は配り役ごとに 1 つで変わらないので、辞書と別の文脈に置く（言語を変えるだけの部品を、辞書の差し替えで起こさない）。
 */
const SetLocaleContext = createContext<(locale: Locale) => void>(() => {})

/** 選んだのに辞書を読めず、日本語で出している言語（読めていれば null）。設定の窓の言語の行が知らせを出すのに使う */
const LoadFailedContext = createContext<Locale | null>(null)

/**
 * 画面の言語を配る。求められた言語の辞書を読み、読めたら差し替える。読めるまでは前の言語のまま出し、
 * 読めなかったときは日本語で出す（画面を空にしない）。`<html lang>` も、いま出している辞書の言語に合わせる。
 *
 * - `locale`: 初めに求める言語。後から変えても追う（テストで差し替えるため）。アプリの中からは {@link useSetLocale} で変える
 * - `preloaded`: `locale` の辞書を描く前に読み終えていれば渡す。渡せば初めからその言語で描く（`main.tsx` が起動の前に読む）。
 *   渡さなければ日本語で描いてから差し替える
 */
export function I18nProvider({ locale, preloaded, children }: { locale: Locale; preloaded?: Messages; children: ReactNode }) {
  const [requested, setRequested] = useState<Locale>(locale)
  // `locale` が後から変わったときだけ追う。描いた直後には走らせない —— 子（App）の効果は親より先に走るので、
  // ここで初めの `locale` を入れ直すと、App が設定から決めた言語を上書きしてしまう
  const propLocale = useRef(locale)
  useEffect(() => {
    if (propLocale.current === locale) return
    propLocale.current = locale
    setRequested(locale)
  }, [locale])
  // 値は言語が変わったときだけ作り直す（memo した部品を、言語と関係ない描き直しで起こさない）
  const [value, setValue] = useState<I18nValue>(() => (
    preloaded !== undefined ? { locale, messages: preloaded } : { locale: 'ja', messages: JA_MESSAGES }
  ))
  // 読めなかった言語。日本語へ戻したことで効果が走り直しても、同じ言語を読み直さない（ログも 1 回で済ませる）
  const [failedLocale, setFailedLocale] = useState<Locale | null>(null)

  useEffect(() => {
    if (requested === value.locale || requested === failedLocale) return
    let cancelled = false
    loadMessages(requested).then(
      (messages) => { if (!cancelled) setValue({ locale: requested, messages }) },
      (err) => {
        log.error(`[i18n] 言語「${requested}」の辞書を読めず、日本語で出す`, err)
        if (cancelled) return
        setFailedLocale(requested)
        // 直前の言語（読めていた別の言語）のまま残さず、日本語へ戻す
        // 既に日本語なら同じ値を保つ（配る値を作り直して、言語と関係ない描き直しを起こさない）
        setValue((prev) => (prev.locale === 'ja' ? prev : { locale: 'ja', messages: JA_MESSAGES }))
      },
    )
    return () => { cancelled = true }
  }, [requested, value.locale, failedLocale])

  // 選び直したら、前に読めなかった言語もまた試す（一時的に読めなかっただけかもしれない）
  const setLocale = useRef((next: Locale) => {
    setFailedLocale((prev) => (prev === next ? null : prev))
    setRequested(next)
  }).current

  // 読めなかったまま回線が戻ったら、選んだ言語をもう一度読む（オフラインで開いて一度失敗しただけで、日本語のまま残さない）
  useEffect(() => {
    if (failedLocale === null) return
    const retry = () => {
      log.info(`[i18n] 回線が戻ったので言語「${failedLocale}」の辞書を読み直す`)
      setFailedLocale(null)
    }
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [failedLocale])

  useEffect(() => {
    document.documentElement.lang = localeTag(value.locale)
  }, [value.locale])

  return (
    <SetLocaleContext.Provider value={setLocale}>
      <LoadFailedContext.Provider value={failedLocale !== null && failedLocale === requested ? failedLocale : null}>
        <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
      </LoadFailedContext.Provider>
    </SetLocaleContext.Provider>
  )
}

/** いまの言語の辞書。 */
export function useMessages(): Messages {
  return useContext(I18nContext).messages
}

/**
 * いまの言語の辞書を持つ参照。**地図の吹き出しのように、一度だけ登録して後から呼ばれる組み立てに渡す**
 * （辞書が変わるたびに登録し直さずに、呼ばれた時点の言語で組める）。参照そのものは描き直しても変わらない。
 */
export function useMessagesRef(): { readonly current: Messages } {
  const messages = useMessages()
  const ref = useRef(messages)
  useLayoutEffect(() => {
    ref.current = messages
  }, [messages])
  return ref
}

/** いま画面に出している辞書の言語。 */
export function useLocale(): Locale {
  return useContext(I18nContext).locale
}

/** 選んだのに辞書を読めず、日本語で出している言語。読めていれば null。 */
export function useLocaleLoadFailed(): Locale | null {
  return useContext(LoadFailedContext)
}

/** 出す言語を変える。同じ言語を渡しても何も起きない。 */
export function useSetLocale(): (locale: Locale) => void {
  return useContext(SetLocaleContext)
}
