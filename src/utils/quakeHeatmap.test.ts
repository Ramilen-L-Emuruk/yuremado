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
  isWithinHeatWindow,
  magnitudeToWeight,
  heatmapPeriodStartMs,
  formatHeatmapDate,
  HEATMAP_PERIODS,
  DEFAULT_HEATMAP_PERIOD,
  isHeatmapPeriod,
  catalogYearsFor,
  catalogHeatPoints,
  gridHeatPoints,
  heatIntensityScale,
  shouldGridHeatPeriod,
  type HeatPoint,
} from './quakeHeatmap'

// リプレイ中は「いま」が再生時刻になる。再生時刻より後の地震を出さないことと、期間の端を固定する
describe('isWithinHeatWindow', () => {
  const now = Date.parse('2024-01-02T00:00:00Z')
  const start = now - 30 * 24 * 60 * 60 * 1000
  it('正: 期間の始まりからいままでは出す（両端を含む）', () => {
    expect(isWithinHeatWindow('2024-01-01T00:00:00Z', now, start)).toBe(true)
    expect(isWithinHeatWindow('2023-12-03T00:00:00Z', now, start)).toBe(true)
    expect(isWithinHeatWindow('2024-01-02T00:00:00Z', now, start)).toBe(true)
  })
  it('対照: いまより後・始まりより前は出さない', () => {
    expect(isWithinHeatWindow('2024-01-02T00:00:01Z', now, start)).toBe(false)
    expect(isWithinHeatWindow('2023-12-02T23:59:59Z', now, start)).toBe(false)
  })
  it('安全弁: 時刻が読めないものは出さない', () => {
    expect(isWithinHeatWindow('not-a-date', now, start)).toBe(false)
  })
})

// 期間の目盛り（2026-10-25 選択「E の案でよい (Recommended)」）
describe('heatmapPeriodStartMs', () => {
  // 2026-10-25 12:00 JST
  const now = Date.parse('2026-10-25T03:00:00Z')
  it('正: 日の目盛りは日数ぶん遡る', () => {
    expect(heatmapPeriodStartMs('30d', now)).toBe(now - 30 * 86_400_000)
    expect(heatmapPeriodStartMs('7d', now)).toBe(now - 7 * 86_400_000)
  })
  it('正: 年の目盛りは日本時間の暦で年だけを引く（閏年を跨いでも日付がずれない）', () => {
    expect(formatHeatmapDate(heatmapPeriodStartMs('1y', now))).toBe('2025/10/25')
    expect(formatHeatmapDate(heatmapPeriodStartMs('5y', now))).toBe('2021/10/25')
    expect(formatHeatmapDate(heatmapPeriodStartMs('50y', now))).toBe('1976/10/25')
  })
  it('正: 「1919年から」は日本時間の 1919/01/01 0 時から', () => {
    const start = heatmapPeriodStartMs('all', now)
    expect(formatHeatmapDate(start)).toBe('1919/01/01')
    expect(start).toBe(Date.parse('1918-12-31T15:00:00Z'))
  })
  it('対照: 目盛りは 10 段で、既定は 30 日', () => {
    expect(HEATMAP_PERIODS.map((p) => p.label)).toEqual([
      '7日', '30日', '90日', '1年', '2年', '5年', '10年', '20年', '50年', '1919年から',
    ])
    expect(DEFAULT_HEATMAP_PERIOD).toBe('30d')
  })
  it('安全弁: 保存された値が目盛りに無ければ期間として扱わない', () => {
    expect(isHeatmapPeriod('30d')).toBe(true)
    expect(isHeatmapPeriod('365d')).toBe(false)
    expect(isHeatmapPeriod(undefined)).toBe(false)
  })
})

// カタログで描く範囲と、年ファイルから点を作る部分
describe('catalogYearsFor / catalogHeatPoints', () => {
  const ms = (iso: string) => Date.parse(iso)
  it('正: 期間に掛かる日本時間の年のうち、索引にある年だけを読む', () => {
    // 2023-12-31 16:00 UTC は日本時間 2024-01-01 1:00
    expect(catalogYearsFor(ms('2022-06-01T00:00:00Z'), ms('2023-12-31T16:00:00Z'), [2021, 2022, 2023, 2024])).toEqual([2022, 2023, 2024])
    expect(catalogYearsFor(ms('2022-06-01T00:00:00Z'), ms('2023-06-01T00:00:00Z'), [2023])).toEqual([2023])
  })
  it('対照: 終わりが始まり以前（再生時刻がカタログより古い等）なら読まない', () => {
    expect(catalogYearsFor(ms('2024-01-01T00:00:00Z'), ms('2024-01-01T00:00:00Z'), [2024])).toEqual([])
  })
  it('正: 期間 [始まり, 終わり) の点だけを作り、M 不明は -1・最小の重みにする', () => {
    const year = {
      year: 2024,
      timeMs: [ms('2024-01-01T00:00:00Z'), ms('2024-01-02T00:00:00Z'), ms('2024-01-03T00:00:00Z')],
      lat: [37.5, 35, 36],
      lng: [137.2, 139, 140],
      depth: [10, 20, 30],
      magnitude: [7.6, NaN, 3],
    }
    const points = catalogHeatPoints([year], ms('2024-01-01T00:00:00Z'), ms('2024-01-03T00:00:00Z'))
    expect(points).toHaveLength(2)
    expect(points[0]).toMatchObject({ lat: 37.5, lng: 137.2, magnitude: 7.6, depth: 10, name: '', time: '2024-01-01T00:00:00.000Z' })
    expect(points[1].magnitude).toBe(-1)
    expect(points[1].weight).toBe(magnitudeToWeight(NaN, null))
  })
  it('安全弁: 震源が未確定の座標は描かない', () => {
    const year = { year: 2024, timeMs: [ms('2024-01-01T00:00:00Z')], lat: [-200], lng: [-200], depth: [0], magnitude: [3] }
    expect(catalogHeatPoints([year], 0, Infinity)).toEqual([])
  })
})

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

describe('gridHeatPoints（長い期間の格子）', () => {
  const pt = (lat: number, lng: number, m: number, time: string): HeatPoint => ({
    lat, lng, weight: magnitudeToWeight(m, null), name: 'x', time, depth: 10, depthAtLeast: false,
    magnitude: m, magnitudeCondition: null, count: 1,
  })

  it('[正] 同じ升目の点は 1 点にまとめ、重みは和・規模は最大・時刻は最新', () => {
    const a = pt(35.001, 139.001, 3, '2000-01-01T00:00:00.000Z')
    const b = pt(35.002, 139.002, 5, '2010-01-01T00:00:00.000Z')
    const [g, ...rest] = gridHeatPoints([a, b])
    expect(rest).toHaveLength(0)
    expect(g.count).toBe(2)
    expect(g.weight).toBeCloseTo(a.weight + b.weight)
    expect(g.magnitude).toBe(5)
    expect(g.time).toBe('2010-01-01T00:00:00.000Z')
    expect(g.lat).toBeGreaterThan(35.001)
    expect(g.lat).toBeLessThan(35.002)
  })

  it('[対照] 升目に 1 点しか無ければその地震のまま', () => {
    const a = pt(35.001, 139.001, 3, '2000-01-01T00:00:00.000Z')
    const b = pt(36.001, 139.001, 4, '2000-01-01T00:00:00.000Z')
    expect(gridHeatPoints([a, b])).toEqual([a, b])
  })

  it('[安全弁] 1 年までは格子にまとめず、それより長い期間だけまとめる', () => {
    expect(shouldGridHeatPeriod('30d')).toBe(false)
    expect(shouldGridHeatPeriod('1y')).toBe(false)
    expect(shouldGridHeatPeriod('2y')).toBe(true)
    expect(shouldGridHeatPeriod('all')).toBe(true)
  })
})

describe('heatIntensityScale（期間に合わせた濃さの係数）', () => {
  const DAY = 86_400_000
  // 正: 30 日より長い期間では、期間の比の平方根で下げる（1 年なら √(30/365)）。
  it('30 日を超える期間では √(30 / 日数) を返す', () => {
    expect(heatIntensityScale(0, 365 * DAY)).toBeCloseTo(Math.sqrt(30 / 365), 10)
    expect(heatIntensityScale(0, 120 * DAY)).toBeCloseTo(0.5, 10)
  })
  // 対照: 30 日ちょうど以下では下げない（既定の 30 日の見え方を変えない）。
  it('30 日以下では 1 のまま', () => {
    expect(heatIntensityScale(0, 30 * DAY)).toBe(1)
    expect(heatIntensityScale(0, DAY)).toBe(1)
  })
  // 安全弁: 壊れた範囲（逆順・非有限）で 0 や NaN を返して地図を消さない。
  it('範囲が逆順・非有限なら 1 を返す', () => {
    expect(heatIntensityScale(10 * DAY, 0)).toBe(1)
    expect(heatIntensityScale(Number.NaN, 0)).toBe(1)
  })
})
