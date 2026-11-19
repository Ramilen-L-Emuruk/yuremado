import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { installPageScrollReset, resetPageScroll, resetPageScrollLogForTest, type PageScrollTarget } from './pageScrollReset'
import { log } from './logger'

/** `window` の代わり。スクロール位置と、フォーカスのある要素（`document.activeElement`）を持つ。`scrollTo` は位置を書き換える */
class FakeWindow extends EventTarget {
  scrollX = 0
  scrollY = 0
  scrollTo = vi.fn((x: number, y: number) => { this.scrollX = x; this.scrollY = y })
  readonly docEvents = new EventTarget()
  readonly document = {
    activeElement: null as { tagName: string; type?: string; isContentEditable?: boolean } | null,
    addEventListener: (type: string, listener: () => void) => this.docEvents.addEventListener(type, listener),
    removeEventListener: (type: string, listener: () => void) => this.docEvents.removeEventListener(type, listener),
  }
}

function make(scrollY: number): FakeWindow {
  const win = new FakeWindow()
  win.scrollY = scrollY
  return win
}

function target(win: FakeWindow): PageScrollTarget {
  return win as unknown as PageScrollTarget
}

beforeEach(() => {
  resetPageScrollLogForTest()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('resetPageScroll', () => {
  // 正: 59 になった文書を 0 へ戻すこと（通知から開いたあとの実機の状態）
  it('スクロール位置が 59 なら 0 へ戻す', () => {
    const win = make(59)
    expect(resetPageScroll(target(win), 'test')).toBe(true)
    expect(win.scrollTo).toHaveBeenCalledWith(0, 0)
    expect(win.scrollY).toBe(0)
  })

  // 対照: 0 のときは何もしない（`scrollTo` を呼ぶと余計なスクロールの通知が出る）
  it('スクロール位置が 0 なら何もしない', () => {
    const win = make(0)
    expect(resetPageScroll(target(win), 'test')).toBe(false)
    expect(win.scrollTo).not.toHaveBeenCalled()
  })

  // 対照: 横だけずれていても戻す
  it('横にずれていても戻す', () => {
    const win = make(0)
    win.scrollX = 12
    expect(resetPageScroll(target(win), 'test')).toBe(true)
    expect(win.scrollX).toBe(0)
  })

  // 安全弁: 文字を入力している間は戻さない（キーボードを出した iOS が欄を見せるためにずらす）
  it.each(['INPUT', 'TEXTAREA', 'SELECT'])('%s にフォーカスがある間は戻さない', (tagName) => {
    const win = make(59)
    win.document.activeElement = { tagName }
    expect(resetPageScroll(target(win), 'test')).toBe(false)
    expect(win.scrollTo).not.toHaveBeenCalled()
  })

  it('編集できる要素（contenteditable）にフォーカスがある間は戻さない', () => {
    const win = make(59)
    win.document.activeElement = { tagName: 'DIV', isContentEditable: true }
    expect(resetPageScroll(target(win), 'test')).toBe(false)
  })

  // 対照: 文字を入力する種類の INPUT は、type を持っていても（持たなくても）入力中として戻さない
  it.each(['text', 'search', 'email', 'number', 'password', 'url', 'tel', 'date', undefined])('INPUT の type が %s の間は戻さない', (type) => {
    const win = make(59)
    win.document.activeElement = { tagName: 'INPUT', type }
    expect(resetPageScroll(target(win), 'test')).toBe(false)
  })

  // 正: キーボードを出さない INPUT（チェックボックス・スライダーなど）は、フォーカスが残っていても戻す
  it.each(['checkbox', 'radio', 'range', 'button', 'submit', 'file', 'color'])('INPUT の type が %s なら、フォーカスが残っていても戻す', (type) => {
    const win = make(59)
    win.document.activeElement = { tagName: 'INPUT', type }
    expect(resetPageScroll(target(win), 'test')).toBe(true)
    expect(win.scrollY).toBe(0)
  })

  // 安全弁: 戻らない状況が続いても、記録は間引く（押すたびに走る合図があるため）
  it('記録は 10 秒に 1 行まで', () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {})
    const now = vi.spyOn(performance, 'now')
    const win = make(59)
    now.mockReturnValue(100_000)
    resetPageScroll(target(win), 'test')
    win.scrollY = 59
    now.mockReturnValue(105_000)
    resetPageScroll(target(win), 'test')
    expect(info).toHaveBeenCalledTimes(1)
    win.scrollY = 59
    now.mockReturnValue(110_001)
    resetPageScroll(target(win), 'test')
    expect(info).toHaveBeenCalledTimes(2)
  })

  // 安全弁: 入力を離れたら戻す（戻さない条件が居座らない）
  it('入力を離れたら戻す', () => {
    const win = make(59)
    win.document.activeElement = { tagName: 'INPUT' }
    expect(resetPageScroll(target(win), 'test')).toBe(false)
    win.document.activeElement = { tagName: 'BODY' }
    expect(resetPageScroll(target(win), 'test')).toBe(true)
  })
})

describe('installPageScrollReset', () => {
  // 正: iOS が 59 を置く合図がどれであっても戻すこと（置く瞬間のイベントは分かっていないので全部見る）
  it.each(['scroll', 'resize', 'orientationchange', 'focus', 'pageshow', 'pointerdown'])('%s で戻す', (type) => {
    const win = make(0)
    installPageScrollReset(target(win))
    win.scrollY = 59
    win.dispatchEvent(new Event(type))
    expect(win.scrollY).toBe(0)
  })

  it('画面が前に出たとき（visibilitychange）に戻す', () => {
    const win = make(0)
    installPageScrollReset(target(win))
    win.scrollY = 59
    win.docEvents.dispatchEvent(new Event('visibilitychange'))
    expect(win.scrollY).toBe(0)
  })

  // 正: 入力中に止めていた分を、入力欄から離れた後に取りこぼさない
  it('入力欄から離れて 300ms 経ち、入力中でなければ戻す', () => {
    vi.useFakeTimers()
    const win = make(0)
    installPageScrollReset(target(win))
    win.document.activeElement = { tagName: 'INPUT', type: 'text' }
    win.scrollY = 59
    win.dispatchEvent(new Event('scroll'))
    expect(win.scrollY).toBe(59)
    win.document.activeElement = { tagName: 'BODY' }
    win.docEvents.dispatchEvent(new Event('focusout'))
    vi.advanceTimersByTime(299)
    expect(win.scrollY).toBe(59)
    vi.advanceTimersByTime(1)
    expect(win.scrollY).toBe(0)
  })

  // 安全弁: 欄から欄へ移るとき（移った先にフォーカスが入っている）は戻さない
  it('別の入力欄へ移ったなら、離れたあとも戻さない', () => {
    vi.useFakeTimers()
    const win = make(0)
    installPageScrollReset(target(win))
    win.scrollY = 59
    win.document.activeElement = { tagName: 'INPUT', type: 'text' }
    win.docEvents.dispatchEvent(new Event('focusout'))
    vi.advanceTimersByTime(1000)
    expect(win.scrollY).toBe(59)
  })

  it('入れた時点で既にずれていたら戻す', () => {
    const win = make(59)
    installPageScrollReset(target(win))
    expect(win.scrollY).toBe(0)
  })

  // 対照: 0 のままなら、どの合図でも `scrollTo` を呼ばない
  it('0 のままならどの合図でも何もしない', () => {
    const win = make(0)
    installPageScrollReset(target(win))
    for (const type of ['scroll', 'resize', 'orientationchange', 'focus', 'pageshow', 'pointerdown']) win.dispatchEvent(new Event(type))
    win.docEvents.dispatchEvent(new Event('visibilitychange'))
    expect(win.scrollTo).not.toHaveBeenCalled()
  })

  // 安全弁: 外したあとは戻さない（離れた直後の待ちも取り消す）
  it('外したあとは戻さない', () => {
    vi.useFakeTimers()
    const win = make(0)
    const uninstall = installPageScrollReset(target(win))
    win.docEvents.dispatchEvent(new Event('focusout'))
    uninstall()
    win.scrollY = 59
    vi.advanceTimersByTime(1000)
    win.docEvents.dispatchEvent(new Event('focusout'))
    vi.advanceTimersByTime(1000)
    for (const type of ['scroll', 'resize', 'orientationchange', 'focus', 'pageshow', 'pointerdown']) win.dispatchEvent(new Event(type))
    win.docEvents.dispatchEvent(new Event('visibilitychange'))
    expect(win.scrollY).toBe(59)
  })
})
