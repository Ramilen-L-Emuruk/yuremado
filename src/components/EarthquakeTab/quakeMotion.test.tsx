// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, cleanup } from '@testing-library/react'
import { StrictMode } from 'react'
import { Reveal } from './quakeMotion'

/**
 * カードの中の開閉（`Reveal`）の動き。jsdom には Web Animations も寸法も無いので、
 * 作り物の動き（`finished` を手で解決・却下する）と高さを差し込んで、開閉の経路を固定する。
 */
interface FakeAnim {
  id: string
  cancel: () => void
  finish: () => void
  finished: Promise<void>
  resolve: () => void
  reject: () => void
}

let anims: FakeAnim[] = []
const realAnimate = HTMLElement.prototype.animate
const realRect = HTMLElement.prototype.getBoundingClientRect

function installFakeAnimations() {
  anims = []
  HTMLElement.prototype.animate = function () {
    let resolve!: () => void
    let reject!: () => void
    const finished = new Promise<void>((res, rej) => { resolve = res; reject = rej })
    finished.catch(() => {})
    const a: FakeAnim = { id: '', finished, resolve, reject, cancel: () => reject(), finish: () => resolve() }
    anims.push(a)
    return a as unknown as Animation
  } as typeof HTMLElement.prototype.animate
  // 中身のある箱は 100px の高さを持つことにする（jsdom は寸法を計算しない）
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 100, width: 100, height: 100, toJSON() {} } as DOMRect
  }
}

beforeEach(() => installFakeAnimations())
afterEach(() => {
  cleanup()
  HTMLElement.prototype.animate = realAnimate
  HTMLElement.prototype.getBoundingClientRect = realRect
})

const view = (open: boolean, build = () => <p>中身</p>) => <Reveal open={open}>{build}</Reveal>

describe('Reveal（カードの中の開閉）', () => {
  // 正: 閉じても、縮み終えるまでは中身を残す（閉じる動きを見せるため）
  it('閉じたら縮み終えるまで中身を残し、終えてから外す', async () => {
    const { rerender } = render(view(true))
    rerender(view(false))
    expect(screen.getByText('中身')).toBeTruthy()
    await act(async () => { anims[anims.length - 1].resolve() })
    expect(screen.queryByText('中身')).toBeNull()
  })

  // 安全弁: 縮みかけで開き直したら、止められた縮みの終わりで中身を外さない
  it('縮みかけで開き直したら中身を残す', async () => {
    const { rerender } = render(view(true))
    rerender(view(false))
    const shrink = anims[anims.length - 1]
    rerender(view(true))
    await act(async () => { shrink.reject() })
    expect(screen.getByText('中身')).toBeTruthy()
  })

  // 正: 閉じている間は中身を組み立てない（閉じている県の観測点まで毎回作らない）
  it('閉じている間は中身の関数を呼ばない', () => {
    const build = vi.fn(() => <p>中身</p>)
    render(view(false, build))
    expect(build).not.toHaveBeenCalled()
  })

  // 正: 初めから開いて描かれた中身は動かさない（外側が丸ごと伸びる。開いた県の数だけ動きを作らない）
  it('初めから開いて描かれたら伸ばさず、後から開いたときだけ伸ばす', async () => {
    const { rerender } = render(view(true))
    expect(anims).toHaveLength(0)
    rerender(view(false))
    await act(async () => { anims[0].resolve() })
    rerender(view(true))
    // 閉じる（縮む）動きと、開き直す（伸びる）動きの 2 つ
    expect(anims).toHaveLength(2)
  })

  // 安全弁: dev の StrictMode（付けて外して付け直す）でも、初めから開いて描かれたものを初回と見分ける
  it('StrictMode でも初めから開いて描かれたら伸ばさない', () => {
    render(<StrictMode>{view(true)}</StrictMode>)
    expect(anims).toHaveLength(0)
  })

  // 対照: 動きが使えない所では、閉じたらすぐ外す
  it('動きが使えなければ閉じたらすぐ外す', () => {
    HTMLElement.prototype.animate = undefined as unknown as typeof HTMLElement.prototype.animate
    const { rerender } = render(view(true))
    rerender(view(false))
    expect(screen.queryByText('中身')).toBeNull()
  })
})
