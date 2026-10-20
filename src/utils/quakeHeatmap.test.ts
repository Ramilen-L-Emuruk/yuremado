// 地震活動ヒートマップの重み・順位・規模の札を固定する。
// 「M 不明」と「Ｍ８を超える巨大地震」はどちらも規模が数値にならないので、説明（`magnitudeCondition`）で
// 分けないと最大級の地震が最も薄い点になる（2026-10-19 ユーザー承認「巨大地震を言い分ける (推奨)」）。
import { describe, it, expect } from 'vitest'
import {
  heatMagnitude,
  heatMagnitudeColorValue,
  heatMagnitudeLabel,
  heatMagnitudeRank,
  isHugeMagnitudeCondition,
  magnitudeToWeight,
} from './quakeHeatmap'
import { MAG_CONDITION_HUGE, MAG_CONDITION_UNKNOWN } from './bufrEstimatedIntensity'

const HUGE = 'Ｍ８を超える巨大地震'

describe('magnitudeToWeight', () => {
  // 正: 巨大地震は M8 以上と同じ最大の重み。
  it('「Ｍ８を超える巨大地震」は M8 と同じ最大の重みになる', () => {
    expect(magnitudeToWeight(NaN, HUGE)).toBe(1)
    expect(magnitudeToWeight(NaN, HUGE)).toBe(magnitudeToWeight(8, null))
  })

  // 正: M 不明は土台の不明（-1）と同じ最小の重み。
  it('M 不明は、説明があっても無くても、土台の不明（-1）と同じ最小の重みになる', () => {
    const baseUnknown = magnitudeToWeight(-1, null)
    expect(baseUnknown).toBe(0.1)
    expect(magnitudeToWeight(NaN, null)).toBe(baseUnknown)
    expect(magnitudeToWeight(NaN, 'Ｍ不明')).toBe(baseUnknown)
  })

  // 対照: 数値の規模は従来どおり（M1〜M8 を 0〜1 へ正規化して二乗、下限 0.1）。
  it('数値の規模は従来どおりの重みのまま', () => {
    expect(magnitudeToWeight(4.5, null)).toBeCloseTo(0.25)
    expect(magnitudeToWeight(1, null)).toBe(0.1)
    expect(magnitudeToWeight(9.1, null)).toBe(1)
  })

  // 安全弁: どの入力でも有限の値を返す（NaN を地図へ流さない）。
  it('非有限の規模でも重みは有限の値になる', () => {
    for (const m of [NaN, Infinity, -Infinity]) {
      for (const c of [null, HUGE, 'Ｍ不明']) {
        expect(Number.isFinite(magnitudeToWeight(m, c))).toBe(true)
      }
    }
  })
})

describe('規模の説明の判定', () => {
  it('巨大地震の説明は二進電文の復号器が使う値と同じ文字列', () => {
    expect(isHugeMagnitudeCondition(MAG_CONDITION_HUGE)).toBe(true)
    expect(isHugeMagnitudeCondition(MAG_CONDITION_UNKNOWN)).toBe(false)
    expect(isHugeMagnitudeCondition(null)).toBe(false)
  })
})

describe('heatMagnitude', () => {
  // 土台のキャッシュ（JSON）を通すと NaN は null に化けるので、点には -1 で持つ。
  it('数値にならない規模は -1 へ揃え、JSON を通しても数値のまま残る', () => {
    expect(heatMagnitude(NaN)).toBe(-1)
    expect(heatMagnitude(3.2)).toBe(3.2)
    const roundTrip = JSON.parse(JSON.stringify({ magnitude: heatMagnitude(NaN), magnitudeCondition: HUGE }))
    expect(roundTrip.magnitude).toBe(-1)
    expect(heatMagnitudeLabel(roundTrip.magnitude, roundTrip.magnitudeCondition)).toBe('M8を超える巨大地震')
    expect(magnitudeToWeight(roundTrip.magnitude, roundTrip.magnitudeCondition)).toBe(1)
  })
})

describe('heatMagnitudeLabel', () => {
  it('巨大地震は気象庁の説明を半角へ直して出す', () => {
    expect(heatMagnitudeLabel(-1, HUGE)).toBe('M8を超える巨大地震')
  })

  // 対照: M 不明は「Ｍ不明」の説明を持っていても「不明」のまま。
  it('M 不明は「不明」のまま', () => {
    expect(heatMagnitudeLabel(-1, 'Ｍ不明')).toBe('不明')
    expect(heatMagnitudeLabel(-1, null)).toBe('不明')
  })

  it('数値の規模は従来どおり', () => {
    expect(heatMagnitudeLabel(3.24, null)).toBe('M3.2')
  })
})

describe('heatMagnitudeRank / heatMagnitudeColorValue', () => {
  // 吹き出しで重なった点から選ぶ順位。巨大地震を実在する最大の M より上へ置く。
  it('巨大地震は数値の M より上、不明は最下位', () => {
    expect(heatMagnitudeRank(-1, HUGE)).toBeGreaterThan(heatMagnitudeRank(9.1, null))
    expect(heatMagnitudeRank(-1, null)).toBeLessThan(heatMagnitudeRank(0, null))
    expect(Number.isFinite(heatMagnitudeRank(NaN, null))).toBe(true)
  })

  it('巨大地震の札の色は M8 の段', () => {
    expect(heatMagnitudeColorValue(-1, HUGE)).toBe(8)
    expect(heatMagnitudeColorValue(3, null)).toBe(3)
  })
})
