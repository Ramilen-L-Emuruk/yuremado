// @vitest-environment jsdom
//
// 長期震源カタログの読み込みフックを固定する。
// 取得そのもの（`utils/hypocenterCatalog.ts`）はモックし、ここでは**分岐だけ**を見る。
// 背景は docs/spec/map-rendering-spec.md §16「長期震源カタログの点群」。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { muteConsoleError } from '../test-utils/muteConsoleError'
import { renderHook, waitFor, act } from '@testing-library/react'
import type { HypocenterIndex, HypocenterYear } from '../utils/hypocenterCatalog'

vi.mock('../utils/hypocenterCatalog', async () => {
  const actual = await vi.importActual<typeof import('../utils/hypocenterCatalog')>(
    '../utils/hypocenterCatalog',
  )
  return {
    ...actual,
    loadHypocenterIndex: vi.fn(),
    loadHypocenterYear: vi.fn(),
  }
})

// 末尾（カタログの終端より後）は中継の電文一覧から取る。**本物の通信を投げない**よう差し替える（既定は 0 件で取りきれた）
vi.mock('../services/dmdataReplayLive', () => ({
  fetchListedHypocenters: vi.fn(),
}))

import { loadHypocenterIndex, loadHypocenterYear } from '../utils/hypocenterCatalog'
import { fetchListedHypocenters } from '../services/dmdataReplayLive'
import type { JMAQuake } from '../types/earthquake'
import * as clock from '../utils/clock'
import { useHypocenterCatalog } from './useHypocenterCatalog'

const INDEX: HypocenterIndex = {
  source: 's',
  sourceUrl: 'u',
  license: 'l',
  minMagnitude: 2,
  coveredThroughMs: 0,
  completeness: [{ from: 1919, minMagnitude: 5 }],
  years: [2020, 2021, 2022],
  counts: {},
  quality: {},
}

/** 年ごとに**同じオブジェクトを返す**（実装のキャッシュと同じ性質。参照の安定を試すのに要る）。 */
const YEAR_CACHE = new Map<number, HypocenterYear>()
const makeYear = (year: number): HypocenterYear => {
  const hit = YEAR_CACHE.get(year)
  if (hit) return hit
  const y: HypocenterYear = {
    year,
    source: 'catalog',
    telegramLabels: null,
    count: 0,
    coveredThroughMs: 0,
    quality: 'final',
    timeMs: new Float64Array(0),
    lat: new Float64Array(0),
    lng: new Float64Array(0),
    depth: new Float32Array(0),
    magnitude: new Float32Array(0),
    names: [],
    nameIdx: new Int32Array(0),
    external: new Uint8Array(0),
    intensityCode: new Map(),
  }
  YEAR_CACHE.set(year, y)
  return y
}

const mockIndex = vi.mocked(loadHypocenterIndex)
const mockYear = vi.mocked(loadHypocenterYear)
const mockTail = vi.mocked(fetchListedHypocenters)

beforeEach(() => {
  YEAR_CACHE.clear()
  mockIndex.mockReset()
  mockYear.mockReset()
  mockIndex.mockResolvedValue(INDEX)
  mockYear.mockImplementation((y: number) => Promise.resolve(makeYear(y)))
  mockTail.mockReset()
  mockTail.mockResolvedValue({ quakes: [], complete: true })
  muteConsoleError()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useHypocenterCatalog', () => {
  // 対照: タブを開くまで何も取りに行かない（全期間で gzip 12.6MB あるため）。
  it('enabled が false の間は取りに行かない', async () => {
    renderHook(() => useHypocenterCatalog(2020, 2022, false))
    await new Promise((r) => setTimeout(r, 20))
    expect(mockIndex).not.toHaveBeenCalled()
    expect(mockYear).not.toHaveBeenCalled()
  })

  // 正: 範囲の年を読み、欠けは無い。
  it('範囲の年を読む', async () => {
    const { result } = renderHook(() => useHypocenterCatalog(2020, 2022, true))
    await waitFor(() => expect(result.current.years.length).toBe(3))
    expect(result.current.years.map((y) => y.year)).toEqual([2020, 2021, 2022])
    expect(result.current.missingYears).toEqual([])
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  // 正: **1 年失敗しても残りで描く。** `Promise.all` だと 1 本の不調で期間全体が消える。
  it('一部の年が失敗しても残りを返し、欠けた年を伝える', async () => {
    mockYear.mockImplementation((y: number) =>
      y === 2021 ? Promise.reject(new Error('boom')) : Promise.resolve(makeYear(y)),
    )
    const { result } = renderHook(() => useHypocenterCatalog(2020, 2022, true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.years.map((y) => y.year)).toEqual([2020, 2022])
    expect(result.current.missingYears).toEqual([2021])
  })

  // 対照: 全部失敗したら 1 件も返さない（前の期間のものを残さない）。
  // **`requestedYears` と `missingYears` が同数になること**が「まるごと取れなかった」の合図で、
  // 画面の文言はこれで「そのぶん少ない」と「1 件も出ていない」を言い分ける。
  it('全部失敗したら年は空', async () => {
    mockYear.mockImplementation(() => Promise.reject(new Error('boom')))
    const { result } = renderHook(() => useHypocenterCatalog(2020, 2022, true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.years).toEqual([])
    expect(result.current.missingYears).toEqual([2020, 2021, 2022])
    expect(result.current.requestedYears).toBe(3)
  })

  // 対照: 一部だけ欠けたときは同数にならない（上の合図が常に立たないこと）。
  it('一部だけ欠けたら requestedYears の方が多い', async () => {
    mockYear.mockImplementation((y: number) =>
      y === 2021 ? Promise.reject(new Error('boom')) : Promise.resolve(makeYear(y)),
    )
    const { result } = renderHook(() => useHypocenterCatalog(2020, 2022, true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.missingYears.length).toBeLessThan(result.current.requestedYears)
  })

  // 正: 索引の失敗は `error` として出す。
  it('索引の取得に失敗したら error が立つ', async () => {
    mockIndex.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useHypocenterCatalog(2020, 2022, true))
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.loading).toBe(false)
  })

  // **安全弁: タブを往復しても年の配列の参照が変わらない。**
  // ここが変わると、下流の点群の組み立てと GPU への転送がまるごと走り直す
  // （捨てていないのに詰め直すことになる）。
  it('タブを離れて戻っても年の配列の参照が変わらない', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useHypocenterCatalog(2020, 2022, enabled),
      { initialProps: { enabled: true } },
    )
    await waitFor(() => expect(result.current.years.length).toBe(3))
    const first = result.current.years
    rerender({ enabled: false })
    rerender({ enabled: true })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.years).toBe(first)
  })

  // 対照: 期間が変われば参照も変わる（上の安全弁が「常に同じ」になっていないこと）。
  it('期間を変えれば年の配列は差し替わる', async () => {
    const { result, rerender } = renderHook(
      ({ from }: { from: number }) => useHypocenterCatalog(from, 2022, true),
      { initialProps: { from: 2021 } },
    )
    await waitFor(() => expect(result.current.years.length).toBe(2))
    const first = result.current.years
    rerender({ from: 2020 })
    await waitFor(() => expect(result.current.years.length).toBe(3))
    expect(result.current.years).not.toBe(first)
  })

  // 正: 再試行で読み直す。索引は既にあるので取りに行かない。
  it('retry で年を読み直し、索引は取り直さない', async () => {
    mockYear.mockImplementation(() => Promise.reject(new Error('boom')))
    const { result } = renderHook(() => useHypocenterCatalog(2020, 2022, true))
    await waitFor(() => expect(result.current.missingYears.length).toBe(3))
    const indexCalls = mockIndex.mock.calls.length

    mockYear.mockImplementation((y: number) => Promise.resolve(makeYear(y)))
    act(() => { result.current.retry() })
    await waitFor(() => expect(result.current.years.length).toBe(3))
    expect(result.current.missingYears).toEqual([])
    expect(mockIndex.mock.calls.length).toBe(indexCalls)
  })

  // 安全弁: 索引に無い年は取りに行かない（存在しない年で 404 になる）。
  it('索引に無い年は取りに行かない', async () => {
    const { result } = renderHook(() => useHypocenterCatalog(1800, 1900, true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.years).toEqual([])
    expect(mockYear).not.toHaveBeenCalled()
  })
})

const lastYear = (years: readonly HypocenterYear[]): HypocenterYear | undefined => years[years.length - 1]

describe('useHypocenterCatalog の末尾（中継の地震情報の電文）', () => {
  // 終端は 2022-12-30 00:00 JST。期間の終わりの年（2022）が終端の年に掛かる
  const END = Date.UTC(2022, 11, 29, 15)
  const quakeAt = (iso: string): JMAQuake => ({
    kind: 'quake', id: iso, time: iso,
    issue: { source: '', time: iso, type: 'DetailScale', correct: 'None' },
    earthquake: {
      time: iso,
      hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 3.1 },
      maxScale: 30, domesticTsunami: 'None',
    },
    points: [],
  } as unknown as JMAQuake)

  /** 終端の年（2022）の年ファイルの終端を決める。目次の終端とずらして、控えの寿命の違いを作る */
  const yearEndsAt = (endMs: number) => {
    mockYear.mockImplementation((y: number) => Promise.resolve(y === 2022 ? { ...makeYear(y), coveredThroughMs: endMs } : makeYear(y)))
  }

  beforeEach(() => {
    mockIndex.mockResolvedValue({ ...INDEX, coveredThroughMs: END })
    yearEndsAt(END)
    // 今を終端の 1 日半後に置く（末尾の上限 30 日の内）
    vi.spyOn(clock, 'liveServerNow').mockReturnValue(END + 36 * 3600_000)
  })

  // 正: 取りきれたら、終端より後の地震だけを電文の年として後ろへ足し、範囲を返す。
  it('取りきれたら、終端より後の地震を末尾の年として足す', async () => {
    mockTail.mockResolvedValue({
      quakes: [quakeAt('2022-12-29T14:59:00Z'), quakeAt('2022-12-29T15:30:00Z')],
      complete: true,
    })
    const { result } = renderHook(() => useHypocenterCatalog(2020, 2022, true))
    await waitFor(() => expect(result.current.tail).not.toBeNull())
    const last = result.current.years[result.current.years.length - 1]
    expect(last.source).toBe('telegram')
    // 終端の手前（14:59Z）は年ファイルの側にあるので入れない
    expect(last.count).toBe(1)
    expect(last.telegramLabels?.[0].intensity).toBe('最大震度 3')
    expect(result.current.tail?.fromMs).toBe(END)
    expect(mockTail).toHaveBeenCalledTimes(1)
  })

  // 正: 目次だけが 1 日先へ進んでいても（年ファイルの控えが古い）、末尾は年ファイルの終端から足す（1 日抜けない）
  it('年ファイルの終端が目次より前なら、年ファイルの終端から足す', async () => {
    const yearEnd = END - 24 * 3600_000
    yearEndsAt(yearEnd)
    mockTail.mockResolvedValue({ quakes: [quakeAt('2022-12-29T03:00:00Z'), quakeAt('2022-12-29T15:30:00Z')], complete: true })
    const { result } = renderHook(() => useHypocenterCatalog(2020, 2022, true))
    await waitFor(() => expect(result.current.tail).not.toBeNull())
    expect(result.current.tail?.fromMs).toBe(yearEnd)
    expect(mockTail.mock.calls[0][1]).toEqual(new Date(yearEnd))
    expect(lastYear(result.current.years)?.count).toBe(2)
  })

  // 対照: 年ファイルが目次より先へ進んでいても、年ファイルにある地震を末尾に重ねない
  it('年ファイルの終端が目次より後なら、年ファイルの終端から足す（同じ地震を 2 つ並べない）', async () => {
    const yearEnd = END + 24 * 3600_000
    yearEndsAt(yearEnd)
    mockTail.mockResolvedValue({ quakes: [quakeAt('2022-12-30T03:00:00Z'), quakeAt('2022-12-30T15:30:00Z')], complete: true })
    const { result } = renderHook(() => useHypocenterCatalog(2020, 2022, true))
    await waitFor(() => expect(result.current.tail).not.toBeNull())
    expect(result.current.tail?.fromMs).toBe(yearEnd)
    expect(lastYear(result.current.years)?.count).toBe(1)
  })

  // 正: 年をまたいだ直後、期間を新しい年だけにしても、終端の年を別に読んで末尾を足す
  it('期間が終端の年より後だけでも、終端の年を読んで末尾を足す', async () => {
    const { result } = renderHook(() => useHypocenterCatalog(2023, 2023, true))
    await waitFor(() => expect(result.current.tail).not.toBeNull())
    expect(result.current.tail?.fromMs).toBe(END)
    expect(result.current.catalogEndMs).toBe(END)
    expect(result.current.catalogYears).toEqual([])
  })

  // 正: 期間の端に使う終端は、目次ではなく読めた年ファイルの終端
  it('catalogEndMs は年ファイルの終端', async () => {
    const yearEnd = END - 24 * 3600_000
    yearEndsAt(yearEnd)
    const { result } = renderHook(() => useHypocenterCatalog(2020, 2022, true))
    await waitFor(() => expect(result.current.catalogEndMs).toBe(yearEnd))
  })

  // 安全弁: 終端の年を読めていなければ、どこから足せば繋がるか分からないので足さない
  it('終端の年を読めなければ足さない', async () => {
    mockYear.mockImplementation((y: number) => (y === 2022 ? Promise.reject(new Error('404')) : Promise.resolve(makeYear(y))))
    const { result } = renderHook(() => useHypocenterCatalog(2020, 2022, true))
    await waitFor(() => expect(result.current.missingYears).toEqual([2022]))
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(mockTail).not.toHaveBeenCalled()
    expect(result.current.tail).toBeNull()
  })

  // 正: 末尾を除いた並びは、末尾が届いても参照が変わらない（点群を組み直さずに済む）
  it('catalogYears は末尾が届いても同じ参照のまま', async () => {
    let release: (v: { quakes: JMAQuake[]; complete: boolean }) => void = () => {}
    mockTail.mockReturnValue(new Promise((r) => { release = r }))
    const { result } = renderHook(() => useHypocenterCatalog(2020, 2022, true))
    await waitFor(() => expect(mockTail).toHaveBeenCalled())
    expect(result.current.years).toHaveLength(3)
    const before = result.current.catalogYears
    await act(async () => { release({ quakes: [quakeAt('2022-12-29T15:30:00Z')], complete: true }) })
    await waitFor(() => expect(result.current.tail).not.toBeNull())
    expect(result.current.catalogYears).toBe(before)
    expect(result.current.years).toHaveLength(4)
  })

  // 正: 取り直して中身が同じなら、末尾の年は前の参照のまま（範囲の終わりだけ進む）
  it('取り直して中身が同じなら末尾の年の参照を保つ', async () => {
    const now = vi.spyOn(clock, 'liveServerNow').mockReturnValue(END + 36 * 3600_000)
    mockTail.mockResolvedValue({ quakes: [quakeAt('2022-12-29T15:30:00Z')], complete: true })
    const { result } = renderHook(() => useHypocenterCatalog(2020, 2022, true))
    await waitFor(() => expect(result.current.tail).not.toBeNull())
    const first = lastYear(result.current.years)
    now.mockReturnValue(END + 36 * 3600_000 + 11 * 60_000)
    act(() => result.current.retry())
    await waitFor(() => expect(mockTail).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.tail?.untilMs).toBe(END + 36 * 3600_000 + 11 * 60_000))
    expect(lastYear(result.current.years)).toBe(first)
  })

  // 正: 失敗の直後でも、手で押した再試行は取り直す（対照: 押さなければ 60 秒は取り直さない）
  it('失敗の直後に再試行を押せば取り直す', async () => {
    mockTail.mockResolvedValueOnce({ quakes: [], complete: false })
    const { result, rerender } = renderHook(({ to }) => useHypocenterCatalog(2020, to, true), { initialProps: { to: 2022 } })
    await waitFor(() => expect(mockTail).toHaveBeenCalledTimes(1))
    // 期間を行き来しただけ（再試行ではない）なら取り直さない
    rerender({ to: 2021 })
    rerender({ to: 2022 })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(mockTail).toHaveBeenCalledTimes(1)
    act(() => result.current.retry())
    await waitFor(() => expect(mockTail).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.tail).not.toBeNull())
  })

  // 安全弁: 取りきれなかったら足さない（欠けた地震が「起きなかった」に見えないように）。
  it('取りきれなかったら足さない', async () => {
    mockTail.mockResolvedValue({ quakes: [quakeAt('2022-12-29T15:30:00Z')], complete: false })
    const { result } = renderHook(() => useHypocenterCatalog(2020, 2022, true))
    await waitFor(() => expect(mockTail).toHaveBeenCalled())
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    expect(result.current.tail).toBeNull()
    expect(result.current.years.every((y) => y.source === 'catalog')).toBe(true)
  })

  // 対照: 期間が終端の年に掛からなければ、取りに行かない。
  it('期間が終端の年に掛からなければ取りに行かない', async () => {
    renderHook(() => useHypocenterCatalog(2020, 2021, true))
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(mockTail).not.toHaveBeenCalled()
  })
})

describe('useHypocenterCatalog の末尾の上限', () => {
  // 安全弁: 終端が 30 日より前（書き足しが止まった）なら、電文一覧を引かず末尾も足さない。
  it('終端が 30 日より前なら取りに行かない', async () => {
    const end = Date.UTC(2022, 11, 29, 15)
    mockIndex.mockResolvedValue({ ...INDEX, coveredThroughMs: end })
    vi.spyOn(clock, 'liveServerNow').mockReturnValue(end + 31 * 24 * 3600_000)
    const { result } = renderHook(() => useHypocenterCatalog(2020, 2022, true))
    await waitFor(() => expect(result.current.index).not.toBeNull())
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(mockTail).not.toHaveBeenCalled()
    expect(result.current.tail).toBeNull()
  })
})
