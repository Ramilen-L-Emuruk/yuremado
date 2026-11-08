import { fetchJsonWithTimeout } from './fetchJson'
import type { TsunamiObsCoords } from './tsunamiObsCoords'
import type { Wepa60StationMatch } from './wepa60Translate'

/** 国際津波関連情報の震央の地域名（英語・大文字）→ 気象庁の詳細震央地名。生成は `scripts/build-wepa60-region-names.mjs` */
export type Wepa60RegionNames = Readonly<Record<string, string>>

const DATA_URL = `${import.meta.env.BASE_URL}data/wepa60-region-names.json`

let cache: Wepa60RegionNames | null = null
let inflight: Promise<Wepa60RegionNames> | null = null

/** 取得済みの地域名の表（まだなら null）。欄を開き直したときに、最初の描画から訳を出すため */
export function getCachedWepa60RegionNames(): Wepa60RegionNames | null {
  return cache
}

/** 地域名の表を取得する。英文の欄を開いたときだけ読み、初回のみ fetch する。失敗したら次回また取りに行く */
export function loadWepa60RegionNames(): Promise<Wepa60RegionNames> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetchJsonWithTimeout<Wepa60RegionNames>(DATA_URL, 'wepa60-region-names', {
      // 地図の見た目に関わらないので、地図に重ねる取得状況には数えない（取り直しもしない）
      trackStatus: false,
      // 200 でも中身が空・別物なら失敗にする（空の表で訳すと、震央の地名がすべて未訳になる）
      validate: (data) => {
        if (data == null || typeof data !== 'object' || Array.isArray(data)) throw new Error('震央の地名の表が JSON オブジェクトではありません')
        const entries = Object.entries(data as Record<string, unknown>)
        if (entries.length === 0 || entries.some(([, v]) => typeof v !== 'string')) throw new Error('震央の地名の表の中身が空か、値が文字列ではありません')
      },
    })
      .then((data) => {
        cache = data
        return data
      })
      .catch((err) => {
        inflight = null
        throw err
      })
  }
  return inflight
}

/**
 * 英文の観測の表の地点（日本の観測点）を、気象庁の津波観測点名へ座標で引く。10km より遠ければ引かない。
 * 電文の座標は 0.1 度刻み（最大約 8km ずれる）なので、10km 以内に候補が 2 つ以上あれば `ambiguous` を立てる
 */
export function nearestTsunamiStation(coords: TsunamiObsCoords, lat: number, lon: number, maxKm = 10): Wepa60StationMatch | undefined {
  let best: string | undefined
  let bestKm = Infinity
  let within = 0
  const kx = Math.cos(lat * Math.PI / 180) * 111
  for (const [name, [a, b]] of Object.entries(coords)) {
    const km = Math.hypot((a - lat) * 111, (b - lon) * kx)
    if (km > maxKm) continue
    within++
    if (km < bestKm) { best = name; bestKm = km }
  }
  return best === undefined ? undefined : { name: best, ambiguous: within >= 2 }
}
