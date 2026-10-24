// @vitest-environment jsdom
//
// 揺れ検知の診断記録を保存することを固定するテスト。
//
// 以前は録画モードで保存を止めていたが、2026-10-23 に録画モード中も保存すると決めた
// （ユーザー選択「録画モード中も保存する (Recommended)」）。録画モードを渡す口そのものを外した。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import { initGates } from '../utils/kyoshinDetector'
import type { DetectionEvent } from '../utils/kyoshinDetector'

const saveRecord = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('../utils/detectionDiagnosticsDb', () => ({ saveRecord }))

import { useDetectionDiagnostics } from './useDetectionDiagnostics'

const SITES: [number, number][] = [
  [35.0, 139.0],
  [35.1, 139.1],
]
const INDICES = [7, 6]

/** 画面に出る検知（confirmed）1 件。記録を開かせるのに要る分だけ埋める。 */
const DETECTION = {
  id: 'evt-1',
  confidence: 'confirmed',
  memberKeys: [],
  maxIntensity: 3.2,
  lastSize: 4,
  epicenter: [35.05, 139.05],
  gates: initGates(),
  confirmedBy: null,
} as unknown as DetectionEvent

/** 保存の鎖（`persist` の Promise チェーン）が回るまで待つ。 */
function flushChain(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

function mount() {
  return renderHook(() =>
    useDetectionDiagnostics(
      [DETECTION],
      SITES,
      INDICES,
      '2026-09-02T00:00:00.000Z',
      '20260123000000',
    ),
  )
}

describe('useDetectionDiagnostics の保存', () => {
  beforeEach(() => {
    vi.stubGlobal('__APP_VERSION__', '0.0.0-test')
    saveRecord.mockClear()
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('正: 記録を保存する', async () => {
    // アンマウント（画面を閉じる相当）で、開いている記録が後ろ側の足りないまま確定する
    mount().unmount()
    await flushChain()
    expect(saveRecord).toHaveBeenCalled()
  })

  it('安全弁: 続けて開いた記録もそれぞれ保存する', async () => {
    mount().unmount()
    await flushChain()
    const first = saveRecord.mock.calls.length
    expect(first).toBeGreaterThan(0)

    mount().unmount()
    await flushChain()
    expect(saveRecord.mock.calls.length).toBeGreaterThan(first)
  })
})
