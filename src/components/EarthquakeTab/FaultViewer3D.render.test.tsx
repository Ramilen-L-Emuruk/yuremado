// @vitest-environment jsdom
//
// 3D の震源球と断層のずれ。jsdom には描画面が無い（大きさが 0 で、描く関数は何もしない）ので、
// ここで確かめるのは「止まっている間はコマを要求し続けない」「止める・動かす」「キーで回しても外へ伝わらない」。
// 描く中身（面の並び・ずれの量）は `utils/faultGeometry.test.ts` が持つ。言語の配り役で包まないので、辞書は既定の日本語になる。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { NodalPlane, PrincipalAxes } from '../../services/relayAnalysis'
import { muteConsoleError } from '../../test-utils/muteConsoleError'
import { FaultViewer3D } from './FaultViewer3D'

const planes: readonly [NodalPlane, NodalPlane] = [{ strike: 47, dip: 37, rake: 100 }, { strike: 215, dip: 54, rake: 82 }]
const axes: PrincipalAxes = { p: { azimuth: 310, plunge: 8 }, t: { azimuth: 93, plunge: 80 }, n: { azimuth: 219, plunge: 6 } }

function stubReducedMotion(reduced: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduced && query.includes('prefers-reduced-motion'), media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }))
}

/** コマの要求を溜めて、1 つずつ流す。流したあとにまだ要求が残っているか（＝描き続けているか）を返す */
function stubFrames() {
  const queue: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queue.push(cb); return queue.length })
  vi.stubGlobal('cancelAnimationFrame', () => { queue.length = 0 })
  return {
    flush(times: number): number {
      for (let i = 0; i < times; i++) {
        const batch = queue.splice(0)
        act(() => { batch.forEach(cb => cb(performance.now())) })
      }
      return queue.length
    },
  }
}

beforeEach(() => { stubReducedMotion(false) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('FaultViewer3D', () => {
  it('見出しと、動いている間は「一時停止」・止めると「再生」が出る', () => {
    stubFrames()
    render(<FaultViewer3D planes={planes} axes={axes} />)
    expect(screen.getByText('震源球と断層のずれ')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '一時停止' }))
    expect(screen.getByRole('button', { name: '再生' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '一時停止' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '再生' }))
    expect(screen.getByRole('button', { name: '一時停止' })).toBeTruthy()
  })

  it('動きを減らす設定の端末では、初めから止まっていて「再生」が出る（正）', () => {
    stubFrames()
    stubReducedMotion(true)
    render(<FaultViewer3D planes={planes} axes={axes} />)
    expect(screen.getByRole('button', { name: '再生' })).toBeTruthy()
  })

  it('動いている間はコマを要求し続け、止まるとやめる（正と対照）', () => {
    const frames = stubFrames()
    render(<FaultViewer3D planes={planes} axes={axes} />)
    expect(frames.flush(5)).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '一時停止' }))
    // 止めた直後の 1 コマを流した後は、要求が残らない
    expect(frames.flush(5)).toBe(0)
  })

  it('動きを減らす設定では、何もしなければコマの要求が止まる（安全弁。電池を食い続けない）', () => {
    const frames = stubFrames()
    stubReducedMotion(true)
    render(<FaultViewer3D planes={planes} axes={axes} />)
    expect(frames.flush(5)).toBe(0)
  })

  it('止まっていても、回すとその分だけ描き直し、そのあとまた止まる', () => {
    const frames = stubFrames()
    stubReducedMotion(true)
    render(<FaultViewer3D planes={planes} axes={axes} />)
    frames.flush(3)
    fireEvent.keyDown(screen.getByRole('img', { name: '震源球と断層のずれ' }), { key: 'ArrowRight' })
    expect(frames.flush(1)).toBe(0)
  })

  it('矢印キーで回してもキーは外へ伝わらない（窓の Esc や Tab の処理に混ざらない）', () => {
    stubFrames()
    const onKey = vi.fn()
    render(<div onKeyDown={onKey}><FaultViewer3D planes={planes} axes={axes} /></div>)
    const view = screen.getByRole('img', { name: '震源球と断層のずれ' })
    fireEvent.keyDown(view, { key: 'ArrowLeft' })
    fireEvent.keyDown(view, { key: 'ArrowDown' })
    expect(onKey).not.toHaveBeenCalled()
    // [対照] 矢印以外のキーは外へ届く（Tab・Esc は窓が受ける）
    fireEvent.keyDown(view, { key: 'Escape' })
    expect(onKey).toHaveBeenCalledTimes(1)
  })

  it('傾斜が範囲外・数値でない節面の解は、3D を出さない（誤った向きの絵を出さない。正と対照）', () => {
    stubFrames()
    const bad: readonly [NodalPlane, NodalPlane] = [{ strike: 47, dip: 120, rake: 100 }, planes[1]]
    const { container, rerender } = render(<FaultViewer3D planes={bad} axes={axes} />)
    expect(container.textContent).toBe('')
    rerender(<FaultViewer3D planes={[planes[0], { strike: Number.NaN, dip: 54, rake: 82 }]} axes={axes} />)
    expect(container.textContent).toBe('')
    rerender(<FaultViewer3D planes={planes} axes={axes} />)
    expect(screen.getByText('震源球と断層のずれ')).toBeTruthy()
  })

  it('描画面が取れずに描けなかったときは、動きを止め、枠の中に「描画に失敗しました。」を出してログに残す', () => {
    const frames = stubFrames()
    // 大きさを知らせる口と、取れない描画面を差し替える（jsdom は大きさ 0 で描かないので、描く経路へ入れるため）
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: (entries: unknown[]) => void) {}
      observe(target: Element) { act(() => { this.cb([{ target, contentRect: { width: 200 } }]) }) }
      disconnect() {}
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const err = muteConsoleError()
    render(<FaultViewer3D planes={planes} axes={axes} />)
    frames.flush(3)
    expect(screen.getByRole('alert').textContent).toBe('描画に失敗しました。')
    expect(err.mock.calls.some(c => String(c[0]).includes('解析の 3D の描画に失敗しました'))).toBe(true)
    // 動きは止まり、コマの要求は残らない
    expect(frames.flush(5)).toBe(0)
    // [対照] 失敗していないときは、この文を出さない（上のテストで見出しだけが出ている）
  })

  it('主軸が数値でないときは、軸の無い解と同じく描ける（安全弁）', () => {
    stubFrames()
    render(<FaultViewer3D planes={planes} axes={{ ...axes, p: { azimuth: Number.NaN, plunge: 8 } }} />)
    expect(screen.getByText('震源球と断層のずれ')).toBeTruthy()
  })

  it('主軸が無い解でも描ける（P・T の印は出さないだけ）', () => {
    stubFrames()
    render(<FaultViewer3D planes={planes} axes={null} />)
    expect(screen.getByText('震源球と断層のずれ')).toBeTruthy()
  })
})
