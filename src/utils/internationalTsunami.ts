// 国際津波関連情報（WEPA60）を持つ一覧と、地震カードへの結び付け・付くカードの無い報から組むカード。
// 型と電文の形は `types/earthquake.ts` の `JMAInternationalTsunami`。
import type { JMAInternationalTsunami, JMAQuake } from '../types/earthquake'
import { hasKnownEpicenter, haversineKm } from './geo'
import { quakeEventKey, sortQuakes } from './quakeMerge'

/**
 * 震央が両方読めるときに、同じ地震とみなす距離。発生時刻の分だけでは、同じ分に起きた別の地震を取り違えうるので
 * 距離でも裏を取る。全期間の控え（2020-11〜2026-10）で結べた報の震央の差は、国内の地震で最大 23 km、遠地の地震で最大 88 km。
 * 震源の決め直しの幅を見込んで、地方をまたぐ程度に広く取る（推計震度分布図の引き当てと同じ値）。
 */
const EPICENTER_MATCH_MAX_KM = 300

/**
 * 発生時刻の突き合わせで許すずれ。比べるのはカードの地震発生時刻（無ければカードの時刻。→ {@link quakeMsOf}）で、
 * WEPA60 の `ORIGIN TIME` は分まで（秒を切り捨てた UTC）。1 分の幅に、震源の決め直しで発生時刻が動く分の余裕を
 * 1 分足す。
 */
export const ORIGIN_MATCH_TOLERANCE_MS = 120_000

/**
 * 一覧へ 1 通を足す。同じ `id`（発表時刻と題名が同じ）の報は 1 通にまとめる（ライブと取り戻しで
 * 同じ報を 2 度受けることがある）。並びは発表時刻の古い順。
 *
 * @returns 足したら新しい一覧、既にあれば null（画面を描き直さない）
 */
export function upsertInternationalTsunami(
  list: readonly JMAInternationalTsunami[], item: JMAInternationalTsunami,
): JMAInternationalTsunami[] | null {
  if (list.some(x => x.id === item.id)) return null
  return [...list, item].sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
}

/**
 * 受けた報をアプリへ入れるか。**通信試験は設定「試験報を受信（検証用）」が入のときだけ入れる**（2026-11-09 ユーザー選択
 * 「試験報の設定で止める (Recommended)」）。WEPA60 は XML でない電文で、配信元は試験の印（`head.test`）を付けないので、
 * DMDATA の試験報の破棄（`services/dmdata.ts`）を通らない。ここで止めないと、中身が試験の報が全員に通知・音・読み上げで出る。
 * 入れなかった報も電文ログには残る（ログは受信の時点で積む）
 */
export function admitInternationalTsunami(x: JMAInternationalTsunami, receiveTest: boolean): boolean {
  return !x.isCommunicationsTest || receiveTest
}

/** 特別な情報の帯に出しておく日数（他の帯と同じく発表から 7 日。気象庁が定めた期限ではない） */
const BAND_DAYS = 7

/** 特別な情報の帯に出す国際津波関連情報の 1 通（帯の一覧の形 → `utils/specialInfoBandList.ts`） */
export interface InternationalTsunamiBandItem {
  readonly id: string
  readonly reportDateTime: string
  readonly expireAt: string
  readonly report: JMAInternationalTsunami
}

/**
 * 地震カードに付かない報を、特別な情報の帯に出す 1 通にする（2026-11-09 ユーザー選択「帯に出す (Recommended)」。2026-11-10 に
 * 地震タブとの比べを示したうえで同じ答え）。対象は**通信試験**と、**発生時刻を読めない報**（カードの時刻の行が組めない。
 * 全期間の控えに 0 通）。それ以外（地震カードか英文だけのカードに付く報）は null。発表時刻を読めない報も期限を数えられないので null
 */
export function internationalTsunamiBandItem(x: JMAInternationalTsunami): InternationalTsunamiBandItem | null {
  if (!x.isCommunicationsTest && x.originTime !== undefined) return null
  const ms = Date.parse(x.time)
  if (!Number.isFinite(ms)) return null
  return { id: x.id, reportDateTime: x.time, expireAt: new Date(ms + BAND_DAYS * 86_400_000).toISOString(), report: x }
}


/** 英文の結び付けの結果（→ {@link internationalTsunamiIndex}）。 */
export interface InternationalTsunamiIndex {
  /** カードの鍵（`quakeEventKey`）ごとの報（発表時刻の古い順）。英文だけのカードの分も入る。報の無いカードは載らない */
  byQuakeKey: ReadonlyMap<string, readonly JMAInternationalTsunami[]>
  /** 付く地震カードの無い報から組んだカード（→ `JMAQuake.fromInternationalTsunami`） */
  cards: readonly JMAQuake[]
  /** 付く地震カードの無い報（通信試験を除く）。発生時刻を読めない報はここにだけ残り、カードにならない */
  unattached: readonly JMAInternationalTsunami[]
}

/** 報の付かないカードへ渡す空の配列。毎回新しい空の配列を渡すとカードの `memo` が素通りする */
export const NO_INTERNATIONAL_TSUNAMIS: readonly JMAInternationalTsunami[] = []

const EMPTY_INDEX: InternationalTsunamiIndex = { byQuakeKey: new Map(), cards: [], unattached: [] }

/**
 * 英文の報を地震カードへ結ぶ。**国内の地震のカードにも、遠地地震のカードにも付ける**（2026-11-03 ユーザー選択
 * 「国内に付け、無い分はカードに (Recommended)」。前は遠地地震のカードにだけ付けていたが、全期間の控えでは地震の報 163 通のうち
 * 60 通が国内の地震のものだった。例: 2021-02-13 福島県沖 M7.3）。
 *
 * - 付けられるのは、英文の発生時刻（`ORIGIN TIME`）がカードの地震発生時刻（無ければカードの時刻。→ {@link quakeMsOf}）から
 *   {@link ORIGIN_MATCH_TOLERANCE_MS} 以内で、
 *   震央が両方読めるときは {@link EPICENTER_MATCH_MAX_KM} を超えないカード。通信試験と発生時刻を読めない報はどこにも付かない
 * - **1 通は 1 枚にだけ付ける。** 付けられるカードが複数あれば、震央を突き合わせられたカード → 時刻の差が小さいカード →
 *   震央が近いカードの順に選ぶ。全期間の控えで、付けられるカードが 2 枚あった報は 3 通（2022-03-16 福島県沖の前震と本震・
 *   2026-07-28 の本震と 3 分後の余震）で、どれも本震に付く。前震は震度速報だけのカードで震央が無かった
 * - 震央を突き合わせられるカードが無ければ、震央の無いカード（震度速報だけ）にも時刻だけで付ける。同じ地震の震源の報がまだ
 *   届いていない間の形で、続報で震源が決まれば突き合わせ直す。別の地震の英文が震度速報だけのカードに付いたことは、全期間の控えで無い
 * - 付く地震カードの無い報は、同じ発生時刻（分）ごとに 1 枚の英文だけのカードにする（{@link cardFrom}）。気象庁が地震情報を
 *   出さなかった地震（全期間の控えで 32 地震・43 通。フィリピン・ソロモン・カムチャツカなどの M6.5〜6.9）の報は、これが無いと
 *   画面のどこにも出ない。同じ分に離れた 2 つの地震の報が付く先も無く並んだことは、全期間の控えで無い
 *
 * `quakes` は状態の全カード（震度で絞る前）。一覧もカードも作り直さずに差し替える（不変）ので、同じ組の答えは控えて返す。
 * 地震を選ぶたびの一覧の描き直しと、App・useEarthquakes の付く先の無い報の洗い出しが同じ控えを引く。
 */
export function internationalTsunamiIndex(
  quakes: readonly JMAQuake[], list: readonly JMAInternationalTsunami[],
): InternationalTsunamiIndex {
  if (list.length === 0) return EMPTY_INDEX
  let byQuakes = indexCache.get(list)
  if (!byQuakes) indexCache.set(list, byQuakes = new WeakMap())
  const cached = byQuakes.get(quakes)
  if (cached) return cached
  const index = buildIndex(quakes, list)
  byQuakes.set(quakes, index)
  return index
}

const indexCache = new WeakMap<readonly JMAInternationalTsunami[], WeakMap<readonly JMAQuake[], InternationalTsunamiIndex>>()

function buildIndex(quakes: readonly JMAQuake[], list: readonly JMAInternationalTsunami[]): InternationalTsunamiIndex {
  const byQuakeKey = new Map<string, JMAInternationalTsunami[]>()
  const unattached: JMAInternationalTsunami[] = []
  for (const x of list) {
    if (x.isCommunicationsTest) continue
    const best = bestQuakeFor(x, quakes)
    if (!best) { unattached.push(x); continue }
    const key = quakeEventKey(best)
    const group = byQuakeKey.get(key)
    if (group) group.push(x)
    else byQuakeKey.set(key, [x])
  }
  // 発生時刻を読めない報はカードにできない（時刻の行が組めない）
  const byOrigin = new Map<string, JMAInternationalTsunami[]>()
  for (const x of unattached) {
    if (x.originTime === undefined) continue
    const group = byOrigin.get(x.originTime)
    if (group) group.push(x)
    else byOrigin.set(x.originTime, [x])
  }
  const cards: JMAQuake[] = []
  for (const group of byOrigin.values()) {
    const card = cardFrom(group.reduce((a, b) => (Date.parse(b.time) > Date.parse(a.time) ? b : a)))
    cards.push(card)
    byQuakeKey.set(quakeEventKey(card), group)
  }
  const stable = new Map<string, readonly JMAInternationalTsunami[]>()
  for (const [key, group] of byQuakeKey) stable.set(key, stableList(group))
  return { byQuakeKey: stable, cards, unattached }
}

/** 英文だけのカードの鍵（`quakeEventKey`）。同じ発生時刻（分）の報は 1 枚にまとまる（→ {@link cardFrom}） */
export function internationalTsunamiCardKey(originTime: string): string {
  return `wepa60-quake-${originTime}`
}

/**
 * 通知を押したときの開き先（英文の発生時刻と震央）が指す地震カードの鍵。通知は中継からも届き、中継は地震カードを持たないので、
 * 開く側が画面と同じ選び方（{@link bestQuakeFor}）で引き直す。付く地震カードが無ければ英文だけのカードの鍵
 */
export function internationalTsunamiOpenKey(quakes: readonly JMAQuake[], originTime: string, lat?: number, lon?: number): string {
  const probe = {
    id: '', title: '', time: originTime, originTime, isCommunicationsTest: false, text: '',
    ...(lat !== undefined && lon !== undefined && { epicenter: { latitude: lat, longitude: lon } }),
  } satisfies JMAInternationalTsunami
  return internationalTsunamiTarget(quakes, probe)?.key ?? internationalTsunamiCardKey(originTime)
}

/**
 * 英文の報が付く地震カードの、日本語の震源名（読み上げと通知で震源を言うのに使う）。付く先は画面と同じ選び方（{@link bestQuakeFor}）。
 * 付く地震カードが無い・震源名が空・取り消されたカードなら undefined（読み上げは電文の座標で言う）
 */
export function internationalTsunamiQuakeName(quakes: readonly JMAQuake[], x: JMAInternationalTsunami): string | undefined {
  return internationalTsunamiTarget(quakes, x)?.quakeName
}

/**
 * 英文の報を受けたときに選ぶ地震カードの鍵と、その日本語の震源名。付く地震カードがあればそのカード（画面と同じ選び方）、
 * 無ければ英文だけのカード（{@link internationalTsunamiCardKey}）。通信試験と発生時刻を読めない報はどのカードにも付かないので null
 */
export function internationalTsunamiTarget(
  quakes: readonly JMAQuake[], x: JMAInternationalTsunami,
): { key: string; quakeName?: string; cancelled?: true } | null {
  if (x.isCommunicationsTest || x.originTime === undefined) return null
  // 候補は画面の結び付け（`buildIndex`）と同じく、取り消されたカードも含める。外すと、画面が取り消されたカードに英文を付けているのに
  // 選ぶ側は英文だけのカード（画面に無い）を指し、選択も通知の開き先も空振りする
  const best = bestQuakeFor(x, quakes.filter(q => !q.fromInternationalTsunami))
  if (!best) return { key: internationalTsunamiCardKey(x.originTime) }
  // 取り消されたカードの震源名は言わない（取り消された報の地名を事実として読まない。座標で言う側へ倒す）
  if (best.cancelledAt) return { key: quakeEventKey(best), cancelled: true }
  const name = best.earthquake.hypocenter.name.trim()
  return { key: quakeEventKey(best), ...(name && { quakeName: name }) }
}

/** 報を付けるカード（→ {@link internationalTsunamiIndex} の選び方）。付けられるカードが無ければ null */
function bestQuakeFor(x: JMAInternationalTsunami, quakes: readonly JMAQuake[]): JMAQuake | null {
  const ms = originMsOf(x)
  if (!Number.isFinite(ms)) return null
  let best: JMAQuake | null = null
  let bestUnverified = 0, bestDt = 0, bestKm = 0
  for (const q of quakes) {
    const dt = Math.abs(ms - quakeMsOf(q))
    if (!(dt <= ORIGIN_MATCH_TOLERANCE_MS)) continue
    const { latitude, longitude } = q.earthquake.hypocenter
    const verified = x.epicenter !== undefined && hasKnownEpicenter(latitude, longitude)
    const km = verified ? haversineKm(latitude, longitude, x.epicenter!.latitude, x.epicenter!.longitude) : Number.POSITIVE_INFINITY
    if (verified && km > EPICENTER_MATCH_MAX_KM) continue
    const unverified = verified ? 0 : 1
    if (best === null || unverified < bestUnverified
      || (unverified === bestUnverified && (dt < bestDt || (dt === bestDt && km < bestKm)))) {
      best = q; bestUnverified = unverified; bestDt = dt; bestKm = km
    }
  }
  return best
}

/** 英文の発生時刻（ミリ秒）。読めない報は NaN。カードの数だけ読み直さないよう、報ごとに 1 回だけ読む */
function originMsOf(x: JMAInternationalTsunami): number {
  let ms = originMsCache.get(x)
  if (ms === undefined) {
    ms = x.originTime === undefined ? Number.NaN : Date.parse(x.originTime)
    originMsCache.set(x, ms)
  }
  return ms
}

const originMsCache = new WeakMap<JMAInternationalTsunami, number>()

/**
 * 英文の発生時刻と比べるカードの時刻（ミリ秒）。**地震発生時刻（`earthquake.originTime`）があればそれ、無ければ
 * カードの時刻（`earthquake.time`）。** カードの時刻は地震発現時刻で、深い地震・遠い地震では発生時刻より数分遅れうるので、
 * 英文の発生時刻とは発生時刻どうしで比べる（→ data-sources-spec.md §2）。発生時刻を持たないのは震度速報だけのカード。
 * 読めなければ NaN（どの報も付かない）。報の数だけ読み直さないよう、カードごとに 1 回だけ読む
 */
function quakeMsOf(q: JMAQuake): number {
  let ms = quakeMsCache.get(q)
  if (ms === undefined) {
    const origin = q.earthquake.originTime ? Date.parse(q.earthquake.originTime) : Number.NaN
    ms = Number.isFinite(origin) ? origin : Date.parse(q.earthquake.time)
    quakeMsCache.set(q, ms)
  }
  return ms
}

const quakeMsCache = new WeakMap<JMAQuake, number>()

/**
 * 同じ報の並びには同じ配列を返す。結び付けはカードか報が 1 つ増えるたびに組み直すが、付く報の変わらないカードの `memo` を
 * 素通りさせない。報は足すだけで差し替えない（{@link upsertInternationalTsunami}）ので、並びは id で見分けられる
 */
function stableList(group: readonly JMAInternationalTsunami[]): readonly JMAInternationalTsunami[] {
  let byIds = listCache.get(group[0])
  if (!byIds) listCache.set(group[0], byIds = new Map())
  const ids = group.map(x => x.id).join('\n')
  const cached = byIds.get(ids)
  if (cached) return cached
  byIds.set(ids, group)
  return group
}

const listCache = new WeakMap<JMAInternationalTsunami, Map<string, readonly JMAInternationalTsunami[]>>()

/**
 * 付く地震カードの無い報から組んだカード。形は遠地地震のカードと同じ（種別 `遠地地震`・震度なし）で、値（地名・震央・規模・深さ）は
 * 同じ発生時刻の報のうち発表が最も新しい報のもの（2026-11-03 ユーザー選択「英文の値をそのまま並べる (Recommended)」）。
 * カードの中身はその報だけで決まるので、同じ報からは同じカードを返す（津波の電文が届くたびの組み直しで `memo` を素通りさせない）。
 */
function cardFrom(latest: JMAInternationalTsunami): JMAQuake {
  const cached = cardCache.get(latest)
  if (cached) return cached
  const originTime = latest.originTime!
  const key = internationalTsunamiCardKey(originTime)
  const card = {
    kind: 'quake',
    id: key,
    eventKey: key,
    time: latest.time,
    fromInternationalTsunami: true,
    issue: { source: '気象庁', time: latest.time, type: '遠地地震', correct: 'なし' },
    earthquake: {
      time: originTime,
      hypocenter: {
        name: latest.regionName ?? '',
        latitude: latest.epicenter?.latitude ?? -200,
        longitude: latest.epicenter?.longitude ?? -200,
        depth: latest.depthKm ?? -1,
        magnitude: latest.magnitude ?? Number.NaN,
        ...(latest.magnitudeType && { magnitudeType: latest.magnitudeType }),
      },
      maxScale: -1,
      domesticTsunami: '不明',
    },
    points: [],
  } satisfies JMAQuake
  cardCache.set(latest, card)
  return card
}

const cardCache = new WeakMap<JMAInternationalTsunami, JMAQuake>()

/**
 * 状態の地震カードの一覧（震度で絞った後）へ、英文だけのカードを差し込んだ一覧（新しい順）。差し込むものが無ければ元の参照。
 * `index` は絞る前の全カードで作ったもの（→ {@link internationalTsunamiIndex}）。
 */
export function withInternationalTsunamiCards(shown: JMAQuake[], index: InternationalTsunamiIndex): JMAQuake[] {
  return index.cards.length === 0 ? shown : sortQuakes([...shown, ...index.cards])
}
