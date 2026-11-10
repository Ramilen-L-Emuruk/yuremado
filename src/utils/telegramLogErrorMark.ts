/**
 * 電文ログの行の赤字の欄（`TelegramLogEntry.errorMessage`）に入れる印。受信の側（`services/dmdata.ts`・
 * `dmdataReplay.ts`・`dmdataReplayLive.ts`）はここから入れ、画面は辞書の `telegramLog.errorMessage` で文にする。
 * 日本語の辞書はこの型で鍵を縛るので、印を足して辞書へ書き忘れると型検査が落とす。
 *
 * 値は書き出す JSON とダウンロードにもそのまま残る印なので、言語では変えない。
 */
export const TELEGRAM_LOG_ERROR = {
  /** 本文を復号できなかった（本文の形・未対応の圧縮・復号の例外） */
  bodyDecodeFailed: 'body decode failed',
  /** 結合した推計震度分布図（BUFR）を読めなかった */
  bufrDecodeFailed: 'bufr decode failed',
  /** リプレイで電文の本文を取れなかった */
  fetchFailed: '本文を取得できませんでした',
} as const

export type TelegramLogErrorMark = (typeof TELEGRAM_LOG_ERROR)[keyof typeof TELEGRAM_LOG_ERROR]
