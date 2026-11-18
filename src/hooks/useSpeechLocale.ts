import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useLocale, usePlaceNames } from '../i18n/I18nProvider'
import { JA_PLACE_NAMES } from '../i18n/placeNames'
import type { Locale } from '../i18n/messages'
import { speechWordsFor, subscribeSpeechWords } from '../i18n/speechWords'
import { canBuildSpeechText } from '../utils/ttsText'
import { hasSystemVoiceFor, onSystemVoicesChanged } from '../utils/systemSpeech'
import { getSpeechLocale, getSpeechLocaleDecision, subscribeSpeechLocale, type SpeechLocaleDecision } from '../utils/speechLocale'
import { log } from '../utils/logger'

export type { SpeechLocaleDecision }

/**
 * 読み上げの言語を決める。**文の言語と声の言語はここで 1 度に決める**（別々に決めると、英語の文を日本語の声で読む・
 * 日本語の文を英語の声で読む組み合わせが起きる）。
 *
 * 画面の言語で読むのは、その言語の語表が登録され（→ `i18n/speechWords.ts`）、地名の表も読めていて（`placeNamesReady`）、
 * その語表から組を作れて（`canBuildSpeechText`。作れない言語を選ぶと文だけ日本語へ落ちる）、端末にその言語の声があるときだけ。
 * どれかが欠ければ日本語で読む。**語表と地名の表がそろうまでは日本語で読む**（片方だけで読むと、訳した文に日本語の地名が混ざる。
 * 2026-11-18 ユーザー選択「そろうまで日本語、回線で読み直す (Recommended)」。読めなかった方は配り役 `I18nProvider` が回線の戻りで読み直す）。
 *
 * - 語表・地名の表が無い・組を作れないのは端末の事情ではないので、設定の窓に「声が無い」とは出さない（読めなかったときは別の知らせを出す。
 *   組を作れないのは不具合で、記録に残る）
 * - 声の一覧がまだ届いていない（`hasVoice` が null）ときは、分かるまで日本語で読み、「声が無い」とも出さない（届いてから決め直す）。
 *   待ち終えても空のまま（`voicesSettled`）なら、声が無いとして出す（声が 1 つも無い端末で、理由が分からないまま日本語に固定しない）
 */
export function decideSpeechLocale(
  uiLocale: Locale,
  hasVoice: (locale: Locale) => boolean | null,
  canBuild: (locale: Locale) => boolean,
  voicesSettled: boolean,
  placeNamesReady: boolean,
): SpeechLocaleDecision {
  if (uiLocale === 'ja' || speechWordsFor(uiLocale) === null || !placeNamesReady || !canBuild(uiLocale)) {
    return { speechLocale: 'ja', missingVoice: false }
  }
  const voice = hasVoice(uiLocale)
  if (voice === null) return { speechLocale: 'ja', missingVoice: voicesSettled }
  if (!voice) return { speechLocale: 'ja', missingVoice: true }
  return { speechLocale: uiLocale, missingVoice: false }
}

/**
 * 声の一覧を測り直す時刻（購読を張ってからの ms）。`voiceschanged` を出さない端末（Safari の一部）でも、遅れて埋まった一覧を拾う。
 * 端末の声の読み上げが最初の発話で一覧を待つ上限（`systemSpeech.ts` の `VOICES_WAIT_MS`・1 秒）より後まで見る
 */
const VOICE_RECHECK_MS = [0, 1000, 5000] as const

/**
 * 上の測り直しを終えても声の一覧が空の間、さらに測り直す間（前の測り直しからの ms。最後の値で繰り返す）。声の一覧が
 * 届けば止まる。`voiceschanged` を出さない端末で 5 秒より後に一覧が埋まったとき、画面の言語を変えるか読み込み直すまで
 * 「声が無い」のまま日本語で読み続けないため（2026-11-18 ユーザー選択「辞書と一緒に後から読む (Recommended)」の説明
 * 「声の一覧が空の間は間を広げながら測り直す」）。画面が前に出たとき（`visibilitychange`）にも測り直す
 */
const VOICE_RECHECK_BACKOFF_MS = [10_000, 30_000, 60_000, 120_000, 300_000] as const

const sameDecision = (a: SpeechLocaleDecision, b: SpeechLocaleDecision) =>
  a.speechLocale === b.speechLocale && a.missingVoice === b.missingVoice

/**
 * 画面の言語と端末の声から、読み上げの言語を決める（→ {@link decideSpeechLocale}）。声の一覧が届いた・変わった、語表が登録された
 * （`i18n/speechWords.ts` の `registerSpeechWords`）、画面が前に出たら決め直す。結果が変わらなければ描き直さない。
 *
 * **呼ぶのは `App.tsx` の 1 か所だけ。** 決めた値は `App.tsx` が置き場（`utils/speechLocale.ts` の `setSpeechLocaleDecision`）へ渡し、
 * ほかの場所は {@link useSpeechLocale}・{@link useSpeechVoiceMissing} で渡した値を読む（ここを 2 か所で呼ぶと、測り直しの間が
 * それぞれ違って、読んでいる言語と設定の窓の注記が食い違う）
 */
export function useSpeechLocaleDecision(): SpeechLocaleDecision {
  const locale = useLocale()
  // 地名の表が読めているか。配り役は表が届くまで（読めなかったときも）日本語の引き方を配る（→ `I18nProvider`）
  const placeLookup = usePlaceNames()
  const placeNamesReady = locale === 'ja' || placeLookup !== JA_PLACE_NAMES
  // 声の一覧を待ち終えたか（画面の言語ごと。地名の表が後から届いて決め直すときも、待ちをやり直さない）
  const settledRef = useRef<{ locale: Locale; settled: boolean }>({ locale, settled: false })
  const settledFor = (l: Locale) => settledRef.current.locale === l && settledRef.current.settled
  const decide = () => decideSpeechLocale(locale, hasSystemVoiceFor, canBuildSpeechText, settledFor(locale), placeNamesReady)
  // 決めたときの画面の言語・地名の表と一緒に持つ。どちらかが変わった描画では、次の測り直しを待たずにその場で決め直す
  const [state, setState] = useState(() => ({ locale, placeNamesReady, decision: decide() }))
  const readyRef = useRef(placeNamesReady)
  useLayoutEffect(() => { readyRef.current = placeNamesReady })
  // 地名の表が届いた・読めなくなったら決め直す（効果の中の `update` は最新の値を `readyRef` から読む）
  const updateRef = useRef<(() => void) | null>(null)
  useEffect(() => { updateRef.current?.() }, [placeNamesReady])
  useEffect(() => {
    if (settledRef.current.locale !== locale) settledRef.current = { locale, settled: false }
    let backoffTimer: ReturnType<typeof setTimeout> | undefined
    let backoffCount = 0
    const update = () => {
      const ready = readyRef.current
      const next = decideSpeechLocale(locale, hasSystemVoiceFor, canBuildSpeechText, settledFor(locale), ready)
      setState(prev => (prev.locale === locale && prev.placeNamesReady === ready && sameDecision(prev.decision, next)
        ? prev
        : { locale, placeNamesReady: ready, decision: next }))
    }
    updateRef.current = update
    /** 声の一覧がまだ空か（日本語は声を選ばないので見ない） */
    const voicesPending = () => locale !== 'ja' && hasSystemVoiceFor(locale) === null
    const scheduleBackoff = () => {
      if (!voicesPending()) return
      const ms = VOICE_RECHECK_BACKOFF_MS[Math.min(backoffCount, VOICE_RECHECK_BACKOFF_MS.length - 1)]
      backoffCount++
      backoffTimer = setTimeout(() => {
        update()
        if (!voicesPending()) log.info(`[tts] 端末の声の一覧が遅れて届いたので、${locale} の読み上げの言語を決め直しました`)
        scheduleBackoff()
      }, ms)
    }
    const off = onSystemVoicesChanged(update)
    const offWords = subscribeSpeechWords(update)
    const onVisible = () => { if (document.visibilityState === 'visible') update() }
    document.addEventListener('visibilitychange', onVisible)
    // 購読を張るまでに届いた知らせを取りこぼさないよう、張った直後にも測る。知らせを出さない端末のために少し後にも測る。
    // 最後の測り直しでも一覧が空なら、声が無いとして決め、その後も一覧が空の間は間を広げながら測り直す
    const timers = VOICE_RECHECK_MS.map((ms, i) => setTimeout(() => {
      const last = i === VOICE_RECHECK_MS.length - 1
      if (last) {
        settledRef.current = { locale, settled: true }
        if (locale !== 'ja' && speechWordsFor(locale) !== null && hasSystemVoiceFor(locale) === null) {
          log.warn(`[tts] 端末の声の一覧が ${ms / 1000} 秒たっても届かないため、${locale} の声が無いとして日本語で読みます（届くまで測り直します）`)
        }
      }
      update()
      if (last) scheduleBackoff()
    }, ms))
    return () => {
      if (updateRef.current === update) updateRef.current = null
      off()
      offWords()
      document.removeEventListener('visibilitychange', onVisible)
      for (const t of timers) clearTimeout(t)
      clearTimeout(backoffTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 決め直しは画面の言語ごとに張る。地名の表と待ちの状態は ref から読む
  }, [locale])
  return state.locale === locale && state.placeNamesReady === placeNamesReady ? state.decision : decide()
}

/**
 * いまの読み上げの言語（`App.tsx` が置き場へ渡した値。→ `utils/speechLocale.ts`）。
 * 読み上げの文を組む場所（先読み・試聴・切り出し語・時報）はこれで組を引く。声はこの値ではなく、組が文に添えた言語で選ぶ（→ `utils/speechLocale.ts`）
 */
export function useSpeechLocale(): Locale {
  return useSyncExternalStore(subscribeSpeechLocale, getSpeechLocale)
}

/**
 * 画面の言語の声が端末に無く、日本語で読んでいるか（`App.tsx` が置き場へ渡した値。設定の窓の声の行の下に出す知らせ。→ `docs/spec/audio-tts-spec.md` §3「日本語以外の読み上げ（読み上げの言語）」の「声が無いとき」）。
 * 読んでいる言語と同じ決めから読むので、注記と実際の読み上げは食い違わない
 */
export function useSpeechVoiceMissing(): boolean {
  return useSyncExternalStore(subscribeSpeechLocale, () => getSpeechLocaleDecision().missingVoice)
}
