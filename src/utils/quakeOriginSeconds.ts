// 地震カードの発生時刻を**秒まで**決める。自作地震計の波形へ P 波・S 波の線を引くための値。
//
// **地震情報の発生時刻は分までしか無い。** 電文の `OriginTime` は秒が 00 に丸められていて
// （実電文の控え 2412 通で全件）、そのまま使うと線が最大 59 秒ずれる。秒の出どころは
// **発生時刻として発表された値だけ**にし、次の順に使う（2026-10-15 ユーザー承認「カタログが届くまで
// 線を引かない」・「仮定震源の報は使わない」）。
//
//   1. **緊急地震速報の発生時刻**（震源の決まった最後の報）。電文解説資料が「秒値まで有効」と
//      書くのは緊急地震速報の `OriginTime` だけ。**仮定震源要素の報は使わない** —— 揺れを捉えた
//      観測点の直下に震源を置いて逆算した値で、本当の発生より遅く出る
//   2. **長期震源カタログ**（気象庁の震源リスト。0.01 秒）の地震のうち、1 つに決まるもの
//      （→ {@link findCatalogOriginMs}）。震源リストは 2 日前までしか載らない（中継が
//      毎日書き足す）ので、**直近の 2 日ほどには無い**
//
// どちらも無ければ秒は無い —— **線は引かない**（根拠の無い目盛りを実測の絵へ重ねない）。
//
// **地震 ID（14 桁）は秒の出どころにしない。** 資料は「物理的な意味（発生時刻等）を持つものではない」
// と書き、実電文でも発生時刻から −692〜+112 秒ずれた（823 件・±15 秒超 9%）。緊急地震速報を
// 地震カードへ結ぶ**鍵**としてだけ使う。
//
// 出どころの取り方（どこから・いつ取るか）は `hooks/useQuakeOriginSeconds.ts`。ここは
// 「手元の材料からどれを採るか」だけを決める純関数。

import type { JMAQuake } from '../types/earthquake'
import type { EewOriginEntry } from './eewOriginStore'
import { haversineKm, hasKnownEpicenter } from './geo'
import { hasMagnitude } from './formatters'

/** 秒の出どころ。描く範囲の余裕が出どころで違うので、描く側が見分けられるよう持ち回す。 */
export type OriginSecondsSource = 'eew' | 'catalog'

export interface OriginSeconds {
  /** 発生時刻（エポックミリ秒）。 */
  readonly originMs: number
  readonly source: OriginSecondsSource
}

/** 日本時間（UTC+9）。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

const SECOND_MS = 1000
const MINUTE_MS = 60_000

/**
 * 地震カードの時刻（分まで）に対して、本当の発生時刻が入りうる幅（ms）。**分の頭の 30 秒前〜65 秒後。**
 *
 * **カードの時刻は発生時刻ではなく、地震発現時刻（最初に揺れを捉えた時刻）が優先**
 * （`services/dmdataParser.ts`。震度速報は検知時刻）。発生は発現より、震源から最初の観測点までの
 * 走時のぶん前にある。実電文 823 地震（カードと同じ選び方で時刻を取り、気象庁の震源リストと
 * 1 対 1 に結べたもの）で、震源リストの発生時刻 − カードの分の頭は −21.15〜+61.16 秒。
 * 前を 5 秒にしていた形では 11 件が窓の外へ落ち、うち 2 件は窓の中の別の地震を「1 つに決まった」と
 * 取り違えた。30 秒にすると 823 件で取り違え 0（→ {@link findCatalogOriginMs}）。
 */
export const QUAKE_MINUTE_LEAD_MS = 30 * SECOND_MS
export const QUAKE_MINUTE_TAIL_MS = 65 * SECOND_MS

/**
 * 電文の地震発生時刻（`Earthquake/OriginTime`。分まで）に対して、本当の発生時刻が入りうる幅の余白（ms）。
 * **分の頭の 5 秒前〜1 分 5 秒後。**
 *
 * **カードの時刻（地震発現の分）とは別に、こちらの幅でも探す**（2026-11-06 ユーザー選択「発生時刻の分で探し、だめなら
 * 今の幅 (Recommended)」）。深い地震や遠い地震は、発生から最初の観測点に揺れが届くまで 30 秒を超えるので、
 * 発現の分からは {@link QUAKE_MINUTE_LEAD_MS} 前に届かない（2026-10-25 11:09 小笠原諸島西方沖 M7.0・深さ約 500 km は、
 * 発現 11:10 に対して発生 11:09:21〜22）。
 *
 * 余白を置くのは、地震情報の発生時刻と震源リストの確定値が数秒ずれるため。控えの全期間（2020-11〜2026-10・
 * 地震情報 15,968 件）で数えると、余白 0 秒では今の幅で決まっていた 111 件が決まらなくなり、5 秒で 40 件、
 * 10 秒で 80 件（幅が広がり候補が 2 つになる分が増える）。**決まらなかったら発現の分の幅へ戻る**ので、
 * 今の幅で決まっていた地震は手放さない（秒が決まる地震は 14,128 → 14,346 件）。
 */
export const ORIGIN_MINUTE_MARGIN_MS = 5 * SECOND_MS

/** 探す幅（エポックミリ秒の閉区間）。 */
interface SearchWindow {
  readonly fromMs: number
  readonly toMs: number
}

/** 地震発現の分（カードの時刻）から探す幅。読めなければ `null`。 */
function arrivalMinuteWindow(quakeTimeMs: number): SearchWindow | null {
  if (!Number.isFinite(quakeTimeMs)) return null
  const head = Math.floor(quakeTimeMs / MINUTE_MS) * MINUTE_MS
  return { fromMs: head - QUAKE_MINUTE_LEAD_MS, toMs: head + QUAKE_MINUTE_TAIL_MS }
}

/** 電文の地震発生時刻の分から探す幅。電文が持たない（震度速報）・読めなければ `null`。 */
function originMinuteWindow(originMinuteMs: number | null): SearchWindow | null {
  if (originMinuteMs === null || !Number.isFinite(originMinuteMs)) return null
  const head = Math.floor(originMinuteMs / MINUTE_MS) * MINUTE_MS
  return { fromMs: head - ORIGIN_MINUTE_MARGIN_MS, toMs: head + MINUTE_MS + ORIGIN_MINUTE_MARGIN_MS }
}

const inWindow = (w: SearchWindow | null, ms: number): boolean => w !== null && ms >= w.fromMs && ms <= w.toMs

/** 地震発現の分（カードの時刻）に対して、`originMs` が同じ地震の発生時刻として入りうるか。 */
export function withinQuakeMinute(quakeTimeMs: number, originMs: number): boolean {
  return Number.isFinite(originMs) && inWindow(arrivalMinuteWindow(quakeTimeMs), originMs)
}

/** 電文の地震発生時刻の分に対して、`originMs` が同じ地震の発生時刻として入りうるか。 */
export function withinOriginMinute(originMinuteMs: number | null, originMs: number): boolean {
  return Number.isFinite(originMs) && inWindow(originMinuteWindow(originMinuteMs), originMs)
}

/**
 * 本当の発生時刻が入りうる最も早い時刻。**どちらの幅も作れなければ `NaN`。**
 *
 * 波形を取りに行く範囲の起点と、秒が取れないときの揺れが届きうる時間帯が使う（発生がカードの分の頭より
 * 1 分以上前に出る地震で、0 の手前のノイズを測る区間や揺れ始めを範囲の外へ落とさないため）。
 */
export function earliestOriginMs(quakeTimeMs: number, originMinuteMs: number | null): number {
  const starts = [arrivalMinuteWindow(quakeTimeMs), originMinuteWindow(originMinuteMs)]
    .filter((w): w is SearchWindow => w !== null)
    .map((w) => w.fromMs)
  return starts.length === 0 ? Number.NaN : Math.min(...starts)
}

/** 時計表記（`YYYY/MM/DD hh:mm[:ss[.sss]]`・`YYYY-MM-DD hh:mm…` も可）。時間帯を持たない。 */
const WALL_CLOCK_PATTERN = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/

/**
 * 時計表記を読んで、暦にある日時かを確かめる。**時計表記でない・暦に無い日時は `null`。**
 *
 * 暦の確かめは、組み立てた日時を `Date.UTC` へ通して読み戻し、**年月日・時・分・秒がすべて元と一致するか**で見る。
 * `Date.UTC` は範囲の外の値を黙って繰り上げる（2 月 30 日 → 3 月 2 日、75 秒 → 1 分 15 秒）ので、
 * どれか 1 つでも照合を省くと、そこだけ繰り上がった別の日時が「読めた」として通る。
 * 小数の秒はミリ秒の 3 桁へ揃えた文字列で返す（4 桁目からは切り捨て）。
 */
function readWallClock(time: string): { y: number; mo: number; d: number; h: number; mi: number; s: number; fraction: string } | null {
  const m = WALL_CLOCK_PATTERN.exec(time.trim())
  if (m === null) return null
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number)
  const s = m[6] === undefined ? 0 : Number(m[6])
  const back = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  if (
    back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d
    || back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== s
  ) return null
  return { y, mo, d, h, mi, s, fraction: (m[7] ?? '').padEnd(3, '0').slice(0, 3) }
}

/**
 * 時間帯を持たない日本時間の時計表記を、ISO の形（`2026-10-24T01:09:42.830+09:00`）へ直す。
 * **時計表記でないもの・暦にない日時は `null`**（呼び出し側が元の文字列のまま扱う）。
 *
 * Yahoo hypoInfo の時刻を内部の型へ入れる前に通す（→ `services/kyoshin.ts` の `yahooTime`）。
 * そのまま `new Date()` へ渡すと 2 つの穴がある。
 * - **Safari は小数の秒が付いた形（`2026/10/24 01:09:42.83`）を読めない**（WebKit 26.5 で `NaN` を
 *   実測した。小数の秒が無い形は読める）
 * - **時間帯を持たないので、端末の時間帯で読まれる**（日本国外の端末では Chrome でも時刻がずれる）
 *
 * DMDATA の電文の時刻は元から時間帯つきの ISO の形なので、ここで揃えると下流の読み方が 1 つになる。
 * 小数の秒は 3 桁（ミリ秒）に揃え、4 桁目からは切り捨てる。
 */
export function jstWallClockToIso(time: string): string | null {
  const c = readWallClock(time)
  if (c === null) return null
  const two = (n: number) => String(n).padStart(2, '0')
  return `${String(c.y).padStart(4, '0')}-${two(c.mo)}-${two(c.d)}T${two(c.h)}:${two(c.mi)}:${two(c.s)}.${c.fraction}+09:00`
}

/**
 * 地震カードの時刻をエポックミリ秒へ直す。**読めなければ `NaN`。**
 *
 * **時間帯を持たない表記は日本時間として読む。** 時計表記（`2026/10/03 13:26:00`）を
 * `new Date()` に渡すと端末の時間帯で読まれる —— 日本国外の
 * 端末では、気象庁の地震一覧（時間帯つきの絶対時刻）と分が合わず、突き合わせが全滅する。
 * 時間帯を持つ表記（DMDATA の ISO 形式）はそのまま読む。
 */
export function parseJstTimeMs(time: string): number {
  if (!WALL_CLOCK_PATTERN.test(time.trim())) return Date.parse(time)
  const c = readWallClock(time)
  if (c === null) return Number.NaN
  return Date.UTC(c.y, c.mo - 1, c.d, c.h, c.mi, c.s) - JST_OFFSET_MS
}

/**
 * 地震カードが持つ電文の地震発生時刻（分まで）をエポックミリ秒で。**電文が持たない（震度速報）・読めなければ `null`。**
 * 日本時間として読む（{@link parseJstTimeMs}）。
 */
export function telegramOriginMinuteMs(q: Pick<JMAQuake, 'earthquake'>): number | null {
  const raw = q.earthquake.originTime
  if (raw === undefined) return null
  const ms = parseJstTimeMs(raw)
  return Number.isFinite(ms) ? ms : null
}

/**
 * 緊急地震速報の発生時刻を、その地震カードの秒として使ってよいか。
 *
 * - **仮定震源要素の報なら使わない**（`assumed === true`）。見分けられない値（`null`。強震モニタの
 *   緊急地震速報）は使う（2026-10-15 ユーザー承認「仮定震源の報は使わない（推奨）」の説明「標準版の
 *   強震モニタ経路は仮定を見分けられないので除けない」）
 * - **地震情報の分に入らなければ結ばない** —— 同じ地震 ID の中身が別の地震で食い違うことがある
 *   （電文解説資料の出現例４: 2 秒後に起きた別の地震が同じ地震 ID の処理に乗る）。分は地震発生時刻の分
 *   （{@link withinOriginMinute}）と地震発現の分（{@link withinQuakeMinute}）の**どちらかに入ればよい**
 *
 * @param quakeTimeMs 地震カードの時刻（地震発現の分）
 * @param originMinuteMs 電文の地震発生時刻（分まで）。電文が持たなければ `null`
 */
export function usableEewOrigin(
  quakeTimeMs: number,
  originMinuteMs: number | null,
  eew: EewOriginEntry | undefined,
): number | null {
  if (eew === undefined || eew.assumed === true) return null
  return withinOriginMinute(originMinuteMs, eew.originMs) || withinQuakeMinute(quakeTimeMs, eew.originMs)
    ? eew.originMs
    : null
}

/**
 * 手元の材料から秒を決める。**どれも無ければ `null`。**
 *
 * @param params.quakeTimeMs 地震カードの時刻（地震発現の分）
 * @param params.originMinuteMs 電文の地震発生時刻（分まで）。電文が持たなければ `null`
 * @param params.eew 同じ地震 ID の緊急地震速報の記録（地震 ID が判らない・記録が無ければ `undefined`）
 * @param params.catalogOriginMs 長期震源カタログから 1 つに決まった発生時刻（決まらなければ `null`）
 */
export function resolveOriginSeconds(params: {
  readonly quakeTimeMs: number
  readonly originMinuteMs: number | null
  readonly eew: EewOriginEntry | undefined
  readonly catalogOriginMs: number | null
}): OriginSeconds | null {
  const fromEew = usableEewOrigin(params.quakeTimeMs, params.originMinuteMs, params.eew)
  if (fromEew !== null) return { originMs: fromEew, source: 'eew' }
  const { catalogOriginMs } = params
  if (catalogOriginMs !== null && Number.isFinite(catalogOriginMs)) {
    return { originMs: catalogOriginMs, source: 'catalog' }
  }
  return null
}

/** 長期震源カタログ 1 年ぶんのうち、突き合わせに使う列（`utils/hypocenterCatalog.ts` の `HypocenterYear`）。 */
export interface CatalogColumns {
  /** 発生時刻（エポックミリ秒）。**昇順。** */
  readonly timeMs: ArrayLike<number>
  readonly lat: ArrayLike<number>
  readonly lng: ArrayLike<number>
  readonly magnitude: ArrayLike<number>
  /**
   * 気象庁以外の機関が決めた震源なら 1。**突き合わせに使わない** —— 同じ地震を気象庁と他の機関が
   * 両方載せていると候補が 2 つになって引けなくなり、気象庁の行が無い地震では他の機関の秒を
   * 気象庁の発生時刻として線に使ってしまう。
   */
  readonly external: ArrayLike<number>
}

/** 突き合わせる側（地震カード）の材料。 */
export interface QuakeForCatalogLookup {
  /** 地震カードの時刻（地震発現の分）。 */
  readonly timeMs: number
  /** 電文の地震発生時刻（分まで）。電文が持たなければ `null`。 */
  readonly originMinuteMs: number | null
  readonly latitude: number
  readonly longitude: number
  readonly magnitude: number
}

/**
 * 震央の距離の上限（km）。**30 km。**
 *
 * 地震情報の震央（0.1 度）とカタログの震央の差は、1 対 1 に結べた 823 地震で中央値 4.5 km・
 * 90%点 7.2 km・最大 29.4 km。
 */
export const CATALOG_MAX_DISTANCE_KM = 30

/**
 * 規模の差の上限。**0.3。** 上と同じ 823 地震を結んだときの条件。地震情報の M とカタログの M は
 * どちらも気象庁マグニチュードだが、速報と震源リストで値が改められることがある。
 */
export const CATALOG_MAX_MAGNITUDE_DIFF = 0.3

/** `timeMs` の昇順の列で、`fromMs` 以上になる最初の添字。 */
function lowerBound(times: ArrayLike<number>, fromMs: number): number {
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (times[mid] < fromMs) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * 長期震源カタログから、その地震カードの発生時刻（秒まで）を引く。**1 つに決まらなければ `null`。**
 *
 * 幅の中で震央 {@link CATALOG_MAX_DISTANCE_KM} 以内・規模の差 {@link CATALOG_MAX_MAGNITUDE_DIFF} 以内のものが
 * **ちょうど 1 つ**のときだけ採る。群発の最中は 1 分に同じ場所で複数の地震が起き、取り違えると別の地震の秒で
 * 線を引く（取り違えは「線が無い」より重い）。
 *
 * **幅は 2 つを順に試す。** 先に電文の地震発生時刻の分（{@link ORIGIN_MINUTE_MARGIN_MS}）で探し、1 つに
 * 決まらなければ地震発現の分（{@link withinQuakeMinute}）で探す（2026-11-06 ユーザー選択「発生時刻の分で探し、
 * だめなら今の幅 (Recommended)」）。発生時刻の分のほうが狭く、同じ分の別の地震を拾いにくい。発現の分へ戻るのは、
 * 地震情報の発生時刻と震源リストの確定値が数秒ずれて、発生時刻の分の幅から外れる地震があるため。
 *
 * **震央か規模が判らない地震では引かない**（震度速報・規模不明）。時刻だけで 1 つに決めると、
 * カタログにしか載らない小さな地震を取り違える。
 *
 * @param coveredThroughMs カタログが覆っている終端。**幅がこれを越えるなら、その幅では引かない** ——
 *   まだ載っていない地震は「見つからない」のではなく「見ていない」で、残った別の候補を
 *   1 つに決まったと取り違える
 */
export function findCatalogOriginMs(
  quake: QuakeForCatalogLookup,
  years: readonly CatalogColumns[],
  coveredThroughMs: number,
): number | null {
  if (!hasKnownEpicenter(quake.latitude, quake.longitude) || !hasMagnitude(quake.magnitude)) return null
  for (const window of [originMinuteWindow(quake.originMinuteMs), arrivalMinuteWindow(quake.timeMs)]) {
    if (window === null) continue
    const found = findUniqueIn(quake, years, coveredThroughMs, window)
    if (found !== null) return found
  }
  return null
}

/** 幅の中で当てはまる地震がちょうど 1 つならその発生時刻。0 件・2 件以上・まだ載っていない幅なら `null`。 */
function findUniqueIn(
  quake: QuakeForCatalogLookup,
  years: readonly CatalogColumns[],
  coveredThroughMs: number,
  { fromMs, toMs }: SearchWindow,
): number | null {
  if (!(toMs <= coveredThroughMs)) return null
  let found: number | null = null
  for (const y of years) {
    for (let i = lowerBound(y.timeMs, fromMs); i < y.timeMs.length && y.timeMs[i] <= toMs; i += 1) {
      // **許容に 1e-6 を足す。** カタログの規模は Float32 で持つ（5.3 は 5.300000190734863）ので、
      // ちょうど 0.3 違う地震が丸めの誤差で外れないように。
      if (y.external[i] === 1) continue
      if (Math.abs(y.magnitude[i] - quake.magnitude) > CATALOG_MAX_MAGNITUDE_DIFF + 1e-6) continue
      if (haversineKm(quake.latitude, quake.longitude, y.lat[i], y.lng[i]) > CATALOG_MAX_DISTANCE_KM) continue
      if (found !== null) return null
      found = y.timeMs[i]
    }
  }
  return found
}

/**
 * 突き合わせに要る年（日本時間の暦年・昇順）。探す 2 つの幅（{@link findCatalogOriginMs}）のどちらかが
 * 年をまたぐなら両方。
 *
 * **カタログの年は日本時間で区切られている**（`HypocenterYear.timeMs` の注記）。
 */
export function catalogYearsFor(quakeTimeMs: number, originMinuteMs: number | null): number[] {
  const yearOf = (ms: number) => new Date(ms + JST_OFFSET_MS).getUTCFullYear()
  const years = new Set<number>()
  for (const w of [arrivalMinuteWindow(quakeTimeMs), originMinuteWindow(originMinuteMs)]) {
    if (w === null) continue
    years.add(yearOf(w.fromMs))
    years.add(yearOf(w.toMs))
  }
  return [...years].sort((a, b) => a - b)
}
