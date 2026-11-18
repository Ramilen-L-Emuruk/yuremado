// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JMAQuake } from '../types/earthquake'
import noto from '../services/relayAnalysis.noto.fixture.json'
import { parseQuakeAnalysis } from '../services/relayAnalysis'

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  read: vi.fn(),
  write: vi.fn(async () => true),
  now: vi.fn(() => Date.parse('2030-01-01T00:00:00Z')),
}))
vi.mock('../services/relayAnalysis', async (orig) => ({ ...(await orig<object>()), fetchQuakeAnalysis: h.fetch }))
vi.mock('../utils/analysisDb', () => ({ readAnalysis: h.read, writeAnalysis: h.write }))
vi.mock('../utils/clock', async (orig) => ({ ...(await orig<object>()), serverNow: h.now }))

import { analysisQueryOf, useQuakeAnalysis } from './useQuakeAnalysis'

const quake = (over: Record<string, unknown> = {}): JMAQuake => ({
  kind: 'quake',
  id: 'dmdata-quake-20240101161010-x',
  eventId: '20240101161010',
  earthquake: {
    time: '2024-01-01T16:10:00+09:00',
    originTime: '2024-01-01T16:10:00+09:00',
    hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 0, magnitude: 7.6 },
  },
  ...over,
}) as unknown as JMAQuake

const analysis = parseQuakeAnalysis(noto)

beforeEach(() => {
  h.read.mockResolvedValue(null)
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('analysisQueryOf', () => {
  it('EventID・発生時刻・震央・深さ・規模を載せる', () => {
    expect(analysisQueryOf(quake())).toEqual({ eventId: '20240101161010', time: '2024-01-01T16:10:00+09:00', lat: 37.5, lon: 137.2, depthKm: 0, mag: 7.6 })
  })

  it('震央が不明・取り消し・EventID が無い地震は問い合わせない', () => {
    expect(analysisQueryOf(quake({ earthquake: { time: '2024-01-01T16:10:00+09:00', hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: Number.NaN } } }))).toBeNull()
    expect(analysisQueryOf(quake({ cancelledAt: new Date() }))).toBeNull()
    expect(analysisQueryOf(quake({ eventId: undefined, id: 'x' }))).toBeNull()
  })

  it('深さ・規模が読めなければ null で送る', () => {
    const q = analysisQueryOf(quake({ earthquake: { time: '2024-01-01T16:10:00+09:00', hypocenter: { name: '', latitude: 37.5, longitude: 137.2, depth: -1, magnitude: Number.NaN } } }))
    expect(q).toMatchObject({ depthKm: null, mag: null })
  })
})

describe('useQuakeAnalysis', () => {
  it('閉じている間は問い合わせない', async () => {
    renderHook(() => useQuakeAnalysis(quake(), false, false))
    await act(async () => {})
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('開くと問い合わせ、答えを出して控えに書く', async () => {
    h.fetch.mockResolvedValue({ kind: 'ok', analysis, raw: noto })
    const { result } = renderHook(() => useQuakeAnalysis(quake(), true, false))
    expect(result.current.state).toBe('loading')
    await waitFor(() => expect(result.current.state).toBe('ready'))
    expect(h.write).toHaveBeenCalledWith('20240101161010', noto, expect.any(Number))
  })

  it('控えがあれば先に出し、問い合わせに失敗しても控えを出したままにする', async () => {
    h.read.mockResolvedValue({ eventId: '20240101161010', savedAt: 1, body: noto })
    let fail!: (v: unknown) => void
    h.fetch.mockReturnValue(new Promise(r => { fail = r }))
    const { result } = renderHook(() => useQuakeAnalysis(quake(), true, false))
    await waitFor(() => expect(result.current).toMatchObject({ state: 'ready', refreshing: true }))
    await act(async () => fail({ kind: 'error', message: 'status=503' }))
    expect(result.current).toMatchObject({ state: 'ready', refreshing: false, refreshFailed: true })
    expect(h.write).not.toHaveBeenCalled()
  })

  it('控えが無く失敗したら「失敗」、404 なら「確かめられない」', async () => {
    h.fetch.mockResolvedValue({ kind: 'error', message: 'x' })
    const a = renderHook(() => useQuakeAnalysis(quake(), true, false))
    await waitFor(() => expect(a.result.current.state).toBe('failed'))
    h.fetch.mockResolvedValue({ kind: 'unverifiable' })
    const b = renderHook(() => useQuakeAnalysis(quake(), true, false))
    await waitFor(() => expect(b.result.current.state).toBe('unverifiable'))
  })

  it('開き直すたびに問い合わせる', async () => {
    h.fetch.mockResolvedValue({ kind: 'ok', analysis, raw: noto })
    const { result, rerender } = renderHook(({ open }) => useQuakeAnalysis(quake(), open, false), { initialProps: { open: true } })
    await waitFor(() => expect(result.current.state).toBe('ready'))
    rerender({ open: false })
    rerender({ open: true })
    // 開き直した直後も前の答えを出したまま
    expect(result.current.state).toBe('ready')
    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2))
  })

  it('リプレイ中は再生の時計より後に出た版と気象庁の解を出さない', async () => {
    h.now.mockReturnValue(Date.parse('2024-01-01T07:50:00Z'))
    h.fetch.mockResolvedValue({ kind: 'ok', analysis, raw: noto })
    const { result } = renderHook(() => useQuakeAnalysis(quake(), true, true))
    await waitFor(() => expect(result.current.state).toBe('ready'))
    const v = result.current as Extract<typeof result.current, { state: 'ready' }>
    expect(v.analysis.solutions.map(s => s.key).sort()).toEqual(['emsc:CPPT', 'emsc:SC4', 'geofon:GFZ'])
  })

  it('リプレイでなければ版を絞らない（対照）', async () => {
    h.now.mockReturnValue(Date.parse('2024-01-01T07:50:00Z'))
    h.fetch.mockResolvedValue({ kind: 'ok', analysis, raw: noto })
    const { result } = renderHook(() => useQuakeAnalysis(quake(), true, false))
    await waitFor(() => expect(result.current.state).toBe('ready'))
    const v = result.current as Extract<typeof result.current, { state: 'ready' }>
    expect(v.analysis.solutions).toHaveLength(15)
  })
})
