// 地図の生成データが欠けたときに出す 1 行（`components/MapDataStatus.tsx`）。
//
// 文面は 2026-10-25 ユーザー選択「この文面で、名前は短く (Recommended)」——
// 取り直している間は「県境・活断層を取り込めず（取り直しています）」、諦めた後は
// 「県境・活断層を取り込めず（再読み込みで取得し直します）」。名前は 3 つまで並べ、超えたら「ほかN件」。
// 語は辞書の `mapCorner`（`dataNames`・`unknownData`・`dataNameList`・`dataLoadFailed`）。
import type { Messages } from '../i18n/messages'
import type { DataLoadFailure } from './fetchJson'

/** 文を組む語（辞書の地図の隅の節） */
export type MapDataStatusWords = Pick<Messages['mapCorner'], 'dataNames' | 'unknownData' | 'dataNameList' | 'dataLoadFailed'>

/** 名前を並べる上限。超えた分は「ほかN件」にまとめる。 */
export const MAX_LISTED_NAMES = 3

/** 取得の名前（`fetchJsonWithTimeout` の `label`）→ 画面に出す名前。**表に無い名前の英字をそのまま画面に出さない。** */
export function dataDisplayName(label: string, w: MapDataStatusWords): string {
  return Object.prototype.hasOwnProperty.call(w.dataNames, label) ? w.dataNames[label] : w.unknownData
}

/**
 * 欠けているデータの 1 行。欠けが無ければ `null`。
 *
 * **1 つでも諦めたものがあれば「再読み込みで取得し直します」にする** —— 待っても戻らないものが
 * 混ざっているのに「取り直しています」と出すと、利用者は待ち続けることになる。
 */
export function mapDataFailureText(failures: readonly DataLoadFailure[], w: MapDataStatusWords): string | null {
  if (failures.length === 0) return null
  // 表に無い名前が複数あっても「地図のデータ」を 1 回だけ出す
  const names = [...new Set(failures.map(f => dataDisplayName(f.label, w)))]
  const rest = names.length - MAX_LISTED_NAMES
  const subject = w.dataNameList(names.slice(0, MAX_LISTED_NAMES), Math.max(0, rest))
  return w.dataLoadFailed(subject, failures.some(f => f.state === 'gaveUp'))
}
