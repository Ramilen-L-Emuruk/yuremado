import { describe, it, expect } from 'vitest'
import { formatArchiveCoverage } from './historicalArchiveCoverage'
import type { HistoricalArchiveMeta } from '../types/historicalArchive'

const base: HistoricalArchiveMeta = {
  id: 'x', label: 'x', description: 'x',
  from: '2018-09-05T15:00:00.000Z',
  to: '2019-02-22T15:00:00.000Z',
  coveredRanges: [],
  firstEventTime: '2018-09-05T18:08:10.400Z',
}

describe('formatArchiveCoverage', () => {
  it('日を選んで集めたアーカイブは集めた日を並べる（日本時間の日・年が同じなら終わりの年を省く）', () => {
    const meta: HistoricalArchiveMeta = {
      ...base,
      coveredRanges: [
        { from: '2018-09-05T15:00:00.000Z', to: '2018-09-07T15:00:00.000Z' },
        { from: '2018-10-04T15:00:00.000Z', to: '2018-10-06T15:00:00.000Z' },
        { from: '2019-02-20T15:00:00.000Z', to: '2019-02-22T15:00:00.000Z' },
      ],
    }
    expect(formatArchiveCoverage(meta)).toBe('2018/9/6〜9/7、2018/10/5〜10/6、2019/2/21〜2/22')
  })

  it('1 日だけの範囲・年をまたぐ範囲', () => {
    const meta: HistoricalArchiveMeta = {
      ...base,
      coveredRanges: [
        { from: '2018-09-05T15:00:00.000Z', to: '2018-09-06T15:00:00.000Z' },
        { from: '2018-12-30T15:00:00.000Z', to: '2019-01-01T15:00:00.000Z' },
      ],
    }
    expect(formatArchiveCoverage(meta)).toBe('2018/9/6、2018/12/31〜2019/1/1')
  })

  // 対照: 途切れなく集めたアーカイブは従来どおり始まりと終わりの日時
  it('範囲が 1 つなら従来の書き方', () => {
    const meta: HistoricalArchiveMeta = { ...base, coveredRanges: [{ from: base.from, to: base.to }] }
    expect(formatArchiveCoverage(meta)).toBe(
      `${new Date(base.from).toLocaleString('ja-JP')} 〜 ${new Date(base.to).toLocaleString('ja-JP')}`,
    )
  })
})
