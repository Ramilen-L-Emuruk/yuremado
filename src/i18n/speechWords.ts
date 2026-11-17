import type { Locale } from './messages'
import { jaSpeech } from './speech/ja'

/**
 * 語表の値の型を広げる（画面の辞書の `Widen` と同じ作りで、文字列以外を返す関数も引数と戻り値の型のまま残す）。
 * 文字列以外を返すのは、発生の文の並び（`quake.occurrence`）のように、文の組み立てを言語へ任せる関数
 */
type WidenSpeech<T> =
  T extends string ? string
  : T extends (...args: infer A) => string ? (...args: A) => string
  : T extends (...args: infer A) => infer R ? (...args: A) => R
  : { readonly [K in keyof T]: WidenSpeech<T[K]> }

/**
 * 読み上げの文の語表の形。日本語の語表（`speech/ja.ts`）から作る（画面の辞書の `Messages` と同じ作り）。
 *
 * ほかの言語の語表を `SpeechWords` として書けば、キーの欠け・余り・関数の引数の違いが型チェックで落ちる。
 */
export type SpeechWords = WidenSpeech<typeof jaSpeech>

export { jaSpeech }

/**
 * 地震の発生の文で、その報が言える要素の文字列（`quake.occurrence` が受け取る）。言えない要素は持たない。
 *
 * - `name`: 震央地名（画面の言語の名前）
 * - `depth`: 深さの句（`quake.depthOf` か `quake.depthVeryShallowPlace`）。震央地名があるときだけ
 * - `magnitude`: 規模の句（`quake.magnitudeOf`）
 * - `magnitudeSentence`: 規模が数値でないときの文（`quake.magnitudeIs`）。`magnitude` とは同時に持たない
 */
export type QuakeOccurrenceTexts = {
  name?: string
  depth?: string
  magnitude?: string
  magnitudeSentence?: string
}

/**
 * 地震の発生の文を組む断片の並び（`quake.occurrence` が返す）。
 *
 * 要素（`name`・`depth`・`magnitude`・`magnitudeSentence`）は、読み上げの関数の組が既読の記録を付けた断片にする
 * （記録は言語によらない。→ `utils/ttsFollow.ts`）。`text` は語の断片（記録なし）。語順は言語が決める
 * （2026-11-17 ユーザー選択「言語の側で決める (Recommended)」）
 */
export type QuakeOccurrencePart =
  | { kind: 'name' | 'depth' | 'magnitude' | 'magnitudeSentence' }
  | { kind: 'text'; text: string }

/**
 * 訳し終えた区分だけを持つ語表（日本語以外。`speech/<言語>.ts`）。区分ごとに段を分けて訳している（段1 は緊急地震速報、
 * 段2 は地震情報・震度速報と共通の語、段3 は津波）。
 *
 * **全区分がそろうまで読み上げには使わない**（2026-11-17 ユーザー選択「全段そろうまで出さない」。1 つの言語の中で
 * 報ごとに日本語と訳が入れ替わらないため）。そろった言語は {@link SpeechWords} の形になり、下の `SPEECH_WORDS` へ移る。
 * それまでは読み上げの関数の組に通すテスト（`utils/ttsTextLocales.test.ts`）だけが読む。
 *
 * **ここから語表を静的に import しない。** 語表は画面の辞書（`messages/<言語>.ts`）から語を引くので、静的に読むと、言語ごとに
 * 後から読む画面の辞書（`messages.ts` の `LOADERS`）が 6 言語ぶん本体の束へ入る。移すときも言語ごとに後から読む
 */
export type SpeechWordsInProgress = {
  common: SpeechWords['common']
  eew: SpeechWords['eew']
  quake: SpeechWords['quake']
  tsunami: SpeechWords['tsunami']
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
