// 地震タブの「最低表示震度」の絞り込み。遠地地震と津波の原因地震は外さない。
import { describe, it, expect } from 'vitest'
import type { IntensityScale, JMAQuake, JMATsunami } from '../types/earthquake'
import { filterDisplayedQuakes } from './displayedQuakes'

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
    expect(filterDisplayedQuakes([small, large], 30, []).map(q => q.id)).toEqual([large.id])
    expect(filterDisplayedQuakes([small, large], -1, [])).toHaveLength(2)
  })

  // 正: 津波の原因地震は、最低表示震度より小さくても出す（津波タブから飛べるように）。
  it('津波の原因地震は最低表示震度より小さくても出す', () => {
    expect(filterDisplayedQuakes([small, large], 30, [tsunami('20260101162200')]).map(q => q.id)).toEqual([small.id, large.id])
  })

  it('続報で増えた番号（複数の原因地震）でも引き当てる', () => {
    expect(filterDisplayedQuakes([small], 30, [tsunami('20260101150000 20260101162200')])).toHaveLength(1)
  })

  // 安全弁: 別の地震の番号では外したまま。遠地地震は従来どおり外さない。
  it('番号の合わない津波では外したまま。遠地地震は震度に関係なく出す', () => {
    expect(filterDisplayedQuakes([small], 30, [tsunami('20260101170000')])).toHaveLength(0)
    const foreign = quake('20260101180000', -1, '遠地地震')
    expect(filterDisplayedQuakes([foreign], 30, [])).toHaveLength(1)
  })
})
