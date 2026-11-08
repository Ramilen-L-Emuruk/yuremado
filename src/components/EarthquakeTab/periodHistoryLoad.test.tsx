// @vitest-environment jsdom
//
// 地震タブの期間で、選んだ期間の日だけを読む（2026-11-08 ユーザー選択「期間の日だけ取りに行く形を別に作る」）。
// - 期間の日のうち、まだ読んでいない日があれば、地震タブを見ている間に自動で読み足す（`onLoadPeriod`）
// - 期間を選んでいる間の「もっと見る」は期間の続きを読み、足りない日が無ければ出さない（選択「期間の続きを読む (Recommended)」）
// - 読み終わったのに足りない日が減らなければ止め、「〇〇以前は未読込みです。」を出す
// - 日付を指定した期間は両端を含め 90 日まで。超えたら反対の欄を寄せ、「期間は90日までです。」を出す（選択「寄せて注記も出す」）
import { DEFAULT_QUAKE_LIST_FILTER, DEFAULT_QUAKE_LIST_SORT, type QuakeListFilter } from '../../utils/quakeListView'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { useState } from 'react'
import { flushDataEffects } from '../../test-utils/flushDataEffects'
import { EarthquakeTab } from './index'
import { QuakeListFilterDialog } from './QuakeListFilterBar'
import { createEmptyTelegramLoss } from '../../utils/telegramLoss'
import { EMPTY_HISTORY_DAYS, type DayRange, type HistoryDaysState } from '../../utils/historyDays'

afterEach(cleanup)

HTMLElement.prototype.scrollIntoView = () => {}

const FAR: QuakeListFilter = { ...DEFAULT_QUAKE_LIST_FILTER, period: { kind: 'range', from: '2026-01-01', to: '2026-01-10' } }

async function renderTab(opts: {
  filter: QuakeListFilter
  historyDays: HistoryDaysState
  onLoadPeriod: (range: DayRange) => Promise<boolean>
  onLoadMore?: () => Promise<boolean>
  loadMoreFailed?: boolean
  hasMore?: boolean
}) {
  const result = render(
    <EarthquakeTab matchedCount={0}
      earthquakes={[]}
      selectedId={null}
      selectSeq={0}
      speakingKey={null}
      followSpeech={false}
      onSelect={() => {}}
      isLoading={false}
      isLoadingMore={false}
      hasMore={opts.hasMore ?? true}
      onLoadMore={opts.onLoadMore ?? (async () => false)}
      watchLoadMoreThrottle={false}
      error={null}
      historyLoss={createEmptyTelegramLoss()}
      loadMoreFailed={opts.loadMoreFailed ?? false}
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
      filter={opts.filter}
      onFilterChange={() => {}}
      sort={DEFAULT_QUAKE_LIST_SORT}
      onSortChange={() => {}}
      filterSourceQuakes={[]}
      shown
      historyDays={opts.historyDays}
      onLoadPeriod={opts.onLoadPeriod}
      historyInputs={null}
      historyPickedId={null}
      historyView={null}
      onPickHistory={() => {}}
      onReplayQuake={() => {}}
      replayError={null}
    />,
  )
  await flushDataEffects()
  return result
}

const days = (main: DayRange | null, islandDays: string[] = []): HistoryDaysState => ({
  top: '2026-11-08', main, islands: new Map(islandDays.map(d => [d, null])),
})

describe('期間の日だけを読む', () => {
  it('正: 期間に足りない日があれば、その期間の範囲で自動に読み足す（今日から遡らない）', async () => {
    const onLoadPeriod = vi.fn(async () => false)
    const onLoadMore = vi.fn(async () => false)
    await renderTab({ filter: FAR, historyDays: days({ from: '2026-11-01', to: '2026-11-08' }), onLoadPeriod, onLoadMore })

    expect(onLoadPeriod).toHaveBeenCalledWith({ from: '2026-01-01', to: '2026-01-10' })
    expect(onLoadMore).not.toHaveBeenCalled()
  })

  it('正: 読み終わったのに足りない日が減らなければ止め、未読込みの注記を出す', async () => {
    const onLoadPeriod = vi.fn(async () => true)
    await renderTab({ filter: FAR, historyDays: days({ from: '2026-11-01', to: '2026-11-08' }), onLoadPeriod })

    expect(onLoadPeriod).toHaveBeenCalledTimes(1)
    // 足りない日の一番新しい日（1/10）から前が未読込み
    expect(screen.getAllByText('1月10日以前は未読込みです。').length).toBeGreaterThan(0)
  })

  it('安全弁: 読まずに返る（読む先が無い・捨てた）なら、すぐには止めず 3 回続いたら止める', async () => {
    const onLoadPeriod = vi.fn(async () => false)
    await renderTab({ filter: FAR, historyDays: days({ from: '2026-11-01', to: '2026-11-08' }), onLoadPeriod })

    // 起動時の履歴の取り直しと重なって読まずに返っただけなら、もう一度読みに行く。呼び続けはしない
    expect(onLoadPeriod).toHaveBeenCalledTimes(3)
    expect(screen.getAllByText('1月10日以前は未読込みです。').length).toBeGreaterThan(0)
  })

  it('正: 期間を選んでいる間の「もっと見る」は期間の続きを読む', async () => {
    const onLoadPeriod = vi.fn(async () => false)
    const onLoadMore = vi.fn(async () => false)
    // 失敗して自動が止まった形（押し直しの口だけを見る）
    await renderTab({ filter: FAR, historyDays: days({ from: '2026-11-01', to: '2026-11-08' }), onLoadPeriod, onLoadMore, loadMoreFailed: true })
    expect(onLoadPeriod).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'もっと見る' }))

    expect(onLoadPeriod).toHaveBeenCalledWith({ from: '2026-01-01', to: '2026-01-10' })
    expect(onLoadMore).not.toHaveBeenCalled()
  })

  it('対照: 期間の日を読み終えていれば、自動で読まず「もっと見る」も出さない', async () => {
    const onLoadPeriod = vi.fn(async () => false)
    const island = Array.from({ length: 10 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`)
    await renderTab({ filter: FAR, historyDays: days({ from: '2026-11-01', to: '2026-11-08' }, island), onLoadPeriod })

    expect(onLoadPeriod).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'もっと見る' })).toBeNull()
    expect(screen.queryByText(/未読込みです/)).toBeNull()
  })

  it('安全弁: 期間を外していれば、今までどおり「もっと見る」は今日から続く分を遡る', async () => {
    const onLoadPeriod = vi.fn(async () => false)
    const onLoadMore = vi.fn(async () => false)
    await renderTab({ filter: DEFAULT_QUAKE_LIST_FILTER, historyDays: EMPTY_HISTORY_DAYS, onLoadPeriod, onLoadMore })

    fireEvent.click(screen.getByRole('button', { name: 'もっと見る' }))

    expect(onLoadMore).toHaveBeenCalledTimes(1)
    expect(onLoadPeriod).not.toHaveBeenCalled()
  })
})

function DialogHarness({ initial, onFilter }: { initial: QuakeListFilter; onFilter: (f: QuakeListFilter) => void }) {
  const [filter, setFilter] = useState(initial)
  return (
    <QuakeListFilterDialog filter={filter} onChange={f => { setFilter(f); onFilter(f) }} quakes={[]} open onClose={() => {}} shownCount={0} totalCount={0} loadNote={null} />
  )
}

describe('日付を指定した期間の長さ', () => {
  const commitDate = (label: string, value: string) => {
    const input = screen.getByLabelText(label) as HTMLInputElement
    act(() => {
      fireEvent.change(input, { target: { value } })
      fireEvent.blur(input)
    })
  }

  it('正: 90 日を超えたら、打った欄はそのまま反対の欄を寄せ、注記を出す', async () => {
    let last: QuakeListFilter | null = null
    render(<DialogHarness initial={FAR} onFilter={f => { last = f }} />)
    await flushDataEffects()

    commitDate('期間の終了日', '2026-06-30')

    expect(last!.period).toEqual({ kind: 'range', from: '2026-04-02', to: '2026-06-30' })
    expect(screen.getByText('期間は90日までです。')).toBeTruthy()
  })

  it('対照: 90 日までなら寄せず、注記も出さない', async () => {
    let last: QuakeListFilter | null = null
    render(<DialogHarness initial={FAR} onFilter={f => { last = f }} />)
    await flushDataEffects()

    commitDate('期間の終了日', '2026-03-31')

    expect(last!.period).toEqual({ kind: 'range', from: '2026-01-01', to: '2026-03-31' })
    expect(screen.queryByText('期間は90日までです。')).toBeNull()
  })
})
