import type { RuntimeCaching } from 'workbox-build'

/**
 * オフラインでも海底地形が出るよう、Service Worker の実行時キャッシュで控える GEBCO のタイル。
 *
 * **控えるのは日本周辺の枠（`JAPAN_WIDE_BOUNDS`）の中の z8 まで**（2026-10-23 選択「日本周辺だけ控える (Recommended)」、
 * 境は 2026-10-25 選択「z8 まで・約 8 MB」）。枠の中の z0〜z8 は 569 枚で、2026-10-25 に 48 枚を取って測った平均から
 * 見積もると全部見ても約 8 MB。控えに入るのは実際に表示したタイルと、録画モードの先読み（`utils/gebcoPrefetch.ts`）が
 * 取ったタイルだけで、まとめて取りに行くことはしない（配信元のサービスは `exportTilesAllowed:false` で、
 * タイルの一括書き出しを許していない）。
 *
 * 呼び出し側は `vite.config.ts`（`runtimeCaching` へ {@link offlineBathymetryRuntimeCaching} を渡すだけ）と
 * `scripts/offlineBathymetry.test.ts`（範囲表が先読みの計算と一致すること・規則の中身）。
 *
 * 全体像は `docs/spec/settings-pwa-spec.md` §5「生成データの控え」。
 */

/** 実行時キャッシュの名前。生成データと同じ理由でバリアントで分ける（`scripts/offlineData.ts` の `offlineDataCacheName`）。 */
export function offlineBathymetryCacheName(variant: string): string {
  return `bathymetry-tiles-${variant}`
}

/**
 * 控えるタイルか（Workbox の `urlPattern`）。
 *
 * 範囲表は z ごとの `[x の最小, x の最大, y の最小, y の最大]`（`JAPAN_WIDE_BOUNDS` を `lngLatToTile` で
 * タイル座標へ直したもの。一致は `scripts/offlineBathymetry.test.ts` が先読みの `buildPrefetchTiles` と突き合わせる）。
 * 表の長さが控える最大ズーム + 1。
 *
 * **この関数は Service Worker の中へ文字列として書き出される。外の変数・import を参照しないこと。**
 */
export function offlineBathymetryUrlPattern({ url }: { url: URL }): boolean {
  const RANGES = [
    [0, 0, 0, 0],
    [1, 1, 0, 0],
    [3, 3, 1, 1],
    [6, 7, 2, 3],
    [13, 14, 5, 6],
    [26, 29, 11, 13],
    [53, 58, 22, 27],
    [107, 116, 45, 55],
    [214, 233, 91, 110],
  ]
  if (url.origin !== 'https://tiles.arcgis.com') return false
  const m = /^\/tiles\/C8EMgrsFcRFL6LrL\/arcgis\/rest\/services\/GEBCO_basemap_NCEI\/MapServer\/tile\/(\d+)\/(\d+)\/(\d+)$/.exec(url.pathname)
  if (m === null) return false
  const z = Number(m[1])
  const y = Number(m[2])
  const x = Number(m[3])
  const r = RANGES[z]
  if (r === undefined) return false
  return x >= r[0] && x <= r[1] && y >= r[2] && y <= r[3]
}

/**
 * 控えへ書く前に応答を検分する。控えるのは 200 で・リダイレクトされておらず・HTML ではない応答だけ
 * （公衆無線 LAN のログイン画面で控えを上書きしないため。理由は `scripts/offlineData.ts` の `offlineDataCacheWillUpdate`）。
 *
 * **この関数は Service Worker の中へ文字列として書き出される。外の変数・import を参照しないこと。**
 */
export async function offlineBathymetryCacheWillUpdate({ response }: { response: Response }): Promise<Response | null> {
  if (response.status !== 200 || response.redirected) return null
  const type = response.headers.get('content-type') ?? ''
  return type.toLowerCase().includes('html') ? null : response
}

/**
 * 通信がこの秒数のうちに応答の頭を返さなければ、控えを返す（生成データと同じ値）。通信できる間は
 * 今までどおり配信元（とブラウザの HTTP キャッシュ）から取り、控えは新しい応答で置き換える。
 */
export const OFFLINE_BATHYMETRY_NETWORK_TIMEOUT_SECONDS = 3

/** `vite.config.ts` の `runtimeCaching` へ渡す規則。 */
export function offlineBathymetryRuntimeCaching(variant: string): RuntimeCaching {
  return {
    urlPattern: offlineBathymetryUrlPattern,
    handler: 'NetworkFirst',
    options: {
      cacheName: offlineBathymetryCacheName(variant),
      networkTimeoutSeconds: OFFLINE_BATHYMETRY_NETWORK_TIMEOUT_SECONDS,
      plugins: [{ cacheWillUpdate: offlineBathymetryCacheWillUpdate }],
    },
  }
}
