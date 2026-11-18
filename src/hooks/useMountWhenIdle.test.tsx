// @vitest-environment jsdom
//
// 設定の窓の中身を、起動の後の手空きで閉じたまま置くこと（`App.tsx` の `SettingsTab`）を固定する。
// 窓は本物の `SettingsDialog` を使い、閉じている間は隠したまま中身が置かれることまで見る。
import { useRef } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, cleanup } from '@testing-library/react'
import { SettingsDialog } from '../components/SettingsTab/SettingsDialog'
import { useMountWhenIdle } from './useMountWhenIdle'

const DELAY_MS = 5_000
const IDLE_TIMEOUT_MS = 10_000

function Harness({ open }: { open: boolean }) {
  const mounted = useMountWhenIdle(open, DELAY_MS, IDLE_TIMEOUT_MS)
  const returnFocusRef = useRef<HTMLButtonElement>(null)
  return (
    <SettingsDialog open={open} onClose={() => {}} returnFocusRef={returnFocusRef}>
      {mounted && <div>設定の中身</div>}
    </SettingsDialog>
  )
}

/** 手空きの予約。テストから 1 つずつ走らせる */
let idle: { id: number; cb: () => void; timeout: number | undefined }[]
let cancelIdle: ReturnType<typeof vi.fn>

beforeEach(() => {
  // jsdom は要素の `scrollTo` を持たない（窓は分類を移るたびに中身を先頭へ戻す）
  Element.prototype.scrollTo = () => {}
  vi.useFakeTimers()
  idle = []
  vi.stubGlobal('requestIdleCallback', (cb: () => void, opts?: { timeout?: number }) => {
    const id = idle.length + 1
    idle.push({ id, cb, timeout: opts?.timeout })
    return id
  })
  cancelIdle = vi.fn()
  vi.stubGlobal('cancelIdleCallback', cancelIdle)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useMountWhenIdle', () => {
  // 正: 待ちの後の手空きで、閉じたまま中身を置く
  it('起動から待った後の手空きで、閉じた窓の中に中身を置く', () => {
    render(<Harness open={false} />)
    act(() => { vi.advanceTimersByTime(DELAY_MS) })
    expect(idle).toHaveLength(1)
    expect(idle[0].timeout).toBe(IDLE_TIMEOUT_MS)

    act(() => { idle[0].cb() })
    const content = screen.getByText('設定の中身')
    expect(content).toBeTruthy()
    // 窓は閉じたまま（中身は隠れている）
    expect(content.closest('[role="presentation"]')?.hasAttribute('hidden')).toBe(true)
  })

  // 対照: 待ちの前には手空きを予約せず、中身も置かない（起動直後の重い処理に重ねない）
  it('待ちが過ぎる前は手空きを予約せず、中身も置かない', () => {
    render(<Harness open={false} />)
    act(() => { vi.advanceTimersByTime(DELAY_MS - 1) })
    expect(idle).toHaveLength(0)
    expect(screen.queryByText('設定の中身')).toBeNull()
  })

  // 手空きより先に開かれたら、そのときに置く
  it('手空きより先に開かれたら、その描画で中身を置き、手空きの予約は残さない', () => {
    const { rerender } = render(<Harness open={false} />)
    rerender(<Harness open />)
    expect(screen.getByText('設定の中身')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(DELAY_MS) })
    expect(idle).toHaveLength(0)
  })

  // 安全弁: 外されたら予約を取り消す（待ちの途中でも、手空きを待っている間でも）
  it('待ちの途中で外されたら、手空きを予約しない', () => {
    const { unmount } = render(<Harness open={false} />)
    unmount()
    act(() => { vi.advanceTimersByTime(DELAY_MS) })
    expect(idle).toHaveLength(0)
  })

  it('手空きを待っている間に外されたら、その予約を取り消す', () => {
    const { unmount } = render(<Harness open={false} />)
    act(() => { vi.advanceTimersByTime(DELAY_MS) })
    expect(idle).toHaveLength(1)
    unmount()
    expect(cancelIdle).toHaveBeenCalledWith(idle[0].id)
  })

  // `requestIdleCallback` の無いブラウザ（Safari）でも、待ちの後に置く
  it('requestIdleCallback が無くても、待ちの後に中身を置く', () => {
    vi.stubGlobal('requestIdleCallback', undefined)
    render(<Harness open={false} />)
    act(() => { vi.advanceTimersByTime(DELAY_MS) })
    expect(screen.queryByText('設定の中身')).toBeNull()
    act(() => { vi.advanceTimersByTime(100) })
    expect(screen.getByText('設定の中身')).toBeTruthy()
  })
})
