// @vitest-environment jsdom
//
// 地震カードの地震の時刻が、日時として読めない値のときに何を出すか。
//
// `formatQuakeTime` は読めない値で `null` を返す（→ `utils/formatters.ts` の `readDateTime`）。
// **JSX へ素で埋めると `null` は何も描画されず、欄が黙って消える** —— 型検査も通ってしまう。
// ここはカードの主題（いつ起きた地震か）で、空欄にすると隣の種別バッジだけが残り、
// 時刻を読み落としたのか電文に無いのか利用者に分からない。語を出すことを固定する。
//
// **開いたカードと一覧の閉じた行の 2 か所にある。** 片方だけ直しても型検査は通り、例外も出ない。
import { DEFAULT_QUAKE_LIST_FILTER, DEFAULT_QUAKE_LIST_SORT } from '../../utils/quakeListView'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { flushDataEffects } from '../../test-utils/flushDataEffects'
import { EarthquakeTab } from './index'
import { quakeEventKey } from '../../utils/quakeMerge'
import type { JMAQuake } from '../../types/earthquake'
import { createEmptyTelegramLoss } from '../../utils/telegramLoss'
import { QUAKE_ARRIVAL_TIME_LABEL, QUAKE_ARRIVAL_TIME_UNKNOWN } from '../../utils/formatters'
import { EMPTY_HISTORY_DAYS } from '../../utils/historyDays'

afterEach(cleanup)

// jsdom は `scrollIntoView` を持たない（寄せる動きはこのテストの対象ではない）。
HTMLElement.prototype.scrollIntoView = () => {}

const EVENT_ID = '20240101161000'

function makeQuake(earthquakeTime: string): JMAQuake {
  return {
    kind: 'quake',
    id: `dmdata-quake-${EVENT_ID}-1`,
    eventId: EVENT_ID,
    time: '2024-01-01T07:24:00Z',
    issue: { source: 'テスト', time: '2024-01-01T07:24:00Z', type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: earthquakeTime,
      hypocenter: { name: '石川県能登地方', latitude: 37.495, longitude: 137.27, depth: 16, magnitude: 7.6 },
      maxScale: 45,
      domesticTsunami: '警報等',
    },
    points: [{ pref: '石川県', addr: '石川県能登', isArea: true, scale: 45 }],
  }
}

const renderTab = async (quake: JMAQuake, selected: boolean) => {
  const result = render(
  <EarthquakeTab matchedCount={0}
    earthquakes={[quake]}
    selectedId={selected ? quakeEventKey(quake) : null}
    selectSeq={0}
    speakingKey={null}
    followSpeech={false}
    onSelect={() => {}}
    isLoading={false}
    isLoadingMore={false}
    hasMore={false}
    onLoadMore={async () => false}
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
    historyDays={EMPTY_HISTORY_DAYS} onLoadPeriod={async () => false}
    historyInputs={null}
    historyPickedId={null}
    historyView={null}
    onPickHistory={() => {}}
    onReplayQuake={() => {}}
    replayError={null}
  />
  )
  await flushDataEffects()
  return result
}

/** 一覧の閉じた行の時刻の欄（`QuakeListRow` の `data-col="time"`）の文字列。見つからなければ null。 */
function collapsedTime(container: HTMLElement): string | null {
  return container.querySelector('[data-col="time"]')?.textContent ?? null
}

describe('地震カードの地震発現時刻が読めないとき', () => {
  // 対照: 読める値では見出し「地震発現時刻」と日時を出す。ガードが正常な値まで止めていないこと。
  it('読める値では「地震発現時刻」の見出しと ◯月◯日 ◯:◯◯ を出す', async () => {
    await renderTab(makeQuake('2024-01-01T07:10:00Z'), true)
    expect(screen.getByText(QUAKE_ARRIVAL_TIME_LABEL)).toBeTruthy()
    expect(screen.getByText('1月1日 16:10')).toBeTruthy()
    expect(screen.queryByText(QUAKE_ARRIVAL_TIME_UNKNOWN)).toBeNull()
  })

  // 対照（閉じた行）: 時刻の列は時と分だけ（日付は日の区切りが持つ）。
  it('閉じた行の時刻の列は ◯:◯◯ を出す', async () => {
    const { container } = await renderTab(makeQuake('2024-01-01T07:10:00Z'), false)
    expect(collapsedTime(container)).toBe('16:10')
  })

  // 正: 開いた表示（選択中のカード）で語を出す。
  it('開いた表示では「地震発現時刻不明」を出す', async () => {
    await renderTab(makeQuake('壊れた値'), true)
    expect(screen.getAllByText(QUAKE_ARRIVAL_TIME_UNKNOWN).length).toBeGreaterThan(0)
  })

  // 正: 閉じた行の時刻の列も空にしない（語は一覧の行の語）。**2 か所あるのがこのテストの要**
  // （片方だけ直しても型検査は通り、例外も出ない）。
  it('閉じた行の時刻の列も空にしない', async () => {
    const { container } = await renderTab(makeQuake('壊れた値'), false)
    expect(collapsedTime(container)).toBe('不明')
  })

  // 安全弁: `NaN` がそのまま画面へ出ない（これが元の症状）。
  it('NaN を画面に出さない', async () => {
    const { container } = await renderTab(makeQuake('壊れた値'), true)
    expect(container.textContent).not.toContain('NaN')
  })
})
