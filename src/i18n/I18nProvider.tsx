import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { log } from '../utils/logger'
import { JA_MESSAGES, loadMessages, localeTag, type Locale, type Messages } from './messages'
import { JA_PLACE_NAMES, placeNameLookup, type PlaceNameLookup } from './placeNames'
import { getCachedPlaceNames, loadPlaceNames } from './placeNameLoader'

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

/** 地名の訳の引き方。辞書と別の文脈に置く（表は辞書の後から届くので、届いたときに地名を出す部品だけを起こす） */
const PlaceNamesContext = createContext<PlaceNameLookup>(JA_PLACE_NAMES)

/** 言語の地名の表が手元にあれば、その引き方を返す（日本語と、まだ読めていない言語は名前をそのまま返す） */
function cachedLookup(locale: Locale): PlaceNameLookup {
  if (locale === 'ja') return JA_PLACE_NAMES
  const table = getCachedPlaceNames(locale)
  if (!table) return JA_PLACE_NAMES
  // 同じ表からは同じ引き方を返す（言語を切り替え直すたびに参照が変わり、地名を出す部品を起こさない）
  let lookup = lookupByTable.get(table)
  if (!lookup) {
    lookup = placeNameLookup(table)
    lookupByTable.set(table, lookup)
  }
  return lookup
}
const lookupByTable = new WeakMap<object, PlaceNameLookup>()

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

  // 地名の表は、いま出している辞書の言語に合わせて読む。読めるまで・読めなかったときは日本語の名前で出す
  // （画面の文言は訳したまま、地名だけ日本語になる。地名を空にはしない）
  const [placeNames, setPlaceNames] = useState<{ locale: Locale; lookup: PlaceNameLookup }>(() => ({ locale: value.locale, lookup: cachedLookup(value.locale) }))
  // 地名の表を読めなかった言語。回線が戻ったら読み直す（辞書の読み直しと同じ扱い）
  const [placeNamesFailed, setPlaceNamesFailed] = useState<Locale | null>(null)
  useEffect(() => {
    const locale = value.locale
    const lookup = cachedLookup(locale)
    setPlaceNames((prev) => (prev.locale === locale && prev.lookup === lookup ? prev : { locale, lookup }))
    if (locale === 'ja' || lookup !== JA_PLACE_NAMES || placeNamesFailed === locale) return
    let cancelled = false
    loadPlaceNames(locale).then(
      () => { if (!cancelled) setPlaceNames({ locale, lookup: cachedLookup(locale) }) },
      (err) => {
        log.error(`[i18n] 言語「${locale}」の地名の表を読めず、地名は日本語で出す`, err)
        if (!cancelled) setPlaceNamesFailed(locale)
      },
    )
    return () => { cancelled = true }
  }, [value.locale, placeNamesFailed])

  useEffect(() => {
    if (placeNamesFailed === null) return
    // 言語を選び直したら、読めなかった言語の印を外す（次にその言語へ戻ったときにまた読む）
    if (placeNamesFailed !== value.locale) { setPlaceNamesFailed(null); return }
    const retry = () => {
      log.info(`[i18n] 回線が戻ったので言語「${placeNamesFailed}」の地名の表を読み直す`)
      setPlaceNamesFailed(null)
    }
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [placeNamesFailed, value.locale])

  return (
    <SetLocaleContext.Provider value={setLocale}>
      <LoadFailedContext.Provider value={failedLocale !== null && failedLocale === requested ? failedLocale : null}>
        <I18nContext.Provider value={value}>
          {/* 言語を切り替えた最初の描画では state がまだ前の言語なので、手元の表から今の言語の引き方を出す
              （辞書と地名の言語を 1 回の描画もずらさない） */}
          <PlaceNamesContext.Provider value={placeNames.locale === value.locale ? placeNames.lookup : cachedLookup(value.locale)}>{children}</PlaceNamesContext.Provider>
        </I18nContext.Provider>
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

/**
 * 地名の訳の引き方（`placeNames('epi', '石狩地方北部')`）。訳が無い・日本語の画面なら名前をそのまま返す。
 * **表示の直前でだけ使う**（座標・塗り・絞り込み・読み上げには日本語の名前を渡す）
 */
export function usePlaceNames(): PlaceNameLookup {
  return useContext(PlaceNamesContext)
}

/** 地名の訳の引き方を持つ参照。地図の吹き出しのように、一度だけ登録して後から呼ばれる組み立てに渡す */
export function usePlaceNamesRef(): { readonly current: PlaceNameLookup } {
  const lookup = usePlaceNames()
  const ref = useRef(lookup)
  useLayoutEffect(() => {
    ref.current = lookup
  }, [lookup])
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
