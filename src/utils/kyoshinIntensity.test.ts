import { describe, expect, it } from 'vitest'
import { detectionScaleLabelFromValue, kyoshinDetectionScaleLabel, kyoshinIndexToLabel } from './kyoshinIntensity'

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
