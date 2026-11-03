import type { JMAQuake, JMATsunami, TsunamiSourceEarthquake } from '../types/earthquake'
import { extractQuakeEventId } from './quakeMerge'
import { sourceEarthquakeTime, tsunamiEventIds } from './tsunami'

/**
 * 津波の原因地震 1 件と、それに当たる地震の識別番号。
 *
 * `eventId` が無いのは「どの番号の地震か決められなかった」とき。そのときは震源を借りず、
 * 地震カードへのリンクも出さず、読み上げの既読を地震の主題と共有しない。
 */
export interface TsunamiSourceLink {
  source: TsunamiSourceEarthquake
  /** 原因地震 `source` に当たる地震の識別番号（`EventID` の番号 1 つ）。決められなければ undefined。 */
  eventId?: string
}

/**
 * 津波の原因地震（`Body/Earthquake`、地震ごとに 1 件）を、`EventID` に並ぶ地震の識別番号と結ぶ。
 * **原因地震と地震カードの対応はここだけで決める**（震源の借用・バナーの「▶ 地震情報」・読み上げの既読が
 * 同じ答えを使う。共有カードは結びを使わず原因地震を全件並べる）。
 *
 * **どの `Earthquake` 要素がどの番号に当たるかは電文仕様に書かれていない**（電文解説資料 Ⅱ.11-6 は
 * 「地震毎に本要素を記載」とだけ言う）。また番号そのものは発生時刻などの物理的な意味を持たない
 * （同 Ⅰ.別02-2）ので、番号から時刻を読んで結ぶこともできない。そこで次の 2 段で結ぶ
 * （2026-10-15 ユーザー承認「発現時刻で結ぶ（推奨）」）。
 *
 * 1. **番号も原因地震も 1 つずつなら、その組がそのまま対応する**（いまの形。切替えの起きていない津波）
 * 2. それ以外は、**原因地震の発現時刻（分）と、番号が一致する地震カードの時刻を突き合わせる**。
 *    地震カードの時刻は発現時刻で、震度速報も地震の検知時刻（同じ分）を持つ（→ `dmdataParser.ts` の
 *    `earthquakeTime`・`sourceEarthquakeTime`）。**1 対 1 に決まるときだけ結ぶ** —— 同じ分に 2 つの地震が
 *    あると取り違えうるので、そのときは結ばない（誤った震源を出すより、出さないほうが軽い）
 *
 * @param quakes 地震カード（取消表示中のものは結ぶ相手にしない）。2 段目でしか見ない
 */
export function linkTsunamiSources(
  tsunami: Pick<JMATsunami, 'eventId' | 'foldedReports' | 'sourceEarthquakes'>,
  quakes: readonly JMAQuake[],
): TsunamiSourceLink[] {
  const sources = tsunami.sourceEarthquakes ?? []
  if (sources.length === 0) return []
  const ids = tsunamiEventIds(tsunami)
  // 最新の報の番号だけで 1 対 1 を見る（組み立てに使った報の番号まで数えると、番号が入れ替わった
  // 津波で「番号が 2 つ」に見えて 1 段目を外れる）。
  const latestIds = (tsunami.eventId ?? '').split(/\s+/).filter(Boolean)
  if (latestIds.length === 1 && sources.length === 1) return [{ source: sources[0], eventId: latestIds[0] }]

  const idSet = new Set(ids)
  const candidates = quakes.filter(q => !q.cancelledAt)
  const matched = sources.map(source => {
    const minute = minuteOf(sourceEarthquakeTime(source))
    if (minute === null) return [] as string[]
    const hit = new Set<string>()
    for (const q of candidates) {
      const id = extractQuakeEventId(q)
      if (!id || !idSet.has(id)) continue
      if (minuteOf(q.earthquake.time) === minute) hit.add(id)
    }
    return [...hit]
  })
  // 1 対 1 を確かめる: 1 つの原因地震に番号が 1 つだけ当たり、その番号が他の原因地震にも当たらない。
  const useCount = new Map<string, number>()
  for (const ids of matched) for (const id of ids) useCount.set(id, (useCount.get(id) ?? 0) + 1)
  return sources.map((source, i) => {
    const hit = matched[i]
    const eventId = hit.length === 1 && useCount.get(hit[0]) === 1 ? hit[0] : undefined
    return eventId ? { source, eventId } : { source }
  })
}

/** 時刻を分の通し番号へ落とす（電文の発現時刻は分単位で、秒は 00）。読めなければ null。 */
function minuteOf(iso: string | undefined): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? Math.floor(ms / 60_000) : null
}

/**
 * 津波の原因地震を、**結べた地震カードの上段の値**で表したもの（2026-11-03 ユーザー選択「結べた地震カードの値 (Recommended)」）。
 * 上段は同じ地震の報（地震情報・長周期・推計・津波）のうち発表が最も新しい値なので（→ `latestQuakeFacts.ts`）、
 * 津波カードの原因地震の行・読み上げ・地図の×印・共有カードがこれを通すと、地震カードと同じ値になる。
 * 全期間で、津波の原因地震を持つ 71 地震のうち 27 地震で、津波電文の値がその地震の地震情報の最終報と違う。
 *
 * 結べなければ（`card` が無い・取り消されたカード・震源名を持たない震度速報のカード）津波電文の値のまま返す。
 *
 * **カードが値を持たない欄は電文の値を残す**（欄ごとに「カードに有効な値があればカード、無ければ電文」）。カードが
 * 「判らない」と言っているだけで電文の値を捨てると、電文にしか無い値（遠地地震の深さ・震源決定機関など）が画面と声から
 * 黙って落ちる（→ CLAUDE.md「電文の情報をすべてそのまま伝える」）。組で意味を持つ欄は組で扱う —— 座標は緯度経度の両方、
 * 規模は値と種別（カードが説明「Ｍ不明」等を持つならそれ）、震央補助表現はその文と材料（`markCode` ほか）。
 */
export function shownTsunamiSource(source: TsunamiSourceEarthquake, card: JMAQuake | undefined): TsunamiSourceEarthquake {
  if (!card || card.cancelledAt || card.cancelled) return source
  const h = card.earthquake.hypocenter
  if (!h.name) return source
  const shown: TsunamiSourceEarthquake = { ...source, hypocenterName: h.name }
  // 上段の時刻は地震カードの時刻（発現時刻）。津波の行は `sourceEarthquakeTime`（発現時刻を先に採る）で読む
  if (card.earthquake.time) shown.arrivalTime = card.earthquake.time
  if (h.code) { shown.code = h.code; if (h.detailedCode) shown.detailedCode = h.detailedCode; else delete shown.detailedCode }
  if (Number.isFinite(h.latitude) && Number.isFinite(h.longitude)) { shown.latitude = h.latitude; shown.longitude = h.longitude }
  if (Number.isFinite(h.magnitude) && h.magnitude >= 0) {
    shown.magnitude = h.magnitude
    if (h.magnitudeType) shown.magnitudeType = h.magnitudeType; else delete shown.magnitudeType
    delete shown.magnitudeCondition
  } else if (h.magnitudeCondition) {
    // カードが規模を「Ｍ不明」「Ｍ８を超える巨大地震」と言っているなら、それが上段の値
    shown.magnitudeCondition = h.magnitudeCondition
    delete shown.magnitude
    delete shown.magnitudeType
  }
  if (Number.isFinite(h.depth) && h.depth >= 0) {
    shown.depth = h.depth
    if (h.depthAtLeast) shown.depthAtLeast = true; else delete shown.depthAtLeast
  }
  if (h.nameFromMark) {
    shown.nameFromMark = h.nameFromMark
    for (const k of ['markCode', 'direction', 'distanceKm'] as const) delete shown[k]
    if (h.markCode) shown.markCode = h.markCode
    if (h.direction) shown.direction = h.direction
    if (h.distanceKm !== undefined) shown.distanceKm = h.distanceKm
  }
  // 震源決定機関は「誰が決めた震源か」なので、震源の値と組にする。カードが震源の位置か規模を決めているなら、
  // 機関もカードの側に従う（カードが持たなければ出さない）。電文の「ＰＴＷＣ」を気象庁が決めた値の横に残すと、
  // 誰の値かを取り違えさせる。カードがどちらも持たないときだけ、電文の機関を値と一緒に残す
  const cardDecided = (Number.isFinite(h.latitude) && Number.isFinite(h.longitude)) || (Number.isFinite(h.magnitude) && h.magnitude >= 0)
  if (h.source) shown.source = h.source
  else if (cardDecided) delete shown.source
  return shown
}

/**
 * 津波の原因地震を、それぞれ結べた地震カードの上段の値で表して並べる（電文の順のまま。→ {@link shownTsunamiSource}）。
 * 結べなかった原因地震は電文の値のまま。
 */
export function shownTsunamiSources(
  tsunami: Pick<JMATsunami, 'eventId' | 'foldedReports' | 'sourceEarthquakes'>,
  quakes: readonly JMAQuake[],
): TsunamiSourceEarthquake[] {
  return linkTsunamiSources(tsunami, quakes).map(link => shownTsunamiSource(
    link.source,
    link.eventId ? quakes.find(q => extractQuakeEventId(q) === link.eventId && !q.cancelledAt) : undefined,
  ))
}
