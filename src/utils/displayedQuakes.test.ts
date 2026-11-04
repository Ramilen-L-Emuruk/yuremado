// 地震タブの「最低表示震度」の絞り込み。遠地地震・津波の原因地震・国際津波関連情報の付いた地震は外さない。
import { describe, it, expect } from 'vitest'
import type { IntensityScale, JMAQuake, JMATsunami } from '../types/earthquake'
import { filterDisplayedQuakes } from './displayedQuakes'
import { quakeEventKey } from './quakeMerge'

function quake(eventId: string, maxScale: IntensityScale, type: JMAQuake['issue']['type'] = '震源・震度情報'): JMAQuake {
  return {
    kind: 'quake',
    id: `dmdata-quake-${eventId}-1`,
    time: '2026-01-01T07:22:30Z',
    issue: { source: 'dmdata', time: '2026-01-01T07:22:30Z', type, correct: 'なし' },
    earthquake: {
      time: '2026-01-01T07:22:00Z',
      hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 5.2 },
      maxScale,
      domesticTsunami: 'なし',
    },
    points: [],
  } as JMAQuake
}
const tsunami = (eventId: string): Pick<JMATsunami, 'eventId' | 'foldedReports'> => ({ eventId })

describe('filterDisplayedQuakes', () => {
  const small = quake('20260101162200', 20)
  const large = quake('20260101170000', 50)

  // 対照: 従来どおり、最低表示震度より小さい地震は外す。負ならすべて出す。
  it('最低表示震度より小さい地震は外し、負ならすべて出す', () => {
    expect(filterDisplayedQuakes([small, large], 30, [], new Map()).map(q => q.id)).toEqual([large.id])
    expect(filterDisplayedQuakes([small, large], -1, [], new Map())).toHaveLength(2)
  })

  // 正: 津波の原因地震は、最低表示震度より小さくても出す（津波タブから飛べるように）。
  it('津波の原因地震は最低表示震度より小さくても出す', () => {
    expect(filterDisplayedQuakes([small, large], 30, [tsunami('20260101162200')], new Map()).map(q => q.id)).toEqual([small.id, large.id])
  })

  it('続報で増えた番号（複数の原因地震）でも引き当てる', () => {
    expect(filterDisplayedQuakes([small], 30, [tsunami('20260101150000 20260101162200')], new Map())).toHaveLength(1)
  })

  // 安全弁: 別の地震の番号では外したまま。遠地地震は従来どおり外さない。
  it('番号の合わない津波では外したまま。遠地地震は震度に関係なく出す', () => {
    expect(filterDisplayedQuakes([small], 30, [tsunami('20260101170000')], new Map())).toHaveLength(0)
    const foreign = quake('20260101180000', -1, '遠地地震')
    expect(filterDisplayedQuakes([foreign], 30, [], new Map())).toHaveLength(1)
  })

  // 正: 国際津波関連情報（英文）の付いた地震は、最低表示震度より小さくても外さない（2026-11-03 ユーザー選択「地震ごと残す (Recommended)」）
  // 対照: 英文の付いていない同じ震度の地震は外す
  it('国際津波関連情報の付いた地震は、震度が小さくても外さない', () => {
    const withBulletin = quake('20260101190000', -1)
    const without = quake('20260101200000', -1)
    const byQuake = new Map([[quakeEventKey(withBulletin), []]])
    expect(filterDisplayedQuakes([withBulletin, without], 30, [], byQuake).map(q => q.id)).toEqual([withBulletin.id])
  })

  // 正: 最大震度が「5弱以上（未入電）」の地震は、5強以上を選んでいても外さない（2026-11-04 ユーザー選択「5強以上の設定でも残す (Recommended)」）。
  // 対照: 同じ 5弱でも未入電の点が無ければ、5強以上では外す。
  // 安全弁: 未入電が最大震度より下の階級の点にだけあるなら「以上」ではないので外す。
  it('最大震度が「5弱以上（未入電）」の地震は、5強以上を選んでいても外さない', () => {
    const pt = (addr: string, scale: IntensityScale, unreceived = false) => ({ pref: '', addr, isArea: true, scale, ...(unreceived && { unreceived: true }) })
    const orAbove = { ...quake('20260102000000', 45), points: [pt('石川県能登', 45, true), pt('新潟県上越', 45)] } as JMAQuake
    const plain = { ...quake('20260102010000', 45), points: [pt('石川県能登', 45)] } as JMAQuake
    const lower = { ...quake('20260102020000', 40), points: [pt('石川県能登', 40), pt('新潟県上越', 30, true)] } as JMAQuake
    expect(filterDisplayedQuakes([orAbove, plain, lower], 50, [], new Map()).map(q => q.id)).toEqual([orAbove.id])
    expect(filterDisplayedQuakes([orAbove], 70, [], new Map())).toHaveLength(1)
  })
})
