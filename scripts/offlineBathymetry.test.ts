import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  OFFLINE_BATHYMETRY_NETWORK_TIMEOUT_SECONDS,
  offlineBathymetryCacheName,
  offlineBathymetryCacheWillUpdate,
  offlineBathymetryRuntimeCaching,
  offlineBathymetryUrlPattern,
} from './offlineBathymetry'
import { offlineDataCacheName } from './offlineData'
import { BATHYMETRY_URL, buildPrefetchTiles } from '../src/utils/gebcoPrefetch'

const VITE_CONFIG = readFileSync('vite.config.ts', 'utf-8')

/** 控える最大ズーム（2026-10-25 選択「z8 まで・約 8 MB」）。 */
const MAX_Z = 8

const tileUrl = (z: number, x: number, y: number) =>
  new URL(BATHYMETRY_URL.replace('{z}', String(z)).replace('{y}', String(y)).replace('{x}', String(x)))

/** Service Worker へ書き出されたときと同じく、関数の文字列だけから作り直す（外の変数を参照していれば落ちる）。 */
const isolatedPattern = new Function(`return (${offlineBathymetryUrlPattern.toString()})`)() as typeof offlineBathymetryUrlPattern
const match = (url: URL) => isolatedPattern({ url })

describe('offlineBathymetryUrlPattern', () => {
  it('日本周辺の枠の z0〜z8 のタイルにすべて当たる（正 — 先読みの範囲の計算と同じ枠）', () => {
    const tiles = buildPrefetchTiles(MAX_Z)
    expect(tiles).toHaveLength(569)
    expect(tiles.every(t => match(tileUrl(t.z, t.x, t.y)))).toBe(true)
  })

  it('枠のすぐ外と z9 には当たらない（対照）', () => {
    const tiles = buildPrefetchTiles(MAX_Z)
    const inside = new Set(tiles.map(t => `${t.z}/${t.x}/${t.y}`))
    // 枠の外周 1 枚ぶんだけ見る（z8 の全球 65,536 枚は回さない）
    let outsideChecked = 0
    for (const t of tiles) {
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
    const [first9] = buildPrefetchTiles(9).filter(t => t.z === 9)
    expect(match(tileUrl(9, first9.x, first9.y))).toBe(false)
  })

  it('配信元の別のサービス・別のオリジンには当たらない（安全弁）', () => {
    const other = new URL(tileUrl(0, 0, 0).href.replace('GEBCO_basemap_NCEI', 'World_Imagery'))
    expect(match(other)).toBe(false)
    expect(match(new URL('https://example.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/GEBCO_basemap_NCEI/MapServer/tile/0/0/0'))).toBe(false)
    expect(match(new URL(`${tileUrl(0, 0, 0).href}?f=json`))).toBe(true)
  })
})

describe('offlineBathymetryRuntimeCaching', () => {
  it('NetworkFirst で、バリアントのキャッシュ名・時間切れ・検分を持つ', () => {
    const rule = offlineBathymetryRuntimeCaching('dmdss')
    expect(rule.handler).toBe('NetworkFirst')
    expect(rule.urlPattern).toBe(offlineBathymetryUrlPattern)
    expect(rule.options?.cacheName).toBe('bathymetry-tiles-dmdss')
    expect(rule.options?.networkTimeoutSeconds).toBe(OFFLINE_BATHYMETRY_NETWORK_TIMEOUT_SECONDS)
    expect(rule.options?.plugins?.[0]?.cacheWillUpdate).toBe(offlineBathymetryCacheWillUpdate)
  })

  it('キャッシュ名はバリアントで分かれ、生成データの控えとも重ならない', () => {
    expect(offlineBathymetryCacheName('standard')).not.toBe(offlineBathymetryCacheName('dmdss'))
    expect(offlineBathymetryCacheName('dmdss')).not.toBe(offlineDataCacheName('dmdss'))
  })

  it('vite.config.ts が規則をそのまま runtimeCaching へ渡している', () => {
    expect(VITE_CONFIG).toMatch(/^\s*offlineBathymetryRuntimeCaching\(variant\),\s*$/m)
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
