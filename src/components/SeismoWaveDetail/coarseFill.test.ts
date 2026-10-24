import { describe, expect, it } from 'vitest'
import { coarseGeometry, coarseMaxAbs, missingRatios } from './coarseFill'
import type { TimedColumns } from '../../utils/seismoWaveColumns'

const col = (v: number) => ({ min: [-v, -v, -v] as const, max: [v, v, v] as const, minMembers: 3, magMin: 0, magMax: v * 2, magSum: Number.NaN, magCount: 0 })
/** 0〜1000 ms を 100 ms の列 10 本。値は列の番号。 */
const COLUMNS: TimedColumns = { fromMs: 0, columnSpanMs: 100, columns: Array.from({ length: 10 }, (_, i) => col(i)) }
const VIEW = { fromMs: 0, toMs: 1000 }

describe('coarseFill', () => {
  it('正: 取れなかった区間だけを列の上下の端で埋める', () => {
    const g = coarseGeometry({ columns: COLUMNS, missing: [{ fromMs: 500, toMs: 700 }], view: VIEW, widthPx: 10, component: 0 })
    expect(g.kind).toBe('envelope')
    if (g.kind !== 'envelope') return
    expect([...g.max].map((v) => (Number.isNaN(v) ? null : v))).toEqual([null, null, null, null, null, 5, 6, null, null, null])
  })

  it('対照: 取れなかった区間が無ければ全部 NaN（粗い絵を描かない）', () => {
    const g = coarseGeometry({ columns: COLUMNS, missing: [], view: VIEW, widthPx: 10, component: 0 })
    if (g.kind !== 'envelope') throw new Error('envelope でない')
    expect([...g.max].every(Number.isNaN)).toBe(true)
  })

  it('安全弁: 見えている範囲の外の欠けは塗らず、物差しにも入れない', () => {
    expect(missingRatios([{ fromMs: 2000, toMs: 3000 }], VIEW)).toEqual([])
    expect(coarseMaxAbs(COLUMNS, [{ fromMs: 2000, toMs: 3000 }], VIEW, 0)).toBeNaN()
  })

  it('物差しは欠けの中の最大（合成は列の合成の上端）', () => {
    expect(coarseMaxAbs(COLUMNS, [{ fromMs: 500, toMs: 700 }], VIEW, 1)).toBe(6)
    expect(coarseMaxAbs(COLUMNS, [{ fromMs: 500, toMs: 700 }], VIEW, 'composite')).toBe(12)
    expect(missingRatios([{ fromMs: 500, toMs: 700 }], VIEW)).toEqual([{ fromRatio: 0.5, toRatio: 0.7 }])
  })
})
