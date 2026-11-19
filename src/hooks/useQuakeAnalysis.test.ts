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
  // 線の時計。既定は地震から 7 日より後（線をすべて越えていて、線では訊き直さない）
  live: vi.fn(() => Date.parse('2030-01-01T00:00:00Z')),
}))
vi.mock('../services/relayAnalysis', async (orig) => ({ ...(await orig<object>()), fetchQuakeAnalysis: h.fetch }))
vi.mock('../utils/analysisDb', () => ({ readAnalysis: h.read, writeAnalysis: h.write }))
vi.mock('../utils/clock', async (orig) => ({ ...(await orig<object>()), serverNow: h.now, liveServerNow: h.live }))

import { publishAnalysisUpdated } from '../services/analysisUpdates'
import { ANALYSIS_LINE_SLACK_MS, analysisQueryOf, nextAnalysisRefreshMs, useQuakeAnalysis } from './useQuakeAnalysis'

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
  h.live.mockReturnValue(Date.parse('2030-01-01T00:00:00Z'))
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

const EVENT_MS = Date.parse('2024-01-01T16:10:00+09:00')
const MIN = 60_000

describe('nextAnalysisRefreshMs', () => {
  it('次の線の 1 分半後を返す（正）', () => {
    expect(nextAnalysisRefreshMs(EVENT_MS, EVENT_MS)).toBe(EVENT_MS + 10 * MIN + ANALYSIS_LINE_SLACK_MS)
    expect(nextAnalysisRefreshMs(EVENT_MS, EVENT_MS + 20 * MIN)).toBe(EVENT_MS + 30 * MIN + ANALYSIS_LINE_SLACK_MS)
  })

  it('その時刻ちょうどなら次の線へ進む（対照）', () => {
    expect(nextAnalysisRefreshMs(EVENT_MS, EVENT_MS + 10 * MIN + ANALYSIS_LINE_SLACK_MS)).toBe(EVENT_MS + 30 * MIN + ANALYSIS_LINE_SLACK_MS)
  })

  it('7 日の線を過ぎたら訊き直さない（安全弁）', () => {
    expect(nextAnalysisRefreshMs(EVENT_MS, EVENT_MS + 7 * 1440 * MIN + ANALYSIS_LINE_SLACK_MS)).toBeNull()
  })
})

describe('useQuakeAnalysis: 開いている間の問い合わせ直し', () => {
  it('この地震の知らせが来たら問い合わせ直す（正）', async () => {
    h.fetch.mockResolvedValue({ kind: 'ok', analysis, raw: noto })
    const { result } = renderHook(() => useQuakeAnalysis(quake(), true, false))
    await waitFor(() => expect(result.current.state).toBe('ready'))
    act(() => publishAnalysisUpdated(['20240101161010']))
    // 問い合わせ直す間も、前の答えを出したまま
    expect(result.current.state).toBe('ready')
    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2))
    // 開いたままの訊き直しでは控えを読み直さない（画面の答えのほうが新しい）
    expect(h.read).toHaveBeenCalledTimes(1)
  })

  it('訊き直しに失敗しても、出していた答えを出したままにする（安全弁）', async () => {
    h.fetch.mockResolvedValueOnce({ kind: 'ok', analysis, raw: noto }).mockResolvedValue({ kind: 'error', message: 'status=503' })
    const { result } = renderHook(() => useQuakeAnalysis(quake(), true, false))
    await waitFor(() => expect(result.current.state).toBe('ready'))
    act(() => publishAnalysisUpdated(['20240101161010']))
    await waitFor(() => expect(result.current).toMatchObject({ state: 'ready', refreshFailed: true }))
  })

  it('別の地震の知らせ・閉じたカードへの知らせでは問い合わせない（対照）', async () => {
    h.fetch.mockResolvedValue({ kind: 'ok', analysis, raw: noto })
    const { result, rerender } = renderHook(({ open }) => useQuakeAnalysis(quake(), open, false), { initialProps: { open: true } })
    await waitFor(() => expect(result.current.state).toBe('ready'))
    act(() => publishAnalysisUpdated(['20240101161800']))
    rerender({ open: false })
    act(() => publishAnalysisUpdated(['20240101161010']))
    await act(async () => {})
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })

  it('問い合わせの途中に知らせが続いたら、終わってから 1 回だけ問い合わせ直す（安全弁）', async () => {
    let finish!: (v: unknown) => void
    h.fetch.mockReturnValueOnce(new Promise(r => { finish = r })).mockResolvedValue({ kind: 'ok', analysis, raw: noto })
    const { result } = renderHook(() => useQuakeAnalysis(quake(), true, false))
    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1))
    act(() => {
      publishAnalysisUpdated(['20240101161010'])
      publishAnalysisUpdated(['20240101161010'])
    })
    // 途中の問い合わせを打ち切らない
    expect((h.fetch.mock.calls[0][1] as AbortSignal).aborted).toBe(false)
    await act(async () => finish({ kind: 'ok', analysis, raw: noto }))
    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current).toMatchObject({ state: 'ready', refreshing: false }))
    await act(async () => {})
    expect(h.fetch).toHaveBeenCalledTimes(2)
  })

  describe('線', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
    afterEach(() => vi.useRealTimers())

    it('開いたまま 10 分の線を越えたら問い合わせ直す（正）・その手前では訊かない（対照）', async () => {
      h.fetch.mockResolvedValue({ kind: 'ok', analysis, raw: noto })
      const due = EVENT_MS + 10 * MIN + ANALYSIS_LINE_SLACK_MS
      h.live.mockReturnValue(due - 1000)
      renderHook(() => useQuakeAnalysis(quake(), true, false))
      await act(async () => {})
      expect(h.fetch).toHaveBeenCalledTimes(1)
      await act(async () => { vi.advanceTimersByTime(999) })
      expect(h.fetch).toHaveBeenCalledTimes(1)
      h.live.mockReturnValue(due)
      await act(async () => { vi.advanceTimersByTime(1) })
      await act(async () => {})
      expect(h.fetch).toHaveBeenCalledTimes(2)
    })

    it('閉じたら線の待ちを外す（安全弁）', async () => {
      h.fetch.mockResolvedValue({ kind: 'ok', analysis, raw: noto })
      const due = EVENT_MS + 10 * MIN + ANALYSIS_LINE_SLACK_MS
      h.live.mockReturnValue(due - 1000)
      const { rerender } = renderHook(({ open }) => useQuakeAnalysis(quake(), open, false), { initialProps: { open: true } })
      await act(async () => {})
      rerender({ open: false })
      h.live.mockReturnValue(due)
      await act(async () => { vi.advanceTimersByTime(1000) })
      expect(h.fetch).toHaveBeenCalledTimes(1)
    })
  })
})
