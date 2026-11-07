// @vitest-environment jsdom
//
// 一覧を時刻以外で並べたとき、閉じた行の上の段に日付を添えること
// （2026-11-07 ユーザー選択「上の段に出す (Recommended)」。時刻順は日付の区切りがあるので添えない）。
import { DEFAULT_QUAKE_LIST_FILTER, type QuakeListSort } from '../../utils/quakeListView'
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { flushDataEffects } from '../../test-utils/flushDataEffects'
import { EarthquakeTab } from './index'
import type { JMAQuake } from '../../types/earthquake'
import { createEmptyTelegramLoss } from '../../utils/telegramLoss'

afterEach(cleanup)

HTMLElement.prototype.scrollIntoView = () => {}

const QUAKE: JMAQuake = {
  kind: 'quake',
  id: 'dmdata-quake-20240101160610-1',
  eventId: '20240101160610',
  time: '2024-01-01T07:10:00Z',
  issue: { source: 'テスト', time: '2024-01-01T07:10:00Z', type: '震源・震度情報', correct: 'なし' },
  earthquake: {
    time: '2024-01-01T07:06:00Z',
    hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 16, magnitude: 7.6 },
    maxScale: 70,
    domesticTsunami: '警報等',
  },
  points: [{ pref: '', addr: '石川県能登', isArea: true, scale: 70 }],
}

const renderTab = async (sort: QuakeListSort) => {
  const result = render(
    <EarthquakeTab
      earthquakes={[QUAKE]}
      selectedId={null}
      selectSeq={0}
      speakingKey={null}
      followSpeech={false}
      onSelect={() => {}}
      isLoading={false}
      isLoadingMore={false}
      hasMore={false}
      onLoadMore={async () => {}}
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
      sort={sort}
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

const dateOf = (c: HTMLElement) => c.querySelector('[data-col="date"]')?.textContent ?? null

describe('閉じた行の日付', () => {
  // 正: 震度で並べると、上の段に月/日が付く（地震の日時は JST で 2024-01-01 16:06。UTC でも同じ日）
  it('時刻以外で並べると上の段に月/日を添える', async () => {
    const { container } = await renderTab({ key: 'scale', dir: 'desc' })
    expect(dateOf(container)).toBe('01/01')
  })

  // 対照: 時刻で並べると日付の区切りがあるので、行には添えない
  it('時刻で並べると行には添えない', async () => {
    const { container } = await renderTab({ key: 'time', dir: 'desc' })
    expect(dateOf(container)).toBeNull()
  })

  // 安全弁: 古い順（時刻の昇順）でも区切りがあるので添えない
  it('古い順でも添えない', async () => {
    const { container } = await renderTab({ key: 'time', dir: 'asc' })
    expect(dateOf(container)).toBeNull()
  })
})
