// @vitest-environment jsdom
//
// 開いた地震カードの「▶ 再生」と、再生の知らせ（→ docs/spec/quake-spec.md §8「地震カードから再生する」）。
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

/** 国内の報を持たない遠地地震のカード（発生 16:10、報は 16:40） */
const FOREIGN: JMAQuake = {
  ...QUAKE,
  id: 'dmdata-quake-20240101161000-2',
  eventId: '20240101161001',
  time: '2024-01-01T07:40:00Z',
  issue: { ...QUAKE.issue, time: '2024-01-01T07:40:00Z', type: '遠地地震' },
  points: [],
}

async function renderTab(opts: { quake: JMAQuake | null; replayError?: string | null; onReplayQuake?: (key: string, firstReportMs: number | null) => void }) {
  const earthquakes = opts.quake ? [opts.quake] : []
  render(
    <EarthquakeTab
      earthquakes={earthquakes}
      selectedId={opts.quake ? quakeEventKey(opts.quake) : null}
      selectSeq={0}
      speakingKey={null}
      followSpeech={false}
      onSelect={() => {}}
      isLoading={false}
      isLoadingMore={false}
      hasMore={false}
      onLoadMore={() => {}}
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
      historyInputs={null}
      historyPickedId={null}
      historyView={null}
      onPickHistory={() => {}}
      onReplayQuake={opts.onReplayQuake ?? (() => {})}
      replayError={opts.replayError ?? null}
    />,
  )
  await flushDataEffects()
}

describe('開いた地震カードの「▶ 再生」', () => {
  it('正: 国内の地震では「地震の30秒前」の文で出し、押すと鍵と最初の報の時刻を渡す', async () => {
    const onReplayQuake = vi.fn()
    await renderTab({ quake: QUAKE, onReplayQuake })

    const button = screen.getByRole('button', { name: '▶ 再生' })
    expect(button.getAttribute('title')).toBe('この地震の30秒前から再生します')
    fireEvent.click(button)
    expect(onReplayQuake).toHaveBeenCalledWith(quakeEventKey(QUAKE), Date.parse('2024-01-01T07:24:00Z'))
  })

  it('対照: 国内の報を持たないカードは「最初の報の30秒前」の文で出す', async () => {
    await renderTab({ quake: FOREIGN })

    expect(screen.getByRole('button', { name: '▶ 再生' }).getAttribute('title')).toBe('この地震の最初の報の30秒前から再生します')
  })

  it('安全弁: 始める時刻を決められない（時刻が読めない）カードには出さない', async () => {
    await renderTab({ quake: { ...QUAKE, earthquake: { ...QUAKE.earthquake, time: '読めない時刻' } } })

    expect(screen.queryByRole('button', { name: '▶ 再生' })).toBeNull()
  })

  it('安全弁: 取り消された地震には出さない', async () => {
    await renderTab({ quake: { ...QUAKE, cancelledAt: new Date('2024-01-01T07:30:00Z') } })

    expect(screen.queryByRole('button', { name: '▶ 再生' })).toBeNull()
  })
})

describe('地震タブの再生の知らせ', () => {
  it('正: 再生の知らせがあれば一覧の上に同じ文を出す（一覧が空でも）', async () => {
    await renderTab({ quake: null, replayError: '2016 年より前は再生できません（どの取得元にもデータがありません）' })

    expect(screen.getByText('2016 年より前は再生できません（どの取得元にもデータがありません）')).toBeTruthy()
  })

  it('対照: 知らせが無ければ何も足さない', async () => {
    await renderTab({ quake: QUAKE, replayError: null })

    expect(screen.queryByText(/再生できません|取得に失敗/)).toBeNull()
  })
})
