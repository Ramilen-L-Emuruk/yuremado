// @vitest-environment jsdom
//
// 地震カードの地震の時刻が、日時として読めない値のときに何を出すか。
//
// `formatQuakeTime` は読めない値で `null` を返す（→ `utils/formatters.ts` の `readDateTime`）。
// **JSX へ素で埋めると `null` は何も描画されず、欄が黙って消える** —— 型検査も通ってしまう。
// ここはカードの主題（いつ起きた地震か）で、空欄にすると隣の種別バッジだけが残り、
// 時刻を読み落としたのか電文に無いのか利用者に分からない。語を出すことを固定する。
//
// **開いた表示と畳んだ表示の 2 か所にある。** 片方だけ直しても型検査は通り、例外も出ない。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { flushDataEffects } from '../../test-utils/flushDataEffects'
import { EarthquakeTab } from './index'
import { quakeEventKey } from '../../utils/quakeMerge'
import type { JMAQuake } from '../../types/earthquake'
import { createEmptyTelegramLoss } from '../../utils/telegramLoss'
import { formatQuakeTimeLabeled } from '../../utils/formatters'

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
  <EarthquakeTab
    earthquakes={[quake]}
    selectedId={selected ? quakeEventKey(quake) : null}
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
    lpgmByEventId={new Map()}
    updateMarks={new Map()}
    activeLpgmEventId={null}
    onToggleLpgm={() => {}}
    estimatedIntensities={[]}
    distributionQuakeKey={null}
    onToggleDistribution={() => {}}
    unreceivedQuakeKey={null}
    onToggleUnreceived={() => {}}
    onFocusMap={() => {}}
    speakingTelegramTextSubject={null}
    seismoWaves={new Map()}
    seismoWaveView="composite"
  />
  )
  await flushDataEffects()
  return result
}

/**
 * 畳んだカードの時刻の欄（文字列全体が `text` に一致し、折れない塊を子に持つ要素）を探し、
 * その塊の文字列を返す。見つからなければ空の配列。
 * 欄を文字列で絞るので、カードの別の段に折れない要素が増えても巻き込まない。
 */
function collapsedTimePieces(container: HTMLElement, text: string): (string | null)[] {
  const field = [...container.querySelectorAll('span')]
    .find(s => s.textContent === text && s.querySelector(':scope > .whitespace-nowrap') !== null)
  return field ? [...field.querySelectorAll(':scope > .whitespace-nowrap')].map(e => e.textContent) : []
}

describe('地震カードの地震発現時刻が読めないとき', () => {
  // 対照: 読める値では従来どおりの表記。ガードが正常な値まで止めていないこと。
  it('読める値では「地震発現時刻 ◯月◯日 ◯:◯◯」を出す', async () => {
    await renderTab(makeQuake('2024-01-01T07:10:00Z'), true)
    expect(screen.getAllByText(/^地震発現時刻 1月1日 \d{1,2}:\d{2}$/).length).toBeGreaterThan(0)
    expect(screen.queryByText('地震発現時刻不明')).toBeNull()
  })

  // 対照（畳んだ表示）: 畳んだ表示は名前と日時を別の塊に分けて出す（境目でだけ折り返すため）。
  // 上の `getAllByText` は要素 1 つの文字列で照合するので、開いた表示が一致するだけで通ってしまう。
  // 畳んだ表示の文字列は、塊を繋いだ `textContent` で開いた表示と同じであることを確かめる。
  it('畳んだ表示でも、名前と日時を同じ文字列で出し、それぞれ途中では折らない', async () => {
    const quake = makeQuake('2024-01-01T07:10:00Z')
    const { container } = await renderTab(quake, false)
    expect(collapsedTimePieces(container, formatQuakeTimeLabeled(quake.earthquake.time)))
      .toEqual(['地震発現時刻', '1月1日 16:10'])
  })

  // 正: 開いた表示（選択中のカード）で語を出す。
  it('開いた表示では「地震発現時刻不明」を出す', async () => {
    await renderTab(makeQuake('壊れた値'), true)
    expect(screen.getAllByText('地震発現時刻不明').length).toBeGreaterThan(0)
  })

  // 正: 畳んだ表示にも同じ語を出す。**2 か所あるのがこのテストの要**
  // （片方だけ直しても型検査は通り、例外も出ない）。
  it('畳んだ表示にも同じ語を出す', async () => {
    const { container } = await renderTab(makeQuake('壊れた値'), false)
    expect(collapsedTimePieces(container, '地震発現時刻不明')).toEqual(['地震発現時刻不明'])
  })

  // 安全弁: `NaN` がそのまま画面へ出ない（これが元の症状）。
  it('NaN を画面に出さない', async () => {
    const { container } = await renderTab(makeQuake('壊れた値'), true)
    expect(container.textContent).not.toContain('NaN')
  })
})
