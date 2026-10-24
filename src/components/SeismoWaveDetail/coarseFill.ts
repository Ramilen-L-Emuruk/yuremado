// 詳細の窓で、**生のサンプルを取れなかった区間**をカードの列（上下の端）で埋める（2026-10-22 選択
// 「取れた区間だけ生で描き、残りは粗い絵」）。
//
// 以前は分割した取得が 1 つでも失敗すると生のサンプルを丸ごと捨て、窓全体を粗い絵で描いていた。取れた区間まで
// 粗くなるうえ、どこが取れなかったのかも分からない。取れた区間は生で描き、取れなかった区間だけをここで埋めて、
// 境目に線を引き淡く塗る（文言は足さない。2026-10-13「文言を足さない」に揃える）。

import type { TimedColumns } from '../../utils/seismoWaveColumns'
import type { LaneGeometry } from './sampleSeries'
import type { ViewRange } from './detailView'

/** 区間 `[fromMs, toMs)`。 */
export interface MsRange {
  readonly fromMs: number
  readonly toMs: number
}

/** 見えている範囲に掛かる、取れなかった区間を横の比（0〜1）で返す。**掛からなければ空。** */
export function missingRatios(missing: readonly MsRange[], view: ViewRange): { fromRatio: number; toRatio: number }[] {
  const span = view.toMs - view.fromMs
  if (!(span > 0)) return []
  const out: { fromRatio: number; toRatio: number }[] = []
  for (const m of missing) {
    const from = Math.max(m.fromMs, view.fromMs)
    const to = Math.min(m.toMs, view.toMs)
    if (to <= from) continue
    out.push({ fromRatio: (from - view.fromMs) / span, toRatio: (to - view.fromMs) / span })
  }
  return out
}

/**
 * 取れなかった区間だけを、カードの列の上下の端で 1 デバイスピクセルごとに描く形にする（それ以外は `NaN`）。
 *
 * @param component 成分の番号（0〜2）か、合成（`'composite'`。下端は 0、上端は合成の上端）
 */
export function coarseGeometry(params: {
  readonly columns: TimedColumns
  readonly missing: readonly MsRange[]
  readonly view: ViewRange
  readonly widthPx: number
  readonly component: 0 | 1 | 2 | 'composite'
}): LaneGeometry {
  const { columns, missing, view, component } = params
  const w = Math.max(1, Math.floor(params.widthPx))
  const min = new Float32Array(w).fill(Number.NaN)
  const max = new Float32Array(w).fill(Number.NaN)
  const span = view.toMs - view.fromMs
  const colSpan = columns.columnSpanMs
  if (!(span > 0) || !(colSpan > 0) || missing.length === 0) return { kind: 'envelope', min, max }
  for (let c = 0; c < w; c += 1) {
    const t = view.fromMs + ((c + 0.5) / w) * span
    if (!missing.some((m) => t >= m.fromMs && t < m.toMs)) continue
    const col = columns.columns[Math.floor((t - columns.fromMs) / colSpan)]
    if (col === null || col === undefined) continue
    if (component === 'composite') {
      if (!Number.isFinite(col.magMax)) continue
      min[c] = 0
      max[c] = col.magMax
    } else {
      const lo = col.min[component]
      const hi = col.max[component]
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue
      min[c] = lo
      max[c] = hi
    }
  }
  return { kind: 'envelope', min, max }
}

/**
 * 見えている範囲に掛かる、取れなかった区間の振れのいちばん大きい値（絶対値）。**無ければ `NaN`。**
 * 縦の物差しに入れる —— 入れないと、粗い絵の側の大きな揺れが段の外へはみ出す。
 */
export function coarseMaxAbs(
  columns: TimedColumns,
  missing: readonly MsRange[],
  view: ViewRange,
  component: 0 | 1 | 2 | 'composite',
): number {
  const colSpan = columns.columnSpanMs
  if (!(colSpan > 0)) return Number.NaN
  let best = Number.NaN
  for (const m of missing) {
    const from = Math.max(m.fromMs, view.fromMs)
    const to = Math.min(m.toMs, view.toMs)
    if (to <= from) continue
    const i0 = Math.max(0, Math.floor((from - columns.fromMs) / colSpan))
    const i1 = Math.min(columns.columns.length, Math.ceil((to - columns.fromMs) / colSpan))
    for (let i = i0; i < i1; i += 1) {
      const col = columns.columns[i]
      if (col === null) continue
      const v =
        component === 'composite'
          ? col.magMax
          : Math.max(Math.abs(col.min[component]), Math.abs(col.max[component]))
      if (Number.isFinite(v) && !(v <= best)) best = v
    }
  }
  return best
}
