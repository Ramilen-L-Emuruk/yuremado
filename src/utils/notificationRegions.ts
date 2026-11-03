import { EEW_PREFECTURE_CODES } from '../data/eewPrefectureCodes'
import { PREFECTURES } from '../data/prefectureCodes'
import { TSUNAMI_ZONE_PREFECTURES } from '../data/tsunamiZonePrefectures'
import type { EEWAlert, JMAEstimatedIntensity, JMAQuake, JMATsunami } from '../types/earthquake'
import { eewAreas } from './eew'
import { isSameEstimatedIntensityQuake } from './estimatedIntensity'
import { log } from './logger'

/**
 * 通知が関わる都道府県（2 桁のコード）を報から読む。設定「通知する地域」で通知を絞るのに使う
 * （`notificationRegionAllowed`。docs/relay-server-design.md §6.7）。**読めなければ `null`**（絞らない）——
 * 空の並びを返すと、地域を選んだ人に届かなくなる。
 *
 * **読めない名前が 1 つでも混じれば、全体を `null` にする。** 読めた県だけで判定すると、読めなかった方に選んだ県が
 * あったときにその報を落とす。読めなかった名前は記録に残す（表の更新漏れに気づくため）。
 */

const PREFECTURE_CODE_OF_NAME = new Map(PREFECTURES.map(p => [p.name, p.code]))

/** 読めなかった名前の組を、同じ組では 1 回だけ記録する（続報のたびに同じ警告で記録が埋まらないように） */
const warnedUnknown = new Set<string>()
function warnUnknown(kind: string, names: readonly string[]): void {
  const key = `${kind}:${[...new Set(names)].sort().join('・')}`
  if (warnedUnknown.has(key)) return
  if (warnedUnknown.size >= 200) warnedUnknown.clear()
  warnedUnknown.add(key)
  log.warn(`[通知] ${kind}の都道府県を読めない名前があるので、地域で絞らない: ${[...new Set(names)].join('・')}`)
}

function codesOf(kind: string, names: Iterable<string>, table: ReadonlyMap<string, string>): string[] | null {
  const out = new Set<string>()
  const unknown: string[] = []
  for (const raw of names) {
    const n = raw.trim()
    const c = table.get(n)
    if (c) out.add(c)
    else unknown.push(n)
  }
  if (unknown.length > 0) {
    warnUnknown(kind, unknown)
    return null
  }
  return out.size > 0 ? [...out].sort() : null
}

/** 地震情報: 震度を観測した都道府県（電文の都道府県の行。区域・観測点の行は pref を持たない） */
export function quakePrefectures(quake: Pick<JMAQuake, 'points'>): string[] | null {
  return codesOf('地震情報', quake.points.filter(p => p.pref !== '').map(p => p.pref), PREFECTURE_CODE_OF_NAME)
}

/**
 * 推計震度分布図: 元の地震の、震度を観測した都道府県（2026-11-03 ユーザー選択「推計震度は元の地震で絞る」）。
 * 元の地震は、地震カードのうち同じ地震と判定できるもの（{@link isSameEstimatedIntensityQuake}。一覧を地震ごとに 1 通へ保つ物差しと同じ）。
 * **当てはまるカードが 1 枚に決まらなければ絞らない**（同じ分の別の地震の県で落とさないため）
 */
export function estimatedIntensityPrefectures(
  ei: Pick<JMAEstimatedIntensity, 'arrivalTime' | 'hypocenter'>,
  quakes: readonly JMAQuake[],
): string[] | null {
  const hits = quakes.filter(q => !q.cancelledAt && isSameEstimatedIntensityQuake({
    arrivalTime: q.earthquake.time,
    hypocenter: { lat: q.earthquake.hypocenter.latitude, lon: q.earthquake.hypocenter.longitude, depthKm: Number.NaN },
  }, ei))
  return hits.length === 1 ? quakePrefectures(hits[0]) : null
}

/** 緊急地震速報: 予想の対象の地域の都道府県（府県予報区の名前から引く。→ `data/eewPrefectureCodes.ts`） */
export function eewPrefectures(eew: EEWAlert): string[] | null {
  return codesOf('緊急地震速報', eewAreas(eew).map(a => a.pref).filter(p => p !== ''), EEW_PREFECTURE_CODES)
}

/** 津波: 予報区が面する都道府県（生成物 `src/data/tsunamiZonePrefectures.ts`。解除・取消の区域も含める） */
export function tsunamiPrefectures(tsunami: Pick<JMATsunami, 'areas' | 'cancelledAreas'>): string[] | null {
  const out = new Set<string>()
  const unknown: string[] = []
  for (const a of [...tsunami.areas, ...(tsunami.cancelledAreas ?? [])]) {
    const codes = TSUNAMI_ZONE_PREFECTURES[a.name]
    if (codes) for (const c of codes) out.add(c)
    else unknown.push(a.name)
  }
  if (unknown.length > 0) {
    warnUnknown('津波の予報区', unknown)
    return null
  }
  return out.size > 0 ? [...out].sort() : null
}
