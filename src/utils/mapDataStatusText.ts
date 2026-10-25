// 地図の生成データが欠けたときに出す 1 行（`components/MapDataStatus.tsx`）。
//
// 文面は 2026-10-25 ユーザー選択「この文面で、名前は短く (Recommended)」——
// 取り直している間は「県境・活断層を取り込めず（取り直しています）」、諦めた後は
// 「県境・活断層を取り込めず（再読み込みで取得し直します）」。名前は 3 つまで並べ、超えたら「ほかN件」。
import type { DataLoadFailure } from './fetchJson'

/** 取得の名前（`fetchJsonWithTimeout` の `label`）→ 画面に出す名前。 */
const DATA_NAMES: Readonly<Record<string, string>> = {
  prefectures: '県境',
  subregions: '区域の境界',
  'station-coords': '観測点の位置',
  'tsunami-zones': '津波予報区',
  'active-faults': '活断層',
  'plate-boundaries': 'プレート境界',
  'tsunami-obs-coords': '津波観測点の位置',
  'public-stations': '公開観測点',
}

/** 表に無い名前のときに出す語。**取得の名前（英字）をそのまま画面に出さない。** */
const UNKNOWN_NAME = '地図のデータ'

/** 名前を並べる上限。超えた分は「ほかN件」にまとめる。 */
export const MAX_LISTED_NAMES = 3

export function dataDisplayName(label: string): string {
  return DATA_NAMES[label] ?? UNKNOWN_NAME
}

/**
 * 欠けているデータの 1 行。欠けが無ければ `null`。
 *
 * **1 つでも諦めたものがあれば「再読み込みで取得し直します」にする** —— 待っても戻らないものが
 * 混ざっているのに「取り直しています」と出すと、利用者は待ち続けることになる。
 */
export function mapDataFailureText(failures: readonly DataLoadFailure[]): string | null {
  if (failures.length === 0) return null
  // 表に無い名前が複数あっても「地図のデータ」を 1 回だけ出す
  const names = [...new Set(failures.map(f => dataDisplayName(f.label)))]
  const listed = names.slice(0, MAX_LISTED_NAMES).join('・')
  const rest = names.length - MAX_LISTED_NAMES
  const subject = rest > 0 ? `${listed}ほか${rest}件` : listed
  const action = failures.some(f => f.state === 'gaveUp') ? '再読み込みで取得し直します' : '取り直しています'
  return `${subject}を取り込めず（${action}）`
}
