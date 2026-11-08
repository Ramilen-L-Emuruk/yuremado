// リプレイの履歴に付ける「窓を読む口」。見るのは、上端の日が再生を始めた時刻の日本時間の日になることと、
// 口の有無が取得元どおりになること（どの日を読むかは useEarthquakes 側のテストが見る）。
import { describe, it, expect, vi } from 'vitest'
import { withFetchWindow, withoutFetchWindow } from './replayQuakeHistory'
import type { QuakeHistoryResult } from '../types/replay'

function result(over: Partial<QuakeHistoryResult> = {}): QuakeHistoryResult {
  return {
    quakes: [], tsunamis: [], extras: [], skippedByDay: new Map(),
    failedArchiveUrls: [], rateLimitedSources: [], rateLimitedTelegrams: 0,
    hasMore: true, oldestLoadedDay: null,
    ...over,
  }
}

describe('withFetchWindow', () => {
  it('上端の日は再生を始めた時刻の日本時間の日（UTC の日付ではない）', () => {
    // 2024-01-01 00:30 JST = 2023-12-31T15:30Z
    const got = withFetchWindow(result(), new Date('2024-01-01T00:30:00+09:00'), vi.fn())
    expect(got.topDay).toBe('2024-01-01')
  })
  it('在庫の端でも口は付ける（期間の読み足しは在庫の端より新しい日を読む）', () => {
    const fetchWindow = vi.fn()
    expect(withFetchWindow(result({ hasMore: false }), new Date('2024-01-01T16:10:00+09:00'), fetchWindow).fetchWindow).toBe(fetchWindow)
  })
})

describe('withoutFetchWindow', () => {
  it('対照: ローカル履歴アーカイブは口を持たない', () => {
    const got = withoutFetchWindow(result(), new Date('2024-01-01T16:10:00+09:00'))
    expect(got.fetchWindow).toBeNull()
    expect(got.topDay).toBe('2024-01-01')
  })
})
