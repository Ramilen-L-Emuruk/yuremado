// 録画モードのあいだ下地を地図の控えへ載せる係（overviewHold.ts）。
//
// 控えへ触る口（tileCacheAccess.ts）は差し替え、ここでは「いつ口を作るか・いつ載せるか・失敗をどう知らせるか」を見る。
// 知らせ方は、1 度出したら二度と出ない・試し直さない、という広すぎる黙らせ方をしていないかまで固定する。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Map as MapLibreMap } from 'maplibre-gl'

const { resolveSpy, fillSpy } = vi.hoisted(() => ({
  resolveSpy: vi.fn(),
  fillSpy: vi.fn(),
}))
vi.mock('./tileCacheAccess', async importOriginal => ({
  ...(await importOriginal<typeof import('./tileCacheAccess')>()),
  resolveTileCacheAccess: resolveSpy,
  fillTileCache: fillSpy,
}))
import { log } from '../../../utils/logger'
import { startOverviewHold, RETRY_MS, NOT_YET_WARN_MS, FAIL_LIMIT, type OverviewHoldOptions } from './overviewHold'

const map = {} as MapLibreMap
const holdTiles = [{ z: 0, x: 0, y: 0 }, { z: 1, x: 0, y: 0 }]
const ok = { loaded: 2, skipped: 0, failed: 0, firstError: null, aborted: false, gaveUp: false, unread: 0 }

function makeAccess() {
  const restore = vi.fn()
  return {
    access: { has: () => false, load: async () => true, reserve: vi.fn(() => restore), isCurrent: vi.fn(() => true) },
    restore,
  }
}
function opts(over: Partial<OverviewHoldOptions> = {}): OverviewHoldOptions {
  return { sourceId: 'gebco-overview', holdTiles, shouldSkip: () => false, isShown: () => true, onReady: vi.fn(), ...over }
}
let warnSpy: ReturnType<typeof vi.spyOn>
const flush = () => new Promise<void>(r => queueMicrotask(r)).then(() => new Promise<void>(r => queueMicrotask(r)))

beforeEach(() => {
  vi.useFakeTimers()
  resolveSpy.mockReset()
  fillSpy.mockReset()
  fillSpy.mockResolvedValue(ok)
  warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
  vi.spyOn(log, 'debug').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('startOverviewHold', () => {
  it('口が作れたら、上限を決まった枚数ぶん上げて、決まった範囲を載せる（正）', () => {
    const { access } = makeAccess()
    resolveSpy.mockReturnValue({ kind: 'ready', access })
    const o = opts()
    const hold = startOverviewHold(map, o)

    expect(access.reserve).toHaveBeenCalledWith(2)
    expect(fillSpy).toHaveBeenCalledTimes(1)
    expect(fillSpy.mock.calls[0][1]).toEqual(holdTiles)
    expect(o.onReady).toHaveBeenCalledTimes(1)
    hold.stop()
  })

  it('口がまだ作れなければ、RETRY_MS ごとに試し直し、作れた時点で載せる', () => {
    const { access } = makeAccess()
    resolveSpy.mockReturnValueOnce({ kind: 'notYet', reason: 'テスト' }).mockReturnValueOnce({ kind: 'notYet', reason: 'テスト' })
      .mockReturnValue({ kind: 'ready', access })
    const hold = startOverviewHold(map, opts())
    expect(fillSpy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(RETRY_MS)
    expect(fillSpy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(RETRY_MS)

    expect(fillSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).not.toHaveBeenCalled()
    hold.stop()
  })

  it('口が作れない状態が NOT_YET_WARN_MS 続いたら 1 度だけ警告する。下地を出していなければ警告しない', () => {
    resolveSpy.mockReturnValue({ kind: 'notYet', reason: 'テスト' })
    const shown = startOverviewHold(map, opts())
    vi.advanceTimersByTime(NOT_YET_WARN_MS + RETRY_MS * 3)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    shown.stop()

    warnSpy.mockClear()
    const hidden = startOverviewHold(map, opts({ isShown: () => false }))
    vi.advanceTimersByTime(NOT_YET_WARN_MS + RETRY_MS * 3)
    expect(warnSpy).not.toHaveBeenCalled()
    hidden.stop()
  })

  it('形が違えば 1 度だけ警告し、以後は試さない。寄せ先は控えへ載せない（安全弁）', () => {
    resolveSpy.mockReturnValue({ kind: 'unsupported', reason: 'テスト' })
    const hold = startOverviewHold(map, opts())
    vi.advanceTimersByTime(RETRY_MS * 10)

    expect(resolveSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(hold.loadTarget([{ z: 3, x: 1, y: 1 }], new AbortController().signal)).toBe(false)
    hold.stop()
  })

  it('試したぶんが全部読めなかったら、地図がもう持っていたタイルがあっても警告する', async () => {
    const { access } = makeAccess()
    resolveSpy.mockReturnValue({ kind: 'ready', access })
    fillSpy.mockResolvedValueOnce({ loaded: 0, skipped: 3, failed: 5, firstError: '404', aborted: false, gaveUp: false, unread: 0 })
    const hold = startOverviewHold(map, opts())
    await flush()

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain('404')
    hold.stop()
  })

  it('全部読めなかった警告は続けては出さず、読めた結果を見たら次の全滅でまた出す（寄せ先のぶん）', async () => {
    const { access } = makeAccess()
    resolveSpy.mockReturnValue({ kind: 'ready', access })
    const allFail = { loaded: 0, skipped: 0, failed: 2, firstError: 'x', aborted: false, gaveUp: false, unread: 0 }
    const hold = startOverviewHold(map, opts())
    await flush()
    expect(warnSpy).not.toHaveBeenCalled()

    fillSpy.mockResolvedValueOnce(allFail)
    hold.loadTarget([{ z: 3, x: 1, y: 0 }], new AbortController().signal)
    await flush()
    expect(warnSpy).toHaveBeenCalledTimes(1)

    fillSpy.mockResolvedValueOnce(allFail)
    hold.loadTarget([{ z: 3, x: 1, y: 1 }], new AbortController().signal)
    await flush()
    expect(warnSpy).toHaveBeenCalledTimes(1)

    fillSpy.mockResolvedValueOnce(ok)
    hold.loadTarget([{ z: 3, x: 1, y: 2 }], new AbortController().signal)
    await flush()
    fillSpy.mockResolvedValueOnce(allFail)
    hold.loadTarget([{ z: 3, x: 1, y: 3 }], new AbortController().signal)
    await flush()
    expect(warnSpy).toHaveBeenCalledTimes(2)
    hold.stop()
  })

  it('全滅の警告の後、失敗せずに全部載り済みで終わった回を見たら、次の全滅でまた警告する（寄せ先のぶん）', async () => {
    const { access } = makeAccess()
    resolveSpy.mockReturnValue({ kind: 'ready', access })
    const allFail = { loaded: 0, skipped: 0, failed: 2, firstError: 'x', aborted: false, gaveUp: false, unread: 0 }
    const hold = startOverviewHold(map, opts())
    await flush()

    fillSpy.mockResolvedValueOnce(allFail)
    hold.loadTarget([{ z: 3, x: 1, y: 0 }], new AbortController().signal)
    await flush()
    expect(warnSpy).toHaveBeenCalledTimes(1)

    // 地図が自分で読んで埋めていた（こちらの読み込みは 0 枚）
    fillSpy.mockResolvedValueOnce({ loaded: 0, skipped: 1, failed: 0, firstError: null, aborted: false, gaveUp: false, unread: 0 })
    hold.loadTarget([{ z: 3, x: 1, y: 1 }], new AbortController().signal)
    await flush()
    fillSpy.mockResolvedValueOnce(allFail)
    hold.loadTarget([{ z: 3, x: 1, y: 2 }], new AbortController().signal)
    await flush()
    expect(warnSpy).toHaveBeenCalledTimes(2)
    hold.stop()
  })

  it('何も試さなかった回（並びが空）では、全滅の警告を出したことを忘れない', async () => {
    const { access } = makeAccess()
    resolveSpy.mockReturnValue({ kind: 'ready', access })
    const allFail = { loaded: 0, skipped: 0, failed: 2, firstError: 'x', aborted: false, gaveUp: false, unread: 0 }
    const hold = startOverviewHold(map, opts())
    await flush()

    fillSpy.mockResolvedValueOnce(allFail)
    hold.loadTarget([{ z: 3, x: 1, y: 0 }], new AbortController().signal)
    await flush()
    fillSpy.mockResolvedValueOnce({ loaded: 0, skipped: 0, failed: 0, firstError: null, aborted: false, gaveUp: false, unread: 0 })
    hold.loadTarget([{ z: 3, x: 1, y: 1 }], new AbortController().signal)
    await flush()
    fillSpy.mockResolvedValueOnce(allFail)
    hold.loadTarget([{ z: 3, x: 1, y: 2 }], new AbortController().signal)
    await flush()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    hold.stop()
  })

  it('寄せ先は控えへ載せ、終わったら押し出されて欠けたぶんを補う', async () => {
    const { access } = makeAccess()
    resolveSpy.mockReturnValue({ kind: 'ready', access })
    const hold = startOverviewHold(map, opts())
    await flush()
    fillSpy.mockClear()

    const target = [{ z: 4, x: 1, y: 1 }]
    expect(hold.loadTarget(target, new AbortController().signal)).toBe(true)
    expect(fillSpy.mock.calls[0][1]).toBe(target)
    await flush()

    expect(fillSpy).toHaveBeenCalledTimes(2)
    expect(fillSpy.mock.calls[1][1]).toEqual(holdTiles)
    hold.stop()
  })

  it('持ち主が替わっていたら、上限を戻して口を作り直す', () => {
    const first = makeAccess()
    const second = makeAccess()
    resolveSpy.mockReturnValueOnce({ kind: 'ready', access: first.access }).mockReturnValue({ kind: 'ready', access: second.access })
    const hold = startOverviewHold(map, opts())
    first.access.isCurrent.mockReturnValue(false)

    expect(hold.loadTarget([{ z: 4, x: 1, y: 1 }], new AbortController().signal)).toBe(true)

    expect(first.restore).toHaveBeenCalledTimes(1)
    expect(second.access.reserve).toHaveBeenCalledTimes(1)
    hold.stop()
  })

  it('止めると、試し直しのタイマーも読み込みも止まり、上げた上限を戻す（安全弁）', () => {
    const { access, restore } = makeAccess()
    resolveSpy.mockReturnValue({ kind: 'ready', access })
    const hold = startOverviewHold(map, opts())
    const holdSignal = fillSpy.mock.calls[0][2] as AbortSignal

    hold.stop()

    expect(holdSignal.aborted).toBe(true)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(hold.loadTarget([{ z: 4, x: 1, y: 1 }], new AbortController().signal)).toBe(false)
    resolveSpy.mockClear()
    vi.advanceTimersByTime(RETRY_MS * 5)
    expect(resolveSpy).not.toHaveBeenCalled()
  })

  it('通信節約の設定のあいだは決まった範囲を読まない（対照）', () => {
    const { access } = makeAccess()
    resolveSpy.mockReturnValue({ kind: 'ready', access })
    const hold = startOverviewHold(map, opts({ shouldSkip: () => true }))
    expect(fillSpy).not.toHaveBeenCalled()
    hold.stop()
  })
  it('下地を出していなかった間の時間では警告せず、出してから待ち時間を数え始める', () => {
    resolveSpy.mockReturnValue({ kind: 'notYet', reason: 'テスト' })
    let shown = false
    const hold = startOverviewHold(map, opts({ isShown: () => shown }))
    vi.advanceTimersByTime(NOT_YET_WARN_MS * 2)
    shown = true
    vi.advanceTimersByTime(RETRY_MS * 2)
    expect(warnSpy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(NOT_YET_WARN_MS)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    hold.stop()
  })

  it('確かめる途中の例外が続いても諦めずに試し続け、整った時点で載せる（一時的な状態を使えないことにしない）', () => {
    const { access } = makeAccess()
    resolveSpy.mockReturnValue({ kind: 'notYet', reason: '形を確かめる途中で例外（x）' })
    const hold = startOverviewHold(map, opts())
    vi.advanceTimersByTime(RETRY_MS * 20)
    expect(resolveSpy).toHaveBeenCalledTimes(21)

    resolveSpy.mockReturnValue({ kind: 'ready', access })
    vi.advanceTimersByTime(RETRY_MS)

    expect(access.reserve).toHaveBeenCalledTimes(1)
    hold.stop()
  })

  it('決まった範囲が 1 枚も読めなかった後は、寄せのたびには補わない（1 時間ごとの補いまで待つ）', async () => {
    const { access } = makeAccess()
    resolveSpy.mockReturnValue({ kind: 'ready', access })
    fillSpy.mockResolvedValueOnce({ loaded: 0, skipped: 0, failed: FAIL_LIMIT, firstError: '503', aborted: false, gaveUp: true, unread: 10 })
    const hold = startOverviewHold(map, opts())
    await flush()
    fillSpy.mockClear()
    // 寄せ先も 1 枚も読めていない（配信元はまだ戻っていない）
    fillSpy.mockResolvedValueOnce({ loaded: 0, skipped: 2, failed: 0, firstError: null, aborted: false, gaveUp: false, unread: 0 })

    hold.loadTarget([{ z: 4, x: 1, y: 1 }], new AbortController().signal)
    await flush()

    expect(fillSpy).toHaveBeenCalledTimes(1)
    expect(fillSpy.mock.calls[0][1]).not.toEqual(holdTiles)
    hold.stop()
  })

  it('読み込みが終われば、口の合図に付けた聞き手を外す（寄せのたびに溜めない）', async () => {
    const { access } = makeAccess()
    resolveSpy.mockReturnValue({ kind: 'ready', access })
    const hold = startOverviewHold(map, opts())
    await flush()
    const holdSignal = fillSpy.mock.calls[0][2] as AbortSignal
    const add = vi.spyOn(AbortSignal.prototype, 'addEventListener')
    const remove = vi.spyOn(AbortSignal.prototype, 'removeEventListener')

    for (let i = 0; i < 5; i++) {
      hold.loadTarget([{ z: 4, x: i, y: 1 }], new AbortController().signal)
      await flush()
    }

    const added = add.mock.calls.filter(c => c[0] === 'abort').length
    const removed = remove.mock.calls.filter(c => c[0] === 'abort').length
    expect(added).toBeGreaterThan(0)
    expect(removed).toBe(added)
    expect(holdSignal.aborted).toBe(false)
    hold.stop()
  })

  it('口ができた後の準備で例外が出たら、口を捨てて使えないことにし、effect へ例外を漏らさない', () => {
    const { access } = makeAccess()
    access.reserve.mockImplementation(() => { throw new Error('形が違う') })
    resolveSpy.mockReturnValue({ kind: 'ready', access })
    let hold: ReturnType<typeof startOverviewHold> | null = null
    expect(() => { hold = startOverviewHold(map, opts()) }).not.toThrow()

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(hold!.loadTarget([{ z: 3, x: 1, y: 1 }], new AbortController().signal)).toBe(false)
    hold!.stop()
  })

  it('決まった範囲を読んでいる最中に補いを頼まれたら、終わった後にもう 1 度回す', async () => {
    const { access } = makeAccess()
    resolveSpy.mockReturnValue({ kind: 'ready', access })
    let finishFirst: (r: unknown) => void = () => {}
    fillSpy.mockImplementationOnce(() => new Promise(r => { finishFirst = r }))
    const hold = startOverviewHold(map, opts())
    expect(fillSpy).toHaveBeenCalledTimes(1)

    hold.loadTarget([{ z: 4, x: 1, y: 1 }], new AbortController().signal)
    await flush()
    expect(fillSpy).toHaveBeenCalledTimes(2)
    finishFirst(ok)
    await flush()

    expect(fillSpy).toHaveBeenCalledTimes(3)
    expect(fillSpy.mock.calls[2][1]).toEqual(holdTiles)
    hold.stop()
  })

  it('持ち主が替わったら、古い口で走っている寄せ先の読み込みも打ち切る', () => {
    const first = makeAccess()
    const second = makeAccess()
    resolveSpy.mockReturnValueOnce({ kind: 'ready', access: first.access }).mockReturnValue({ kind: 'ready', access: second.access })
    const hold = startOverviewHold(map, opts())
    hold.loadTarget([{ z: 4, x: 1, y: 1 }], new AbortController().signal)
    const oldTargetSignal = fillSpy.mock.calls[1][2] as AbortSignal
    expect(oldTargetSignal.aborted).toBe(false)
    first.access.isCurrent.mockReturnValue(false)

    hold.loadTarget([{ z: 4, x: 2, y: 1 }], new AbortController().signal)

    expect(oldTargetSignal.aborted).toBe(true)
    hold.stop()
  })
  it('決まった範囲が全滅した後でも、寄せ先が読めたら配信元が戻ったとみなし、寄せのたびの補いを再開する', async () => {
    const { access } = makeAccess()
    resolveSpy.mockReturnValue({ kind: 'ready', access })
    fillSpy.mockResolvedValueOnce({ loaded: 0, skipped: 0, failed: FAIL_LIMIT, firstError: '503', aborted: false, gaveUp: true, unread: 10 })
    const hold = startOverviewHold(map, opts())
    await flush()
    fillSpy.mockClear()

    hold.loadTarget([{ z: 4, x: 1, y: 1 }], new AbortController().signal)
    await flush()

    expect(fillSpy).toHaveBeenCalledTimes(2)
    expect(fillSpy.mock.calls[1][1]).toEqual(holdTiles)
    hold.stop()
  })

  it('読めないことが続いて打ち切った回の後は、打ち切った位置の続きから補う（同じ場所で毎回止まって後ろへ届かない、を避ける）', async () => {
    const { access } = makeAccess()
    resolveSpy.mockReturnValue({ kind: 'ready', access })
    const tiles = Array.from({ length: 10 }, (_, i) => ({ z: 5, x: i, y: 0 }))
    // 先頭の 3 枚を試して打ち切り、7 枚を読まずに残した
    fillSpy.mockResolvedValueOnce({ loaded: 1, skipped: 0, failed: 2, firstError: '404', aborted: false, gaveUp: true, unread: 7 })
    const hold = startOverviewHold(map, opts({ holdTiles: tiles }))
    await flush()
    fillSpy.mockClear()

    hold.loadTarget([{ z: 4, x: 1, y: 1 }], new AbortController().signal)
    await flush()

    const refill = fillSpy.mock.calls[1][1] as typeof tiles
    expect(refill[0]).toEqual(tiles[3])
    expect(refill).toHaveLength(10)
    hold.stop()
  })

  it('最後まで回った回の後は、先頭（低い z）から補う（対照）', async () => {
    const { access } = makeAccess()
    resolveSpy.mockReturnValue({ kind: 'ready', access })
    const tiles = Array.from({ length: 10 }, (_, i) => ({ z: 5, x: i, y: 0 }))
    fillSpy.mockResolvedValueOnce({ loaded: 8, skipped: 0, failed: 2, firstError: '404', aborted: false, gaveUp: false, unread: 0 })
    const hold = startOverviewHold(map, opts({ holdTiles: tiles }))
    await flush()
    fillSpy.mockClear()

    hold.loadTarget([{ z: 4, x: 1, y: 1 }], new AbortController().signal)
    await flush()

    expect(fillSpy.mock.calls[1][1]).toEqual(tiles)
    hold.stop()
  })

  it('打ち切られた寄せ先の回でも、読めた結果があれば全滅の印を下ろす', async () => {
    const { access } = makeAccess()
    resolveSpy.mockReturnValue({ kind: 'ready', access })
    fillSpy.mockResolvedValueOnce({ loaded: 0, skipped: 0, failed: FAIL_LIMIT, firstError: '503', aborted: false, gaveUp: true, unread: 10 })
    const hold = startOverviewHold(map, opts())
    await flush()
    // 寄せ先は打ち切られたが、1 枚読めていた
    fillSpy.mockResolvedValueOnce({ loaded: 1, skipped: 0, failed: 0, firstError: null, aborted: true, gaveUp: false, unread: 0 })
    hold.loadTarget([{ z: 4, x: 1, y: 1 }], new AbortController().signal)
    await flush()
    fillSpy.mockClear()

    // 次の寄せ（読めた結果）の後に、補いが走る
    hold.loadTarget([{ z: 4, x: 2, y: 1 }], new AbortController().signal)
    await flush()

    expect(fillSpy).toHaveBeenCalledTimes(2)
    hold.stop()
  })
  it('口を作り直したら、打ち切った位置ではなく先頭（低い z の土台）から補う', async () => {
    const first = makeAccess()
    const second = makeAccess()
    resolveSpy.mockReturnValueOnce({ kind: 'ready', access: first.access }).mockReturnValue({ kind: 'ready', access: second.access })
    const tiles = Array.from({ length: 10 }, (_, i) => ({ z: 5, x: i, y: 0 }))
    fillSpy.mockResolvedValueOnce({ loaded: 1, skipped: 0, failed: 2, firstError: '404', aborted: false, gaveUp: true, unread: 7 })
    const hold = startOverviewHold(map, opts({ holdTiles: tiles }))
    await flush()
    first.access.isCurrent.mockReturnValue(false)
    fillSpy.mockClear()

    hold.loadTarget([{ z: 4, x: 1, y: 1 }], new AbortController().signal)

    expect(fillSpy.mock.calls[0][1]).toEqual(tiles)
    hold.stop()
  })

  it('全部載り済みで失敗せずに終わった回の後は、全滅の印を下ろして寄せのたびの補いを再開する', async () => {
    const { access } = makeAccess()
    resolveSpy.mockReturnValue({ kind: 'ready', access })
    fillSpy.mockResolvedValueOnce({ loaded: 0, skipped: 0, failed: FAIL_LIMIT, firstError: '503', aborted: false, gaveUp: true, unread: 10 })
    vi.useFakeTimers()
    const hold = startOverviewHold(map, opts())
    await flush()
    // 1 時間ごとの補い: 地図が自分で埋めていて、全部載り済みだった
    fillSpy.mockResolvedValueOnce({ loaded: 0, skipped: 2, failed: 0, firstError: null, aborted: false, gaveUp: false, unread: 0 })
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    // 寄せ先も載り済み（読めた結果は無い）
    fillSpy.mockResolvedValueOnce({ loaded: 0, skipped: 2, failed: 0, firstError: null, aborted: false, gaveUp: false, unread: 0 })
    fillSpy.mockClear()

    hold.loadTarget([{ z: 4, x: 1, y: 1 }], new AbortController().signal)
    await flush()

    expect(fillSpy).toHaveBeenCalledTimes(2)
    hold.stop()
  })
})
