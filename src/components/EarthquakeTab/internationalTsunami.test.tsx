// @vitest-environment jsdom
//
// 遠地地震のカードに国際津波関連情報（WEPA60・英文）を畳んで添える（2026-10-30 ユーザー選択
// 「受けて英文のまま出す (Recommended)」）。結び付けの判定は `utils/internationalTsunami.test.ts`、
// ここは渡された報がカードに原文のまま出ることと、国内の地震のカードに出ないことを固定する。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { flushDataEffects } from '../../test-utils/flushDataEffects'
import { EarthquakeTab } from './index'
import { quakeEventKey } from '../../utils/quakeMerge'
import type { IssueType, JMAInternationalTsunami, JMAQuake } from '../../types/earthquake'
import { createEmptyTelegramLoss } from '../../utils/telegramLoss'

afterEach(cleanup)

// jsdom は `scrollIntoView` を持たない（寄せる動きはこのテストの対象ではない）。
HTMLElement.prototype.scrollIntoView = () => {}

const TEXT = ['WEPA60 RJTD 211247', 'TSUNAMI BULLETIN NUMBER 001', 'ORIGIN TIME:1223Z 21 JAN 2021'].join('\n')
const BULLETIN: JMAInternationalTsunami = {
  id: 'WEPA60:2021-01-21T12:47:00.000Z:TSUNAMI BULLETIN NUMBER 001',
  title: 'TSUNAMI BULLETIN NUMBER 001',
  time: '2021-01-21T12:47:00.000Z',
  originTime: '2021-01-21T12:23:00.000Z',
  isCommunicationsTest: false,
  text: TEXT,
}

function makeQuake(type: IssueType): JMAQuake {
  return {
    kind: 'quake',
    id: 'dmdata-quake-20210121212300-1',
    eventId: '20210121212300',
    time: '2021-01-21T12:51:00Z',
    issue: { source: 'テスト', time: '2021-01-21T12:51:00Z', type, correct: 'なし' },
    earthquake: {
      time: '2021-01-21T12:23:00Z',
      hypocenter: { name: 'インドネシア付近', latitude: 4.8, longitude: 127.4, depth: 140, magnitude: 7.0 },
      maxScale: -1,
      domesticTsunami: 'なし',
    },
    points: [],
  }
}

const renderTab = async (quake: JMAQuake, bulletins: readonly JMAInternationalTsunami[], onSelect: (id: string) => void = () => {}) => {
  render(
    <EarthquakeTab
      earthquakes={[quake]}
      selectedId={quakeEventKey(quake)}
      speakingKey={null}
      followSpeech={false}
      onSelect={onSelect}
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
      internationalTsunamis={bulletins}
      distributionQuakeKey={null}
      onToggleDistribution={() => {}}
      unreceivedQuakeKey={null}
      onToggleUnreceived={() => {}}
      onFocusMap={() => {}}
      speakingTelegramTextSubject={null}
      seismoWaves={new Map()}
      seismoWaveFailedKeys={new Set()}
      seismoWaveView="composite"
    />,
  )
  await flushDataEffects()
}

describe('地震カードの国際津波関連情報（英文）', () => {
  it('渡された報を、題名つきの畳んだ枠に原文のまま出す', async () => {
    await renderTab(makeQuake('遠地地震'), [BULLETIN])
    const summary = screen.getByText('国際津波関連情報（英文）', { exact: false })
    expect(summary.textContent).toContain('TSUNAMI BULLETIN NUMBER 001')
    const details = summary.closest('details')
    expect(details?.open).toBe(false)
    expect(details?.querySelector('pre')?.textContent).toBe(TEXT)
  })

  it('枠を開いてもカードの選択は動かない（押した操作をカードへ伝えない）', async () => {
    const onSelect = vi.fn()
    await renderTab(makeQuake('遠地地震'), [BULLETIN], onSelect)
    const summary = screen.getByText('国際津波関連情報（英文）', { exact: false })
    fireEvent.click(summary)
    expect(onSelect).not.toHaveBeenCalled()
    // 対照: カードの見出し（震源名）を押せばカードへ伝わる
    fireEvent.click(screen.getAllByText('インドネシア付近')[0])
    expect(onSelect).toHaveBeenCalled()
  })

  it('報が無ければ枠を出さない', async () => {
    await renderTab(makeQuake('遠地地震'), [])
    expect(screen.queryByText('国際津波関連情報（英文）', { exact: false })).toBeNull()
  })
})
