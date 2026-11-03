// @vitest-environment jsdom
//
// 遠地地震のカードに国際津波関連情報（WEPA60・英文）を畳んで添える（2026-10-30 ユーザー選択
// 「受けて英文のまま出す (Recommended)」）。結び付けの判定は `utils/internationalTsunami.test.ts`、
// ここは渡された報がカードに原文のまま出ることと、国内の地震のカードに出ないことを固定する。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
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

const tabElement = (quake: JMAQuake, bulletins: readonly JMAInternationalTsunami[], onSelect: (id: string) => void, selectSeq: number) => (
    <EarthquakeTab
      earthquakes={[quake]}
      selectedId={quakeEventKey(quake)}
      selectSeq={selectSeq}
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
      relayGapNotices={[]}
      onDismissKeyReentry={null}
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
    />
)

const renderTab = async (quake: JMAQuake, bulletins: readonly JMAInternationalTsunami[], onSelect: (id: string) => void = () => {}) => {
  const view = render(tabElement(quake, bulletins, onSelect, 0))
  await flushDataEffects()
  return view
}

describe('地震カードの国際津波関連情報（英文）', () => {
  // 付加文の下に、畳まずに本文ごと出す（→ docs/quake-tab-redesign.md。2026-11-01
  // 「それぞれ自分の欄を持つ (Recommended)」）
  it('渡された報を、題名つきの枠に畳まず原文のまま出す', async () => {
    await renderTab(makeQuake('遠地地震'), [BULLETIN])
    const title = screen.getByText('国際津波関連情報（英文）', { exact: false })
    expect(title.textContent).toContain('TSUNAMI BULLETIN NUMBER 001')
    expect(title.closest('details')).toBeNull()
    const box = title.parentElement
    expect(box?.querySelector('pre')?.textContent).toBe(TEXT)
  })

  it('枠を押してもカードの選択は動かない', async () => {
    const onSelect = vi.fn()
    await renderTab(makeQuake('遠地地震'), [BULLETIN], onSelect)
    const title = screen.getByText('国際津波関連情報（英文）', { exact: false })
    fireEvent.click(title)
    fireEvent.click(title.parentElement!.querySelector('pre')!)
    expect(onSelect).not.toHaveBeenCalled()
    // 対照: 開いたカードの見出しの行を押せばカードが畳まれる（枠が消える）
    fireEvent.click(screen.getByRole('button', { expanded: true, name: /^▾/ }))
    expect(screen.queryByText('国際津波関連情報（英文）', { exact: false })).toBeNull()
  })

  // 見出しの行は畳むだけで、選択は外さない（2026-11-03 選択「見出しも帯も閉じるだけ (Recommended)」）。
  // 畳んだ行をもう一度押すと開き直すだけで、親へは伝えない（地図を動かさない）
  it('見出しで畳んでも選択を外さず、畳んだ行を押すと親へ伝えずに開き直す', async () => {
    const onSelect = vi.fn()
    await renderTab(makeQuake('遠地地震'), [BULLETIN], onSelect)
    fireEvent.click(screen.getByRole('button', { expanded: true, name: /^▾/ }))
    expect(onSelect).not.toHaveBeenCalled()
    const row = screen.getByRole('button', { pressed: true })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(row)
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByText('国際津波関連情報（英文）', { exact: false })).toBeTruthy()
  })

  // 選んだまま畳んでいても、選択が呼ばれたら（同じ地震の続報・読み上げ・津波タブからのリンク）開き直す
  // （2026-11-03 選択「どれが来ても開き直す (Recommended)」）
  it('畳んだカードは、選択の番号が進んだら開き直す', async () => {
    const quake = makeQuake('遠地地震')
    const { rerender } = await renderTab(quake, [BULLETIN])
    fireEvent.click(screen.getByRole('button', { expanded: true, name: /^▾/ }))
    expect(screen.queryByText('国際津波関連情報（英文）', { exact: false })).toBeNull()
    // 対照: 番号が同じまま描き直しても畳んだまま
    await act(async () => { rerender(tabElement(quake, [BULLETIN], () => {}, 0)) })
    expect(screen.queryByText('国際津波関連情報（英文）', { exact: false })).toBeNull()
    // 正: 番号が進むと開き直す
    await act(async () => { rerender(tabElement(quake, [BULLETIN], () => {}, 1)) })
    expect(screen.getByText('国際津波関連情報（英文）', { exact: false })).toBeTruthy()
  })

  it('報が無ければ枠を出さない', async () => {
    await renderTab(makeQuake('遠地地震'), [])
    expect(screen.queryByText('国際津波関連情報（英文）', { exact: false })).toBeNull()
  })
})
