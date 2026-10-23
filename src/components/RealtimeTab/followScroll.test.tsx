// @vitest-environment jsdom
//
// 緊急地震速報のカードを、タブの枠の中で見える位置へ寄せる（`hooks/useFollowScroll.ts`）。
//
// 寄せる場面は 2 つ —— 読み上げが語り始めたときと、取消が届いたとき。後者は読み上げが無効な端末で
// 取消のカードが枠の外に残らないためのもの（スマホで「取消」が見えなかった）。寄せる量は
// `planFollowScroll` が決め、その中身は `ttsFollow.test.ts` が見ている。ここで守るのは**いつ寄せるか**。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { RealtimeTab } from './index'
import type { EEWAlert } from '../../types/earthquake'

/** 枠の高さ。カードはこの外（下）に置く。 */
const VIEW_H = 300

let scrollTo: ReturnType<typeof vi.fn>
/** カードの上端（枠の上端からの位置）。テストごとに置き直す。 */
let cardTop = 500

beforeEach(() => {
  // jsdom は Element.scrollTo を実装していない（呼ぶと「not implemented」で落ちる）
  scrollTo = vi.fn()
  Object.defineProperty(Element.prototype, 'scrollTo', { value: scrollTo, writable: true, configurable: true })
  // jsdom は寸法を持たない。枠には高さを、カードには位置を与える（それ以外は 0）。
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === 'scroller' ? VIEW_H : 0
  })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === 'scroller' ? 3000 : 0
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    // 震央地名が「日向灘」のカードだけは別の位置に置く（同時の取消でどちらへ寄せたかを見分けるため）。
    const top = this.classList.contains('bg-card') ? ((this.textContent ?? '').includes('日向灘') ? 900 : cardTop) : 0
    const height = this.classList.contains('bg-card') ? 200 : 0
    return { top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect
  })
  cardTop = 500
})
afterEach(() => { vi.restoreAllMocks() })

function makeEEW(cancelledAt?: Date, eventId = 'evt-A', name = '宮城県沖'): EEWAlert {
  return {
    kind: 'eew',
    id: `id-${eventId}`,
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: '',
      hypocenter: { name, latitude: 36.2, longitude: 141.0, depth: 30, magnitude: 6.5 },
    },
    severity: 'Warning',
    cancelled: false,
    cancelledAt,
    issue: { eventId, serial: '1', time: '2026-01-01T12:00:00Z' },
  } as EEWAlert
}

const tab = (eew: EEWAlert | EEWAlert[], opts: { speaking?: boolean; visible?: boolean } = {}) => (
  <div data-testid="scroller" style={{ overflowY: 'auto' }}>
    <RealtimeTab
      eewNoForecastSettledKeys={new Set()}
      eews={Array.isArray(eew) ? eew : [eew]}
      swaveArrival={null}
      kyoshinV2Detections={[]}
      kyoshinDetectedPoints={[]}
      visible={opts.visible ?? true}
      speakingEewKey={opts.speaking ? 'evt-A' : null}
    />
  </div>
)

describe('緊急地震速報のカードを枠の中へ寄せる', () => {
  // 正: 語り始めたら、枠の外にあるカードの頭を枠の上端（余白 24px）へ寄せる。
  it('語り始めたら枠の外のカードを寄せる', () => {
    render(tab(makeEEW(), { speaking: true }))
    expect(scrollTo).toHaveBeenCalledWith({ top: cardTop - 24, behavior: 'smooth' })
  })

  // 正: 読み上げが無効でも（語らなくても）、取消が届いたら寄せる。これが無いと、
  // 読み上げを使わない端末では取消のカードが枠の外に残る。
  it('取消が届いたら、語っていなくても寄せる', () => {
    const { rerender } = render(tab(makeEEW()))
    expect(scrollTo).not.toHaveBeenCalled()
    rerender(tab(makeEEW(new Date('2026-01-01T12:00:30Z'))))
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  // 対照: 枠に収まっているカードは動かさない（見ている位置を奪わない）。
  it('枠に収まっていれば動かさない', () => {
    cardTop = 40
    render(tab(makeEEW(new Date('2026-01-01T12:00:30Z')), { speaking: true }))
    expect(scrollTo).not.toHaveBeenCalled()
  })

  // 対照: 語っているあいだに描き直されても、寄せ直さない（利用者がスクロールした位置を動かさない）。
  it('語っているあいだの描き直しでは寄せ直さない', () => {
    const { rerender } = render(tab(makeEEW(), { speaking: true }))
    rerender(tab(makeEEW(), { speaking: true }))
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  // 正: 語り終えて、また語り始めたら寄せ直す（合図が変わる）。
  it('語り終えてまた語り始めたら寄せ直す', () => {
    const { rerender } = render(tab(makeEEW(), { speaking: true }))
    rerender(tab(makeEEW(), { speaking: false }))
    rerender(tab(makeEEW(), { speaking: true }))
    expect(scrollTo).toHaveBeenCalledTimes(2)
  })

  // 安全弁: 別のタブを見ている・パネルを畳んでいる間は寄せず、見えた時点で寄せる。
  it('見えていないあいだは寄せず、見えたら寄せる', () => {
    const { rerender } = render(tab(makeEEW(new Date('2026-01-01T12:00:30Z')), { visible: false }))
    expect(scrollTo).not.toHaveBeenCalled()
    rerender(tab(makeEEW(new Date('2026-01-01T12:00:30Z')), { visible: true }))
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  // 対照: 取消の読み上げを終えても寄せ直さない。合図を「語っているか」で切り替えると、語り終えた瞬間に
  // 取消の合図へ戻り、声の間に読み進めた位置をカードの頭へ引き戻す（取消 → 語る → 語り終える で 2 回）。
  it('取消を語り終えても寄せ直さない', () => {
    const cancelled = makeEEW(new Date('2026-01-01T12:00:30Z'))
    const { rerender } = render(tab(cancelled))
    rerender(tab(cancelled, { speaking: true }))
    rerender(tab(cancelled, { speaking: false }))
    expect(scrollTo).toHaveBeenCalledTimes(2)
  })

  // 正: 語っている最中に取消が届いたら、その時点で寄せる（語り終えるのを待たない）。
  it('語っている最中に取消が届いたら寄せ、語り終えても寄せ直さない', () => {
    const { rerender } = render(tab(makeEEW(), { speaking: true }))
    const cancelled = makeEEW(new Date('2026-01-01T12:00:30Z'))
    rerender(tab(cancelled, { speaking: true }))
    expect(scrollTo).toHaveBeenCalledTimes(2)
    rerender(tab(cancelled, { speaking: false }))
    expect(scrollTo).toHaveBeenCalledTimes(2)
  })

  // 安全弁: 同じ回に複数のカードが取消になっても、寄せるのは取消がいちばん新しいカードだけ。
  // カードごとに寄せると、最後に呼ばれたもの（いちばん古いカード）が勝つ。
  it('同時に取消になったら、取消がいちばん新しいカードだけへ寄せる', () => {
    render(tab([
      makeEEW(new Date('2026-01-01T12:00:30Z'), 'evt-A', '宮城県沖'),
      makeEEW(new Date('2026-01-01T12:00:40Z'), 'evt-B', '日向灘'),
    ]))
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo).toHaveBeenCalledWith({ top: 900 - 24, behavior: 'smooth' })
  })
})

describe('取消の時刻が変わる場面', () => {
  // 正: 取消済みのまま現れたカード（いちばん新しい取消）は、現れた時点で寄せる。
  it('取消済みで現れたら寄せる', () => {
    render(tab(makeEEW(new Date('2026-01-01T12:00:30Z'))))
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  // 正: 取消が外れて、より新しい時刻でまた取消になったら寄せ直す。対照: 前の時刻へ戻っただけなら寄せない。
  it('新しい時刻の取消では寄せ直し、前の時刻へ戻っただけでは寄せない', () => {
    const first = new Date('2026-01-01T12:00:30Z')
    const { rerender } = render(tab(makeEEW(first)))
    rerender(tab(makeEEW()))
    rerender(tab(makeEEW(first)))
    expect(scrollTo).toHaveBeenCalledTimes(1)
    rerender(tab(makeEEW(new Date('2026-01-01T12:00:50Z'))))
    expect(scrollTo).toHaveBeenCalledTimes(2)
  })
})

describe('寄せ直さない場面（合図は増えるだけ）', () => {
  const A_AT = new Date('2026-01-01T12:00:30Z')
  const B_AT = new Date('2026-01-01T12:00:40Z')
  const a = (cancelledAt?: Date) => makeEEW(cancelledAt, 'evt-A', '宮城県沖')
  const b = (cancelledAt?: Date) => makeEEW(cancelledAt, 'evt-B', '日向灘')

  // 対照: 取消を語ったカード A の後に、別のカード B が取消になっても、A は寄せ直さない。
  // 寄せるのは B だけ（A の「いちばん新しい取消」が外れたことで合図を変えない）。
  it('別のカードに新しい取消が来ても、前の取消のカードは寄せ直さない', () => {
    const { rerender } = render(tab([a(A_AT), b()], { speaking: true }))
    const before = scrollTo.mock.calls.length
    rerender(tab([a(A_AT), b(B_AT)]))
    expect(scrollTo.mock.calls.slice(before)).toEqual([[{ top: 900 - 24, behavior: 'smooth' }]])
  })

  // 対照: いちばん新しい取消のカードが片付いて、古い取消のカードが繰り上がっても寄せない。
  it('古い取消のカードが繰り上がっても寄せない', () => {
    const { rerender } = render(tab([a(A_AT), b(B_AT)]))
    const before = scrollTo.mock.calls.length
    rerender(tab([a(A_AT)]))
    expect(scrollTo.mock.calls.length).toBe(before)
  })

  // 対照: 見えない間に語り終えた発話では、戻ったときに寄せない（もう語っていない）。
  it('見えない間に語り終えた発話では、戻っても寄せない', () => {
    const { rerender } = render(tab(a(), { speaking: true, visible: false }))
    rerender(tab(a(), { speaking: false, visible: false }))
    rerender(tab(a(), { speaking: false, visible: true }))
    expect(scrollTo).not.toHaveBeenCalled()
  })

  // 正: 見えない間に語り始め、語っているうちに戻ったら寄せる。
  it('見えない間に語り始め、語っているうちに戻ったら寄せる', () => {
    const { rerender } = render(tab(a(), { speaking: true, visible: false }))
    rerender(tab(a(), { speaking: true, visible: true }))
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })
})

describe('取消の文字を、カードのうち見えている範囲の真ん中へ置く', () => {
  const withObservers = (fn: (fire: () => void) => void) => {
    const observers: Array<() => void> = []
    Object.defineProperty(globalThis, 'ResizeObserver', {
      value: class { constructor(cb: () => void) { observers.push(cb) } observe() {} unobserve() {} disconnect() {} },
      writable: true, configurable: true,
    })
    try { fn(() => observers.forEach(cb => cb())) } finally {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    }
  }
  /** カードと幕を top〜top+height に置き、塊（高さ 100）はふだん幕の縦の真ん中にあるとする。 */
  const place = (card: { top: number; height: number }) => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const onCard = this.classList.contains('bg-card') || this.classList.contains('bg-black/70')
      const top = onCard ? card.top : 0
      const height = onCard ? card.height : 0
      return { top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('bg-card') ? card.height : 100
    })
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(() => card.height / 2 - 50)
  }
  const blockOf = (getByText: (t: string) => HTMLElement) => getByText('取消').parentElement!

  // 正: 枠より高いカードが枠を埋めているときは、塊を枠の真ん中へずらす（枠は 0〜300）。
  it('枠を埋めているカードでは、塊を枠の真ん中へずらす', () => {
    const card = { top: -700, height: 1800 }
    place(card)
    withObservers(() => {
      const { getByText } = render(tab(makeEEW(new Date('2026-01-01T12:00:30Z'))))
      // ふだんの位置は -700 + 900 - 50 = 150、枠の真ん中に置くと 150 - 50 = 100 → 50 px 上へ。
      expect(blockOf(getByText).style.transform).toBe('translateY(-50px)')
    })
  })

  // 正: スクロールしたら、次のコマで見えている範囲の真ん中へ置き直す。
  it('スクロールしたら置き直す', () => {
    const card = { top: 40, height: 200 }
    place(card)
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { frames.push(cb); return frames.length })
    withObservers(() => {
      const { getByText, getByTestId } = render(tab(makeEEW(new Date('2026-01-01T12:00:30Z'))))
      const block = blockOf(getByText)
      expect(block.style.transform).toBe('translateY(0px)')
      // カードの上 100 px が枠の外へ出た（見えているのは 0〜100）。真ん中は 50 → 塊の上端は 0。
      card.top = -100
      getByTestId('scroller').dispatchEvent(new Event('scroll'))
      getByTestId('scroller').dispatchEvent(new Event('scroll'))
      expect(frames).toHaveLength(1) // 1 コマに 1 回へまとめる
      frames[0](0)
      // ふだんの位置は -100 + 100 - 50 = -50 → 0 へ置くので 50 px 下へ。
      expect(block.style.transform).toBe('translateY(50px)')
    })
  })

  // 安全弁: 枠の高さが 0（パネルを畳んでいる）の間は何も書かず、開いたら置く。
  it('枠の高さが 0 の間は書かず、開いたら置く', () => {
    place({ top: -700, height: 1800 })
    let viewH = 0
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'scroller' ? viewH : 0
    })
    withObservers(fire => {
      const { getByText } = render(tab(makeEEW(new Date('2026-01-01T12:00:30Z'))))
      expect(blockOf(getByText).style.transform).toBe('')
      viewH = VIEW_H
      fire()
      expect(blockOf(getByText).style.transform).toBe('translateY(-50px)')
    })
  })

  // 安全弁: 取消の表示が消えた（アンマウントした）後は、スクロールの見張りも外れている。
  it('取消の表示が消えた後は、スクロールしても次のコマを予約しない', () => {
    place({ top: -700, height: 1800 })
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    withObservers(() => {
      const { getByTestId, rerender } = render(tab(makeEEW(new Date('2026-01-01T12:00:30Z'))))
      rerender(tab(makeEEW()))
      getByTestId('scroller').dispatchEvent(new Event('scroll'))
      expect(raf).not.toHaveBeenCalled()
    })
  })

  // 安全弁: 見張りを持たない環境では何もしない（塊は幕の縦の真ん中のまま）。
  it('見張りを持たない環境ではずらさない', () => {
    const { getByText } = render(tab(makeEEW(new Date('2026-01-01T12:00:30Z'))))
    expect(blockOf(getByText).style.transform).toBe('')
  })
})
