import type { Locale } from '../i18n/messages'
import { log } from './logger'

/**
 * 読み上げの言語の決めの結果。
 *
 * - `speechLocale` … 読み上げの言語（文と声の両方）。画面の言語で読めないときは日本語
 * - `missingVoice` … 画面の言語の語表はあるのに、端末にその言語の声が無いので日本語で読んでいる（設定の窓に出す。
 *   2026-11-16 ユーザー選択「日本語で読む＋設定に出す (Recommended)」）
 */
export type SpeechLocaleDecision = { readonly speechLocale: Locale; readonly missingVoice: boolean }

/**
 * 読み上げの言語の決めの置き場。**決めるのは `App.tsx` の 1 か所だけ**（`hooks/useSpeechLocale.ts` の `useSpeechLocaleDecision`）で、
 * 設定の窓などはここを読む（自分で決め直すと、読んでいる言語と設定の窓の注記が食い違う。2026-11-18 ユーザー選択
 * 「辞書と一緒に後から読む (Recommended)」の説明「言語の決めは App が 1 か所で行い設定の窓はそれを読む」）。
 *
 * **文を組む側（`ttsText.ts` の `speechTextFor` を呼ぶ側）は、`speechLocale` で組を引く。** 声はこの値ではなく、組が文に添えた言語で
 * 選ぶ（`voicevox.ts` の `SpeechUtterance`）—— 読む時点でこの値を取り直すと、組が日本語へ落ちた回や、組んでから読むまでに言語が
 * 変わった回に、日本語の文を英語の声で読むような食い違いが起きる。日本語以外は端末の声で読む（VOICEVOX は日本語だけ）。
 *
 * **読み上げの部品（`voicevox.ts`）から分けて置く。** あちらは多くのテストが丸ごと偽物に差し替えるので、そこに置くと
 * 差し替えたテストでは言語が引けなくなる（読み上げを偽物にしても、文を組む言語は本物のこの値を読む）。
 */
const INITIAL: SpeechLocaleDecision = { speechLocale: 'ja', missingVoice: false }
let decision: SpeechLocaleDecision = INITIAL
const listeners = new Set<() => void>()

/** 決めの結果を置く。どちらかが変わったときだけ知らせる */
export function setSpeechLocaleDecision(next: SpeechLocaleDecision): void {
  if (next.speechLocale === decision.speechLocale && next.missingVoice === decision.missingVoice) return
  decision = { speechLocale: next.speechLocale, missingVoice: next.missingVoice }
  // 1 つの購読者が投げても、残りへは知らせる（一部だけ古い言語のまま残ると、先読みや試聴の言語が食い違う）
  for (const listener of listeners) {
    try {
      listener()
    } catch (err) {
      log.error('[tts] 読み上げの言語の切り替えを知らせる途中で失敗', err)
    }
  }
}

/** 読み上げの言語だけを替える（声が無いことは偽にする）。テストと、決めを通さずに言語を固定したい所のためのもの */
export function setSpeechLocale(locale: Locale): void {
  setSpeechLocaleDecision({ speechLocale: locale, missingVoice: false })
}

/** いまの読み上げの言語 */
export function getSpeechLocale(): Locale {
  return decision.speechLocale
}

/** いまの決めの結果（同じ値の間は同じオブジェクトを返す。React の `useSyncExternalStore` に渡せる） */
export function getSpeechLocaleDecision(): SpeechLocaleDecision {
  return decision
}

/** 読み上げの言語の決めが変わったら呼ぶ（React の `useSyncExternalStore` に渡す形）。外すための関数を返す */
export function subscribeSpeechLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function __resetSpeechLocaleForTest(): void {
  decision = INITIAL
  listeners.clear()
}
