import type { RuntimeCaching } from 'workbox-build'

/**
 * オフラインでも海底地形が出るよう、Service Worker の実行時キャッシュで控える GEBCO のタイル。
 *
 * **控える範囲は録画モードの先読み（`utils/gebcoPrefetch.ts`）と同じ 3 段**: 日本周辺の枠（`JAPAN_WIDE_BOUNDS`）の
 * z9 まで（2,090 枚）・その周りの帯（`BAND_BOUNDS`）の z6〜z7（958 枚）・全球の z5 まで（1,365 枚）。重なりを除くと 4,244 枚。
 * 2026-10-28 の選択（「段9まで保存し、保存分を先に返す (Recommended)」「帯も温めて保存する (Recommended)」
 * 「全球の段5までも保存する (Recommended)」）で、それまでの「日本周辺だけ控える」（2026-10-23）・「z8 まで・約 8 MB」
 * （2026-10-25）を覆した。2026-10-25 に 48 枚を取って測った 1 枚の平均（約 14 KB）から見積もると、全部見ても
 * 約 59 MB（未実測）。控えに入るのは実際に表示したタイルと、録画モードの先読みが取ったタイルだけで、
 * まとめて取りに行くことはしない（配信元のサービスは `exportTilesAllowed:false` で、タイルの一括書き出しを許していない）。
 *
 * **取り方は「控えを先に返し、裏で配信元に確かめて差し替える」**（Workbox の `StaleWhileRevalidate`）。
 * 以前の「まず配信元、繋がらないときだけ控え」（`NetworkFirst`）では、繋がっている間は毎回配信元を待つため、
 * 控えがあっても寄せた先の海底地形が 1 枚 250〜430 ms 遅れて出ていた。控えに無いタイルは今までどおり配信元から取る。
 *
 * **ただし先読みの要求には控えを渡さず、配信元の応答を待って返す**（{@link offlineBathymetryCachedResponseWillBeUsed}。
 * 2026-10-28 ユーザー選択「先読みだけ配信元へ取りに行く (Recommended)」）。控えを先に返すと先読みの 1 本が即座に終わり、
 * 同時に投げる本数の上限が配信元へ効かなくなる（裏の取り直しだけが上限なく出る）うえ、配信元が止まっていても成功に数える。
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
 * 範囲表は z ごとの `[x の最小, x の最大, y の最小, y の最大]`。`JAPAN` は `JAPAN_WIDE_BOUNDS`、`BAND` は `BAND_BOUNDS`
 * を `lngLatToTile` でタイル座標へ直したもの（一致は `scripts/offlineBathymetry.test.ts` が先読みの
 * `buildPrefetchTiles` / `buildBandPrefetchTiles` と突き合わせる）。`GLOBAL_MAX_Z` 以下は全球を控える。
 *
 * **この関数は Service Worker の中へ文字列として書き出される。外の変数・import を参照しないこと。**
 */
export function offlineBathymetryUrlPattern({ url }: { url: URL }): boolean {
  const GLOBAL_MAX_Z = 5
  const JAPAN: Record<number, [number, number, number, number]> = {
    6: [53, 58, 22, 27],
    7: [107, 116, 45, 55],
    8: [214, 233, 91, 110],
    9: [429, 467, 182, 220],
  }
  const BAND: Record<number, [number, number, number, number]> = {
    6: [51, 63, 17, 32],
    7: [103, 127, 35, 64],
  }
  if (url.origin !== 'https://tiles.arcgis.com') return false
  const m = /^\/tiles\/C8EMgrsFcRFL6LrL\/arcgis\/rest\/services\/GEBCO_basemap_NCEI\/MapServer\/tile\/(\d+)\/(\d+)\/(\d+)$/.exec(url.pathname)
  if (m === null) return false
  const z = Number(m[1])
  const y = Number(m[2])
  const x = Number(m[3])
  if (z <= GLOBAL_MAX_Z) return true
  const inside = (r: [number, number, number, number] | undefined) =>
    r !== undefined && x >= r[0] && x <= r[1] && y >= r[2] && y <= r[3]
  return inside(JAPAN[z]) || inside(BAND[z])
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
 * 控えを返してよい要求か（Workbox のプラグイン `cachedResponseWillBeUsed`）。**先読みの要求には控えを渡さない。**
 *
 * 先読み（`src/utils/gebcoPrefetch.ts` の `PREFETCH_REQUEST_INIT`）は `referrerPolicy: 'no-referrer'` を付けて投げる。
 * ここで控えを渡さなければ、StaleWhileRevalidate は配信元の応答を待ってそれを返し、同じ応答で控えを書き直す。
 * 配信元へ届かなければ要求ごと失敗するので、先読みの側で失敗に数えられる。
 *
 * **この関数は Service Worker の中へ文字列として書き出される。外の変数・import を参照しないこと。**
 */
export async function offlineBathymetryCachedResponseWillBeUsed({
  request,
  cachedResponse,
}: {
  request: Request
  cachedResponse?: Response
}): Promise<Response | null> {
  if (request.referrerPolicy === 'no-referrer') return null
  return cachedResponse ?? null
}

/**
 * `vite.config.ts` の `runtimeCaching` へ渡す規則。
 *
 * 控えがあればそれを先に返し、裏で配信元（とブラウザの HTTP キャッシュ）へ取りに行って控えを新しい応答で
 * 置き換える。海底地形のタイルは描き替わることがほぼ無い静的な絵なので、1 回ぶん古い絵を出しても
 * 見た目は変わらない。控えが無ければ配信元の応答を待って返す（オフラインなら失敗し、地図はそのタイルを描かない）。
 * 先読みの要求は控えを使わずに配信元の応答を待つ（{@link offlineBathymetryCachedResponseWillBeUsed}）。
 */
export function offlineBathymetryRuntimeCaching(variant: string): RuntimeCaching {
  return {
    urlPattern: offlineBathymetryUrlPattern,
    handler: 'StaleWhileRevalidate',
    options: {
      cacheName: offlineBathymetryCacheName(variant),
      plugins: [
        {
          cacheWillUpdate: offlineBathymetryCacheWillUpdate,
          cachedResponseWillBeUsed: offlineBathymetryCachedResponseWillBeUsed,
        },
      ],
    },
  }
}
