import { log } from './logger'

/**
 * 地震カードの履歴を、次にどこから先へ遡るか（次の窓の上端）。
 *
 * **DMDSS 版の「もっと見る」はこのカーソルを進めて呼び直す**（ライブ・リプレイとも）。窓どうしが
 * 重ならないので、押しても既に読んだ日を読み直さない。区切りは日数（`HISTORY_WINDOW_DAYS`）で、
 * 1 回押すたびに窓 1 つぶんを丸ごと読む。
 *
 * **遡れる範囲に上限は置かない。** 在庫はアーカイブの保存開始（地震津波関連は 2020-11-18）まで
 * あり、目録が空になった時点で `hasMore` が偽になって自然に止まる。
 *
 * `null` は「続きの位置がまだ決まっていない」。P2PQuake 版は `offset` で遡るので使わない。
 */
export type HistoryCursor = Date | null

/**
 * 読み終えた最古の JST 日から、次の窓の上端を作る。
 *
 * その日は丸ごと読み切っているので、**上端はその日の直前**（前日の 23:59:59.999 JST）。
 * 取得側は `entryTime > before` で捨てるため、同じ日を二度読まずに続きへ進める。
 *
 * **日付として読めなければ `null` を返す。** `Date.parse` の `NaN` をそのまま渡すと、窓の両端が
 * `NaN` になって目録を 1 件も引けなくなる。値は目録の `date` 由来なので通常は起きないが、
 * 起きたら記録を残す —— 画面には「押しても増えない」としか出ない。`null` を受けた側が何をするか
 * （同じ窓を読み直す）は呼び出し側が決める。
 */
export function historyCursorFromOldestDay(day: string | null): HistoryCursor {
  if (!day) return null
  const ms = Date.parse(`${day}T00:00:00+09:00`)
  if (!Number.isFinite(ms)) {
    log.warn(`[data] 履歴のカーソルを日付として読めませんでした（次は同じ範囲を読み直します）: ${day}`)
    return null
  }
  return new Date(ms - 1)
}
