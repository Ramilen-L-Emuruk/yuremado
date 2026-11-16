// 地図に重ねる USGS のファイルを読む。素材は中継が写した能登（2024-01-01）の ShakeMap の等値線と有限断層モデル（2026-11-15 取得）
import { afterEach, describe, expect, it, vi } from 'vitest'
import shakemap from './analysisOverlay.shakemap.fixture.json'
import ffm from './analysisOverlay.ffm.fixture.json'
import {
  analysisOverlayFailedFor, clearAnalysisOverlayMemo, fetchAnalysisOverlay, getAnalysisOverlayFailure, getAnalysisOverlayRetry,
  mmiColor, parseMmiOverlay, parseSlipOverlay, retryAnalysisOverlay, setAnalysisOverlayFailure, slipColorStops,
  subscribeAnalysisOverlayStatus,
} from './analysisOverlay'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

describe('parseMmiOverlay', () => {
  it('能登の等値線 12 本を読み、最大は MMI 8.5', () => {
    const o = parseMmiOverlay(shakemap)
    expect(o.lines.features).toHaveLength(12)
    expect(o.maxMmi).toBe(8.5)
  })

  it('値や線の欠けた地物は捨て、1 本も残らなければ投げる', () => {
    const bad = clone(shakemap) as { features: { properties: { value: unknown } }[] }
    bad.features[0].properties.value = 'x'
    expect(parseMmiOverlay(bad).lines.features).toHaveLength(11)
    expect(() => parseMmiOverlay({ type: 'FeatureCollection', features: [] })).toThrow()
    expect(() => parseMmiOverlay([])).toThrow()
  })
})

describe('parseSlipOverlay', () => {
  it('能登の小区画 315 個を読み、最大のすべりは約 6.0 m', () => {
    const o = parseSlipOverlay(ffm)
    expect(o.cells.features).toHaveLength(315)
    expect(o.maxSlipM).toBeCloseTo(6.03, 2)
  })

  it('面でない地物は捨てる', () => {
    expect(() => parseSlipOverlay(shakemap)).toThrow()
  })
})

describe('色', () => {
  it('MMI は四捨五入した階級の色。範囲の外は端の色', () => {
    expect(mmiColor(8.5)).toBe(mmiColor(9))
    expect(mmiColor(12)).toBe(mmiColor(10))
    expect(mmiColor(-1)).toBe(mmiColor(0))
  })

  it('すべりの段は 0 から最大まで等間隔の 5 段', () => {
    expect(slipColorStops(6).map(s => s.at)).toEqual([0, 1.5, 3, 4.5, 6])
    const stops = slipColorStops(0)
    expect(stops[stops.length - 1].at).toBe(1)
  })
})

describe('fetchAnalysisOverlay', () => {
  afterEach(() => { vi.unstubAllGlobals(); clearAnalysisOverlayMemo() })
  const url = 'https://data.yuremado.com/x/us6000m0xl/shakemap/1.json'

  it('置き場所の外の URL は取らない', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    expect((await fetchAnalysisOverlay('https://example.com/x.json', 'mmi', null)).kind).toBe('error')
    expect(f).not.toHaveBeenCalled()
  })

  it('同じ版は 2 度目から取らない', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(shakemap), { status: 200 }))
    vi.stubGlobal('fetch', f)
    expect((await fetchAnalysisOverlay(url, 'mmi', null)).kind).toBe('ok')
    expect((await fetchAnalysisOverlay(url, 'mmi', null)).kind).toBe('ok')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('取れない・形の違うファイルは失敗。失敗した版は 1 分の間は取り直さない', async () => {
    const f404 = vi.fn(async () => new Response('x', { status: 404 }))
    vi.stubGlobal('fetch', f404)
    expect((await fetchAnalysisOverlay(url, 'mmi', null)).kind).toBe('error')
    expect((await fetchAnalysisOverlay(url, 'mmi', null)).kind).toBe('error')
    expect(f404).toHaveBeenCalledTimes(1)
    clearAnalysisOverlayMemo()
    const fEmpty = vi.fn(async () => new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fEmpty)
    expect((await fetchAnalysisOverlay(url, 'mmi', null)).kind).toBe('error')
    expect(fEmpty).toHaveBeenCalledTimes(1)
  })

  it('[安全弁] 1 分が過ぎたら取り直し、取れたら答えを出す', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 503 })))
      expect((await fetchAnalysisOverlay(url, 'mmi', null)).kind).toBe('error')
      vi.setSystemTime(Date.now() + 61_000)
      const ok = vi.fn(async () => new Response(JSON.stringify(shakemap), { status: 200 }))
      vi.stubGlobal('fetch', ok)
      expect((await fetchAnalysisOverlay(url, 'mmi', null)).kind).toBe('ok')
      expect(ok).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('取れなかった重ねの状態と押し直し', () => {
  afterEach(() => { vi.unstubAllGlobals(); clearAnalysisOverlayMemo() })
  const url = 'https://data.yuremado.com/x/us6000m0xl/shakemap/1.json'

  it('[正] 押し直すと、1 分の間引きの中でもすぐ取り直す。押し直しの回数が増え、見ている側へ知らせる', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 503 })))
    expect((await fetchAnalysisOverlay(url, 'mmi', null)).kind).toBe('error')
    const heard = vi.fn()
    const off = subscribeAnalysisOverlayStatus(heard)
    const before = getAnalysisOverlayRetry()
    retryAnalysisOverlay(url)
    off()
    expect(getAnalysisOverlayRetry()).toBe(before + 1)
    expect(heard).toHaveBeenCalledTimes(1)
    const ok = vi.fn(async () => new Response(JSON.stringify(shakemap), { status: 200 }))
    vi.stubGlobal('fetch', ok)
    expect((await fetchAnalysisOverlay(url, 'mmi', null)).kind).toBe('ok')
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it('[対照] 押し直さなければ、1 分の間は取りに行かない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 503 })))
    expect((await fetchAnalysisOverlay(url, 'mmi', null)).kind).toBe('error')
    const again = vi.fn(async () => new Response(JSON.stringify(shakemap), { status: 200 }))
    vi.stubGlobal('fetch', again)
    expect((await fetchAnalysisOverlay(url, 'mmi', null)).kind).toBe('error')
    expect(again).not.toHaveBeenCalled()
  })

  it('[安全弁] 取れなかった印は、同じ版を指すときだけ立つ。同じ値の入れ直しでは知らせない', () => {
    const heard = vi.fn()
    const off = subscribeAnalysisOverlayStatus(heard)
    setAnalysisOverlayFailure({ layer: 'mmi', url })
    setAnalysisOverlayFailure({ layer: 'mmi', url })
    expect(heard).toHaveBeenCalledTimes(1)
    expect(analysisOverlayFailedFor(url)).toBe(true)
    expect(analysisOverlayFailedFor('https://data.yuremado.com/x/us6000m0xl/shakemap/2.json')).toBe(false)
    setAnalysisOverlayFailure(null)
    off()
    expect(getAnalysisOverlayFailure()).toBeNull()
    expect(analysisOverlayFailedFor(url)).toBe(false)
  })
})
