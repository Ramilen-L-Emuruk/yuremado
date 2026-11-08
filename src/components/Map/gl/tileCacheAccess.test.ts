// 地図の控えへタイルを先に載せる口（tileCacheAccess.ts）。
//
// 本物の地図は WebGL が要るのでここでは立てない。地図ライブラリの中身のうち、このファイルが頼る形だけを
// 偽物で作り、その形のときに正しく載せること・形が違えば使わないことを固定する。本物の地図で黒が消えることは
// ブラウザで確かめる（docs/spec/map-rendering-spec.md §4「下地を地図の控えへ載せる」）。
//
// 偽の控え（FakeCache）は、本物（maplibre-gl 6.10.0 の tile/tile_cache.ts）と同じく、上限を縮めると古い順に捨てる。
// 地図が描くたびに上限を画面相応へ決め直す（tile_manager.ts の updateCacheSize）ので、それで載せたタイルが
// 捨てられないことまでここで見る。
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { fillTileCache, resolveTileCacheAccess, TILE_LOAD_TIMEOUT_MS, type TileCacheAccess } from './tileCacheAccess'
import type { TileXYZ } from '../../../utils/gebcoPrefetch'

class FakeId {
  key: string
  canonical: { z: number; x: number; y: number }
  constructor(public overscaledZ: number, public wrap: number, z: number, x: number, y: number) {
    this.canonical = { z, x, y }
    this.key = `${overscaledZ}/${wrap}/${z}/${x}/${y}`
  }
  wrapped() { return new FakeId(this.overscaledZ, 0, this.canonical.z, this.canonical.x, this.canonical.y) }
}
class FakeTile {
  state = 'loading'
  constructor(public tileID: FakeId, public size: number) {}
}
/** 本物と同じく、上限を超えたら古い順に捨てる控え。 */
class FakeCache {
  max = 10
  data = new Map<string, FakeTile>()
  order: string[] = []
  removed: FakeTile[] = []
  has(id: FakeId) { return this.data.has(id.wrapped().key) }
  add(id: FakeId, tile: FakeTile) {
    const key = id.wrapped().key
    this.data.set(key, tile)
    this.order.push(key)
    this.trim()
  }
  setMaxSize(max: number) {
    this.max = max
    this.trim()
    return this
  }
  private trim() {
    while (this.order.length > this.max) {
      const key = this.order.shift()!
      const t = this.data.get(key)
      this.data.delete(key)
      if (t) this.removed.push(t)
    }
  }
}

/** 地図の中身の形だけを持った偽物。`loadTile` の振る舞いは `load` で差し替える。 */
function fakeMap(opts: { load?: (t: FakeTile) => Promise<void>; inView?: FakeTile[]; noCache?: boolean } = {}) {
  const sample = new FakeTile(new FakeId(5, 0, 5, 0, 0), 256)
  const inView = opts.inView ?? [sample]
  const cache = new FakeCache()
  const tm = {
    getTileByID: (key: string) => inView.find(t => t.tileID.key === key),
    _outOfViewCache: opts.noCache ? undefined : cache,
    // 本物と同じく、描くたびに上限を画面相応（ここでは 10）へ決め直す
    updateCacheSize: () => { cache.setMaxSize(10) },
    _inViewTiles: { getAllTiles: () => inView },
  }
  const source = {
    tileSize: 256,
    loadTile: vi.fn(opts.load ?? (async (t: FakeTile) => { t.state = 'loaded' })),
    abortTile: vi.fn(),
    unloadTile: vi.fn(),
  }
  const managers: Record<string, unknown> = { 'gebco-overview': tm }
  const sources: Record<string, unknown> = { 'gebco-overview': source }
  const map = {
    style: { tileManagers: managers },
    getSource: (id: string) => sources[id],
  } as unknown as MapLibreMap
  return { map, tm, cache, source, inView, managers, sources }
}

const T = (z: number, x: number, y: number): TileXYZ => ({ z, x, y })

function ready(map: MapLibreMap): TileCacheAccess {
  const r = resolveTileCacheAccess(map, 'gebco-overview')
  if (r.kind !== 'ready') throw new Error(`口が作れない: ${r.kind} ${'reason' in r ? r.reason : ''}`)
  return r.access
}

describe('resolveTileCacheAccess', () => {
  it('読み込んだタイルを、地図と同じ形の番号（z と同じ深さ・回り込み 0）で控えへ入れる（正）', async () => {
    const f = fakeMap()
    const access = ready(f.map)

    expect(await access.load(T(4, 3, 5), new AbortController().signal)).toBe(true)

    const stored = f.cache.data.get('4/0/4/3/5')
    expect(stored?.state).toBe('loaded')
    expect(stored?.size).toBe(256)
    expect(access.has(T(4, 3, 5))).toBe(true)
    expect(f.source.unloadTile).not.toHaveBeenCalled()
  })

  it('地図がもう持っているタイル（表示中・控えの中）は読まない（対照）', async () => {
    const f = fakeMap()
    const access = ready(f.map)
    // 表示中（借りた見本のタイル 5/0/0）
    expect(await access.load(T(5, 0, 0), new AbortController().signal)).toBe(false)
    // 控えの中
    f.cache.add(new FakeId(3, 0, 3, 1, 1), new FakeTile(new FakeId(3, 0, 3, 1, 1), 256))
    expect(await access.load(T(3, 1, 1), new AbortController().signal)).toBe(false)

    expect(f.source.loadTile).not.toHaveBeenCalled()
  })

  it('読んでいる間に地図が同じタイルを持ったら、こちらは手放して 2 枚目を入れない（安全弁）', async () => {
    const f = fakeMap({
      load: async (t) => {
        f.inView.push(new FakeTile(t.tileID, 256))
        t.state = 'loaded'
      },
    })
    const access = ready(f.map)

    expect(await access.load(T(4, 2, 2), new AbortController().signal)).toBe(false)

    expect(f.cache.data.size).toBe(0)
    expect(f.source.unloadTile).toHaveBeenCalledTimes(1)
  })

  it('打ち切られたら読み込みも打ち切り、読めたものも控えへ入れずに手放す（安全弁）', async () => {
    const ctrl = new AbortController()
    const f = fakeMap({
      load: async (t) => {
        ctrl.abort()
        t.state = 'loaded'
      },
    })
    const access = ready(f.map)

    expect(await access.load(T(4, 2, 2), ctrl.signal)).toBe(false)

    expect(f.source.abortTile).toHaveBeenCalledTimes(1)
    expect(f.source.unloadTile).toHaveBeenCalledTimes(1)
    expect(f.cache.data.size).toBe(0)
  })

  it('読めなかったタイルは控えへ入れず、手放してから理由を投げる', async () => {
    const f = fakeMap({ load: async () => { throw new Error('404') } })
    const access = ready(f.map)

    await expect(access.load(T(4, 2, 2), new AbortController().signal)).rejects.toThrow('404')

    expect(f.cache.data.size).toBe(0)
    expect(f.source.unloadTile).toHaveBeenCalledTimes(1)
  })

  it('読み込み口が同期で例外を投げても、理由を投げ、期限のタイマーと聞き手を残さない', async () => {
    vi.useFakeTimers()
    try {
      const f = fakeMap()
      f.source.loadTile.mockImplementation(() => { throw new Error('同期の例外') })
      const access = ready(f.map)
      const ctrl = new AbortController()

      await expect(access.load(T(4, 2, 2), ctrl.signal)).rejects.toThrow('同期の例外')

      expect(vi.getTimerCount()).toBe(0)
      ctrl.abort()
      expect(f.source.abortTile).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('期限の後に遅れて読み終わったら、そのテクスチャも 1 度だけ返す', async () => {
    vi.useFakeTimers()
    try {
      let finish: () => void = () => {}
      const f = fakeMap({ load: (t) => new Promise<void>(r => { finish = () => { t.state = 'loaded'; r() } }) })
      const access = ready(f.map)
      const p = access.load(T(4, 2, 2), new AbortController().signal)
      const settled = expect(p).rejects.toThrow('時間切れ')
      await vi.advanceTimersByTimeAsync(TILE_LOAD_TIMEOUT_MS)
      await settled
      expect(f.source.unloadTile).toHaveBeenCalledTimes(1)

      finish()
      await vi.advanceTimersByTimeAsync(0)

      expect(f.source.unloadTile).toHaveBeenCalledTimes(2)
      expect(f.cache.data.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('読み込みが期限までに返らなければ、打ち切って時間切れを投げる（1 枚の詰まりで補いを止めない）', async () => {
    vi.useFakeTimers()
    try {
      const f = fakeMap({ load: () => new Promise<void>(() => {}) })
      const access = ready(f.map)
      const p = access.load(T(4, 2, 2), new AbortController().signal)
      const settled = expect(p).rejects.toThrow('時間切れ')

      await vi.advanceTimersByTimeAsync(TILE_LOAD_TIMEOUT_MS)
      await settled

      expect(f.source.abortTile).toHaveBeenCalledTimes(1)
      expect(f.cache.data.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('打ち切りで読めなかったときは投げずに false を返す', async () => {
    const ctrl = new AbortController()
    const f = fakeMap({ load: async () => { ctrl.abort(); throw new Error('AbortError') } })
    const access = ready(f.map)

    expect(await access.load(T(4, 2, 2), ctrl.signal)).toBe(false)
  })

  describe('reserve（控えの上限を上げる）', () => {
    it('地図が描くたびに上限を決め直しても、載せたタイルは捨てられない（正）', async () => {
      const f = fakeMap()
      const access = ready(f.map)
      access.reserve(20)
      const ctrl = new AbortController()
      for (let x = 0; x < 25; x++) await access.load(T(5, x, 9), ctrl.signal)
      expect(f.cache.data.size).toBe(25)

      // 地図が描くたびに呼ぶ決め直し（上限を画面相応の 10 へ）を何度走らせても、上乗せのぶんは残る
      for (let i = 0; i < 5; i++) f.tm.updateCacheSize()

      expect(f.cache.max).toBe(30)
      expect(f.cache.data.size).toBe(25)
      expect(f.cache.removed).toHaveLength(0)
    })

    it('上乗せしなければ、決め直しで画面相応まで捨てられる（対照）', async () => {
      const f = fakeMap()
      const access = ready(f.map)
      f.cache.setMaxSize(30)
      const ctrl = new AbortController()
      for (let x = 0; x < 25; x++) await access.load(T(5, x, 9), ctrl.signal)

      f.tm.updateCacheSize()

      expect(f.cache.data.size).toBe(10)
    })

    it('戻すと元の決め方へ戻り、上乗せのぶんだけ縮む。2 度戻しても 2 度は縮まない（安全弁）', () => {
      const f = fakeMap()
      const access = ready(f.map)
      const realSet = f.cache.setMaxSize

      const restore = access.reserve(168)
      expect(f.cache.max).toBe(178)
      restore()
      restore()

      expect(f.cache.max).toBe(10)
      expect(f.cache.setMaxSize).toBe(realSet)
      f.tm.updateCacheSize()
      expect(f.cache.max).toBe(10)
    })

    it('重ねて呼んでも、戻す順に関わらず元へ戻る', () => {
      const f = fakeMap()
      const access = ready(f.map)
      const realSet = f.cache.setMaxSize
      const a = access.reserve(5)
      const b = access.reserve(7)
      f.tm.updateCacheSize()
      expect(f.cache.max).toBe(22)

      a()
      f.tm.updateCacheSize()
      expect(f.cache.max).toBe(17)
      b()

      expect(f.cache.setMaxSize).toBe(realSet)
      f.tm.updateCacheSize()
      expect(f.cache.max).toBe(10)
    })
  })

  it('isCurrent は、ソースが作り直されて持ち主が替わると false になる', () => {
    const f = fakeMap()
    const access = ready(f.map)
    expect(access.isCurrent()).toBe(true)

    f.managers['gebco-overview'] = { ...f.tm }

    expect(access.isCurrent()).toBe(false)
  })

  it('作った番号の鍵が、地図が作った番号の鍵と合わなければ unsupported（載せても拾われないため）', () => {
    const odd = new FakeTile(new FakeId(5, 0, 5, 0, 0), 256)
    odd.tileID.key = 'ちがう鍵'
    const f = fakeMap({ inView: [odd] })
    expect(resolveTileCacheAccess(f.map, 'gebco-overview').kind).toBe('unsupported')
  })

  it('形を確かめる途中で例外が出たら notYet（一時的な状態として試し直す。呼び出し側の effect を落とさない）', () => {
    const map = {
      get style(): unknown { throw new Error('壊れた') },
      getSource: () => undefined,
    } as unknown as MapLibreMap
    const r = resolveTileCacheAccess(map, 'gebco-overview')
    expect(r.kind).toBe('notYet')
  })

  it('地図がまだタイルを 1 枚も持っていなければ notYet（後で試し直す）', () => {
    const f = fakeMap({ inView: [] })
    expect(resolveTileCacheAccess(f.map, 'gebco-overview').kind).toBe('notYet')
  })

  it('ソースがまだ無ければ notYet', () => {
    const f = fakeMap()
    expect(resolveTileCacheAccess(f.map, 'gebco-other').kind).toBe('notYet')
  })

  it('控えの形が違えば unsupported（今の HTTP の先読みだけに戻る）', () => {
    const f = fakeMap({ noCache: true })
    expect(resolveTileCacheAccess(f.map, 'gebco-overview').kind).toBe('unsupported')
  })

  it('スタイルがまだ無ければ notYet（読み込み前・組み替えの途中）', () => {
    const map = { getSource: () => undefined } as unknown as MapLibreMap
    expect(resolveTileCacheAccess(map, 'gebco-overview').kind).toBe('notYet')
  })

  it('スタイルはあるのに持ち主の一覧（style.tileManagers）が無ければ unsupported', () => {
    const map = { style: {}, getSource: () => undefined } as unknown as MapLibreMap
    expect(resolveTileCacheAccess(map, 'gebco-overview').kind).toBe('unsupported')
  })

  it('このソースのタイルがまだ表示されていなければ notYet（番号の鍵を確かめられないまま使える、にしない）', () => {
    const other = new FakeTile(new FakeId(5, 0, 5, 0, 0), 256)
    const f = fakeMap({ inView: [] })
    f.managers['gebco'] = { _inViewTiles: { getAllTiles: () => [other] } }
    expect(resolveTileCacheAccess(f.map, 'gebco-overview').kind).toBe('notYet')
  })

  it('例外なしで読み終わったのに読めた状態でなければ、手放して理由を投げる', async () => {
    const f = fakeMap({ load: async () => { /* 状態は loading のまま */ } })
    const access = ready(f.map)

    await expect(access.load(T(4, 2, 2), new AbortController().signal)).rejects.toThrow('読み込みが終わらなかった')

    expect(f.cache.data.size).toBe(0)
    expect(f.source.unloadTile).toHaveBeenCalledTimes(1)
  })

  it('isCurrent は、同じ持ち主のまま控えが入れ替わっても false になる', () => {
    const f = fakeMap()
    const access = ready(f.map)
    ;(f.tm as { _outOfViewCache: unknown })._outOfViewCache = new FakeCache()
    expect(access.isCurrent()).toBe(false)
  })
})

describe('fillTileCache', () => {
  /** has と load だけの偽の口。`held` に入っているタイルを「地図がもう持っている」とみなす。 */
  function fakeAccess(load: (t: TileXYZ, s: AbortSignal) => Promise<boolean>) {
    const held = new Set<string>()
    const key = (t: TileXYZ) => `${t.z}/${t.x}/${t.y}`
    const access: TileCacheAccess = {
      has: (t) => held.has(key(t)),
      load: vi.fn(async (t, s) => {
        const ok = await load(t, s)
        if (ok) held.add(key(t))
        return ok
      }),
      reserve: () => () => {},
      isCurrent: () => true,
    }
    return { access, held, key }
  }

  it('持っていないタイルだけを読み、数を返す（正・対照）', async () => {
    const { access, held } = fakeAccess(async () => true)
    held.add('3/1/1')
    const tiles = [T(3, 1, 1), T(3, 1, 2), T(3, 2, 2)]

    const r = await fillTileCache(access, tiles, new AbortController().signal, 2, 99)

    expect(r).toEqual({ loaded: 2, skipped: 1, failed: 0, firstError: null, aborted: false, gaveUp: false, unread: 0 })
    expect(access.load).toHaveBeenCalledTimes(2)
  })

  it('同時に読むのは concurrency 枚まで', async () => {
    let active = 0
    let peak = 0
    const { access } = fakeAccess(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise(r => setTimeout(r, 1))
      active--
      return true
    })
    const tiles = Array.from({ length: 10 }, (_, i) => T(5, i, 0))

    await fillTileCache(access, tiles, new AbortController().signal, 3, 99)

    expect(peak).toBe(3)
  })

  it('打ち切ったら残りは読まず、失敗にも数えない（安全弁）', async () => {
    const ctrl = new AbortController()
    const { access } = fakeAccess(async () => {
      ctrl.abort()
      return false
    })
    const tiles = Array.from({ length: 5 }, (_, i) => T(5, i, 0))

    const r = await fillTileCache(access, tiles, ctrl.signal, 1, 99)

    expect(access.load).toHaveBeenCalledTimes(1)
    expect(r.aborted).toBe(true)
    expect(r.failed).toBe(0)
  })

  it('読めなかったタイルは failed に数え、最初の理由を残す', async () => {
    const { access } = fakeAccess(async () => { throw new Error('404') })

    const r = await fillTileCache(access, [T(2, 0, 0), T(2, 1, 0)], new AbortController().signal, 2, 99)

    expect(r).toEqual({ loaded: 0, skipped: 0, failed: 2, firstError: '404', aborted: false, gaveUp: false, unread: 0 })
  })

  it('読めないことが failLimit 枚続いたら、残りは読まずにやめる（配信元が止まっているときに投げ続けない）', async () => {
    const { access } = fakeAccess(async () => { throw new Error('503') })
    const tiles = Array.from({ length: 50 }, (_, i) => T(5, i, 0))

    const r = await fillTileCache(access, tiles, new AbortController().signal, 1, 8)

    expect(access.load).toHaveBeenCalledTimes(8)
    expect(r.gaveUp).toBe(true)
    expect(r.failed).toBe(8)
    expect(r.unread).toBe(42)
  })

  it('途中で読めれば数え直す（ときどき失敗するだけではやめない・対照）', async () => {
    let n = 0
    const { access } = fakeAccess(async () => { if (++n % 3 === 0) return true; throw new Error('x') })
    const tiles = Array.from({ length: 30 }, (_, i) => T(5, i, 0))

    const r = await fillTileCache(access, tiles, new AbortController().signal, 1, 3)

    expect(r.gaveUp).toBe(false)
    expect(access.load).toHaveBeenCalledTimes(30)
  })

  it('口の中（has）で例外が出ても reject せず、読めなかったものとして数える', async () => {
    const { access } = fakeAccess(async () => true)
    access.has = () => { throw new Error('形が変わった') }

    const r = await fillTileCache(access, [T(2, 0, 0)], new AbortController().signal, 1, 99)

    expect(r.failed).toBe(1)
    expect(r.firstError).toBe('形が変わった')
  })
})

// **この口は地図ライブラリの公開されていない中身に頼っている。** 版が変わると、形の確かめ（resolveTileCacheAccess）を
// 素通りしたまま意味だけ変わることがある（控えの鍵の作り方・上限の決め直しの呼ばれ方など）。版を上げたら、
// ブラウザで「下地を控えへ載せてから遠くへ飛ぶと黒が出ない」ことを確かめ直してから、ここの版を書き換える
// （確かめ方は docs/spec/map-rendering-spec.md §4「下地を地図の控えへ載せる」）。
describe('地図ライブラリの版', () => {
  it('maplibre-gl は 6.10.0（控えへ触る口を確かめた版）', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../../node_modules/maplibre-gl/package.json', import.meta.url), 'utf8'))
    expect(pkg.version).toBe('6.10.0')
  })
})
