// 取得の失敗を画面へ出す文に直す。

/**
 * 通信そのものの失敗（`fetch` が `TypeError` で落ちた）か。文面はブラウザごとに違う
 * （Chrome「Failed to fetch」・Safari「Load failed」・Firefox「NetworkError when attempting to fetch resource.」）。
 * 同じ `TypeError` でもプログラムの誤り（`undefined` を読んだ等）は通信の失敗ではないので、文面まで見る。
 * 動的な読み込みの失敗（Chrome「Failed to fetch dynamically imported module」）も当たるが、配信ファイルを取れなかった失敗なので通信の失敗に数えてよい。
 */
export function isFetchNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError && /failed to fetch|load failed|networkerror/i.test(err.message)
}

/** 通信の失敗の理由として画面に出す文（2026-11-03 ユーザー選択「通信の失敗だけ日本語に (Recommended)」）。 */
export const FETCH_NETWORK_FAILURE_TEXT = '通信できませんでした'

/**
 * 取得の失敗の理由を画面へ出す文にする。通信の失敗はブラウザの英語の文を出さず {@link FETCH_NETWORK_FAILURE_TEXT}。
 * それ以外（状態番号や時間切れなど、こちらで組んだ文）はそのまま。英語の文は呼ぶ側が記録へ残す。
 */
export function fetchFailureReason(err: unknown): string {
  if (isFetchNetworkFailure(err)) return FETCH_NETWORK_FAILURE_TEXT
  return err instanceof Error ? err.message : '取得失敗'
}
