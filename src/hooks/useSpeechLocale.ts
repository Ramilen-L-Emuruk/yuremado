import { useEffect, useState, useSyncExternalStore } from 'react'
import { useLocale } from '../i18n/I18nProvider'
import type { Locale } from '../i18n/messages'
import { speechWordsFor } from '../i18n/speechWords'
import { canBuildSpeechText } from '../utils/ttsText'
import { hasSystemVoiceFor, onSystemVoicesChanged } from '../utils/systemSpeech'
import { getSpeechLocale, subscribeSpeechLocale } from '../utils/speechLocale'
import { log } from '../utils/logger'

/**
 * 読み上げの言語の決め方の結果。
 *
 * - `speechLocale` … 読み上げの言語（文と声の両方）。画面の言語で読めないときは日本語
 * - `missingVoice` … 画面の言語の語表はあるのに、端末にその言語の声が無いので日本語で読んでいる（設定の窓に出す。
 *   2026-11-16 ユーザー選択「日本語で読む＋設定に出す (Recommended)」）
 */
export type SpeechLocaleDecision = { speechLocale: Locale; missingVoice: boolean }

/**
 * 読み上げの言語を決める。**文の言語と声の言語はここで 1 度に決める**（別々に決めると、英語の文を日本語の声で読む・
 * 日本語の文を英語の声で読む組み合わせが起きる）。
 *
 * 画面の言語で読むのは、その言語の語表があり（→ `i18n/speechWords.ts`。全区分を訳し終えた言語だけ）、その語表から組を作れて
 * （`canBuildSpeechText`。作れない言語を選ぶと文だけ日本語へ落ちる）、端末にその言語の声があるときだけ。どれかが欠ければ日本語で読む。
 *
 * - 語表が無い・組を作れないのは端末の事情ではないので、設定の窓に「声が無い」とは出さない（言語の行の説明が日本語で読むと言っている。
 *   組を作れないのは不具合で、記録に残る）
 * - 声の一覧がまだ届いていない（`hasVoice` が null）ときは、分かるまで日本語で読み、「声が無い」とも出さない（届いてから決め直す）。
 *   待ち終えても空のまま（`voicesSettled`）なら、声が無いとして出す（声が 1 つも無い端末で、理由が分からないまま日本語に固定しない）
 */
export function decideSpeechLocale(
  uiLocale: Locale,
  hasVoice: (locale: Locale) => boolean | null,
  canBuild: (locale: Locale) => boolean,
  voicesSettled: boolean,
): SpeechLocaleDecision {
  if (uiLocale === 'ja' || speechWordsFor(uiLocale) === null || !canBuild(uiLocale)) return { speechLocale: 'ja', missingVoice: false }
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

const sameDecision = (a: SpeechLocaleDecision, b: SpeechLocaleDecision) =>
  a.speechLocale === b.speechLocale && a.missingVoice === b.missingVoice

/**
 * 画面の言語と端末の声から、読み上げの言語を決める（→ {@link decideSpeechLocale}）。声の一覧が届いた・変わったら決め直す
 * （`voiceschanged` と、購読を張った直後からの数回）。結果が変わらなければ描き直さない。
 * 決めた値を読み上げへ渡すのは `App.tsx`（`setSpeechLocale`）。ほかの場所は {@link useSpeechLocale} で渡した値を読む
 */
export function useSpeechLocaleDecision(): SpeechLocaleDecision {
  const locale = useLocale()
  const decide = (settled: boolean) => decideSpeechLocale(locale, hasSystemVoiceFor, canBuildSpeechText, settled)
  // 決めたときの画面の言語と一緒に持つ。画面の言語が変わった描画では、次の測り直しを待たずにその場で決め直す
  const [state, setState] = useState(() => ({ locale, decision: decide(false) }))
  useEffect(() => {
    let settled = false
    const update = () => {
      const next = decideSpeechLocale(locale, hasSystemVoiceFor, canBuildSpeechText, settled)
      setState(prev => (prev.locale === locale && sameDecision(prev.decision, next) ? prev : { locale, decision: next }))
    }
    const off = onSystemVoicesChanged(update)
    // 購読を張るまでに届いた知らせを取りこぼさないよう、張った直後にも測る。知らせを出さない端末のために少し後にも測る。
    // 最後の測り直しでも一覧が空なら、声が無いとして決める（それ以降に一覧が届けば `voiceschanged` で決め直す）
    const timers = VOICE_RECHECK_MS.map((ms, i) => setTimeout(() => {
      if (i === VOICE_RECHECK_MS.length - 1) {
        settled = true
        if (locale !== 'ja' && speechWordsFor(locale) !== null && hasSystemVoiceFor(locale) === null) {
          log.warn(`[tts] 端末の声の一覧が ${ms / 1000} 秒たっても届かないため、${locale} の声が無いとして日本語で読みます`)
        }
      }
      update()
    }, ms))
    return () => {
      off()
      for (const t of timers) clearTimeout(t)
    }
  }, [locale])
  return state.locale === locale ? state.decision : decide(false)
}

/**
 * いまの読み上げの言語（`App.tsx` が読み上げへ渡した値。→ `utils/speechLocale.ts`）。
 * 読み上げの文を組む場所（先読み・試聴・切り出し語）はこれで組を引く。声はこの値ではなく、組が文に添えた言語で選ぶ（→ `utils/speechLocale.ts`）
 */
export function useSpeechLocale(): Locale {
  return useSyncExternalStore(subscribeSpeechLocale, getSpeechLocale)
}
