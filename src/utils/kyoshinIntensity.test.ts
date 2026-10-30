import { describe, expect, it } from 'vitest'
import { detectionScaleLabelFromValue, kyoshinDetectionScaleLabel, kyoshinIndexToLabel, kyoshinSubZeroStep, KYOSHIN_SUB_ZERO_COLOR, KYOSHIN_SUB_ZERO_STEP_COLORS } from './kyoshinIntensity'
import { SHINDO0_COLOR } from './measuredIntensity'

// インデックスと計測震度の対応: 計測震度 = index * 0.5 - 3.0（index 6 が 0.0）
describe('揺れ検知の震度の呼び名', () => {
  it('正: 震度0 未満（計測震度が 0 を下回る）は「0以下」', () => {
    expect(kyoshinDetectionScaleLabel(5)).toBe('0以下')
    expect(kyoshinDetectionScaleLabel(0)).toBe('0以下')
    expect(detectionScaleLabelFromValue(-0.1)).toBe('0以下')
  })

  it('対照: 震度0 以上はいまの階級のまま', () => {
    expect(kyoshinDetectionScaleLabel(6)).toBe('0')
    expect(kyoshinDetectionScaleLabel(11)).toBe(kyoshinIndexToLabel(11))
    expect(detectionScaleLabelFromValue(0.0)).toBe('0')
    expect(detectionScaleLabelFromValue(4.4)).toBe('4')
  })

  it('安全弁: 欠測・読めない値は呼び名を持たない（「0以下」に化けない）', () => {
    expect(kyoshinDetectionScaleLabel(-1)).toBeNull()
    expect(kyoshinDetectionScaleLabel(undefined)).toBeNull()
    expect(kyoshinDetectionScaleLabel(Number.NaN)).toBeNull()
    expect(detectionScaleLabelFromValue(null)).toBeNull()
    expect(detectionScaleLabelFromValue(Number.NaN)).toBeNull()
  })

  it('安全弁: 地図・カードの点の段（kyoshinIndexToLabel）は震度0 未満を持たないまま', () => {
    expect(kyoshinIndexToLabel(5)).toBeNull()
  })
})

// 震度0 未満の 6 段の色（2026-10-30 ユーザー選択「明るさと大きさで段を付ける (Recommended)」）。
// 以前の 1 色（#c8ccd2）は震度0 の灰より明るく、強さの順と明るさの順が逆になっていた。
describe('震度0 未満の段の色', () => {
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16)
    return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
  }

  it('正: 段が上がるほど明るい', () => {
    for (let i = 1; i < KYOSHIN_SUB_ZERO_STEP_COLORS.length; i++) {
      expect(lum(KYOSHIN_SUB_ZERO_STEP_COLORS[i]!)).toBeGreaterThan(lum(KYOSHIN_SUB_ZERO_STEP_COLORS[i - 1]!))
    }
  })

  it('対照: いちばん強い段も震度0 の灰より暗い（強さの順と明るさの順を揃える）', () => {
    expect(lum(KYOSHIN_SUB_ZERO_STEP_COLORS[KYOSHIN_SUB_ZERO_STEP_COLORS.length - 1]!)).toBeLessThan(lum(SHINDO0_COLOR))
  })

  it('カードの「0以下」の行はいちばん強い段の色', () => {
    expect(KYOSHIN_SUB_ZERO_COLOR).toBe(KYOSHIN_SUB_ZERO_STEP_COLORS[5])
  })

  it('安全弁: 段は 0〜5 へ収まる（範囲外・非有限は端へ）', () => {
    expect(kyoshinSubZeroStep(0)).toBe(0)
    expect(kyoshinSubZeroStep(5)).toBe(5)
    expect(kyoshinSubZeroStep(9)).toBe(5)
    expect(kyoshinSubZeroStep(-3)).toBe(0)
    expect(kyoshinSubZeroStep(Number.NaN)).toBe(0)
  })
})
