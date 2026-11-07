// @vitest-environment jsdom
//
// 地震タブの絞り込みの窓は、地震タブを離れたら閉じる（2026-11-07 選択「地震タブを離れたら閉じる (Recommended)」）。
// タブは常時マウントで、窓は body の最前面に描くので、緊急地震速報などで自動で移ったときに警報の上へ残さない。
import { DEFAULT_QUAKE_LIST_FILTER } from '../../utils/quakeListView'
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
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

const tab = (shown: boolean) => (
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
      sort={{ key: 'time', dir: 'desc' }}
      onSortChange={() => {}}
      filterSourceQuakes={[]}
      shown={shown}
      historyOldestDay={null}
      historyInputs={null}
      historyPickedId={null}
      historyView={null}
      onPickHistory={() => {}}
    />
)

const dialog = () => document.querySelector('[role="dialog"]')

const openScale = async (shown: boolean) => {
  const r = render(tab(shown))
  await flushDataEffects()
  const chip = document.querySelector<HTMLElement>('[data-filter-button]')
  expect(chip).not.toBeNull()
  act(() => { fireEvent.click(chip!) })
  expect(dialog()).not.toBeNull()
  return r
}

describe('地震タブを離れたら絞り込みの窓を閉じる', () => {
  // 正: 別のタブへ移ると（shown が false になると）窓が閉じる
  it('タブを離れると窓が閉じる', async () => {
    const { rerender } = await openScale(true)
    act(() => { rerender(tab(false)) })
    expect(dialog()).toBeNull()
  })

  // 対照: 地震タブのまま描き直しても、窓は開いたまま
  it('地震タブのままなら窓は開いたまま', async () => {
    const { rerender } = await openScale(true)
    act(() => { rerender(tab(true)) })
    expect(dialog()).not.toBeNull()
  })

  // 安全弁: 地震タブへ戻っても、閉じた窓は勝手に開き直さない
  it('戻っても窓は開き直さない', async () => {
    const { rerender } = await openScale(true)
    act(() => { rerender(tab(false)) })
    act(() => { rerender(tab(true)) })
    expect(dialog()).toBeNull()
  })
})
