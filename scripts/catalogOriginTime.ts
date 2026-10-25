// 予報の発表状況（fc_hist）は発生時刻を分までしか書かないので、秒を長期震源カタログ
// （public/data/hypocenter/<年>.json。気象庁の震源カタログを年ごとに詰めたもの）から補う。
//
// 発生時刻は予報円の半径を決める。分のまま（秒を 0）にすると、最大 59 秒ぶん早い時刻から
// 波が広がった絵になる —— S 波でおよそ 200 km 先へ出る。
//
// **fc_hist の震源要素の表は、緊急地震速報の最終報の値**で、震源カタログ（地震情報の確定値）と
// 一致しない（2016-04-16 01:25 の地震は表が M7.1、カタログが M7.3）。そのため幅を持たせて照合する。
// 手掛かりは EventID（ページのディレクトリ名）—— 緊急地震速報の EventID はたいてい発生時刻の
// 数秒後になる（同じ地震で 01:25:05.4 発生・EventID 01:25:10）。**ただし発生時刻より前になる地震もある**
// （警報の発表状況が秒まで書く熊本・鳥取の 18 地震で、確定の発生時刻が EventID の 7.2 秒後・25 秒後のものがあった）。
//
// - 時刻: EventID の 60 秒前から 30 秒後まで、かつ表の分の 10 秒前から 70 秒後まで
// - 位置: 緯度・経度とも 0.3 度以内
// - M: 1.0 以内（M の決まっていない地震は M では絞らない）
//
// 候補が 2 つ以上あれば、EventID の時刻にいちばん近い地震を採る（余震の続く時期は、同じ場所で
// 1 分以内に 2 つ起きることが珍しくない）。**M が決まっていない候補は、M が合う候補があれば後回しにする**
// （M で絞れていないぶん、別の小さな地震である見込みが高い）。候補が複数あったことは呼び出し側が記録する。1 つも無ければ補わない（呼び出し側が EventID の時刻で代える）。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface CatalogYear {
  timeMs: number[]
  lat: number[]
  lng: number[]
  /** M が決まっていない地震は NaN */
  magnitude: number[]
}

/** 緯度・経度の許容差（度） */
export const POSITION_TOLERANCE_DEG = 0.3
/** M の許容差 */
export const MAGNITUDE_TOLERANCE = 1.0
/** EventID の何ミリ秒前から探すか */
export const EVENT_ID_LEAD_MS = 60_000
/** EventID の何ミリ秒後まで探すか（確定した発生時刻が EventID より後になる地震がある。実測で最大 25 秒） */
export const EVENT_ID_LAG_MS = 30_000
/** 表の分の何ミリ秒前から探すか */
export const MINUTE_LEAD_MS = 10_000
/** 表の分の何ミリ秒後まで探すか（分の終わり 60 秒に、ずれの幅 10 秒を足す） */
export const MINUTE_LAG_MS = 70_000

interface RawYear {
  count: number
  startMs: number
  coordScale: number
  magScale: number
  timeScale: number
  t: number[]
  lat: number[]
  lng: number[]
  mag: (number | null)[]
}

/** 年ファイルを読む。列の長さ・刻みが崩れていれば例外（黙って別の地震の値を組み合わせない）。 */
export async function loadCatalogYear(root: string, year: number): Promise<CatalogYear> {
  const raw = JSON.parse(await readFile(join(root, 'public', 'data', 'hypocenter', `${year}.json`), 'utf-8')) as RawYear
  for (const key of ['t', 'lat', 'lng', 'mag'] as const) {
    if (!Array.isArray(raw[key]) || raw[key].length !== raw.count) throw new Error(`震源カタログ ${year}: ${key} の長さが count と一致しません`)
  }
  for (const key of ['startMs', 'coordScale', 'magScale', 'timeScale'] as const) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || (key !== 'startMs' && raw[key] <= 0)) {
      throw new Error(`震源カタログ ${year}: ${key} が不正です`)
    }
  }
  return {
    timeMs: raw.t.map((t) => raw.startMs + (t * 1000) / raw.timeScale),
    lat: raw.lat.map((v) => v / raw.coordScale),
    lng: raw.lng.map((v) => v / raw.coordScale),
    magnitude: raw.mag.map((m) => (m === null ? NaN : m / raw.magScale)),
  }
}

export interface OriginQuery {
  /** EventID の時刻（UTC ISO） */
  eventIdIso: string
  /** 表の分までの発生時刻（秒は 0）。UTC ISO */
  minuteIso: string
  latitude: number | null
  longitude: number | null
  magnitude: number | null
}

export type OriginMatch =
  | { kind: 'matched'; originTimeIso: string; candidates: number }
  | { kind: 'none' }

/** EventID・分までの発生時刻・震源から、カタログの秒まである発生時刻を引き当てる。 */
export function matchCatalogOrigin(q: OriginQuery, catalog: CatalogYear): OriginMatch {
  const eventIdMs = new Date(q.eventIdIso).getTime()
  const minute = new Date(q.minuteIso).getTime()
  if (Number.isNaN(eventIdMs)) throw new Error(`EventID の時刻を日時として読めません: ${q.eventIdIso}`)
  if (Number.isNaN(minute)) throw new Error(`発生時刻を日時として読めません: ${q.minuteIso}`)
  if (q.latitude === null || q.longitude === null) return { kind: 'none' }
  const from = Math.max(eventIdMs - EVENT_ID_LEAD_MS, minute - MINUTE_LEAD_MS)
  const to = Math.min(eventIdMs + EVENT_ID_LAG_MS, minute + MINUTE_LAG_MS)
  /** M が合う候補（表の M が無いときは、絞れないのですべてここへ入れる） */
  const magnitudeMatched: number[] = []
  /** M が決まっていない候補 */
  const magnitudeUnknown: number[] = []
  for (let i = 0; i < catalog.timeMs.length; i++) {
    const t = catalog.timeMs[i]
    if (t < from || t > to) continue
    if (Math.abs(catalog.lat[i] - q.latitude) > POSITION_TOLERANCE_DEG) continue
    if (Math.abs(catalog.lng[i] - q.longitude) > POSITION_TOLERANCE_DEG) continue
    const m = catalog.magnitude[i]
    if (q.magnitude === null) magnitudeMatched.push(i)
    else if (Number.isNaN(m)) magnitudeUnknown.push(i)
    else if (Math.abs(m - q.magnitude) <= MAGNITUDE_TOLERANCE) magnitudeMatched.push(i)
  }
  const pool = magnitudeMatched.length > 0 ? magnitudeMatched : magnitudeUnknown
  if (pool.length === 0) return { kind: 'none' }
  const best = pool.reduce((a, b) => (Math.abs(catalog.timeMs[b] - eventIdMs) < Math.abs(catalog.timeMs[a] - eventIdMs) ? b : a))
  return {
    kind: 'matched',
    originTimeIso: new Date(catalog.timeMs[best]).toISOString(),
    candidates: magnitudeMatched.length + magnitudeUnknown.length,
  }
}
