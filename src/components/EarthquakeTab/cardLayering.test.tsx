// @vitest-environment jsdom
//
// 地震カードの重なりと覆いの形。どれも見た目だけの不具合で、型検査もほかのテストも素通りする。
//
// - 取消の覆いは角を丸めない（行もカードも四角いので、丸めると四隅だけ暗くならずに残る）
// - 広い組で貼りつく震度の枠は、見出しの段の下に描く（理由は src/index.css の `.quake-stick`）
import { DEFAULT_QUAKE_LIST_FILTER, DEFAULT_QUAKE_LIST_SORT } from '../../utils/quakeListView'
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { render, cleanup } from '@testing-library/react'
import { flushDataEffects } from '../../test-utils/flushDataEffects'
import { EarthquakeTab } from './index'
import { quakeEventKey } from '../../utils/quakeMerge'
import type { JMAQuake } from '../../types/earthquake'
import { createEmptyTelegramLoss } from '../../utils/telegramLoss'
import { EMPTY_HISTORY_DAYS } from '../../utils/historyDays'

afterEach(cleanup)

// jsdom は `scrollIntoView` を持たない（寄せる動きはこのテストの対象ではない）。
HTMLElement.prototype.scrollIntoView = () => {}

const EVENT_ID = '20240101161000'

function makeCancelledQuake(): JMAQuake {
  return {
    kind: 'quake',
    id: `dmdata-quake-${EVENT_ID}-1`,
    eventId: EVENT_ID,
    time: '2024-01-01T07:24:00Z',
    cancelled: true,
    cancelledAt: new Date('2024-01-01T07:30:00Z'),
    issue: { source: 'テスト', time: '2024-01-01T07:24:00Z', type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: '2024-01-01T07:10:00Z',
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
    />,
  )
  await flushDataEffects()
  return result
}

/** 取消の覆い（「取消」の大きな字を持つ暗い面）。 */
function cancelOverlay(container: HTMLElement): HTMLElement {
  const overlay = container.querySelector<HTMLElement>('.bg-black\\/70')
  expect(overlay).not.toBeNull()
  expect(overlay!.textContent).toContain('取消')
  return overlay!
}

describe('地震の取消の覆い', () => {
  // 正: 開いたカードの覆いは角を丸めない
  it('開いたカードの覆いは角を丸めない', async () => {
    const { container } = await renderTab(makeCancelledQuake(), true)
    expect(cancelOverlay(container).className).not.toMatch(/\brounded/)
  })

  // 正: 閉じた行の覆いも同じ（2 か所あるので片方だけ直すと残る）
  it('閉じた行の覆いも角を丸めない', async () => {
    const { container } = await renderTab(makeCancelledQuake(), false)
    expect(cancelOverlay(container).className).not.toMatch(/\brounded/)
  })

  // 正: 覆い（z-10）はカード・行の箱の中で閉じる。箱が重なりの文脈を作らないと、一覧の見出しの行（z-[4]）・
  // 日付の区切り（z-[3]）と同じ文脈で比べられ、巻いたとき覆いがその上へ被る
  it('覆いを入れる箱は isolate（開いたカード・閉じた行の両方）', async () => {
    for (const selected of [true, false]) {
      const { container, unmount } = await renderTab(makeCancelledQuake(), selected)
      expect(cancelOverlay(container).parentElement!.classList.contains('isolate')).toBe(true)
      unmount()
    }
  })

  // 安全弁: 覆いはカード・行いっぱいに広がったまま（角を外すついでに覆う範囲を変えていない）
  it('覆いはカード・行いっぱいに広がる', async () => {
    for (const selected of [true, false]) {
      const { container, unmount } = await renderTab(makeCancelledQuake(), selected)
      expect(cancelOverlay(container).className).toMatch(/\babsolute inset-0\b/)
      unmount()
    }
  })
})

describe('広い組で貼りつく見出しの段と震度の枠の重なり', () => {
  // jsdom の環境では `import.meta.url` が file: でないので、リポジトリのトップからのパスで読む
  const css = readFileSync('src/index.css', 'utf8')
  /** `[data-stick-tall] <selector>` の規則の z-index。 */
  const stickZ = (selector: string): number => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = new RegExp(`\\[data-stick-tall\\] ${escaped}\\s*\\{[^}]*z-index:\\s*(\\d+)`).exec(css)
    expect(m).not.toBeNull()
    return Number(m![1])
  }
  // 一覧の見出しの行と日付の区切りの z（`QuakeListRow` のクラス `z-[4]`・`z-[3]`）
  const row = readFileSync('src/components/EarthquakeTab/QuakeListRow.tsx', 'utf8')
  const rowZ = [...row.matchAll(/\bsticky\b[^"]*\bz-\[(\d+)\]/g)].map(m => Number(m[1]))

  // 正: 枠は見出しの段より下（同じ z だと DOM で後ろの枠が上へ被さる）
  it('震度の枠の z は見出しの段より小さい', () => {
    expect(stickZ('.quake-stick')).toBeLessThan(stickZ('.quake-open-head'))
  })

  // 安全弁: どちらも一覧の見出しの行・日付の区切りより下のまま（巻いたとき、その下へ潜る）
  it('見出しの段も震度の枠も、一覧の見出しの行と日付の区切りより下', () => {
    expect(rowZ).toHaveLength(2)
    for (const z of rowZ) {
      expect(stickZ('.quake-open-head')).toBeLessThan(z)
      expect(stickZ('.quake-stick')).toBeLessThan(z)
    }
  })
})
