// リプレイの開始時に復元する地震カードの履歴へ、再生中の「もっと見る」で続きを読む口を付ける。
//
// 続きの読み方は取得元で違う（DMDSS 版はカーソル、標準版は `offset`）。標準版の口は取得と
// 持ち越しが絡むので `p2pquakeReplay.ts` が自分で付け、ここには DMDSS 版とローカル履歴アーカイブの
// 分だけを置く。

import type { QuakeHistoryResult, ReplayQuakeHistoryResult } from '../types/replay'
import { historyCursorFromOldestDay } from '../utils/historyCursor'
import { log } from '../utils/logger'

/**
 * 続きを持たない履歴にする（ローカル履歴アーカイブ。収録範囲の外を持たない）。
 */
export function withoutLoadMore(result: QuakeHistoryResult): ReplayQuakeHistoryResult {
  return { ...result, loadMore: null }
}

/**
 * DMDSS 版の履歴に、続きを読む口を付ける。
 *
 * **続きの上端は、読み切った最古の日の手前**（`historyCursorFromOldestDay`。ライブの「もっと見る」と
 * 同じ計算）。窓どうしが重ならないので、押しても読んだ日を読み直さない。
 *
 * **上端は、この結果を読んだ窓の上端（`before`）より新しくしない。** 上端が無い・読めないとき
 * （窓の最新の日を読み切れなかった＝429 の窓や取得の失敗）は、同じ窓をもう一度読む。ライブの経路と
 * 違って `serverDate()`（いま）へは落とさない —— 落とすと再生時刻より未来の地震が一覧に並ぶ。
 *
 * 在庫の端（`hasMore` が偽）なら口を付けない。
 *
 * @param result 窓 1 つぶんを読んだ結果
 * @param before その窓の上端
 * @param fetchWindow 上端を受け取って窓 1 つぶんを読む
 */
export function withDmdataLoadMore(
  result: QuakeHistoryResult,
  before: Date,
  fetchWindow: (before: Date, signal: AbortSignal | null) => Promise<QuakeHistoryResult>,
): ReplayQuakeHistoryResult {
  if (!result.hasMore) return { ...result, loadMore: null }
  const cursor = historyCursorFromOldestDay(result.oldestLoadedDay)
  let next = before
  if (cursor === null) {
    // **429 の待機と本物の不具合を混ぜない**（ライブの「もっと見る」と同じ判定）。429 は待てば
    // 解ける正常な足踏みで、警告にすると押すたび出続けて診断の価値が落ちる。
    if (result.rateLimitedSources.length > 0) {
      log.info('[replay] 履歴のカーソルは進みませんでした（429 の窓が明けるまでの足踏み）')
    } else {
      log.warn('[replay] 履歴のカーソルが進みませんでした（次に押すと同じ範囲を読み直します）')
    }
  } else if (cursor.getTime() < before.getTime()) {
    next = cursor
  } else {
    // 取得側は窓の中の日しか返さないので通常は起きない。起きたら上端を進めずに記録する
    log.warn(`[replay] 履歴のカーソルが窓の上端より新しいため、同じ範囲を読み直します: cursor=${cursor.toISOString()} before=${before.toISOString()}`)
  }
  return {
    ...result,
    loadMore: async (signal) => withDmdataLoadMore(await fetchWindow(next, signal), next, fetchWindow),
  }
}
