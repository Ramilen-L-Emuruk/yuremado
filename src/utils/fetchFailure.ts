// 取得の失敗を画面へ出す文に直す。
import { jaErrorText, errorText, errorTextOf, renderErrorText, type ErrorTextWords } from './localizedError'

/**
 * 通信そのものの失敗（`fetch` が `TypeError` で落ちた）か。文面はブラウザごとに違う
 * （Chrome「Failed to fetch」・Safari「Load failed」・Firefox「NetworkError when attempting to fetch resource.」）。
 * 同じ `TypeError` でもプログラムの誤り（`undefined` を読んだ等）は通信の失敗ではないので、文面まで見る。
 * 動的な読み込みの失敗（Chrome「Failed to fetch dynamically imported module」）も当たるが、配信ファイルを取れなかった失敗なので通信の失敗に数えてよい。
 */
export function isFetchNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError && /failed to fetch|load failed|networkerror/i.test(err.message)
}

/**
 * 通信の失敗の理由として画面に出す文の日本語（2026-11-03 ユーザー選択「通信の失敗だけ日本語に (Recommended)」）。
 * 語は辞書の `errorText.networkFailure`
 */
export const FETCH_NETWORK_FAILURE_TEXT = jaErrorText(errorText('networkFailure'))

/**
 * 取得の失敗の理由を画面へ出す文にする。`w` は画面の言語の辞書の `errorText`（記録に残す文は日本語の辞書を渡す）。
 *
 * - 通信の失敗はブラウザの英語の文を出さず「通信できませんでした」の語。英語の文は呼ぶ側が記録へ残す
 * - 文の鍵と引数を持つエラー（中継の札・時間切れ・API キー・アーカイブの一覧など。→ `localizedError.ts`）は、言語の辞書で組む
 * - それ以外（こちらで組んだ文で、鍵を持たないもの）は `message` のまま
 */
export function fetchFailureReason(err: unknown, w: ErrorTextWords): string {
  if (isFetchNetworkFailure(err)) return w.networkFailure()
  const t = errorTextOf(err)
  const text = t !== undefined ? renderErrorText(t, w) : undefined
  if (text !== undefined) return text
  // 文の無いエラー（`message` が空）は空のまま返す。呼ぶ側が「理由なし」として括弧を付けずに出す（`EarthquakeTab`）
  return err instanceof Error ? err.message : w.fetchFailed()
}
