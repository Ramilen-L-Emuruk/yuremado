// @vitest-environment jsdom
// 震源カタログの索引・年ファイルが読めなかったときの取り直し（`utils/retrySchedule.ts`）を、フックを立てて確かめる。
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const h = vi.hoisted(() => ({
  loadHypocenterIndex: vi.fn(),
  loadHypocenterYear: vi.fn(),
  fetchJmaQuakeHistory: vi.fn(),
  warn: vi.fn(),
}))
vi.mock('../utils/hypocenterCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/hypocenterCatalog')>()
  return { ...actual, loadHypocenterIndex: h.loadHypocenterIndex, loadHypocenterYear: h.loadHypocenterYear }
})
vi.mock('../services/p2pquake', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/p2pquake')>()
  return { ...actual, fetchJmaQuakeHistory: h.fetchJmaQuakeHistory }
})
vi.mock('../utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/logger')>()
  return { ...actual, log: { ...actual.log, warn: h.warn } }
})

import { useQuakeHeatmap } from './useQuakeHeatmap'
import { jstYearOf } from '../utils/quakeHeatmap'

/** 待っている Promise を流し切る（偽のタイマーは進めない）。 */
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

function render() {
  return renderHook(() => useQuakeHeatmap(true, '', [], null, '30d'))
}

describe('useQuakeHeatmap（震源カタログの索引の取り直し）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    h.loadHypocenterIndex.mockReset()
    h.loadHypocenterYear.mockReset().mockRejectedValue(new Error('年ファイルは使わない'))
    h.fetchJmaQuakeHistory.mockReset().mockResolvedValue([])
    h.warn.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  // 正: 1 回目に読めなかった索引を、30 秒後に取り直す。
  test('読めなかった索引は 30 秒後に取り直す', async () => {
    h.loadHypocenterIndex.mockRejectedValue(new Error('network'))
    render()
    await flush()
    expect(h.loadHypocenterIndex).toHaveBeenCalledTimes(1)

    // 対照: 30 秒に届かないうちは取り直さない。
    await advance(29_000)
    expect(h.loadHypocenterIndex).toHaveBeenCalledTimes(1)

    await advance(1_000)
    await flush()
    expect(h.loadHypocenterIndex).toHaveBeenCalledTimes(2)
  })

  // 安全弁: 読めないままでも取り直しは 5 回で止まり、諦めたことを記録に残す。
  test('取り直しは 5 回で止まる', async () => {
    h.loadHypocenterIndex.mockRejectedValue(new Error('network'))
    render()
    await flush()
    for (let i = 0; i < 10; i += 1) {
      await advance(5 * 60_000)
      await flush()
    }
    expect(h.loadHypocenterIndex).toHaveBeenCalledTimes(6)
    expect(h.warn.mock.calls.some(([msg]) => String(msg).includes('取り直しを諦めます'))).toBe(true)
  })
})

describe('useQuakeHeatmap（震源カタログの年ファイルの取り直し）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    const year = jstYearOf(Date.now())
    h.loadHypocenterIndex.mockReset().mockResolvedValue({
      years: [year],
      coveredThroughMs: Date.now() - 2 * 86400_000,
      quality: { [String(year)]: 'final' },
      minMagnitude: 2,
      completeness: [{ from: 1919, minMagnitude: 2 }],
    })
    h.loadHypocenterYear.mockReset().mockRejectedValue(new Error('network'))
    h.fetchJmaQuakeHistory.mockReset().mockResolvedValue([])
    h.warn.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  // 正: 読めなかった年を 30 秒後に取り直す。対照: 30 秒に届かないうちは取り直さない。
  test('読めなかった年は 30 秒後に取り直す', async () => {
    render()
    // 期間の確定（300ms）を待ってから年を取りに行く
    await advance(400)
    await flush()
    const first = h.loadHypocenterYear.mock.calls.length
    expect(first).toBeGreaterThan(0)

    await advance(29_000)
    expect(h.loadHypocenterYear.mock.calls.length).toBe(first)

    await advance(1_000)
    await flush()
    expect(h.loadHypocenterYear.mock.calls.length).toBeGreaterThan(first)
  })

  // 安全弁: 読めないままでも取り直しは 5 回で止まり、諦めたことを記録に残す。
  test('年の取り直しは 5 回で止まる', async () => {
    render()
    await advance(400)
    await flush()
    const perTry = h.loadHypocenterYear.mock.calls.length
    for (let i = 0; i < 10; i += 1) {
      await advance(5 * 60_000)
      await flush()
    }
    expect(h.loadHypocenterYear.mock.calls.length).toBe(perTry * 6)
    expect(h.warn.mock.calls.some(([msg]) => String(msg).includes('年を 6 回続けて読めず'))).toBe(true)
  })

  // 正: 諦めた後でも、期間を変えると取り直しが始まり直す。対照: 期間が同じなら諦めたまま。
  test('諦めた後に期間を変えると取り直しが始まり直す', async () => {
    const { rerender } = renderHook(({ period }: { period: '30d' | '90d' }) => useQuakeHeatmap(true, '', [], null, period), {
      initialProps: { period: '30d' as '30d' | '90d' },
    })
    await advance(400)
    await flush()
    for (let i = 0; i < 10; i += 1) {
      await advance(5 * 60_000)
      await flush()
    }
    const gaveUp = h.loadHypocenterYear.mock.calls.length
    await advance(5 * 60_000)
    expect(h.loadHypocenterYear.mock.calls.length).toBe(gaveUp)

    rerender({ period: '90d' })
    await advance(400)
    await flush()
    const afterChange = h.loadHypocenterYear.mock.calls.length
    expect(afterChange).toBeGreaterThan(gaveUp)
    await advance(30_000)
    await flush()
    expect(h.loadHypocenterYear.mock.calls.length).toBeGreaterThan(afterChange)
  })

  // 対照: 取り直しで読めたら、それ以上は取りに行かない。
  test('取り直しで読めたら、それ以上は取り直さない', async () => {
    const year = jstYearOf(Date.now())
    const okYear = { year, count: 0, coveredThroughMs: Date.now(), quality: 'final', timeMs: new Float64Array(0), lat: new Float64Array(0), lng: new Float64Array(0), depth: new Float32Array(0), magnitude: new Float32Array(0), names: [], nameIdx: new Int32Array(0), external: new Uint8Array(0), intensityCode: new Map() }
    h.loadHypocenterYear.mockReset()
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(okYear)
      .mockRejectedValue(new Error('network'))
    render()
    await advance(400)
    await flush()
    await advance(30_000) // 1 回目の取り直し（失敗）
    await flush()
    await advance(60_000) // 2 回目の取り直し（成功）
    await flush()
    expect(h.loadHypocenterYear).toHaveBeenCalledTimes(3)
    for (let i = 0; i < 5; i += 1) {
      await advance(5 * 60_000)
      await flush()
    }
    expect(h.loadHypocenterYear).toHaveBeenCalledTimes(3)
  })
})
