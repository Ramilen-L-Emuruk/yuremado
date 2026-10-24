// @vitest-environment jsdom
//
// 再生中に自作地震計の帯と下端の波形を、再生時刻のぶんホストから読み返す層のテスト（#992・S7）。
// **形は 3 種を対にする**（正・対照・安全弁）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

const fetchSeismoStatus = vi.fn()
const fetchSeismoQuakeIntensity = vi.fn()
const fetchSeismoWaveSamples = vi.fn()
let nowMs = 0

vi.mock('../services/seismoStream', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/seismoStream')>()),
  fetchSeismoStatus: (...args: unknown[]) => fetchSeismoStatus(...args),
}))
vi.mock('../services/seismoQuakeIntensity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/seismoQuakeIntensity')>()),
  fetchSeismoQuakeIntensity: (...args: unknown[]) => fetchSeismoQuakeIntensity(...args),
}))
vi.mock('../services/seismoWaveSamples', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/seismoWaveSamples')>()),
  fetchSeismoWaveSamples: (...args: unknown[]) => fetchSeismoWaveSamples(...args),
}))
vi.mock('../utils/clock', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/clock')>()),
  serverNow: () => nowMs,
}))

const { cutWindowAt, replayIntensityAt, useSeismoReplay } = await import('./useSeismoReplay')
const { WAVE_RETAIN_SEC } = await import('./useSeismoStation')

/** 再生時刻（どこの家でもない日時）。 */
const T0 = 1_790_000_000_000
const OFFSET = -3600_000

function status() {
  return {
    kind: 'ok' as const,
    stations: [{ stationId: 'home', displayName: '自宅', lat: 35, lon: 135 }],
    sensorCount: 1,
    sensors: [],
    usualIntensities: new Map(),
    assignedStationCount: 1,
    assignedStationIds: ['home'],
  }
}

function intensity(fromMs: number, toMs: number) {
  const realtimeSeries = []
  for (let t = fromMs + 1000; t <= toMs; t += 1000) realtimeSeries.push({ atMs: t, value: 1.2 })
  return {
    kind: 'ok' as const,
    intensity: {
      fromMs, toMs, maxRealtime: 1.2, maxRealtimeAtMs: fromMs, realtimeSeries,
      measured: null, measuredUnavailable: 'no-data', usualMeasured: 0.3,
      gapCount: 0, invalidChunkCount: 0, unsolvedChunkCount: 0, filesMissing: 0, filesFailed: 0, skippedBytes: 0, truncated: false,
    },
  }
}

function samples(fromMs: number, toMs: number) {
  const n = Math.round((toMs - fromMs) / 10)
  const axis = new Float32Array(n).fill(0.5)
  return {
    kind: 'ok' as const,
    samples: {
      stationKnown: true, filesFailed: 0, skippedBytes: 0, truncated: false,
      chunks: [{ firstSampleMs: fromMs, msPerSample: 10, gal: [axis, axis, axis] as const, memberCount: new Float32Array(n).fill(3) }],
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0 - OFFSET)
  nowMs = T0
  fetchSeismoStatus.mockResolvedValue(status())
  fetchSeismoQuakeIntensity.mockImplementation(async (p: { fromMs: number; toMs: number }) => intensity(p.fromMs, p.toMs))
  fetchSeismoWaveSamples.mockImplementation(async (p: { fromMs: number; toMs: number }) => samples(p.fromMs, p.toMs))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

async function advance(ms: number): Promise<void> {
  await act(async () => {
    nowMs += ms
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('replayIntensityAt', () => {
  const series = [{ atMs: 1000, value: 1 }, { atMs: 2000, value: 2 }, { atMs: 3000, value: null }]
  it('正: 再生時刻の手前でいちばん新しい値', () => {
    expect(replayIntensityAt(series, 2500)).toEqual({ atMs: 2000, value: 2 })
  })
  it('対照: 5 秒より古い値しか無ければ出さない（記録の無い時刻は出さない）', () => {
    expect(replayIntensityAt(series, 2000 + 5000)).toBeNull()
  })
  it('安全弁: いちばん新しい刻みが値を持たなければ出さない（前の値を「いま」として出さない）', () => {
    expect(replayIntensityAt(series, 3500)).toBeNull()
  })
})

describe('cutWindowAt', () => {
  const win = { firstSampleMs: 0, msPerSample: 10, gal: [new Float32Array(10), new Float32Array(10), new Float32Array(10)] as const, memberCount: new Float32Array(10) }
  it('正: 再生時刻より後のサンプルを落とす', () => {
    expect(cutWindowAt(win, 45)?.gal[0].length).toBe(5)
  })
  it('対照: 窓の中に再生時刻より後が無ければそのまま', () => {
    expect(cutWindowAt(win, 1000)).toBe(win)
  })
  it('安全弁: 再生時刻が窓より前なら何も描かない', () => {
    expect(cutWindowAt(win, -1)).toBeNull()
  })
})

describe('useSeismoReplay', () => {
  it('正: 再生中は再生時刻の震度と波形を読み返して、ライブと同じ形で返す', async () => {
    const h = renderHook(() => useSeismoReplay({ enabled: true, baseUrl: 'http://host:50506', replayOffsetMs: OFFSET, wave: 'station' }))
    await advance(0)
    await advance(1000)
    await advance(1000)
    expect(h.result.current.stations).toMatchObject([{ stationId: 'home', intensity: 1.2, usualMeasured: 0.3, source: { kind: 'station' } }])
    const win = h.result.current.readLiveWave('home', null)
    // 先回りして読んだ分は描かない（再生時刻で切る）。
    expect(win === null ? null : win.firstSampleMs + (win.gal[0].length - 1) * win.msPerSample).toBeLessThanOrEqual(nowMs)
    // 地震カードには渡さない。
    expect(h.result.current.readWave('home', null)).toBeNull()
  })

  it('正: 先回りして読んだ分があっても、再生時刻の手前 180 秒ぶんを描ける（入れ物は先回りの分だけ長い）', async () => {
    const h = renderHook(() => useSeismoReplay({ enabled: true, baseUrl: 'http://host:50506', replayOffsetMs: OFFSET, wave: 'station' }))
    await advance(0)
    for (let i = 0; i < 240; i += 1) await advance(1000)
    // 先回りして読んでいること（入れ物の長さが足りないと、ここで古い側が押し出される）。
    const lastAsked = Math.max(...fetchSeismoWaveSamples.mock.calls.map((c) => (c[0] as { toMs: number }).toMs))
    expect(lastAsked).toBeGreaterThan(nowMs + 30_000)
    const win = h.result.current.readLiveWave('home', null)
    expect(win).not.toBeNull()
    expect(win!.firstSampleMs).toBeLessThanOrEqual(nowMs - (WAVE_RETAIN_SEC - 1) * 1000)
  })

  it('対照: ライブ（オフセット無し）では何も読まない', async () => {
    renderHook(() => useSeismoReplay({ enabled: true, baseUrl: 'http://host:50506', replayOffsetMs: null, wave: 'station' }))
    await advance(3000)
    expect(fetchSeismoStatus).not.toHaveBeenCalled()
  })

  it('安全弁: 波形を表示しない設定なら波形は読まない', async () => {
    renderHook(() => useSeismoReplay({ enabled: true, baseUrl: 'http://host:50506', replayOffsetMs: OFFSET, wave: 'none' }))
    await advance(0)
    await advance(2000)
    expect(fetchSeismoQuakeIntensity).toHaveBeenCalled()
    expect(fetchSeismoWaveSamples).not.toHaveBeenCalled()
  })

  // 取れた応答を取り込む途中で投げる形（壊れたまとまり）でも、取り直しの上限は効く。失敗の数を先に戻すと毎回 1 回目に数え直される。
  it('安全弁: 取り込む途中で投げ続けても、5 回で波形の読み返しを諦める', async () => {
    fetchSeismoWaveSamples.mockImplementation(async (p: { fromMs: number }) => ({
      kind: 'ok' as const,
      samples: {
        stationKnown: true, filesFailed: 0, skippedBytes: 0, truncated: false,
        chunks: [{ firstSampleMs: p.fromMs, msPerSample: 10, gal: null as unknown as never, memberCount: new Float32Array(1) }],
      },
    }))
    renderHook(() => useSeismoReplay({ enabled: true, baseUrl: 'http://host:50506', replayOffsetMs: OFFSET, wave: 'station' }))
    await advance(0)
    await advance(1000)
    expect(fetchSeismoWaveSamples).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 20 * 60; i += 1) await advance(1000)
    expect(fetchSeismoWaveSamples).toHaveBeenCalledTimes(6)
  })

  it('安全弁: 読み返せなければ間隔を広げて取り直し、5 回で諦める', async () => {
    fetchSeismoQuakeIntensity.mockResolvedValue({ kind: 'unreachable', detail: 'x' })
    renderHook(() => useSeismoReplay({ enabled: true, baseUrl: 'http://host:50506', replayOffsetMs: OFFSET, wave: 'none' }))
    await advance(0)
    await advance(1000)
    expect(fetchSeismoQuakeIntensity).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 20 * 60; i += 1) await advance(1000)
    expect(fetchSeismoQuakeIntensity).toHaveBeenCalledTimes(6)
  })
})
