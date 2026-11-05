// @vitest-environment jsdom
//
// スマホ幅の開いたカードの帯（QuakeOpenPin）の作り。
//
// - カードの下端での押し上げはブラウザの貼りつきに任せる（2026-11-05 ユーザー選択「CSS の貼りつきで作り直す (Recommended)」）。
//   受け皿（quake-pin）は、カードと同じ大きさの透明な箱（quake-pin-track）の中で貼りつく。箱がカードの中身を押せなく
//   してしまうと、カードの地もボタンも押せなくなる（押せるのは出ている帯だけ）。
// - 帯は日付の区切り（z-[3]）より下に描く（2026-11-05 ユーザー回答「下に書いて」）。
// レイアウトの計算は jsdom では走らないので、ここでは作り（入れ子・クラス）を縛る。位置はブラウザで確かめた。
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { useRef } from 'react'
import { QuakeOpenPin } from './QuakeOpenPin'

function Card() {
  const factsRef = useRef<HTMLDivElement>(null)
  return (
    <div data-quake-key="k" className="quake-open relative">
      <QuakeOpenPin targetRef={factsRef} onActivate={() => {}} onLpgmActivate={undefined}><span>帯の中身</span></QuakeOpenPin>
      <div ref={factsRef}>震度の枠</div>
    </div>
  )
}

describe('QuakeOpenPin の作り', () => {
  it('受け皿はカードと同じ大きさの透明な箱の中で貼りつく（押し上げをブラウザに任せる）', () => {
    const { container } = render(<Card />)
    const track = container.querySelector('.quake-pin-track')
    expect(track).not.toBeNull()
    expect(track!.parentElement!.matches('[data-quake-key]')).toBe(true)
    expect(track!.classList.contains('absolute')).toBe(true)
    expect(track!.classList.contains('inset-0')).toBe(true)
    const pin = track!.querySelector('.quake-pin')
    expect(pin!.parentElement).toBe(track)
    expect(pin!.classList.contains('sticky')).toBe(true)
    // 高さ 0 の受け皿だと、貼りつく要素の高さが 0 のまま下端の判定に使われ、帯がカードの外へはみ出す
    expect(pin!.classList.contains('h-0')).toBe(false)
  })

  it('透明な箱はカードの中身を塞がない（押せない）', () => {
    const { container } = render(<Card />)
    const track = container.querySelector('.quake-pin-track')!
    expect(track.classList.contains('pointer-events-none')).toBe(true)
  })

  it('帯は日付の区切り（z-[3]）・一覧の見出しの行（z-[4]）より下に描く', () => {
    const { container } = render(<Card />)
    const pin = container.querySelector('.quake-pin')!
    expect(pin.classList.contains('z-[2]')).toBe(true)
  })

  it('受け皿も大きさの見張りに入れる（広い組との切り替えで、カードの大きさが変わらずに帯の出し方が変わるため）', () => {
    const observed: Element[] = []
    const orig = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      constructor(_cb: ResizeObserverCallback) {}
      observe(el: Element) { observed.push(el) }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
    try {
      const { container } = render(<Card />)
      expect(observed).toContain(container.querySelector('[data-quake-key]'))
      expect(observed).toContain(container.querySelector('.quake-pin'))
    } finally {
      globalThis.ResizeObserver = orig
    }
  })

  it('隠れている帯は押せる印を持たない（出たときだけ押せる）', () => {
    const { container } = render(<Card />)
    const band = container.querySelector('.quake-pin > div')!
    expect(band.classList.contains('pointer-events-auto')).toBe(false)
    expect(band.getAttribute('role')).toBeNull()
  })
})
