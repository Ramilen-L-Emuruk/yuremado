import type { Locale, Widen } from './messages'
import { jaSpeech } from './speech/ja'

/**
 * 読み上げの文の語表の形。日本語の語表（`speech/ja.ts`）から作る（画面の辞書の `Messages` と同じ作り）。
 *
 * ほかの言語の語表を `SpeechWords` として書けば、キーの欠け・余り・関数の引数の違いが型チェックで落ちる。
 */
export type SpeechWords = Widen<typeof jaSpeech>

export { jaSpeech }

/**
 * 語表を持つ言語。**ここに無い言語の画面では、読み上げは日本語の文で読む**（2026-11-16 ユーザー選択
 * 「日本語で読む＋設定に出す (Recommended)」。声も日本語の声）。ほかの言語の語表はまだ無い。
 */
const SPEECH_WORDS: Partial<Record<Locale, SpeechWords>> = {
  ja: jaSpeech,
}

/** 画面の言語の語表。持っていなければ null（呼び出し側は日本語で読む）。 */
export function speechWordsFor(locale: Locale): SpeechWords | null {
  return SPEECH_WORDS[locale] ?? null
}
