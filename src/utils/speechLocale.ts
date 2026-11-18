import type { Locale } from '../i18n/messages'
import { log } from './logger'

/**
 * 読み上げの言語。**文を組む側（`ttsText.ts` の `speechTextFor` を呼ぶ側）は、この 1 つの値で組を引く。** 声はこの値ではなく、
 * 組が文に添えた言語で選ぶ（`voicevox.ts` の `SpeechUtterance`）—— 読む時点でこの値を取り直すと、組が日本語へ落ちた回や、
 * 組んでから読むまでに言語が変わった回に、日本語の文を英語の声で読むような食い違いが起きる。
 *
 * 決めるのは `App.tsx`（`hooks/useSpeechLocale.ts` の `decideSpeechLocale`）。日本語以外は端末の声で読む（VOICEVOX は日本語だけ）。
 *
 * **読み上げの部品（`voicevox.ts`）から分けて置く。** あちらは多くのテストが丸ごと偽物に差し替えるので、そこに置くと
 * 差し替えたテストでは言語が引けなくなる（読み上げを偽物にしても、文を組む言語は本物のこの値を読む）。
 */
let speechLocale: Locale = 'ja'
const listeners = new Set<() => void>()

/** 読み上げの言語を切り替える。変わったときだけ知らせる */
export function setSpeechLocale(locale: Locale): void {
  if (locale === speechLocale) return
  speechLocale = locale
  // 1 つの購読者が投げても、残りへは知らせる（一部だけ古い言語のまま残ると、先読みや試聴の言語が食い違う）
  for (const listener of listeners) {
    try {
      listener()
    } catch (err) {
      log.error('[tts] 読み上げの言語の切り替えを知らせる途中で失敗', err)
    }
  }
}

/** いまの読み上げの言語 */
export function getSpeechLocale(): Locale {
  return speechLocale
}

/** 読み上げの言語が変わったら呼ぶ（React の `useSyncExternalStore` に渡す形）。外すための関数を返す */
export function subscribeSpeechLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function __resetSpeechLocaleForTest(): void {
  speechLocale = 'ja'
  listeners.clear()
}
