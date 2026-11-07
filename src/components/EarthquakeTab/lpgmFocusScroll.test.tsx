// @vitest-environment jsdom
//
// 長周期地震動観測情報の受信・長周期の通知を押したときに、開いたカードの長周期の節を、長周期の札を
// 押したときと同じ位置へ巻く（→ docs/spec/quake-spec.md §8「一覧の寄せ方」）。
//
// **ここで確かめるのは「求めが来たら 1 回巻く・同じ求めでは巻き直さない・求め直せば巻く」の配線。**
// 着地の位置（貼りつく見出し・震度の枠の下）は jsdom では測れない（要素の高さが 0 になる）ので、実機で見る。
// 巻く関数そのものは長周期の札と共有している（`scrollOpenSectionIntoView`）。
import { DEFAULT_QUAKE_LIST_FILTER, DEFAULT_QUAKE_LIST_SORT } from '../../utils/quakeListView'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { flushDataEffects } from '../../test-utils/flushDataEffects'
import { EarthquakeTab } from './index'
import { quakeEventKey } from '../../utils/quakeMerge'
import type { JMAQuake, JMALpgm } from '../../types/earthquake'
import type { LpgmSectionFocus } from '../../utils/quakeCardScroll'
import { createEmptyTelegramLoss } from '../../utils/telegramLoss'

// jsdom は要素の `scrollTo`・`scrollIntoView` を持たない。巻いた回数だけを数える
const scrollTo = vi.fn()
HTMLElement.prototype.scrollTo = scrollTo as unknown as HTMLElement['scrollTo']
HTMLElement.prototype.scrollIntoView = () => {}

beforeEach(() => { scrollTo.mockClear() })

const EVENT_ID = '20240101161000'

const QUAKE: JMAQuake = {
  kind: 'quake',
  id: `dmdata-quake-${EVENT_ID}-1`,
  eventId: EVENT_ID,
  time: '2024-01-01T07:24:00Z',
  issue: { source: 'テスト', time: '2024-01-01T07:24:00Z', type: '震源・震度情報', correct: 'なし' },
  earthquake: {
    time: '2024-01-01T07:10:00Z',
    hypocenter: { name: '石川県能登地方', latitude: 37.495, longitude: 137.27, depth: 16, magnitude: 7.6 },
    maxScale: 70,
    domesticTsunami: '警報等',
  },
  points: [],
}

const LPGM: JMALpgm = {
  id: `test-lpgm-${EVENT_ID}`,
  eventId: EVENT_ID,
  time: '2024-01-01T07:23:00Z',
  originTime: '2024-01-01T07:10:00Z',
  maxClass: 4,
  cancelled: false,
}

const KEY = quakeEventKey(QUAKE)

// 巻く箱（`overflow-y: auto` の祖先）の中に置く。巻く関数は最も近いこの祖先を巻く
const tab = (lpgmFocus: LpgmSectionFocus | null, quake: JMAQuake = QUAKE, lpgm: JMALpgm = LPGM) => (
  <div style={{ overflowY: 'auto', height: 400 }}>
    <EarthquakeTab
      earthquakes={[quake]}
      selectedId={KEY}
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
      lpgmByEventId={new Map([[EVENT_ID, lpgm]])}
      updateMarks={new Map()}
      activeLpgmEventId={null}
      onToggleLpgm={() => {}}
      lpgmFocus={lpgmFocus}
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
    />
  </div>
)

/** 描いてから、その後に巻いた回数を数える（最初の描画での一覧の寄せは数えない）。 */
async function mount(focus: LpgmSectionFocus | null) {
  const r = render(tab(focus))
  await flushDataEffects()
  return r
}

describe('長周期地震動の節を見せる求め', () => {
  // 正: 求めが来たら、長周期の節へ 1 回巻く。
  it('求めが来たら巻く', async () => {
    const r = await mount(null)
    scrollTo.mockClear()
    r.rerender(tab({ key: KEY, seq: 1, quakeId: QUAKE.id }))
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  // 対照: 同じ求めのまま描き直しても巻き直さない（利用者が読んでいる位置を動かさない）。
  it('同じ求めでは巻き直さない', async () => {
    const r = await mount({ key: KEY, seq: 1, quakeId: QUAKE.id })
    scrollTo.mockClear()
    r.rerender(tab({ key: KEY, seq: 1, quakeId: QUAKE.id }))
    expect(scrollTo).not.toHaveBeenCalled()
  })

  // 正: 求め直せば（通知をもう一度押す等）巻き直す。
  it('求め直すと巻き直す', async () => {
    const r = await mount({ key: KEY, seq: 1, quakeId: QUAKE.id })
    scrollTo.mockClear()
    r.rerender(tab({ key: KEY, seq: 2, quakeId: QUAKE.id }))
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  // 安全弁: 長周期が取り消されて節が無ければ巻かない。
  it('長周期の節が無ければ巻かない', async () => {
    const r = render(tab(null, QUAKE, { ...LPGM, cancelled: true }))
    await flushDataEffects()
    scrollTo.mockClear()
    r.rerender(tab({ key: KEY, seq: 1, quakeId: QUAKE.id }, QUAKE, { ...LPGM, cancelled: true }))
    expect(scrollTo).not.toHaveBeenCalled()
  })
})
