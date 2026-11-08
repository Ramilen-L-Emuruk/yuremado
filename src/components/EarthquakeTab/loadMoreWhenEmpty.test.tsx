// @vitest-environment jsdom
//
// 一覧が空でも「もっと見る」を出す。
//
// 地震タブの絞りを掛けていて、読んだ範囲に条件に合う地震が無いと一覧は空になる。空のときの画面が
// 「地震情報はありません」だけだと、遡れば出る地震があっても押す口が無い（2026-11-03 ユーザー選択
// 「空でもボタンを出す (Recommended)」）。
import { DEFAULT_QUAKE_LIST_FILTER, DEFAULT_QUAKE_LIST_SORT } from '../../utils/quakeListView'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { flushDataEffects } from '../../test-utils/flushDataEffects'
import { EarthquakeTab } from './index'
import { quakeEventKey } from '../../utils/quakeMerge'
import type { JMAQuake } from '../../types/earthquake'
import { createEmptyTelegramLoss } from '../../utils/telegramLoss'

afterEach(cleanup)

HTMLElement.prototype.scrollIntoView = () => {}

const QUAKE: JMAQuake = {
  kind: 'quake',
  id: 'dmdata-quake-20240101161000-1',
  eventId: '20240101161000',
  time: '2024-01-01T07:24:00Z',
  issue: { source: 'テスト', time: '2024-01-01T07:24:00Z', type: '震源・震度情報', correct: 'なし' },
  earthquake: {
    time: '2024-01-01T16:10:00+09:00',
    hypocenter: { name: '石川県能登地方', latitude: 37.495, longitude: 137.27, depth: 16, magnitude: 7.6 },
    maxScale: 45,
    domesticTsunami: '警報等',
  },
  points: [{ pref: '石川県', addr: '石川県能登', isArea: true, scale: 45 }],
}

async function renderTab(opts: { earthquakes: JMAQuake[]; hasMore: boolean; isLoadingMore?: boolean; onLoadMore?: () => Promise<boolean> }) {
  const { earthquakes } = opts
  const result = render(
    <EarthquakeTab matchedCount={0}
      earthquakes={earthquakes}
      selectedId={earthquakes[0] ? quakeEventKey(earthquakes[0]) : null}
      selectSeq={0}
      speakingKey={null}
      followSpeech={false}
      onSelect={() => {}}
      isLoading={false}
      isLoadingMore={opts.isLoadingMore ?? false}
      hasMore={opts.hasMore}
      onLoadMore={opts.onLoadMore ?? (async () => false)}
      watchLoadMoreThrottle={false}
      error={null}
      historyLoss={createEmptyTelegramLoss()}
      loadMoreFailed={false}
      reconnectGapLoss={false}
      fetchThrottled={false}
      onDismissKeyReentry={null}
      lpgmByEventId={new Map()}
      updateMarks={new Map()}
      activeLpgmEventId={null}
      onToggleLpgm={() => {}}
      lpgmFocus={null}
      estimatedIntensities={[]}
      internationalTsunamisByQuake={new Map()}
      distributionQuakeKey={null}
      onToggleDistribution={() => {}}
      unreceivedQuakeKey={null}
      onToggleUnreceived={() => {}}
      onFocusMap={() => {}}
      speakingTelegramTextSubject={null}
      seismoWaves={new Map()}
      seismoWaveFailedKeys={new Set()}
      seismoWaveView="composite"
      filter={DEFAULT_QUAKE_LIST_FILTER}
      onFilterChange={() => {}}
      sort={DEFAULT_QUAKE_LIST_SORT}
      onSortChange={() => {}}
      filterSourceQuakes={[]}
      shown
      historyOldestDay={null}
      historyInputs={null}
      historyPickedId={null}
      historyView={null}
      onPickHistory={() => {}}
    />,
  )
  await flushDataEffects()
  return result
}

describe('一覧が空のときの「もっと見る」', () => {
  it('正: 空でも遡れるならボタンを出し、押すと続きを読む', async () => {
    const onLoadMore = vi.fn(async () => false)
    await renderTab({ earthquakes: [], hasMore: true, onLoadMore })

    expect(screen.getByText('地震情報はありません')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'もっと見る' }))
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('正: 読んでいる間は一覧の末尾と同じく「取得中…」で押せない', async () => {
    await renderTab({ earthquakes: [], hasMore: true, isLoadingMore: true })

    expect((screen.getByRole('button', { name: '取得中…' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('対照: これ以上遡れないなら空のときもボタンを出さない', async () => {
    await renderTab({ earthquakes: [], hasMore: false })

    expect(screen.getByText('地震情報はありません')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'もっと見る' })).toBeNull()
    // 空のときは末尾の「これ以上は遡れません」も添えない（一覧の末尾にだけ出す文言）
    expect(screen.queryByText('これ以上は遡れません')).toBeNull()
  })

  it('安全弁: 地震があるときは、今までどおり一覧の末尾に 1 つだけ', async () => {
    await renderTab({ earthquakes: [QUAKE], hasMore: true })

    expect(screen.queryByText('地震情報はありません')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'もっと見る' })).toHaveLength(1)
  })
})
