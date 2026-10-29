import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  offlineBathymetryCachedResponseWillBeUsed,
  offlineBathymetryCacheName,
  offlineBathymetryCacheWillUpdate,
  offlineBathymetryRuntimeCaching,
  offlineBathymetryUrlPattern,
} from './offlineBathymetry'
import { offlineDataCacheName } from './offlineData'
import {
  BATHYMETRY_URL,
  BAND_MAX_TILE_ZOOM,
  GLOBAL_MAX_TILE_ZOOM,
  MAX_TILE_ZOOM,
  buildBandPrefetchTiles,
  buildGlobalPrefetchTiles,
  buildPrefetchQueue,
  buildPrefetchTiles,
  PREFETCH_REQUEST_INIT,
} from '../src/utils/gebcoPrefetch'

const VITE_CONFIG = readFileSync('vite.config.ts', 'utf-8')

/** 日本の枠を控える最大ズーム（2026-10-28 選択「段9まで保存し、保存分を先に返す (Recommended)」）。 */
const MAX_Z = 9

const tileUrl = (z: number, x: number, y: number) =>
  new URL(BATHYMETRY_URL.replace('{z}', String(z)).replace('{y}', String(y)).replace('{x}', String(x)))

/** Service Worker へ書き出されたときと同じく、関数の文字列だけから作り直す（外の変数を参照していれば落ちる）。 */
const isolatedPattern = new Function(`return (${offlineBathymetryUrlPattern.toString()})`)() as typeof offlineBathymetryUrlPattern
const match = (url: URL) => isolatedPattern({ url })

describe('offlineBathymetryUrlPattern', () => {
  it('先読みのキューと同じ範囲を控える（日本の枠の z9 まで・帯の z6〜z7・全球の z5 まで）', () => {
    // 控える範囲と先読みの範囲がずれると、先読みしたのに次に開いたとき控えから出ないタイルができる。
    expect(MAX_TILE_ZOOM).toBe(MAX_Z)
    const tiles = buildPrefetchQueue().tiles
    expect(tiles.every(t => match(tileUrl(t.z, t.x, t.y)))).toBe(true)
    expect(buildPrefetchTiles(MAX_Z)).toHaveLength(2090)
    expect(buildBandPrefetchTiles()).toHaveLength(958)
    expect(buildGlobalPrefetchTiles()).toHaveLength(1365)
  })

  it('日本の枠と帯のすぐ外の深い z、z10 には当たらない（対照）', () => {
    // 全球を控える z（GLOBAL_MAX_TILE_ZOOM 以下）は外周が無いので見ない。
    const deep = [...buildPrefetchTiles(MAX_Z), ...buildBandPrefetchTiles()].filter(t => t.z > GLOBAL_MAX_TILE_ZOOM)
    const inside = new Set(deep.map(t => `${t.z}/${t.x}/${t.y}`))
    let outsideChecked = 0
    for (const t of deep) {
      const n = 2 ** t.z
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const x = t.x + dx
        const y = t.y + dy
        if (x < 0 || y < 0 || x >= n || y >= n || inside.has(`${t.z}/${x}/${y}`)) continue
        expect(match(tileUrl(t.z, x, y))).toBe(false)
        outsideChecked++
      }
    }
    expect(outsideChecked).toBeGreaterThan(0)
    // 帯は BAND_MAX_TILE_ZOOM より深くは控えない。日本の枠から外れた帯の東端（x=127 は東経 177° 付近）の
    // 子タイルで確かめる。
    const bandEdge = buildBandPrefetchTiles().find(t => t.z === BAND_MAX_TILE_ZOOM && t.x === 127)
    expect(bandEdge).toBeDefined()
    expect(match(tileUrl(BAND_MAX_TILE_ZOOM, bandEdge!.x, bandEdge!.y))).toBe(true)
    expect(match(tileUrl(BAND_MAX_TILE_ZOOM + 1, bandEdge!.x * 2, bandEdge!.y * 2))).toBe(false)
    const [first10] = buildPrefetchTiles(10).filter(t => t.z === 10)
    expect(match(tileUrl(10, first10.x, first10.y))).toBe(false)
  })

  it('配信元の別のサービス・別のオリジンには当たらない（安全弁）', () => {
    const other = new URL(tileUrl(0, 0, 0).href.replace('GEBCO_basemap_NCEI', 'World_Imagery'))
    expect(match(other)).toBe(false)
    expect(match(new URL('https://example.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/GEBCO_basemap_NCEI/MapServer/tile/0/0/0'))).toBe(false)
    expect(match(new URL(`${tileUrl(0, 0, 0).href}?f=json`))).toBe(true)
  })
})

describe('offlineBathymetryRuntimeCaching', () => {
  it('控えを先に返す StaleWhileRevalidate で、バリアントのキャッシュ名・検分を持つ', () => {
    // NetworkFirst へ戻すと、繋がっている間は控えがあっても毎回配信元を待ち、寄せた先の海底地形が遅れて出る。
    const rule = offlineBathymetryRuntimeCaching('dmdss')
    expect(rule.handler).toBe('StaleWhileRevalidate')
    expect(rule.urlPattern).toBe(offlineBathymetryUrlPattern)
    expect(rule.options?.cacheName).toBe('bathymetry-tiles-dmdss')
    expect(rule.options?.plugins?.[0]?.cacheWillUpdate).toBe(offlineBathymetryCacheWillUpdate)
    expect(rule.options?.plugins?.[0]?.cachedResponseWillBeUsed).toBe(offlineBathymetryCachedResponseWillBeUsed)
  })

  it('キャッシュ名はバリアントで分かれ、生成データの控えとも重ならない', () => {
    expect(offlineBathymetryCacheName('standard')).not.toBe(offlineBathymetryCacheName('dmdss'))
    expect(offlineBathymetryCacheName('dmdss')).not.toBe(offlineDataCacheName('dmdss'))
  })

  it('vite.config.ts が規則をそのまま runtimeCaching へ渡している', () => {
    expect(VITE_CONFIG).toMatch(/^\s*offlineBathymetryRuntimeCaching\(variant\),\s*$/m)
  })
})

describe('offlineBathymetryCachedResponseWillBeUsed', () => {
  const url = BATHYMETRY_URL.replace('{z}', '5').replace('{y}', '12').replace('{x}', '28')
  const cached = new Response('x', { status: 200, headers: { 'content-type': 'image/jpeg' } })
  /** Service Worker へ書き出されたときと同じく、関数の文字列だけから作り直す。 */
  const isolated = new Function(`return (${offlineBathymetryCachedResponseWillBeUsed.toString()})`)() as typeof offlineBathymetryCachedResponseWillBeUsed

  it('先読みの要求には控えを渡さない（正）', async () => {
    // 控えを渡すと先読みの 1 本が即座に終わり、裏の取り直しだけが上限なく配信元へ出る。
    const request = new Request(url, PREFETCH_REQUEST_INIT)
    expect(await isolated({ request, cachedResponse: cached })).toBeNull()
  })

  it('地図の表示の要求には控えを先に返す（対照）', async () => {
    expect(await isolated({ request: new Request(url), cachedResponse: cached })).toBe(cached)
  })

  it('控えが無ければ何も返さない（安全弁）', async () => {
    expect(await isolated({ request: new Request(url) })).toBeNull()
  })

  it('先読みの印は Service Worker 側の照合と同じ値（片方だけ変えると先読みがまた控えから返る）', () => {
    expect(PREFETCH_REQUEST_INIT.referrerPolicy).toBe('no-referrer')
    // 変換で引用符の種類が変わりうるので、どちらの引用符でも当たる形で見る。
    expect(offlineBathymetryCachedResponseWillBeUsed.toString()).toMatch(new RegExp(`['"]${PREFETCH_REQUEST_INIT.referrerPolicy}['"]`))
  })
})

describe('offlineBathymetryCacheWillUpdate', () => {
  const image = (init: ResponseInit = {}) =>
    new Response('x', { status: 200, headers: { 'content-type': 'image/jpeg' }, ...init })

  it('200 の画像は控える（正）', async () => {
    const res = image()
    expect(await offlineBathymetryCacheWillUpdate({ response: res })).toBe(res)
  })

  it('200 でも HTML は控えない（対照）', async () => {
    const res = new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    expect(await offlineBathymetryCacheWillUpdate({ response: res })).toBeNull()
  })

  it('200 以外とリダイレクトされた応答は控えない（安全弁）', async () => {
    expect(await offlineBathymetryCacheWillUpdate({ response: image({ status: 404 }) })).toBeNull()
    const res = image()
    Object.defineProperty(res, 'redirected', { value: true })
    expect(await offlineBathymetryCacheWillUpdate({ response: res })).toBeNull()
  })

  it('外の変数を参照しない（Service Worker へ文字列として書き出されるため）', async () => {
    const isolated = new Function(`return (${offlineBathymetryCacheWillUpdate.toString()})`)() as typeof offlineBathymetryCacheWillUpdate
    const res = image()
    expect(await isolated({ response: res })).toBe(res)
  })
})
