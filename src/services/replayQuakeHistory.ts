// リプレイの開始時に復元する地震カードの履歴へ、同じ取得元で窓を読む口を付ける。
//
// 続きの読み方は取得元で違う（DMDATA は窓を読める、ローカル履歴アーカイブは収録範囲の外を持たない）。
// どの日を読むかは取得元ではなく呼び出し側が決める（→ `utils/historyDays.ts`・`useEarthquakes` の `readHistoryWindow`）。

import type { QuakeHistoryResult, ReplayQuakeHistoryResult } from '../types/replay'
import { jstDayOf } from '../utils/historyDays'

/**
 * 窓を読む口を持たない履歴にする（ローカル履歴アーカイブ。収録範囲の外を持たない）。
 *
 * @param before 開始時の窓の上端（再生を始めた時刻）
 */
export function withoutFetchWindow(result: QuakeHistoryResult, before: Date): ReplayQuakeHistoryResult {
  return { ...result, topDay: jstDayOf(before.getTime()), fetchWindow: null }
}

/**
 * DMDATA の履歴に、窓を読む口を付ける。在庫の端（`hasMore` が偽）でも口は付ける —— 期間の読み足しは
 * 在庫の端より新しい日を読むので、続きが無いことと期間の日が読めないことは別の話。「もっと見る」を出すかは
 * `hasMore` で決める（→ `useEarthquakes` の `restoreQuakeHistory`）。
 *
 * @param before 開始時の窓の上端（再生を始めた時刻）
 * @param fetchWindow 上端の時刻と日数を受け取って窓 1 つを読む
 */
export function withFetchWindow(
  result: QuakeHistoryResult,
  before: Date,
  fetchWindow: NonNullable<ReplayQuakeHistoryResult['fetchWindow']>,
): ReplayQuakeHistoryResult {
  return { ...result, topDay: jstDayOf(before.getTime()), fetchWindow }
}
