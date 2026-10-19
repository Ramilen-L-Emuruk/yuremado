// 縦の下限（`WaveUnit.minScale`）は、どの物差しを渡しても有限の正の値を返す。
// 描く側（`paintWave.ts`）は縦の倍率が 0 以下になる場合を見ない —— 倍率は
// 「この下限」と「0 以上の振れの最大」の大きいほうなので、下限が正なら必ず正になる。

import { describe, it, expect } from 'vitest'
import { PUBLIC_WAVE_UNIT, SEISMO_WAVE_UNIT, type LiveScaleUse } from './waveUnit'
import { quietScaledGal } from '../../utils/seismoQuietScale'

const QUIET_LEVELS: readonly (number | null)[] = [
  null,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  0,
  -1,
  1e-9,
  1e9,
]
const USES: readonly LiveScaleUse[] = ['card', 'detail']

describe('縦の下限は必ず有限の正の値', () => {
  for (const [name, unit] of [['自作地震計', SEISMO_WAVE_UNIT], ['公開観測点', PUBLIC_WAVE_UNIT]] as const) {
    it(`正: ${name}の下限は、壊れた物差しを渡しても有限の正の値`, () => {
      for (const use of USES) {
        for (const level of QUIET_LEVELS) {
          const v = unit.minScale(use, level)
          expect(Number.isFinite(v), `${use} / ${String(level)}`).toBe(true)
          expect(v, `${use} / ${String(level)}`).toBeGreaterThan(0)
        }
      }
    })
  }

  // 対照: 読める物差しでは、物差しに比例した値を返す（下限の受け皿に張り付かない）。
  it('対照: 読める物差しでは物差しに比例する', () => {
    expect(SEISMO_WAVE_UNIT.minScale('card', 1)).toBeCloseTo(2 * SEISMO_WAVE_UNIT.minScale('card', 0.5))
    expect(PUBLIC_WAVE_UNIT.minScale('detail', 1)).toBeCloseTo(2 * PUBLIC_WAVE_UNIT.minScale('detail', 0.5))
  })

  // 安全弁: カードの繋ぎ足しを止める「収まった」の閾値（同じ関数の別の用途）も同じく正。
  it('安全弁: 「収まった」の閾値も有限の正の値', () => {
    for (const level of QUIET_LEVELS) {
      const v = quietScaledGal('settle', level)
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThan(0)
    }
  })
})
