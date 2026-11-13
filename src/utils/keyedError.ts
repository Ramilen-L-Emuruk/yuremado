// 画面に届くエラーが持つ「文の鍵と引数」の形。**何も読み込まない**（自作地震計のホスト・生成スクリプトも読むファイルが使うため。
// 辞書を読むと、ブラウザ用のファイルまで連れ込む）。辞書で文にするのは `utils/localizedError.ts`。

/** 文の鍵（辞書の `errorText` の関数の名前）と、その引数の並び。引数の文字列の位置には別の `ErrorText` も入れられる */
export interface ErrorText {
  readonly key: string
  readonly args: readonly unknown[]
}

/**
 * 文の鍵と引数を持つエラー。`message` は日本語の文（ログと記録に残る）。辞書を読めないファイルは、辞書の日本語と同じ文を
 * `message` に書いて渡す（同じ字面であることは `utils/keyedError.test.ts` が突き合わせる）
 */
export class KeyedError extends Error {
  constructor(message: string, readonly errorText: ErrorText) {
    super(message)
    this.name = 'KeyedError'
  }
}

export function isErrorText(v: unknown): v is ErrorText {
  return typeof v === 'object' && v !== null && typeof (v as ErrorText).key === 'string' && Array.isArray((v as ErrorText).args)
}

/** エラーが持つ文の鍵と引数（持たなければ undefined。中継の札・時間切れ・API キーの型も同じ欄 `errorText` を持つ） */
export function errorTextOf(err: unknown): ErrorText | undefined {
  if (!(err instanceof Error)) return undefined
  const t = (err as { errorText?: unknown }).errorText
  return isErrorText(t) ? t : undefined
}

/** 文の引数に入れる失敗の文。鍵を持つエラーならその鍵と引数（描くときに言語の辞書で組む）、無ければ `message` */
export function errorDetailOf(err: unknown): ErrorText | string {
  return errorTextOf(err) ?? (err instanceof Error ? err.message : String(err))
}

/** {@link KeyedError} を組む（日本語の文と、辞書の鍵とその引数） */
export function keyedError(message: string, key: string, ...args: unknown[]): KeyedError {
  return new KeyedError(message, { key, args })
}
