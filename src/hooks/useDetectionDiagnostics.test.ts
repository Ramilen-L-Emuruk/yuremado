// @vitest-environment jsdom
//
// 揺れ検知の診断記録を保存することを固定するテスト。
//
// 以前は録画モードで保存を止めていたが、2026-10-23 に録画モード中も保存すると決めた
// （ユーザー選択「録画モード中も保存する (Recommended)」）。録画モードを渡す口そのものを外した。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import { fakeEnsembleDetection } from '../test-utils/ensembleDetection'
import { log } from '../utils/logger'

const saveRecord = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('../utils/detectionDiagnosticsDb', () => ({ saveRecord }))

import { noteSoloConfirmed, SOLO_CONFIRMED_LOG_MS, useDetectionDiagnostics } from './useDetectionDiagnostics'

const SITES: [number, number][] = [
  [35.0, 139.0],
  [35.1, 139.1],
]
const INDICES = [7, 6]

/** 画面に出る検知（confirmed）1 件。記録を開かせるのに要る分だけ埋める。 */
const DETECTION = fakeEnsembleDetection({
  id: 'evt-1',
  confidence: 'confirmed',
  memberKeys: [],
  maxIntensity: 3.2,
  epicenter: [35.05, 139.05],
})

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

// 確かな段の束が 1 点のまま居座ったときの記録（2026-10-28 ユーザー選択「カードと記憶を外す」）。
// 組み合わせの検知器には居座りを降ろす仕組みが無いので、起きたことに気づけるのはこのログだけ。
describe('noteSoloConfirmed', () => {
  const T0 = 1_000_000
  const solo = (id = 'evt-1', keys = ['35.000,139.000']) =>
    fakeEnsembleDetection({ id, confidence: 'confirmed', memberKeys: keys, epicenter: [35, 139] })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('[正] 1 点のまま 30 秒続いたら 1 度だけ warn し、その後は続いても出さない', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const since = new Map<string, number>()
    noteSoloConfirmed(since, [solo()], T0)
    noteSoloConfirmed(since, [solo()], T0 + SOLO_CONFIRMED_LOG_MS)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('evt-1')
    noteSoloConfirmed(since, [solo()], T0 + SOLO_CONFIRMED_LOG_MS * 3)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('[対照] 29 秒では出さない', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const since = new Map<string, number>()
    noteSoloConfirmed(since, [solo()], T0)
    noteSoloConfirmed(since, [solo()], T0 + SOLO_CONFIRMED_LOG_MS - 1000)
    expect(warn).not.toHaveBeenCalled()
  })

  it('[安全弁] 点が増えたら数え直す（増えた後に 1 点へ戻っても、戻った時刻から 30 秒を数える）', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const since = new Map<string, number>()
    noteSoloConfirmed(since, [solo()], T0)
    noteSoloConfirmed(since, [solo('evt-1', ['a', 'b'])], T0 + 20_000)
    noteSoloConfirmed(since, [solo()], T0 + 25_000)
    noteSoloConfirmed(since, [solo()], T0 + SOLO_CONFIRMED_LOG_MS + 1000) // 起点から 31 秒・戻ってから 6 秒
    expect(warn).not.toHaveBeenCalled()
    noteSoloConfirmed(since, [solo()], T0 + 25_000 + SOLO_CONFIRMED_LOG_MS)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('[対照] 早い段の 1 点は数えない', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const since = new Map<string, number>()
    const likely = fakeEnsembleDetection({ id: 'evt-1', confidence: 'likely', memberKeys: ['a'] })
    noteSoloConfirmed(since, [likely], T0)
    noteSoloConfirmed(since, [likely], T0 + SOLO_CONFIRMED_LOG_MS * 2)
    expect(warn).not.toHaveBeenCalled()
  })

  it('[安全弁] 消えた束の起点は捨てる（同じ id が後で現れても前の起点から数えない）', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const since = new Map<string, number>()
    noteSoloConfirmed(since, [solo()], T0)
    noteSoloConfirmed(since, [], T0 + 10_000)
    expect(since.size).toBe(0)
    noteSoloConfirmed(since, [solo()], T0 + SOLO_CONFIRMED_LOG_MS)
    expect(warn).not.toHaveBeenCalled()
  })
})
