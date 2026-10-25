// リプレイの履歴に付ける「続きを読む口」。見るのは、続きの上端をどこに置くか ——
// 読み切った日の手前へ進むこと、進めないときも同じ窓に留まり「いま」へ落ちないこと。
import { describe, it, expect, vi } from 'vitest'
import { withDmdataLoadMore, withoutLoadMore } from './replayQuakeHistory'
import type { QuakeHistoryResult } from '../types/replay'

vi.mock('../utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function result(over: Partial<QuakeHistoryResult> = {}): QuakeHistoryResult {
  return {
    quakes: [], tsunamis: [], extras: [], skippedByDay: new Map(),
    failedArchiveUrls: [], rateLimitedSources: [], rateLimitedTelegrams: 0,
    hasMore: true, oldestLoadedDay: null,
    ...over,
  }
}

/** 再生開始時刻（JST 2024-01-01 16:10）。 */
const BEFORE = new Date('2024-01-01T16:10:00+09:00')

describe('withDmdataLoadMore', () => {
  it('正: 続きは読み切った最古の日の手前から読み、押すたびに先へ進む', async () => {
    const fetchWindow = vi.fn(async (_before: Date, _signal: AbortSignal | null) => result({ oldestLoadedDay: '2023-12-19' }))
    const first = withDmdataLoadMore(result({ oldestLoadedDay: '2023-12-26' }), BEFORE, fetchWindow)

    const second = await first.loadMore!(null)
    await second.loadMore!(null)

    expect(fetchWindow.mock.calls.map(c => c[0].toISOString())).toEqual([
      new Date(Date.parse('2023-12-26T00:00:00+09:00') - 1).toISOString(),
      new Date(Date.parse('2023-12-19T00:00:00+09:00') - 1).toISOString(),
    ])
  })

  it('正: 止める合図をそのまま渡す', async () => {
    const fetchWindow = vi.fn(async (_before: Date, _signal: AbortSignal | null) => result({ hasMore: false }))
    const ac = new AbortController()
    await withDmdataLoadMore(result({ oldestLoadedDay: '2023-12-26' }), BEFORE, fetchWindow).loadMore!(ac.signal)
    expect(fetchWindow.mock.calls[0][1]).toBe(ac.signal)
  })

  it('対照: 在庫の端（hasMore が偽）なら口を付けない', () => {
    const fetchWindow = vi.fn()
    expect(withDmdataLoadMore(result({ hasMore: false, oldestLoadedDay: '2023-12-26' }), BEFORE, fetchWindow).loadMore).toBeNull()
  })

  // 窓の最新の日を読み切れなかった（429 の窓・取得の失敗）とき。ライブの経路は `serverDate()` へ落ちるが、
  // 再生中にそうすると再生時刻より未来の地震が一覧に並ぶ
  it('安全弁: カーソルが無いときは同じ窓を読み直し、いまへは落とさない', async () => {
    const fetchWindow = vi.fn(async (_before: Date, _signal: AbortSignal | null) => result({ hasMore: false }))
    await withDmdataLoadMore(result({ oldestLoadedDay: null }), BEFORE, fetchWindow).loadMore!(null)
    expect(fetchWindow.mock.calls[0][0].getTime()).toBe(BEFORE.getTime())
  })

  it('安全弁: カーソルが窓の上端より新しければ、上端より先へは進めない', async () => {
    const fetchWindow = vi.fn(async (_before: Date, _signal: AbortSignal | null) => result({ hasMore: false }))
    await withDmdataLoadMore(result({ oldestLoadedDay: '2024-01-05' }), BEFORE, fetchWindow).loadMore!(null)
    expect(fetchWindow.mock.calls[0][0].getTime()).toBe(BEFORE.getTime())
  })
})

describe('withoutLoadMore', () => {
  it('続きの口を持たない（在庫が残っていても出さない）', () => {
    expect(withoutLoadMore(result({ hasMore: true })).loadMore).toBeNull()
  })
})
