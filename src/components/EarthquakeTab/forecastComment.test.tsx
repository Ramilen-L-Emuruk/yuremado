// @vitest-environment jsdom
//
// 地震情報の固定付加文（`ForecastComment/Text` → `forecastText`）を地震カードに原文のまま出すこと
// （2026-10-19 ユーザー承認。→ docs/spec/quake-spec.md §3「津波の付加文」）。
//
// 津波の欄は付加文の**コード**を区分へ丸めたもので、区分にならない文（0245「この地震で緊急地震速報を
// 発表しましたが、強い揺れは観測されませんでした。」）はこの枠にしか現れない。消しても型検査は通り
// 例外も出ないので、ここで固定する。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { flushDataEffects } from '../../test-utils/flushDataEffects'
import { EarthquakeTab } from './index'
import { quakeEventKey } from '../../utils/quakeMerge'
import type { JMAQuake } from '../../types/earthquake'
import { createEmptyTelegramLoss } from '../../utils/telegramLoss'

afterEach(cleanup)

// jsdom は `scrollIntoView` を持たない（寄せる動きはこのテストの対象ではない）。
HTMLElement.prototype.scrollIntoView = () => {}

/** 2026-10-16 カムチャツカ半島付近 M6.9 の実電文（VXSE53）の固定付加文。パーサーは改行を詰めて 1 行にする。 */
const FORECAST_TEXT = 'この地震による津波の心配はありません。この地震で緊急地震速報を発表しましたが、強い揺れは観測されませんでした。'
const VAR_COMMENT_TEXT = '＊印は気象庁以外の震度観測点についての情報です。'

function makeQuake(over: Partial<JMAQuake> = {}): JMAQuake {
  return {
    kind: 'quake',
    id: 'dmdata-quake-20261016123810-1',
    eventId: '20261016123810',
    time: '2026-10-16T03:52:00Z',
    issue: { source: 'テスト', time: '2026-10-16T03:52:00Z', type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: '2026-10-16T03:35:00Z',
      hypocenter: { name: 'カムチャツカ半島付近', latitude: 50.0, longitude: 158.1, depth: 160, magnitude: 6.9 },
      maxScale: 10,
      domesticTsunami: 'なし',
    },
    points: [],
    forecastText: FORECAST_TEXT,
    varCommentText: VAR_COMMENT_TEXT,
    ...over,
  }
}

const renderTab = async (quake: JMAQuake, selected = true) => {
  render(
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
    />,
  )
  await flushDataEffects()
}

describe('地震カードの固定付加文', () => {
  // 正: 選択中のカードに原文がそのまま出る（区分にならない 2 文目も含めて）。
  it('原文を全部出す', async () => {
    await renderTab(makeQuake())
    expect(screen.getByText(FORECAST_TEXT)).toBeTruthy()
  })

  // 並び: 電文と同じく「その他」（`＊` 印の説明）より前に出す。
  it('固定付加文（その他）より前に出す', async () => {
    await renderTab(makeQuake())
    const forecast = screen.getByText(FORECAST_TEXT)
    const varComment = screen.getByText(VAR_COMMENT_TEXT)
    expect(forecast.compareDocumentPosition(varComment) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // 対照: 付加文を持たない電文（P2PQuake 経路など）では枠ごと出さない。
  it('付加文が無ければ何も出さない', async () => {
    await renderTab(makeQuake({ forecastText: undefined }))
    expect(screen.queryByText(/緊急地震速報を発表しましたが/)).toBeNull()
  })

  // 安全弁: 一覧の畳んだカードには出さない（自由付加文と同じく選択中のカードだけ）。
  it('選んでいないカードには出さない', async () => {
    await renderTab(makeQuake(), false)
    expect(screen.queryByText(FORECAST_TEXT)).toBeNull()
  })
})
