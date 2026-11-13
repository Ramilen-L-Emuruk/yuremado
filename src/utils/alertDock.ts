/**
 * どのタブからでも見える速報・津波の帯（`components/AlertDock`）に載せる値を組む。
 *
 * **値の取り方はカードと同じ関数を通す**（区分は `computeDisplayEEWLevel`、最大予想震度は `eewMaxScaleInfo`、
 * 長周期は `eewMaxLpgmClassInfo`＋`canPresentLpgmClass`、津波の到達は `arrivalConditionBadge`）。別々に引くと、
 * 同じ電文で帯とカードの言うことが割れる。
 *
 * 載せる値と語は 2026-11-09 にユーザーと決めた（docs/spec/architecture-spec.md「どのタブからでも見える速報・津波の帯」）。
 */
import type { EEWAlert, JMATsunami, TsunamiArea, TsunamiObservation } from '../types/earthquake'
import type { SWaveArrival } from '../hooks/useSWaveCountdown'
import type { PlaceNameLookup } from '../i18n/placeNames'
import { eewPrefDisplayName } from '../data/eewPrefectureCodes'
import {
  canPresentLpgmClass,
  compareEewNewestFirst,
  computeDisplayEEWLevel,
  eewAreas,
  eewEventKey,
  eewMaxLpgmClassInfo,
  eewMaxScaleInfo,
  isProvisionalHypocenter,
} from './eew'
import { isEewWarningKindCode } from './eewKind'
import { depthText, magnitudeWithConditionText, formatTime, formatTimeMin, hasMagnitude } from './formatters'
import { getDepthColor, getEewAreaIntensityLabel, getIntensityColor, getMagnitudeColor, intensityLabelWithApproxAbove } from './intensity'
import { getLpgmClassColor, lpgmShortLabel } from './lpgm'
import { readableTextColor } from './contrast'
import { GRADES_IN_CARD_ORDER, arrivalConditionBadge, arrivalConditionKey, hasForecastHeight, overSuffixedHeight } from './tsunami'
import { getGradeStyle } from './tsunamiGradeStyle'
import { hasKnownEpicenter, haversineKm, pointInRings, type LatLng } from './geo'
import { SUBREGION_NEAREST_KM } from './subregions'
import { log } from './logger'
import type { Messages } from '../i18n/messages'

/** 色を塗った値の札（「6強程度以上」「長周期2」「巨大」）。 */
export interface DockChip { text: string; bg: string; fg: string }

export interface EewDockItem {
  kind: 'eew'
  key: string
  title: string
  /** 見出しの字の色・左の帯と枠の色（速報カードの見出しと枠と同じ） */
  titleColor: string
  accent: string
  /** 運用種別の札（「訓練報」「試験報」）。本物の報では null */
  status: string | null
  chips: DockChip[]
  updated: string | null
  hypocenter: { name: string; magnitude: { text: string; color: string } | null; depth: { text: string; color: string } | null } | null
  /** 警報の都道府県（PC だけ出す）。先頭 3 件と残りの件数 */
  warning: { shown: string[]; rest: number } | null
  /** 登録地点の段。出せないとき（未設定・区域が載らない・到達予測が無い）は null */
  home: { area: string; chip: DockChip | null; shake: string } | null
}

export interface TsunamiDockItem {
  kind: 'tsunami'
  key: string
  title: string
  titleColor: string
  accent: string
  status: string | null
  chip: DockChip | null
  updated: string | null
  /** 観測した最大波（PC だけ出す） */
  observed: { value: string; station: string } | null
  /** 「第１波の到達を確認」の区域（PC だけ出す）。先頭の区域名と残りの件数 */
  firstWave: { first: string; rest: number } | null
  home: { zone: string; grade: DockChip; height: DockChip | null; arrival: { label: string | null; text: string } | null; rest: number } | null
}

const MAX_SHOWN_WARNING_PREFS = 3

/**
 * 登録地点の都道府県コード。県の境界の点内判定で引き、どの県にも入らないときは境界から
 * `SUBREGION_NEAREST_KM` 以内の最寄りの県へ寄せる（区域の引き方 `subRegionNameAt` と同じ決まり）。
 * 地図用に簡略化した境界では、海岸や港のすぐ近くの地点が海の側へ落ちることがあるため。
 */
export function homePrefectureCode(
  lat: number,
  lng: number,
  shapes: Readonly<Record<string, { rings: LatLng[][] } | undefined>>,
  prefectures: readonly { name: string; code: string }[],
): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  for (const p of prefectures) {
    const shape = shapes[p.name]
    if (shape && pointInRings(lat, lng, shape.rings)) return p.code
  }
  let best: string | null = null
  let bestKm = SUBREGION_NEAREST_KM
  for (const p of prefectures) {
    const shape = shapes[p.name]
    if (!shape) continue
    for (const ring of shape.rings) {
      for (const [vLat, vLng] of ring) {
        const d = haversineKm(lat, lng, vLat, vLng)
        if (d <= bestKm) { bestKm = d; best = p.code }
      }
    }
  }
  return best
}

function intensityChip(scale: number, label: string): DockChip {
  const bg = getIntensityColor(scale)
  return { text: label, bg, fg: readableTextColor(bg) }
}

function hm(iso: string | undefined): string | null {
  return iso ? formatTimeMin(iso) : null
}

/** 速報の更新時刻（時分秒）。発表時刻（`issue.time`）を先に、無ければ受けた報の時刻。読めない時刻は `formatTime` が記録する。 */
function eewUpdated(eew: EEWAlert): string | null {
  const iso = eew.issue?.time || eew.time
  return iso ? formatTime(iso) : null
}

/** 同じ中身の警告を 1 回だけ記録する（続報のたびに同じ警告で記録が埋まらないように） */
const warned = new Set<string>()
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return
  if (warned.size >= 200) warned.clear()
  warned.add(key)
  log.warn(message)
}

/**
 * 主要動の到達の語。速報カードの到達の枠と同じ語（「到達済み」・秒数・「到達時間を推定中…」）。
 * 到達予測の出ていない地域は段ごと出さないので null。
 */
function shakeText(arrival: SWaveArrival, key: string, m: Messages): string | null {
  const row = arrival.rows.find(r => r.key === key)
  if (!row || row.noForecast) return null
  if (row.arrived) return m.realtime.arrived
  if (row.etaSec !== null) return m.alertDock.seconds(row.etaSec)
  return m.realtime.countdown.estimating
}

/**
 * 速報の帯の項目。語は `m`（いま出している言語の辞書）から引く。
 * 地名（震央・府県予報区・細分区域）は表示する言語へ訳して載せる（`place`）。突き合わせは訳す前の日本語の名前で行う。
 */
export function buildEewDockItems(eews: readonly EEWAlert[], arrival: SWaveArrival | null, m: Messages, place: PlaceNameLookup): EewDockItem[] {
  const sorted = [...eews].filter(e => !e.cancelled && !e.cancelledAt).sort(compareEewNewestFirst)
  return sorted.map((eew, index) => {
    const level = computeDisplayEEWLevel(eew)
    const title = level === 2 ? m.realtime.eewKind.special : level === 1 ? m.realtime.eewKind.warning : m.realtime.eewKind.forecast
    const titleColor = level === 2 ? '#fca5a5' : level === 1 ? '#f87171' : '#fcd34d'
    const accent = level === 2 ? '#7f1d1d' : level === 1 ? '#b91c1c' : '#d97706'
    const chips: DockChip[] = []
    const { scale, orAbove } = eewMaxScaleInfo(eew)
    if (scale > 0) chips.push(intensityChip(scale, intensityLabelWithApproxAbove(scale, orAbove, m.formats)))
    const { cls, over } = eewMaxLpgmClassInfo(eew)
    if (canPresentLpgmClass(scale, cls)) {
      const bg = getLpgmClassColor(cls)
      const label = lpgmShortLabel(cls, m.formats)
      chips.push({ text: over ? m.formats.approxAbove(label) : label, bg, fg: readableTextColor(bg) })
    }
    const h = eew.earthquake.hypocenter
    const provisional = isProvisionalHypocenter(eew)
    const hypocenter = h.name || hasKnownEpicenter(h.latitude, h.longitude)
      ? {
        name: h.name ? (provisional ? `${place('epi', h.name)}${m.realtime.provisional}` : place('epi', h.name)) : '',
        // 仮定震源要素のときは規模・深さが仮の値なので出さない（速報カードと同じ）
        magnitude: provisional ? null : {
          text: magnitudeWithConditionText(h.magnitude, h.magnitudeCondition, h.magnitudeType, m.formats),
          color: hasMagnitude(h.magnitude) ? getMagnitudeColor(h.magnitude) : '#6b7280',
        },
        depth: provisional ? null : { text: depthText(h.depth, h.depthAtLeast === true, m.formats), color: getDepthColor(h.depth) },
      }
      : null
    const areas = eewAreas(eew)
    const warnPrefs = [...new Set(areas.filter(a => a.pref && isEewWarningKindCode(a.kindCode)).map(a => a.pref))]
    const warning = warnPrefs.length > 0
      ? { shown: warnPrefs.slice(0, MAX_SHOWN_WARNING_PREFS).map(p => eewPrefDisplayName(p, place)), rest: Math.max(0, warnPrefs.length - MAX_SHOWN_WARNING_PREFS) }
      : null
    // 登録地点の段は一番新しい 1 件だけ。震源の段はどの件にも出す（2026-11-10 ユーザー選択「全件 2 行に改める (Recommended)」）。
    // 区域の値は区域名と一緒に出す —— 自前計算（地点の値）を区域名で書くと、地点の値が区域の値として読まれる
    // （→ useSWaveCountdown.ts の source）。
    let home: EewDockItem['home'] = null
    if (index === 0 && arrival && arrival.source === 'telegram' && arrival.areaName) {
      const key = eewEventKey(eew)
      const shake = shakeText(arrival, key, m)
      const area = areas.find(a => a.name === arrival.areaName)
      if (shake && area) {
        home = {
          area: place('area', arrival.areaName),
          chip: area.scaleTo > 0 ? intensityChip(area.scaleTo, getEewAreaIntensityLabel(area.scaleFrom, area.scaleTo, area.scaleToOrAbove === true, m.formats)) : null,
          shake,
        }
      }
    }
    return {
      kind: 'eew' as const,
      key: eewEventKey(eew),
      title, titleColor, accent,
      status: eew.operationStatus ? m.realtime.operation[eew.operationStatus] : null,
      chips,
      updated: eewUpdated(eew),
      hypocenter,
      warning,
      home,
    }
  })
}


function gradeRank(grade: TsunamiArea['grade']): number {
  const i = GRADES_IN_CARD_ORDER.indexOf(grade)
  return i < 0 ? GRADES_IN_CARD_ORDER.length : i
}

function gradeChip(grade: TsunamiArea['grade'], text: string): DockChip {
  const bg = getGradeStyle(grade).cardBorder
  return { text, bg, fg: readableTextColor(bg) }
}

/**
 * 登録地点の区域の到達。時刻があれば「到達予想 23:30」、「ただちに津波来襲と予測」は電文の文を「到達予想」に添える
 * （津波タブの区域の行と同じ）。到達を確認・到達中と推測の区域は、津波タブの札と同じ語（「第1波到達」「到達中」）を名目なしで出す。
 */
function homeArrival(area: TsunamiArea, arrivalHm: string | null, m: Messages): { label: string | null; text: string } | null {
  if (arrivalHm) return { label: m.alertDock.estimatedArrival, text: arrivalHm }
  const condition = area.firstHeight?.condition
  if (condition === 'ただちに津波来襲と予測' || (!condition && area.immediate)) {
    const { labelled, text } = m.alertDock.immediateArrival
    return { label: labelled ? m.alertDock.estimatedArrival : null, text }
  }
  const key = arrivalConditionKey(condition)
  if (key) return { label: null, text: m.tsunami.arrivalCondition[key] }
  // 表に無い語は電文の語のまま出す（津波タブの札と同じ。記録は `arrivalConditionBadge` が残す）
  const badge = arrivalConditionBadge(condition)
  return badge ? { label: null, text: badge } : null
}

/** 観測点のうち、数値の出ている最大波が一番高いもの（「以上」も含めて出す）。 */
function highestObservation(observations: readonly TsunamiObservation[]): TsunamiObservation | null {
  let best: TsunamiObservation | null = null
  for (const o of observations) {
    if (!o.height || !Number.isFinite(o.height.value)) continue
    if (!best || o.height.value > best.height!.value) best = o
  }
  return best
}

/**
 * 津波の帯。取消・解除でない報すべての区域・観測をまとめて組む（区分名は全区域のうち一番重い等級から。更新時刻と運用種別の札だけ最新の報から採る）。
 *
 * @param homePrefCode 登録地点の都道府県コード。未設定・県が引けないときは null（登録地点の段を出さない）
 * @param zonePrefectures 津波予報区の名前 → 海岸線が通る県コード（`src/data/tsunamiZonePrefectures.ts`）
 */
export function buildTsunamiDockItem(
  tsunamis: readonly JMATsunami[],
  homePrefCode: string | null,
  zonePrefectures: Readonly<Record<string, readonly string[]>>,
  m: Messages,
  place: PlaceNameLookup,
): TsunamiDockItem | null {
  const live = tsunamis.filter(t => !t.cancelled && !t.cancelledAt)
  const latest = live[live.length - 1]
  if (!latest) return null
  const areas = live.flatMap(t => t.areas).filter(a => a.grade !== 'Unknown')
  if (areas.length === 0) {
    // 発表中の報があるのに帯が消える経路なので、黙らせない
    warnOnce(`unknown:${latest.id}`, `[帯] 発表中の津波の報（${latest.id}）に等級の読める区域が無いので、帯に出さない`)
    return null
  }
  const top = areas.reduce((a, b) => (gradeRank(b.grade) < gradeRank(a.grade) ? b : a))
  const style = getGradeStyle(top.grade)
  const topHeights = areas.filter(a => a.grade === top.grade && hasForecastHeight(a))
  // 見出しの最大は、一番重い等級の区域の予想の高さのうち一番高いもの（数値に直せない「巨大」「高い」は数値の高さより重く扱う）
  const topHeight = topHeights.reduce<TsunamiArea | null>((best, a) => {
    if (!best) return a
    const av = a.maxHeight?.value, bv = best.maxHeight?.value
    if (av === undefined) return bv === undefined ? best : a
    if (bv === undefined) return best
    return av > bv ? a : best
  }, null)
  // 「第１波の到達を確認」の判定は、津波タブの札と同じ表（`arrivalConditionKey`）を引く
  const firstWaveAreas = areas.filter(a => arrivalConditionKey(a.firstHeight?.condition) === 'firstArrived')
  const observations = live.flatMap(t => t.observations ?? [])
  const obs = highestObservation(observations)

  let home: TsunamiDockItem['home'] = null
  if (homePrefCode) {
    const unknownZones = [...new Set(areas.filter(a => !zonePrefectures[a.name]).map(a => a.name))]
    if (unknownZones.length > 0) {
      warnOnce(`zone:${unknownZones.sort().join('・')}`, `[帯] 海岸線の県を引けない津波予報区があるので、登録地点の段の候補から外す: ${unknownZones.join('・')}`)
    }
    const mine = areas.filter(a => zonePrefectures[a.name]?.includes(homePrefCode))
    if (mine.length > 0) {
      const heaviest = mine.reduce((a, b) => (gradeRank(b.grade) < gradeRank(a.grade) ? b : a))
      const arrivalHm = hm(heaviest.firstHeight?.arrivalTime)
      home = {
        zone: place('tsunamiArea', heaviest.name),
        grade: gradeChip(heaviest.grade, m.tsunami.grade[heaviest.grade]),
        height: hasForecastHeight(heaviest) ? gradeChip(heaviest.grade, m.tsunami.height(heaviest.maxHeight!.description, false)) : null,
        arrival: homeArrival(heaviest, arrivalHm, m),
        rest: new Set(mine.map(a => a.name)).size - 1,
      }
    }
  }

  return {
    kind: 'tsunami',
    key: latest.eventId ?? latest.id,
    title: m.tsunami.grade[top.grade],
    titleColor: style.headerColor,
    accent: style.cardBorder,
    status: latest.operationStatus ? m.realtime.operation[latest.operationStatus] : null,
    chip: topHeight ? gradeChip(top.grade, m.tsunami.height(topHeight.maxHeight!.description, false)) : null,
    updated: hm(latest.time),
    observed: obs ? { value: overSuffixedHeight(obs.height!, m.tsunami), station: place('tsunamiStation', obs.name) } : null,
    firstWave: firstWaveAreas.length > 0 ? { first: place('tsunamiArea', firstWaveAreas[0].name), rest: new Set(firstWaveAreas.map(a => a.name)).size - 1 } : null,
    home,
  }
}
