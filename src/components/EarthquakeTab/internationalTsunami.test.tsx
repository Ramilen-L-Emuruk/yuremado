// @vitest-environment jsdom
//
// 地震カードに国際津波関連情報（WEPA60・英文）を添える（2026-10-30 ユーザー選択
// 「受けて英文のまま出す (Recommended)」・2026-11-03 ユーザー選択「国内に付け、無い分はカードに (Recommended)」）。
// 結び付けの判定は `utils/internationalTsunami.test.ts`、ここは渡された報がカードに日本語訳と原文の切り替えで出ることと、
// 英文だけのカードの見出し・時刻の名前・津波の欄を固定する。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { flushDataEffects } from '../../test-utils/flushDataEffects'
import { EarthquakeTab } from './index'
import { quakeEventKey } from '../../utils/quakeMerge'
import type { IssueType, JMAInternationalTsunami, JMAQuake } from '../../types/earthquake'
import { createEmptyTelegramLoss } from '../../utils/telegramLoss'
import { internationalTsunamiIndex } from '../../utils/internationalTsunami'

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
      onDismissKeyReentry={null}
      lpgmByEventId={new Map()}
      updateMarks={new Map()}
      activeLpgmEventId={null}
      onToggleLpgm={() => {}}
      lpgmFocus={null}
      estimatedIntensities={[]}
      internationalTsunamisByQuake={internationalTsunamiIndex([quake], bulletins).byQuakeKey}
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
    />
)

const renderTab = async (quake: JMAQuake, bulletins: readonly JMAInternationalTsunami[], onSelect: (id: string) => void = () => {}) => {
  const view = render(tabElement(quake, bulletins, onSelect, 0))
  await flushDataEffects()
  return view
}

/** 英文の 1 報の見出しの行（押すと本文を開閉する） */
const foldRow = (): HTMLElement => screen.getByText('国際津波関連情報（英文）', { exact: false })

/**
 * 開いた欄は地名の表と観測点の座標を読み込んでから訳を出す。開く操作のあとはその読み込みを act() の中で決着させる
 * （テスト環境では読み込みがその場で失敗し、表無しで訳す）
 */
const press = async (fire: () => void) => {
  fire()
  await flushDataEffects()
}

/** 開いた欄の「原文」を押して、英文の `<pre>` を返す */
const showOriginal = (row: HTMLElement): HTMLPreElement => {
  const box = row.parentElement!
  fireEvent.click(Array.from(box.querySelectorAll('button')).find(b => b.textContent === '原文')!)
  return box.querySelector('pre')!
}

describe('地震カードの国際津波関連情報（英文）', () => {
  // 地震情報のカードでは閉じて置き、見出しの行で開閉する（2026-11-05 ユーザー選択「英文だけのカードだけ開く」）
  // 開くと初めは日本語訳を出し、「原文」で英文に切り替える（2026-11-08 ユーザー発言「切り替えだけどせっかくなんだからデフォ翻訳でいいんじゃない」）
  it('地震情報のカードでは題名つきの行だけを出し、押すと日本語訳で開き、原文に切り替えられ、もう一度押すと閉じる', async () => {
    const onSelect = vi.fn()
    await renderTab(makeQuake('遠地地震'), [BULLETIN], onSelect)
    const row = foldRow()
    expect(row.textContent).toContain('TSUNAMI BULLETIN NUMBER 001')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(row.parentElement!.querySelector('pre')).toBeNull()
    await press(() => fireEvent.click(row))
    expect(row.getAttribute('aria-expanded')).toBe('true')
    // 正: 初めは日本語訳（英文の <pre> は出さない）。訳せない行は英語のまま「（未訳）」を付ける
    expect(row.parentElement!.querySelector('pre')).toBeNull()
    expect(row.parentElement!.textContent).toContain('北西太平洋津波情報 第1報')
    expect(row.parentElement!.textContent).toContain('（未訳）ORIGIN TIME:1223Z 21 JAN 2021')
    // 対照: 「原文」を押すと英文をそのまま出す
    expect(showOriginal(row).textContent).toBe(TEXT)
    // 安全弁: 開閉の行や切り替えを押しても、カードの選択は呼び直さない（地図を動かさない）
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  // 正: 英文だけのカードは、ほかに出すものが無いので初めから開く（同じ選択）
  it('英文だけのカードでは初めから日本語訳を開いて出し、押すと閉じる', async () => {
    const [card] = internationalTsunamiIndex([], [BULLETIN]).cards
    await renderTab(card, [BULLETIN])
    const row = foldRow()
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(row.parentElement!.textContent).toContain('北西太平洋津波情報 第1報')
    expect(showOriginal(row).textContent).toBe(TEXT)
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  // 対照: 報ごとに開閉する（1 報を押しても他の報は変わらない）。キーボード（Enter・Space）でも開閉でき、
  // 安全弁: 英文だけのカードで押しても選択は呼び直さない
  it('2 報あれば押した報だけが変わり、Enter と Space でも開閉し、選択は呼ばない', async () => {
    const second: JMAInternationalTsunami = {
      ...BULLETIN,
      id: 'WEPA60:2021-01-21T13:10:00.000Z:TSUNAMI BULLETIN NUMBER 002',
      title: 'TSUNAMI BULLETIN NUMBER 002',
      time: '2021-01-21T13:10:00.000Z',
      text: TEXT.replace('001', '002'),
    }
    const [card] = internationalTsunamiIndex([], [BULLETIN, second]).cards
    const onSelect = vi.fn()
    await renderTab(card, [BULLETIN, second], onSelect)
    const rows = () => screen.getAllByText('国際津波関連情報（英文）', { exact: false })
    expect(rows().map(r => r.getAttribute('aria-expanded'))).toEqual(['true', 'true'])
    fireEvent.click(rows()[0])
    expect(rows().map(r => r.getAttribute('aria-expanded'))).toEqual(['false', 'true'])
    fireEvent.keyDown(rows()[1], { key: 'Enter' })
    expect(rows().map(r => r.getAttribute('aria-expanded'))).toEqual(['false', 'false'])
    await press(() => fireEvent.keyDown(rows()[0], { key: ' ' }))
    expect(rows().map(r => r.getAttribute('aria-expanded'))).toEqual(['true', 'false'])
    expect(onSelect).not.toHaveBeenCalled()
  })

  // 開いたカードの地（押せる所の外）を押すと、地図を全体へ寄せ直すために選択を呼び直す
  // （2026-11-03 選択「開いたカードの地を押す (Recommended)」）。開いた英文の本文は地に数える
  it('枠の本文を押すと選択を呼び直し、字を選んだ後の指の離しでは呼ばない', async () => {
    const onSelect = vi.fn()
    const quake = makeQuake('遠地地震')
    await renderTab(quake, [BULLETIN], onSelect)
    await press(() => fireEvent.click(foldRow()))
    const pre = showOriginal(foldRow())
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(pre)
    expect(onSelect).toHaveBeenCalledWith(quakeEventKey(quake))
    // 安全弁: 本文をなぞって選んでいる間の指の離しは地のクリックに数えない
    onSelect.mockClear()
    const range = document.createRange()
    range.selectNodeContents(pre)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    fireEvent.click(pre)
    expect(onSelect).not.toHaveBeenCalled()
    window.getSelection()!.removeAllRanges()
    // 対照: 見出しの行を押すとカードが畳まれるだけで、選択は呼ばない
    fireEvent.click(screen.getByRole('button', { expanded: true, name: /^▾/ }))
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.queryByText('国際津波関連情報（英文）', { exact: false })).toBeNull()
  })

  // 見出しの行は畳むだけで、選択は外さない（2026-11-03 選択「見出しも帯も閉じるだけ (Recommended)」）。
  // 畳んだ行をもう一度押すと開き直すだけで、親へは伝えない（地図を動かさない）
  it('見出しで畳んでも選択を外さず、畳んだ行を押すと親へ伝えずに開き直す', async () => {
    const onSelect = vi.fn()
    await renderTab(makeQuake('遠地地震'), [BULLETIN], onSelect)
    fireEvent.click(screen.getByRole('button', { expanded: true, name: /^▾/ }))
    expect(onSelect).not.toHaveBeenCalled()
    const row = screen.getByRole('button', { current: true })
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

  // 正: 国内の地震のカードにも、渡された報を出す
  it('国内の地震のカードにも出す', async () => {
    await renderTab(makeQuake('震源・震度情報'), [BULLETIN])
    expect(screen.getByText('国際津波関連情報（英文）', { exact: false })).toBeTruthy()
  })

  // 英文だけのカード（2026-11-03 ユーザー選択「英文の値をそのまま並べる (Recommended)」「「地震発生時刻」 (Recommended)」）
  it('英文だけのカードは見出しが「国際津波関連情報」、時刻の名前が「地震発生時刻」で、津波の欄を出さない', async () => {
    const [card] = internationalTsunamiIndex([], [{ ...BULLETIN, regionName: 'TALAUD ISLANDS, INDONESIA', epicenter: { latitude: 4.8, longitude: 127.4 }, magnitude: 7.0 }]).cards
    await renderTab(card, [BULLETIN])
    expect(screen.getAllByText('国際津波関連情報').length).toBeGreaterThan(0)
    expect(screen.getByText('地震発生時刻')).toBeTruthy()
    expect(screen.queryByText('地震発現時刻')).toBeNull()
    expect(screen.queryByText('津波')).toBeNull()
  })

  // 対照: 地震情報のカードは今までどおり「地震発現時刻」と津波の欄を出す
  it('地震情報のカードは「地震発現時刻」と津波の欄を出す', async () => {
    await renderTab(makeQuake('遠地地震'), [BULLETIN])
    expect(screen.getByText('地震発現時刻')).toBeTruthy()
    expect(screen.getByText('津波')).toBeTruthy()
  })

  it('報が無ければ枠を出さない', async () => {
    await renderTab(makeQuake('遠地地震'), [])
    expect(screen.queryByText('国際津波関連情報（英文）', { exact: false })).toBeNull()
  })
})
