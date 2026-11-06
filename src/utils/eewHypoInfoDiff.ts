// 強震モニタ（Yahoo）の緊急地震速報の一覧（hypoInfo）を、前回と今回で比べて報に直す。強震モニタの取得（`services/kyoshin`）に
// 依るので、緊急地震速報の共通の判定（`eew.ts`。中継のプッシュ通知も写して使う）とは分けて置く。

import type { EEWAlert } from '../types/earthquake'
import { hypoInfoItemToEEW, type YahooHypoInfoItem } from '../services/kyoshin'

// Yahoo hypoInfo（強震モニタのEEW一覧）は1秒間隔のポーリングで取得するスナップショットのため、
// ネットワーク遅延や配信タイミングのブレで対象 reportId が1回だけ欠落することがある。
// 消滅を即座に解除確定にすると、JMAの取消電文が無いのに解除扱いになってしまうため、
// この回数分は猶予を持って様子を見る（復活すれば何も起きない）。
const HYPO_INFO_MISSING_CONFIRM_TICKS = 2

/** hypoInfo 消滅の連続検出回数を reportId ごとに追跡する状態。 */
export interface HypoInfoPendingMissing {
  item: YahooHypoInfoItem
  missingTicks: number
}

/**
 * Yahoo hypoInfo の前回・今回スナップショットを比較し、新規発報・続報・解除に相当する
 * EEWAlert を導出する。消滅（前回まで追跡していた reportId が今回に無い）は
 * HYPO_INFO_MISSING_CONFIRM_TICKS 回連続で確認できて初めて解除を確定する。
 *
 * 解除確定時、直前に isCancel=true を確認できていれば「誤報取消」として cancelled のみ立てる。
 * それ以外（終わった速報が一覧から外れた・欠測から戻らなかった）は expired と `vanishedFromList` を立てた自動解除を出す。
 * 受け口はこの自動解除をその場では当てず、最終報から積む自動解除と同じ待ち（揺れ検知が広がっている間は待つ。
 * eew-spec §7）を通してから消す（2026-11-06 ユーザー選択「消えたら①と同じ待ちを通す (Recommended)」）。
 * 強震モニタは最終報を出さずに一覧から外すことがあり、そのときはこの報が速報を終わらせる唯一の合図になる。
 * expired は誤報取消の音・通知（useLiveEventHandler の !event.expired かつ hadKey=true 分岐）を鳴らさないための印。
 */
export function diffHypoInfoEvents(
  prev: YahooHypoInfoItem[],
  curr: YahooHypoInfoItem[],
  prevPendingMissing: ReadonlyMap<string, HypoInfoPendingMissing>,
): { events: EEWAlert[]; pendingMissing: Map<string, HypoInfoPendingMissing> } {
  const events: EEWAlert[] = []
  const currMap = new Map(curr.map(it => [it.reportId, it]))

  // 直前まで追跡していた全アイテム（前回スナップショット ∪ 消滅猶予中のアイテム）。
  // 猶予中の reportId は呼び出し元の設計上 prev には含まれない（消滅した回の prev からは
  // 既に消えている）ため重複は起きないはずだが、念のため has チェックで安全側に倒す。
  const trackedItems = new Map<string, YahooHypoInfoItem>()
  for (const it of prev) trackedItems.set(it.reportId, it)
  for (const [id, pending] of prevPendingMissing) {
    if (!trackedItems.has(id)) trackedItems.set(id, pending.item)
  }

  // 新規発報・報番号更新
  for (const item of curr) {
    const prevItem = trackedItems.get(item.reportId)
    const isNew = !prevItem
    const isUpdated = !!prevItem && item.reportNum !== prevItem.reportNum
    if (isNew || isUpdated) {
      events.push(hypoInfoItemToEEW(item))
    }
  }

  // 消滅判定（猶予つき）: リストに復活したものは pendingMissing に残さずここで消える
  const pendingMissing = new Map<string, HypoInfoPendingMissing>()
  for (const [reportId, item] of trackedItems) {
    if (currMap.has(reportId)) continue
    const missingTicks = (prevPendingMissing.get(reportId)?.missingTicks ?? 0) + 1
    if (missingTicks < HYPO_INFO_MISSING_CONFIRM_TICKS) {
      pendingMissing.set(reportId, { item, missingTicks })
      continue
    }
    // 消える直前に確認できていた isCancel の値をそのまま尊重する（誤報取消 か 自動終了 かの分岐）
    const cancelledEEW = hypoInfoItemToEEW(item)
    events.push(item.isCancel === 'true'
      ? { ...cancelledEEW, cancelled: true }
      : { ...cancelledEEW, cancelled: true, expired: true, vanishedFromList: true })
  }

  return { events, pendingMissing }
}
