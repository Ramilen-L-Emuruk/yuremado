// 長周期地震動の周期ごとの内訳（2秒〜8秒）を、カードと地図の吹き出しで同じ形に出すための部品。
//
// **電文は観測点の下にだけ内訳を持つ**（区域・県の段には無い）。カードの観測点の行・地図の観測点の
// 吹き出しは内訳を、地図の区域の吹き出しは観測点の並びを出す（→ docs/spec/quake-spec.md §8
// 「長周期地震動は「どの周期帯が強く出たか」まで出す」）。
import { describe, it, expect } from 'vitest'
import { buildLpgmRows, lpgmPeriodRows, lpgmStationsByArea } from './lpgm'
import type { LpgmPoint } from '../types/earthquake'

const noRank = () => 0
const deps = { prefOfArea: () => null, rank: noRank, onUnplaceableStation: () => {} }

describe('lpgmPeriodRows', () => {
  it('正: 帯ごとに中心周期の見出し・階級・揺れの大きさ（小数 1 桁）を並べる', () => {
    expect(lpgmPeriodRows([{ band: 1, lgInt: 4, sva: 268.54 }, { band: 7, lgInt: 2, sva: 30 }])).toEqual([
      { label: '2秒', lgInt: 4, sva: '268.5' },
      { label: '8秒', lgInt: 2, sva: '30.0' },
    ])
  })

  it('安全弁: 階級 0 の帯も行として残す（階級は null＝画面では「−」）', () => {
    expect(lpgmPeriodRows([{ band: 5, lgInt: 0, sva: 1.2 }])).toEqual([{ label: '6秒', lgInt: null, sva: '1.2' }])
  })

  it('対照: 読めない値は空にする（NaN・無限大を文字にしない）', () => {
    expect(lpgmPeriodRows([{ band: 9, sva: Number.NaN }])).toEqual([{ label: '周期不明', lgInt: null, sva: '' }])
    expect(lpgmPeriodRows([{ band: 1, lgInt: 2, sva: Number.POSITIVE_INFINITY }])).toEqual([{ label: '2秒', lgInt: 2, sva: '' }])
  })
})

describe('buildLpgmRows の観測点の行', () => {
  const periods = [{ band: 1, lgInt: 3, sva: 50 }]

  it('正: 電文の内訳を観測点の行へ通す', () => {
    const points: LpgmPoint[] = [{ code: '1', name: '輪島市', pref: '石川県', area: '石川県能登', lgInt: 3, periods }]
    const [pref] = buildLpgmRows([], points, [], deps)
    expect(pref.areas[0].stations[0].periods).toEqual(periods)
  })

  it('対照: 内訳を持たない観測点（空配列も含む）には持たせない（カードで開けない行にする）', () => {
    const points: LpgmPoint[] = [
      { code: '1', name: 'A', pref: '石川県', area: '石川県能登', lgInt: 3 },
      { code: '2', name: 'B', pref: '石川県', area: '石川県能登', lgInt: 2, periods: [] },
    ]
    const [pref] = buildLpgmRows([], points, [], deps)
    for (const st of pref.areas[0].stations) expect(st).not.toHaveProperty('periods')
  })
})

describe('lpgmStationsByArea', () => {
  it('正: 区域ごとに階級の高い順、同じ階級は電文の順で並べる（カードで区域を開いたときと同じ）', () => {
    const points: LpgmPoint[] = [
      { code: '1', name: 'A', pref: 'P', area: 'X', lgInt: 2 },
      { code: '2', name: 'B', pref: 'P', area: 'X', lgInt: 4 },
      { code: '3', name: 'C', pref: 'P', area: 'X', lgInt: 2 },
      { code: '4', name: 'D', pref: 'P', area: 'Y', lgInt: 1 },
    ]
    const byArea = lpgmStationsByArea(points, noRank)
    expect(byArea.get('X')!.map(s => s.name)).toEqual(['B', 'A', 'C'])
    expect(byArea.get('Y')!.map(s => s.name)).toEqual(['D'])

    // カード側の並び（buildLpgmRows）と一致すること
    const [pref] = buildLpgmRows([], points, [], deps)
    const cardX = pref.areas.find(a => a.name === 'X')!.stations.map(s => s.name)
    expect(cardX).toEqual(['B', 'A', 'C'])
  })

  it('正: 同じ階級どうしは渡した順位で並べ、カードと同じ順になる（並べ方は 1 つの関数を共有する）', () => {
    const points: LpgmPoint[] = [
      { code: '1', name: 'A', pref: 'P', area: 'X', lgInt: 2 },
      { code: '2', name: 'B', pref: 'P', area: 'X', lgInt: 2 },
      { code: '3', name: 'C', pref: 'P', area: 'X', lgInt: 3 },
    ]
    const rank = (name: string) => ({ A: 2, B: 1, C: 0 } as Record<string, number>)[name] ?? 99
    expect(lpgmStationsByArea(points, rank).get('X')!.map(s => s.name)).toEqual(['C', 'B', 'A'])
    const [pref] = buildLpgmRows([], points, [], { ...deps, rank })
    expect(pref.areas[0].stations.map(s => s.name)).toEqual(['C', 'B', 'A'])
  })

  it('安全弁: 階級 0 の観測点も含める（画面には残す決まり）', () => {
    const byArea = lpgmStationsByArea([{ code: '1', name: 'A', pref: 'P', area: 'X', lgInt: 0 }], noRank)
    expect(byArea.get('X')!.map(s => s.lgInt)).toEqual([0])
  })

  it('対照: 区域の分からない観測点・階級の読めない観測点はどの区域にも入らない', () => {
    const byArea = lpgmStationsByArea([
      { code: '1', name: 'A', pref: 'P', lgInt: 3 },
      { code: '2', name: 'B', pref: 'P', area: 'X', lgInt: 9 },
    ], noRank)
    expect(byArea.size).toBe(0)
  })
})
