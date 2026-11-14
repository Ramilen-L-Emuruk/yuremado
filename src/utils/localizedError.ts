// 画面に届くエラーの文を、言語の辞書で組めるようにする。
//
// エラーには文の鍵と引数（`ErrorText`。辞書の `errorText` の関数の名前と、その引数）を持たせる（→ `keyedError.ts`）。`message` は
// 日本語の文のまま（ログと記録に残るのは日本語）。画面に出す所は {@link errorTextOf} で鍵を引き、あれば {@link renderErrorText} で
// いまの言語の文にし、無ければ `message` を出す。
//
// 引数の文字列の位置には、別の `ErrorText` も入れられる（K-NET の失敗の一覧に、ファイルごとの失敗の文を入れるとき）。
// 描くときに中の `ErrorText` から先に文にする。
//
// **このファイルは辞書を読む。** 自作地震計のホスト・生成スクリプトも読むファイル（`utils/knet`・`dmdataApiKey.ts`）は
// ここを読まず、`keyedError.ts` の `KeyedError` に日本語の文を渡す。
import type { Messages } from '../i18n/messages'
import { ja } from '../i18n/messages/ja'
import { KeyedError, errorTextOf, isErrorText, type ErrorText } from './keyedError'

export type { ErrorText }
export { errorTextOf }

/** 文を組む語（辞書の `errorText`） */
export type ErrorTextWords = Messages['errorText']
export type ErrorTextKey = keyof ErrorTextWords

/** 引数の文字列の位置に `ErrorText` も入れられる形 */
type Loose<T> = T extends string ? string | ErrorText : T extends readonly (infer U)[] ? readonly Loose<U>[] : T
type ErrorTextArgs<K extends ErrorTextKey> = { [I in keyof Parameters<ErrorTextWords[K]>]: Loose<Parameters<ErrorTextWords[K]>[I]> }

/** 文の鍵と引数を組む（型で、鍵ごとの引数の並びを確かめる） */
export function errorText<K extends ErrorTextKey>(key: K, ...args: ErrorTextArgs<K>): ErrorText {
  return { key, args }
}

function renderArg(v: unknown, w: ErrorTextWords): unknown {
  // 中の文がこの言語の辞書に無くても、空にはしない（原因が文から消える）。日本語の文、それも無ければ鍵の名前を出す
  if (isErrorText(v)) return renderErrorText(v, w) ?? renderErrorText(v, ja.errorText) ?? v.key
  if (Array.isArray(v)) return v.map(x => renderArg(x, w))
  return v
}

/** 文の鍵と引数を、渡した言語の辞書で文にする。辞書に無い鍵は undefined */
export function renderErrorText(t: ErrorText, w: ErrorTextWords): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(w, t.key)) return undefined
  const fn = w[t.key as ErrorTextKey] as (...args: unknown[]) => string
  return fn(...t.args.map(a => renderArg(a, w)))
}

/** 日本語の文（エラーの `message` と、記録に残す文） */
export function jaErrorText(t: ErrorText): string {
  return renderErrorText(t, ja.errorText) ?? t.key
}

/**
 * 鍵と引数を持ち、`message` を日本語の辞書で組むエラー（ブラウザだけで読むファイル用）。
 * `message` に別の日本語の文を入れたいとき（差し込む名前が言語で変わるとき）は `message` を渡す
 */
export class LocalizedError extends KeyedError {
  constructor(text: ErrorText, message: string = jaErrorText(text)) {
    super(message, text)
    this.name = 'LocalizedError'
  }
}

/** 画面に出す文。鍵があれば言語の辞書で組み、無ければ `message`（エラーでない値は文字列にする） */
export function screenErrorMessage(err: unknown, w: ErrorTextWords): string {
  const t = errorTextOf(err)
  const text = t !== undefined ? renderErrorText(t, w) : undefined
  if (text !== undefined) return text
  return err instanceof Error ? err.message : String(err)
}
