// 長周期地震動の区域の印の吹き出しに並べる観測点の行（2026-10-25 ユーザー選択「観測点を並べる (Recommended)」）。
//
// **電文は区域の段に周期ごとの内訳を持たない**ので、区域では観測点の顔ぶれと階級・震度だけを出す。
// 作りは地震の区域塗りの吹き出しの市町村の行（上限 8・「ほか N 市町村」）に揃える。
import { describe, it, expect } from 'vitest'
import { POPUP_STATION_LIMIT, regionStationRowsHtml } from './LpgmRegionFillGL'
import type { LpgmStationRow } from '../../utils/lpgm'

const station = (name: string, lgInt: number, extra: Partial<LpgmStationRow> = {}): LpgmStationRow =>
  ({ name, lgInt, ...extra })

describe('regionStationRowsHtml', () => {
  it('正: 観測点名・階級・震度を、渡した順に並べる', () => {
    const html = regionStationRowsHtml([station('志賀町香能', 4, { int: 70 }), station('輪島市門前町走出', 3, { int: 60 })])
    expect(html.indexOf('志賀町香能')).toBeLessThan(html.indexOf('輪島市門前町走出'))
    expect(html).toContain('震度 7')
    expect(html).toContain('震度 6強')
    expect(html).not.toContain('ほか')
  })

  it('正: 上限を超えた分は「ほか N 観測点」にまとめる', () => {
    const many = Array.from({ length: POPUP_STATION_LIMIT + 2 }, (_, i) => station(`観測点${i}`, 1))
    const html = regionStationRowsHtml(many)
    expect(html).toContain(`観測点${POPUP_STATION_LIMIT - 1}`)
    expect(html).not.toContain(`観測点${POPUP_STATION_LIMIT}<`)
    expect(html).toContain('ほか 2 観測点')
  })

  it('安全弁: 気象庁以外の観測点には印（＊）を付け、震度の無い観測点は震度を書かない', () => {
    const html = regionStationRowsHtml([station('普代村銅屋', 2, { nonJma: true })])
    expect(html).toContain('普代村銅屋＊')
    expect(html).not.toContain('震度')
  })

  it('対照: 観測点が無い区域は何も足さない（区域名と階級の 2 行のまま）', () => {
    expect(regionStationRowsHtml([])).toBe('')
  })
})
