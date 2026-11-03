import type { Hypocenter, JMAEstimatedIntensity, JMALpgm, JMAQuake } from '../types/earthquake'
import { compareReportAge, extractQuakeEventId, withoutLatestQuakeFacts } from './quakeMerge'
import { matchEstimatedIntensity } from './estimatedIntensity'
import { haversineKm, hasKnownEpicenter } from './geo'

/**
 * 同じ地震について届いた報（地震情報・長周期地震動観測情報・推計震度分布図）のうち、**発表が最も新しい報の値を
 * 地震カードの上段（震源・規模・深さ・地震発現時刻・座標・全国の最大震度）へ当てる**
 * （2026-11-03 ユーザー選択「発表時刻が最も新しい報 (Recommended)」「一覧を渡す手前でまとめる (Recommended)」
 * 「長周期と同じくカード本体へまとめる (Recommended)」。→ docs/quake-tab-redesign.md の決まっていること）。
 *
 * **地震情報どうしは、続報を当てる統合（`mergeQuakeInto`）が同じ考え方で既に新しい報の値を出している。** ここで足すのは、
 * 地震情報でない 2 種類の報の値。全期間の控え（2020-11〜2026-10）では、どちらも直前の地震情報と同じ値を運んでいた
 * （推計の座標だけ 0.01 度まで細かい）。それでも当てるのは、電文の値を画面から落とさないため（CLAUDE.md「アプリの基本理念」）。
 *
 * **長周期・推計の入れ物（`lpgmByEventId`・`estimatedIntensities`）は残す。** 長周期の欄と震度分布の表示はそちらを読む。
 *
 * **取消表示中のカードは触らない。** 気象庁が取り下げた内容へ新しい値を書き込むことになる（津波から借りる処理と同じ向き）。
 *
 * **当てたら、津波から借りた印（`hypocenterSource`）を外す。** 上段は津波の値ではなくなるので、残すと出どころが津波と出るうえ、
 * 津波の続報のたびに借り直しの対象になり、当てた値が津波の値へ戻る（→ `borrowHypocenterFromTsunami`）。
 *
 * **組み立ては毎回、地震情報が運んだ値（`quakeInfoFacts`）から行う。** 当てた報が取り消されて当てる報が無くなれば、
 * 上段は地震情報の値へ戻る（2026-11-03 ユーザー選択「戻す (Recommended)」）。
 *
 * 何も変わらなければ**元の参照を返す**（呼び出し側が `===` で「変わったか」を判定し、無駄な再描画を起こさない）。
 */
export function withLatestQuakeFacts(
  card: JMAQuake,
  lpgmByEventId: ReadonlyMap<string, JMALpgm>,
  estimatedIntensities: readonly JMAEstimatedIntensity[],
): JMAQuake {
  return withLatestQuakeFactsBy(card, lpgmByEventId, estimatedIntensities)
}

function withLatestQuakeFactsBy(
  card: JMAQuake,
  lpgmByEventId: ReadonlyMap<string, JMALpgm>,
  estimatedCandidates: readonly JMAEstimatedIntensity[],
): JMAQuake {
  if (card.cancelledAt || card.cancelled) return card
  const base = withoutLatestQuakeFacts(card)
  const newer = newestOtherReport(base, lpgmByEventId, estimatedCandidates)
  // 当てる報が無い（当てていた報が取り消された）なら、地震情報の値へ戻ったカード
  if (!newer) return base
  const earthquake = newer.kind === 'lpgm' ? factsFromLpgm(base, newer.lpgm) : factsFromEstimated(base, newer.ei)
  if (sameFacts(base.earthquake, earthquake)) return base
  if (card.quakeInfoFacts && sameFacts(card.earthquake, earthquake)) return card
  const { hypocenterSource: _borrowed, ...rest } = base
  return {
    ...rest,
    earthquake,
    quakeInfoFacts: {
      hypocenter: base.earthquake.hypocenter,
      time: base.earthquake.time,
      maxScale: base.earthquake.maxScale,
      ...(base.hypocenterSource && { hypocenterSource: base.hypocenterSource }),
    },
  }
}

/** 一覧の全カードへ {@link withLatestQuakeFacts} を当てる。1 枚も変わらなければ元の配列参照を返す。 */
export function latestQuakeFactsIntoCards(
  cards: readonly JMAQuake[],
  lpgmByEventId: ReadonlyMap<string, JMALpgm>,
  estimatedIntensities: readonly JMAEstimatedIntensity[],
): JMAQuake[] {
  // 推計は発現時刻の分で引くので、先に分ごとへ分けておく。カードごとに一覧を総当たりすると、
  // 日時の読み直しが「カード × 推計」回になる（履歴の組み直しのたびに全カードを回すため）
  const byMinute = new Map<number, JMAEstimatedIntensity[]>()
  for (const ei of estimatedIntensities) {
    const m = minuteOf(ei.arrivalTime)
    if (m === null) continue
    const bucket = byMinute.get(m)
    if (bucket) bucket.push(ei)
    else byMinute.set(m, [ei])
  }
  let changed = false
  const next = cards.map(card => {
    // 分は地震情報の発現時刻で引く（当てた長周期の時刻が分をまたいでいても、推計の引き当ては地震情報の値で行う）
    const m = minuteOf(card.quakeInfoFacts?.time ?? card.earthquake.time)
    const candidates = (m !== null && byMinute.get(m)) || []
    const applied = withLatestQuakeFactsBy(card, lpgmByEventId, candidates)
    if (applied !== card) changed = true
    return applied
  })
  return changed ? next : (cards as JMAQuake[])
}

function minuteOf(iso: string): number | null {
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? Math.floor(t / 60000) : null
}

/**
 * 推計の値を上段へ当ててよいほど、その推計がこの地震のものと言えるか。
 *
 * **震度分布の表示の引き当て（`matchEstimatedIntensity`）より厳しくする。** あちらは発現時刻の分と 300 km 以内で結ぶので、
 * 同じ分に起きた別の地震（本震の直後の余震など）の分布を取り違えうる。取り違えたまま当てると、震央地名はこの地震のまま
 * 座標・深さ・規模だけが別の地震になり、誤った事実を出す。全期間の控えでは推計の値は直前の地震情報と同じで、
 * 違いは座標の桁（0.01 度と 0.1 度）だけだった（→ quake-spec.md）。そこで次の両方を満たすときだけ当てる。
 *
 * - 震央が両方読めて、{@link ESTIMATED_APPLY_MAX_KM} 以内
 * - 規模が両方数値なら、差が {@link ESTIMATED_APPLY_MAX_DM} 以内
 */
const ESTIMATED_APPLY_MAX_KM = 30
const ESTIMATED_APPLY_MAX_DM = 0.5

function estimatedFitsCard(card: JMAQuake, ei: JMAEstimatedIntensity): boolean {
  const { latitude, longitude, magnitude } = card.earthquake.hypocenter
  if (!hasKnownEpicenter(latitude, longitude) || !hasKnownEpicenter(ei.hypocenter.lat, ei.hypocenter.lon)) return false
  if (haversineKm(latitude, longitude, ei.hypocenter.lat, ei.hypocenter.lon) > ESTIMATED_APPLY_MAX_KM) return false
  if (Number.isFinite(magnitude) && Number.isFinite(ei.magnitude) && Math.abs(magnitude - ei.magnitude) > ESTIMATED_APPLY_MAX_DM) return false
  return true
}

/** 当ててよい推計のうち、発表が最も新しいもの。 */
function estimatedToApply(card: JMAQuake, candidates: readonly JMAEstimatedIntensity[]): JMAEstimatedIntensity | null {
  let found: JMAEstimatedIntensity | null = null
  for (const ei of candidates) {
    if (!matchEstimatedIntensity(card, ei) || !estimatedFitsCard(card, ei)) continue
    if (found === null || ei.time > found.time) found = ei
  }
  return found
}

type OtherReport = { kind: 'lpgm'; lpgm: JMALpgm } | { kind: 'estimated'; ei: JMAEstimatedIntensity }

/**
 * カードの報（地震情報）より発表が新しい長周期・推計のうち、最も新しいもの。無ければ `null`。
 *
 * 新旧は {@link compareReportAge}（作成時刻が両方にあれば秒まで、無ければ発表時刻）で比べる。**同じ分で前後が
 * 決まらない（0）ときは地震情報を採る** —— どちらが新しいか言えない値でカードを書き換えない。
 */
function newestOtherReport(
  card: JMAQuake,
  lpgmByEventId: ReadonlyMap<string, JMALpgm>,
  estimatedIntensities: readonly JMAEstimatedIntensity[],
): OtherReport | null {
  let best: { report: OtherReport; age: { time: string; createdAtMs?: number } } | null = null
  const consider = (report: OtherReport, age: { time: string; createdAtMs?: number }) => {
    if (compareReportAge(age, card) <= 0) return
    if (best && compareReportAge(age, best.age) <= 0) return
    best = { report, age }
  }
  const eventId = extractQuakeEventId(card)
  const lpgm = eventId ? lpgmByEventId.get(eventId) : undefined
  // 震源を持たない長周期（取消・震源の要素が読めなかった報）は当てる値が無い
  if (lpgm && !lpgm.cancelled && lpgm.hypocenter?.name) {
    consider({ kind: 'lpgm', lpgm }, { time: lpgm.time, ...(lpgm.createdAtMs !== undefined && { createdAtMs: lpgm.createdAtMs }) })
  }
  const ei = estimatedToApply(card, estimatedIntensities)
  if (ei) consider({ kind: 'estimated', ei }, { time: ei.time })
  return (best as { report: OtherReport } | null)?.report ?? null
}

/**
 * 長周期の報が運ぶ値を、カードの上段の形へ写す。**電文に無い欄はカードの値のまま**（長周期は津波区分を持たない）。
 *
 * 震央地名に添う欄（詳細の番号・震央補助表現・その番号・方位・距離）は、**震央地名が同じなら、長周期に無い欄を地震情報の
 * 値で残す**。地名が変わったら長周期の値だけを使う —— 前の地名に添えた補助表現を新しい地名へ付けない。深さの「以上」も、
 * 長周期が深さを持つときだけ長周期の値にする。
 *
 * - 地震発現時刻は `arrivalTime`（地震情報の `earthquake.time` と同じ意味の時刻）。無ければカードのまま
 * - 全国の最大震度は `maxInt`。無ければカードのまま
 * - 規模が数値で求まらない報は `NaN` と説明（`magnitudeCondition`）を写す（地震情報のパーサーと同じ番兵）
 */
function factsFromLpgm(card: JMAQuake, lpgm: JMALpgm): JMAQuake['earthquake'] {
  const h = lpgm.hypocenter!
  const base = card.earthquake.hypocenter
  const sameName = h.name === base.name
  const aux = <K extends 'detailedCode' | 'nameFromMark' | 'markCode' | 'direction' | 'distanceKm'>(k: K) =>
    h[k] ?? (sameName ? base[k] : undefined)
  const hypocenter: Hypocenter = {
    ...base,
    name: h.name,
    latitude: h.latitude ?? base.latitude,
    longitude: h.longitude ?? base.longitude,
    depth: h.depth ?? base.depth,
    depthAtLeast: h.depth !== undefined ? h.depthAtLeast : base.depthAtLeast,
    magnitude: lpgm.magnitude ?? (lpgm.magnitudeCondition ? Number.NaN : base.magnitude),
    magnitudeCondition: lpgm.magnitudeCondition,
    magnitudeType: lpgm.magnitudeType ?? base.magnitudeType,
    code: h.code ?? base.code,
    detailedCode: aux('detailedCode'),
    nameFromMark: aux('nameFromMark'),
    markCode: aux('markCode'),
    direction: aux('direction'),
    distanceKm: aux('distanceKm'),
    ...(h.source !== undefined && { source: h.source }),
  }
  return {
    ...card.earthquake,
    hypocenter: dropUndefined(hypocenter),
    ...(lpgm.arrivalTime && { time: lpgm.arrivalTime }),
    ...(lpgm.maxInt !== undefined && { maxScale: lpgm.maxInt }),
  }
}

/**
 * 推計震度分布図が運ぶ値（座標・深さ・規模）を写す。**震央地名は地震情報のまま** —— 推計は地名の番号（`areaCode`）しか
 * 持たず、番号から名前を引く表がアプリに無い（2026-11-03 ユーザー選択「長周期と同じくカード本体へまとめる」の説明）。
 * 地名と食い違いうる震央補助表現・その番号も地震情報のまま残す（推計の `mark` は位置の番号で、文を持たない）。
 */
function factsFromEstimated(card: JMAQuake, ei: JMAEstimatedIntensity): JMAQuake['earthquake'] {
  const base = card.earthquake.hypocenter
  const hypocenter: Hypocenter = {
    ...base,
    latitude: ei.hypocenter.lat,
    longitude: ei.hypocenter.lon,
    depth: ei.hypocenter.depthKm,
    // 規模が数値で求まらない報は番兵（`NaN`）と説明を写す。説明も無い `NaN` は読めなかっただけなので、地震情報の値を残す
    magnitude: Number.isFinite(ei.magnitude) || ei.magnitudeCondition ? ei.magnitude : base.magnitude,
    magnitudeCondition: Number.isFinite(ei.magnitude) || ei.magnitudeCondition ? ei.magnitudeCondition : base.magnitudeCondition,
  }
  return { ...card.earthquake, hypocenter: dropUndefined(hypocenter) }
}

/** 値が `undefined` の欄を落とす（無い欄を `undefined` で持つと、比べるときに「欄がある」と読める）。 */
function dropUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

/** 上段の値が同じか。規模は `NaN` を取りうるので `Object.is` で比べる。 */
function sameFacts(a: JMAQuake['earthquake'], b: JMAQuake['earthquake']): boolean {
  if (a.time !== b.time || a.maxScale !== b.maxScale) return false
  const x = a.hypocenter as unknown as Record<string, unknown>
  const y = b.hypocenter as unknown as Record<string, unknown>
  const keys = new Set([...Object.keys(x), ...Object.keys(y)])
  for (const k of keys) if (!Object.is(x[k], y[k])) return false
  return true
}
