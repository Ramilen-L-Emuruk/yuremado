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
 * 訳し終えた区分だけを持つ語表（日本語以外。`speech/<言語>.ts`）。区分ごとに段を分けて訳している（段1 は緊急地震速報）。
 *
 * **全区分がそろうまで読み上げには使わない**（2026-11-17 ユーザー選択「全段そろうまで出さない」。1 つの言語の中で
 * 報ごとに日本語と訳が入れ替わらないため）。そろった言語は {@link SpeechWords} の形になり、下の `SPEECH_WORDS` へ移る。
 * それまでは読み上げの関数の組に通すテスト（`utils/ttsTextLocales.test.ts`）だけが読む。
 *
 * **ここから語表を静的に import しない。** 語表は画面の辞書（`messages/<言語>.ts`）から語を引くので、静的に読むと、言語ごとに
 * 後から読む画面の辞書（`messages.ts` の `LOADERS`）が 6 言語ぶん本体の束へ入る。移すときも言語ごとに後から読む
 */
export type SpeechWordsInProgress = {
  common: Pick<SpeechWords['common'], 'listSep' | 'sentenceSep' | 'intensity' | 'time' | 'telegramTextElsewhere'>
  eew: SpeechWords['eew']
}

/**
 * 語表を持つ言語。**ここに無い言語の画面では、読み上げは日本語の文で読む**（2026-11-16 ユーザー選択
 * 「日本語で読む＋設定に出す (Recommended)」。声も日本語の声）。全区分を訳し終えた言語だけをここへ足す（→ {@link SpeechWordsInProgress}）。
 */
const SPEECH_WORDS: Partial<Record<Locale, SpeechWords>> = {
  ja: jaSpeech,
}

/** 画面の言語の語表。持っていなければ null（呼び出し側は日本語で読む）。 */
export function speechWordsFor(locale: Locale): SpeechWords | null {
  return SPEECH_WORDS[locale] ?? null
}
