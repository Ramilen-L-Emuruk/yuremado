import type { Locale } from './messages'
import { jaSpeech } from './speech/ja'
import { log } from '../utils/logger'

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
 * 国際津波関連情報の本文で、その報が言える要素（`internationalTsunami.body` が受け取る）。言えない要素は null。
 *
 * - `when`: 発生時刻（`internationalTsunami.when` で組んだ文字列。日本時間）
 * - `where`: 震源（地震カードに結べたときは画面の言語の震源名、結べなければ `internationalTsunami.coordinate` の文字列）
 * - `depthKm`: 深さ（電文にあるときだけ。100 km 以深の地震だけ書かれる）
 * - `magnitude`: 規模（小数 1 桁の文字列。小数点の言い方は言語が直す）
 * - `evaluation`: 津波発生の可能性（`internationalTsunami.evaluation` の文）。読めない報は null（言語は「情報が発表された」で結ぶ）
 */
export type InternationalTsunamiSpeechParts = {
  when: string | null
  where: string | null
  depthKm: number | null
  magnitude: string | null
  evaluation: string | null
}

/**
 * 語表を持つ言語。日本語は起動の束に入れ、ほかの言語は画面の辞書と同じ読み込みで後から読んで登録する
 * （→ `messages.ts` の `LOADERS`。2026-11-18 ユーザー選択「辞書と一緒に後から読む (Recommended)」）。
 * **登録されていない言語の画面では、読み上げは日本語の文で読む**（2026-11-16 ユーザー選択「日本語で読む＋設定に出す (Recommended)」。
 * 声も日本語の声。語表を読めなかった言語もここへ来る）。
 *
 * **ここから日本語以外の語表を静的に import しない。** 語表は画面の辞書（`messages/<言語>.ts`）から語を引くので、静的に読むと、
 * 言語ごとに後から読む画面の辞書が 6 言語ぶん起動の束へ入る（`utils/ttsTextLocaleImports.test.ts` が止める）
 */
const SPEECH_WORDS: Partial<Record<Locale, SpeechWords>> = {
  ja: jaSpeech,
}

const speechWordsListeners = new Set<() => void>()

/** 画面の言語の語表。持っていなければ null（呼び出し側は日本語で読む）。 */
export function speechWordsFor(locale: Locale): SpeechWords | null {
  return SPEECH_WORDS[locale] ?? null
}

/**
 * 日本語以外の語表を登録する（`messages.ts` の読み込みが、画面の辞書を返す前に呼ぶ）。初めて登録したときだけ知らせる
 * （読み上げの言語の決め直し。→ `hooks/useSpeechLocale.ts`）
 */
export function registerSpeechWords(locale: Exclude<Locale, 'ja'>, words: SpeechWords): void {
  if (SPEECH_WORDS[locale] === words) return
  SPEECH_WORDS[locale] = words
  // 1 つの購読者が投げても、残りへは知らせる（言語の決め直しが一部だけ漏れないように）
  for (const listener of speechWordsListeners) {
    try {
      listener()
    } catch (err) {
      log.error('[tts] 読み上げの語表の登録を知らせる途中で失敗', err)
    }
  }
}

/** 語表が登録されたら呼ぶ。外すための関数を返す */
export function subscribeSpeechWords(listener: () => void): () => void {
  speechWordsListeners.add(listener)
  return () => { speechWordsListeners.delete(listener) }
}

export function __resetSpeechWordsForTest(): void {
  for (const key of Object.keys(SPEECH_WORDS) as Locale[]) {
    if (key !== 'ja') delete SPEECH_WORDS[key]
  }
  speechWordsListeners.clear()
}
