import type { Map as MapLibreMap } from 'maplibre-gl'
import type { TileXYZ } from '../../../utils/gebcoPrefetch'

// 地図ライブラリ（MapLibre GL JS）が持つタイルの控え（表示から外れたタイルを捨てずに取っておく箱。
// ライブラリの中では out-of-view cache と呼ぶ）へ、こちらから先にタイルを入れておくための口。
//
// **何のためか。** 遠くへ寄せた直後、寄せた先の海底地形の下地（`BaseMapGL` の `gebco-overview`）のタイルが
// 地図に貼られるまで、背景の色が黒くのぞく。HTTP の控えを温めても消えない（読み込み・画像の読み解き・
// テクスチャ化の待ちが残る）。一方で、地図がもう読み込んだタイルを控えに持っていれば、寄せた瞬間に
// そのまま貼られて黒は 0 になる（2026-11-08 実測。控えへ 80 枚を入れてから飛んだときは黒 0、
// 入れていない場所へ飛んだときは 128ms 黒かった）。
//
// **地図ライブラリの公開されていない中身に触る。触るのはこのファイルだけにする。**
// 使っているのは次のもの（maplibre-gl 6.10.0 で確かめた。版を上げたら確かめ直す。
// `tileCacheAccess.test.ts` が版を固定している）。
// - `map.style.tileManagers[ソースの id]`（ソースごとのタイルの持ち主）
// - その `getTileByID(key)`（表示中のタイル）・`_inViewTiles.getAllTiles()`・`_outOfViewCache`（控え。`has`・`add`・`max`・
//   `setMaxSize`。地図は描くたびに `updateCacheSize` から `setMaxSize` を呼んで、上限を画面の大きさから決め直す）
// - タイルと番号の作り方（`Tile`・`OverscaledTileID`）。どちらも公開されていないので、地図がもう持っている
//   タイルから借りる
// 形が 1 つでも違えば `resolveTileCacheAccess` が `unsupported` を返し、呼び出し側はこれまでどおり HTTP の控えを
// 温めるだけに戻る（黒い抜けは残るが、壊れはしない）。スタイルがまだ無い・確かめる途中で例外が出た・このソースの
// タイルがまだ表示されていない、は一時的な状態として `notYet` を返す（呼び出し側が試し直す）。

/** タイルの控えへ触る口。 */
export interface TileCacheAccess {
  /** そのタイルを地図がもう持っているか（表示中か、読み込み中か、控えの中）。 */
  has(tile: TileXYZ): boolean
  /**
   * タイルを読み込み、地図の控えへ入れる。入れたら true。
   * 打ち切られた・読んでいる間に地図が自分で持った、なら false（読んだものは手放す）。
   * 読めなかったときは、読んだものを手放してから理由を投げる。
   */
  load(tile: TileXYZ, signal: AbortSignal): Promise<boolean>
  /**
   * 控えの上限を、画面の大きさから決まる値より `extra` 枚だけ上げる。上げたぶんを戻す関数を返す。
   * 戻すと上限が元へ縮み、溢れた古いタイルから捨てられる。
   */
  reserve(extra: number): () => void
  /** この口が、いまの地図のソースを指しているか（ソースの作り直しで持ち主が替わると false）。 */
  isCurrent(): boolean
}

/** 1 枚の読み込みを待つ上限。HTTP の控えに無くても配信元から取って足りる長さ（`fetchWithTimeout` の上限と同じ）。 */
export const TILE_LOAD_TIMEOUT_MS = 30_000

export type ResolveResult =
  | { kind: 'ready'; access: TileCacheAccess }
  /**
   * まだ形を確かめられない（スタイルやソースが無い・このソースのタイルがまだ表示されていない・確かめる途中で例外）。
   * 後でもう一度試す。
   */
  | { kind: 'notYet'; reason: string }
  /** 形が想定と違う。この地図ライブラリの版では使えない。 */
  | { kind: 'unsupported'; reason: string }

// 以下の型は、このファイルが頼る形だけを書いたもの（ライブラリの型は公開されていない）。
interface TileIdLike {
  key: string
  overscaledZ: number
  wrap: number
  canonical: { z: number; x: number; y: number }
  wrapped(): { key: string }
}
interface TileLike {
  tileID: TileIdLike
  state: string
}
interface TileCacheLike {
  max: number
  has(id: TileIdLike): boolean
  add(id: TileIdLike, tile: TileLike, expiryTimeout?: number): unknown
  setMaxSize(max: number): unknown
}
interface TileManagerLike {
  getTileByID(key: string): TileLike | undefined
  _outOfViewCache: TileCacheLike
  _inViewTiles?: { getAllTiles(): TileLike[] }
}
interface RasterSourceLike {
  tileSize: number
  loadTile(tile: TileLike): Promise<unknown>
  abortTile?(tile: TileLike): unknown
  unloadTile?(tile: TileLike): unknown
}
type TileIdCtor = new (overscaledZ: number, wrap: number, z: number, x: number, y: number) => TileIdLike
type TileCtor = new (id: TileIdLike, size: number) => TileLike

const isFn = (v: unknown): boolean => typeof v === 'function'

function inViewTilesOf(tm: unknown): TileLike[] {
  const tiles = (tm as TileManagerLike | undefined)?._inViewTiles?.getAllTiles?.()
  return Array.isArray(tiles) ? tiles : []
}

/** 地図の `sourceId` のソースについて、タイルの控えへ触る口を作る。形を確かめる途中の例外は `unsupported` にする。 */
export function resolveTileCacheAccess(map: MapLibreMap, sourceId: string): ResolveResult {
  try {
    return resolveUnguarded(map, sourceId)
  } catch (e) {
    // 地図がスタイルを組み替えている途中など、一時的に中身が揃っていないことがある。形が違うと決めつけず、後で試し直す
    return { kind: 'notYet', reason: `形を確かめる途中で例外（${e instanceof Error ? e.message : String(e)}）` }
  }
}

function resolveUnguarded(map: MapLibreMap, sourceId: string): ResolveResult {
  const styleOf = () => (map as unknown as { style?: { tileManagers?: Record<string, unknown> } }).style
  const managersOf = () => styleOf()?.tileManagers
  const style = styleOf()
  // スタイルがまだ無い（読み込み前・組み替えの途中）は一時的な状態。スタイルはあるのに持ち主の一覧が無いなら形が違う
  if (!style) return { kind: 'notYet', reason: 'map.style がまだ無い' }
  const managers = managersOf()
  if (!managers || typeof managers !== 'object') return { kind: 'unsupported', reason: 'map.style.tileManagers が無い' }
  const tm = managers[sourceId] as TileManagerLike | undefined
  if (!tm) return { kind: 'notYet', reason: `ソース ${sourceId} のタイルの持ち主がまだ無い` }
  const cache = tm._outOfViewCache
  if (!isFn(tm.getTileByID) || !cache
    || !isFn(cache.has) || !isFn(cache.add) || !isFn(cache.setMaxSize) || typeof cache.max !== 'number') {
    return { kind: 'unsupported', reason: 'タイルの持ち主か控えの形が想定と違う' }
  }
  const source = map.getSource(sourceId) as unknown as RasterSourceLike | undefined
  if (!source) return { kind: 'notYet', reason: `ソース ${sourceId} がまだ無い` }
  if (!isFn(source.loadTile) || typeof source.tileSize !== 'number') {
    return { kind: 'unsupported', reason: 'ソースにタイルを読み込む口が無い' }
  }
  // タイルと番号の作り方を、このソースの表示中のタイルから借りる（下で番号の形の確かめにも使う）。
  // 確かめられないまま「使える」にはしない —— 鍵が合っていなければ、載せても地図は一度も拾わない。
  const own = inViewTilesOf(tm)
  const probe = own.find(t => t.tileID?.wrap === 0 && t.tileID.overscaledZ === t.tileID.canonical?.z)
  if (!probe) return { kind: 'notYet', reason: 'このソースのタイルがまだ表示されていない' }
  const sample = probe
  const TileC = (sample as unknown as { constructor: TileCtor }).constructor
  const IdC = (sample.tileID as unknown as { constructor: TileIdCtor }).constructor
  if (!isFn(TileC) || !isFn(IdC) || !isFn(sample.tileID?.wrapped)) {
    return { kind: 'unsupported', reason: 'タイルか番号の作り方を借りられない' }
  }

  // 下地のソースは maxzoom 以下のタイルしか要求しないので、番号は z と同じ深さ・回り込み 0 で作る
  // （地図が要求する番号も同じ形になる。ラスタは reparseOverscaled を使わないため）。
  const idOf = (t: TileXYZ): TileIdLike => new IdC(t.z, 0, t.z, t.x, t.y)
  // 作った番号が、地図が自分で作った番号と同じ鍵になるかを確かめる。違えば、載せても地図は一度も拾わない
  // （載せた枚数だけが増えて、成功に見える）。
  {
    const c = probe.tileID.canonical
    if (idOf({ z: c.z, x: c.x, y: c.y }).key !== probe.tileID.key) {
      return { kind: 'unsupported', reason: '作った番号の鍵が、地図の番号の鍵と合わない' }
    }
  }

  const has = (id: TileIdLike): boolean => !!tm.getTileByID(id.key) || cache.has(id)
  const released = new WeakSet<TileLike>()
  const release = (tile: TileLike, late = false) => {
    // 読んだテクスチャを地図の使い回しの箱へ返す（返さないと GPU の記憶が漏れる）。
    // 返すのは 1 枚につき 1 度だけ（同じテクスチャを箱へ 2 度入れると、別のタイルが同じ絵を貼る）。
    // ただし期限の後に遅れて読み終わったときは、そのとき初めてテクスチャができるので、もう 1 度だけ返す（late）。
    if (released.has(tile) && !late) return
    released.add(tile)
    // 返せなくても描画には響かない。毎回知らせると本物の警告を埋めるので黙る（地図の unloadTile は非同期なので、拒否も受け止める）。
    try { void Promise.resolve(source.unloadTile?.(tile)).catch(() => {}) } catch { /* 上のとおり */ }
  }
  let reserved = 0
  const realSetMaxSize = cache.setMaxSize

  const access: TileCacheAccess = {
    has: (t) => has(idOf(t)),
    load: async (t, signal) => {
      if (signal.aborted) return false
      const id = idOf(t)
      if (has(id)) return false
      const tile = new TileC(id, source.tileSize)
      // 打ち切れなくても、読み終わった後の判定で結果は捨てる
      const onAbort = () => { try { source.abortTile?.(tile) } catch { /* 上のとおり */ } }
      signal.addEventListener('abort', onAbort, { once: true })
      // **期限を置く。** 地図ライブラリの読み込みには時間切れが無く、応答の返らない 1 枚があると、
      // それを待つ呼び出し側（1 本ずつ回す補い）が永久に止まる。期限が来たら読み込みを打ち切り、理由を投げる。
      let timer: ReturnType<typeof setTimeout> | null = null
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onAbort()
          reject(new Error(`時間切れ（${TILE_LOAD_TIMEOUT_MS / 1000} 秒）`))
        }, TILE_LOAD_TIMEOUT_MS)
      })
      // 読み込みが先に決着したら、この期限の拒否は誰も待たない（未処理の拒否にしない）
      timedOut.catch(() => {})
      let loading: Promise<unknown> | null = null
      try {
        // 読み込み口が同期で例外を投げても、下の finally でタイマーと聞き手を外す
        loading = source.loadTile(tile)
        await Promise.race([loading, timedOut])
      } catch (e) {
        release(tile)
        // 期限の後に遅れて読み終わったら、そのとき作られたテクスチャも返す
        if (loading) void loading.then(() => release(tile, true), () => {})
        if (signal.aborted) return false
        throw e
      } finally {
        if (timer !== null) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
      // 読んでいる間に地図が同じタイルを自分で持ったなら、こちらは手放す（同じ番号を 2 枚入れない）
      if (signal.aborted || has(id)) {
        release(tile)
        return false
      }
      // 例外なしで読み終わったのに読めた状態でない（空の応答など）は、読めなかったものとして理由を投げる
      if (tile.state !== 'loaded') {
        release(tile)
        throw new Error(`読み込みが終わらなかった（状態 ${tile.state}）`)
      }
      // **期限を渡さない。** 渡すと配信元の有効期限（1 時間）で控えから落ち、取り直しの要求が増える。
      // 期限の切れたタイルが表示へ入れば、地図が自分で取り直しを掛ける（表示中のタイルと同じ扱い。
      // 取り直す間も古い絵を出し続けるので、黒くはならない）。
      // 入れたら参照は持ち続けない —— 控えから溢れたタイルのテクスチャは地図が使い回すので、
      // こちらが持ったまま後で入れ直すと、別の絵を貼ることになる。
      cache.add(id, tile)
      return true
    },
    reserve: (extra) => {
      // **地図が上限を決め直す口（setMaxSize）そのものに上乗せする。** 決め直しの後から上げ直す形にすると、
      // 決め直しが先に画面相応の上限まで縮め、そのとき溢れたぶん（先に載せたタイルから）を捨ててしまう。
      // 上乗せは足し引きで持つので、重ねて呼んでも戻す順に関わらず元へ戻る。
      reserved += extra
      if (reserved === extra) {
        cache.setMaxSize = function (this: TileCacheLike, max: number) {
          return realSetMaxSize.call(this, max + reserved)
        }
      }
      try {
        realSetMaxSize.call(cache, cache.max + extra)
      } catch (e) {
        // 上げ損ねたら、足したぶんと差し替えを自分で戻してから投げる（戻す関数を返せないので、呼び出し側では戻せない）
        reserved -= extra
        if (reserved === 0) cache.setMaxSize = realSetMaxSize
        throw e
      }
      let released = false
      return () => {
        if (released) return
        released = true
        reserved -= extra
        if (reserved === 0) cache.setMaxSize = realSetMaxSize
        realSetMaxSize.call(cache, Math.max(0, cache.max - extra))
      }
    },
    isCurrent: () => managersOf()?.[sourceId] === tm && tm._outOfViewCache === cache && map.getSource(sourceId) === (source as unknown),
  }
  return { kind: 'ready', access }
}

/** `fillTileCache` の結果。 */
export interface FillResult {
  /** 控えへ入れた枚数 */
  loaded: number
  /** 地図がもう持っていたので読まなかった枚数 */
  skipped: number
  /** 読めなかった枚数（打ち切りで止めたぶんは含まない） */
  failed: number
  /** 読めなかったうち最初の理由（無ければ null） */
  firstError: string | null
  /** 打ち切られたか */
  aborted: boolean
  /** 読めないことが `failLimit` 枚続いたので、残りを読まずにやめたか */
  gaveUp: boolean
  /** やめたので読まなかった枚数 */
  unread: number
}

/**
 * `tiles` を並べた順に、同時 `concurrency` 枚まで読んで控えへ入れる。地図がもう持っているタイルは読まない。
 * `signal` を打ち切ると、まだ読んでいないものは読まず、読んでいるものも捨てる。
 * 読めないことが `failLimit` 枚続いたら、残りは読まずにやめる（配信元が止まっているときに、全部の枚数ぶん失敗する要求を投げ続けない）。
 * **reject しない。** 口の中で例外が出ても、そのタイルを読めなかったものとして数える（呼び出し側は結果だけ見ればよい）。
 */
export async function fillTileCache(
  access: TileCacheAccess,
  tiles: readonly TileXYZ[],
  signal: AbortSignal,
  concurrency: number,
  failLimit: number,
): Promise<FillResult> {
  const result: FillResult = { loaded: 0, skipped: 0, failed: 0, firstError: null, aborted: false, gaveUp: false, unread: 0 }
  let index = 0
  let failedInRow = 0
  const worker = async () => {
    while (!signal.aborted && !result.gaveUp && index < tiles.length) {
      const tile = tiles[index++]
      try {
        if (access.has(tile)) { result.skipped++; continue }
        if (await access.load(tile, signal)) { result.loaded++; failedInRow = 0 }
        else if (!signal.aborted) result.skipped++
      } catch (e) {
        if (signal.aborted) continue
        result.failed++
        result.firstError ??= e instanceof Error ? e.message || e.name : String(e)
        if (++failedInRow >= failLimit) result.gaveUp = true
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  result.aborted = signal.aborted
  if (result.gaveUp) result.unread = tiles.length - index
  return result
}
