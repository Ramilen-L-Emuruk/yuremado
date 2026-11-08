/**
 * 地震カードの履歴を、どの日まで読んだか（日本時間の日付で持つ）。
 *
 * **読み方は「この日々を読む」1 つだけ**（2026-11-08 ユーザー発言「同じ関数でやるほうが汎用性高くない？」）。
 * 「もっと見る」・期間の読み足し・再生中の続きは、どれも読む日の範囲をここで決め、同じ取得へ渡す
 * （→ `hooks/useEarthquakes.ts` の `readHistoryWindow`）。
 *
 * 読んだ日は 2 つに分けて持つ。
 * - **今日から途切れずに続く分**（`main`）。起動時の履歴と「もっと見る」が伸ばす。絞りを外した一覧に出し、捨てない
 * - **期間で読んだ日**（`IslandDays`）。期間の絞りが足りない日だけを読んだもの。その期間を選んでいる間だけ一覧に出し、
 *   期間を外した・変えた後は 3 日で捨てる（2026-11-08 ユーザー発言「時間で消えるようにすれば？即時じゃなくて。」・
 *   選択「3日 (Recommended)」・選択「一覧には出さない (Recommended)」）
 *
 * 2 つを 1 つに混ぜないのは、隣り合った期間の分が今日から続く分に溶けて、期間を外しても消えなくなるため
 * （選択「近い期間も別に読む (Recommended)」の「外すと元に戻る」）。
 */

import type { JMAQuake } from '../types/earthquake'
import { parseJstTimeMs } from './quakeOriginSeconds'

/** 日本時間の日付（`YYYY-MM-DD`）。 */
export type JstDay = string

/** 両端を含む日の範囲（`from <= to`）。 */
export interface DayRange {
  readonly from: JstDay
  readonly to: JstDay
}

/**
 * 期間で読んだ日 → 期間から外れた時刻（エポックミリ秒）。いま選んでいる期間に入っている日は `null`。
 */
export type IslandDays = ReadonlyMap<JstDay, number | null>

/**
 * 読んだ日の全体。`top` は今日から続く分の上端の日（ライブは起動時の履歴を読んだ日、再生は再生を始めた時刻の日）。
 * まだ読みに行っていなければ null。
 */
export interface HistoryDaysState {
  readonly top: JstDay | null
  readonly main: DayRange | null
  readonly islands: IslandDays
}

export const EMPTY_HISTORY_DAYS: HistoryDaysState = { top: null, main: null, islands: new Map() }

const DAY_MS = 86_400_000
const JST_OFFSET_MS = 9 * 3_600_000

/** 期間を外した後、期間で読んだ地震を持ち続ける長さ（2026-11-08 選択「3日 (Recommended)」）。 */
export const ISLAND_KEEP_MS = 3 * DAY_MS

/** 日付を指定した期間の長さの上限（両端を含む日数。2026-11-08 ユーザー選択「期間の日だけ取りに行く形を別に作る」の説明「長さで 90 日までにする」）。 */
export const PERIOD_MAX_DAYS = 90

/** 日本時間の `YYYY-MM-DD` の 0 時のエポックミリ秒。読めなければ NaN。 */
export function jstDayStartMs(day: JstDay): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return Number.NaN
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - JST_OFFSET_MS
}

/** エポックミリ秒の日本時間の日付。 */
export function jstDayOf(ms: number): JstDay {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10)
}

/** `day` から `n` 日ずらした日（負なら前）。日本時間に夏時間は無いので日の長さは一定。 */
export function addDays(day: JstDay, n: number): JstDay {
  return jstDayOf(jstDayStartMs(day) + n * DAY_MS)
}

/** `a` から `b` までの日数（`b` が後なら正）。 */
export function daysBetween(a: JstDay, b: JstDay): number {
  return Math.round((jstDayStartMs(b) - jstDayStartMs(a)) / DAY_MS)
}

/** その日の終わり（日本時間の翌日 0 時の 1 ミリ秒前）。取得の窓の上端に使う（取得側は `before` ちょうどまでを含む）。 */
export function jstDayEndMs(day: JstDay): number {
  return jstDayStartMs(day) + DAY_MS - 1
}

function inRange(day: JstDay, r: DayRange | null): boolean {
  return r !== null && day >= r.from && day <= r.to
}

/**
 * 期間の絞りが掛かる日の範囲。時間で選ぶ期間（24時間など）は、始まりの時刻の日から今日まで。
 * 日付を指定した期間はその日付のまま（未来の日は今日で切る）。
 */
export function periodDayRange(period: { kind: 'hours'; hours: number } | { kind: 'range'; from: JstDay; to: JstDay }, nowMs: number): DayRange {
  const today = jstDayOf(nowMs)
  if (period.kind === 'hours') return { from: jstDayOf(nowMs - period.hours * 3_600_000), to: today }
  return { from: period.from, to: period.to < today ? period.to : today }
}

/**
 * 範囲のうち、まだ読んでいない日のまとまり（新しい側から）。今日から続く分（`main`）と期間で読んだ日の両方を読んだものとみなす。
 * 期間の読み足しは、これの先頭（一番新しいまとまり）の窓から読む。
 *
 * **今日から続く分の上端より新しい日も読んだものとみなす。** 開いたまま日付が変わると上端は起動した日のままだが、その後の日は
 * ライブ（再生なら再生）が届けている。足りない日に数えると、届いている日を取り直し、「今日以前は未読込み」と出てしまう。
 */
export function missingRanges(range: DayRange, main: DayRange | null, islands: IslandDays): DayRange[] {
  const out: DayRange[] = []
  let runTo: JstDay | null = null
  let runFrom: JstDay | null = null
  const span = daysBetween(range.from, range.to)
  if (!Number.isFinite(span) || span < 0) return out
  for (let i = 0; i <= span; i++) {
    const day = addDays(range.to, -i)
    const loaded = inRange(day, main) || islands.has(day) || (main !== null && day > main.to)
    if (!loaded) {
      if (runTo === null) runTo = day
      runFrom = day
    } else if (runTo !== null && runFrom !== null) {
      out.push({ from: runFrom, to: runTo })
      runTo = null
      runFrom = null
    }
  }
  if (runTo !== null && runFrom !== null) out.push({ from: runFrom, to: runTo })
  return out
}

/**
 * まだ読んでいない範囲から、次に 1 回で読む窓（新しい側の端から、両端を含めて最大 `windowDays + 1` 日）。
 * 日数は「もっと見る」の窓と同じ（→ `HISTORY_WINDOW_DAYS`。上端の日とその前 `windowDays` 日）。
 */
export function nextWindowOf(range: DayRange, windowDays: number): DayRange {
  const lowest = addDays(range.to, -windowDays)
  return { from: lowest > range.from ? lowest : range.from, to: range.to }
}

/**
 * 「もっと見る」が次に読む窓。今日から続く分（`main`）の一番古い日の前から、古い方へ。
 *
 * - `main` が無い（起動時の履歴を読めていない）なら、起動時と同じ窓（上端の日とその前 `windowDays` 日）を読み直す
 * - すぐ下の日を期間で読み終えていれば、その日々は読み直さずに今日から続く分へ入れる（`promote`）。押した人は今日から
 *   途切れずに遡りたいので、そこから先は期間を外しても消さない
 * - 窓の途中に期間で読んだ日があれば、その手前で窓を切る（同じ日を二度読まない）
 */
export function nextLoadMoreWindow(
  main: DayRange | null, topDay: JstDay, islands: IslandDays, windowDays: number,
): { promote: JstDay[]; window: DayRange } {
  if (main === null) return { promote: [], window: { from: addDays(topDay, -windowDays), to: topDay } }
  const promote: JstDay[] = []
  let to = addDays(main.from, -1)
  // 期間で読んだ日が続く限り今日から続く分へ入れる。在庫の端（2020-11-18）より古くは続かないので、回数は有限
  while (islands.has(to)) {
    promote.push(to)
    to = addDays(to, -1)
  }
  let from = addDays(to, -windowDays)
  for (let i = 1; i <= windowDays; i++) {
    const day = addDays(to, -i)
    if (islands.has(day)) {
      from = addDays(day, 1)
      break
    }
  }
  return { promote, window: { from, to } }
}

/**
 * 今日から続く分を、読み切った範囲で伸ばす。`main` に接していなければ（間に読めていない日があれば）伸ばさない。
 */
export function extendMain(main: DayRange | null, loaded: DayRange): DayRange {
  if (main === null) return loaded
  const from = loaded.from < main.from && loaded.to >= addDays(main.from, -1) ? loaded.from : main.from
  const to = loaded.to > main.to && loaded.from <= addDays(main.to, 1) ? loaded.to : main.to
  return { from, to }
}

/**
 * 期間で読んだ日を足す。足した日はいま選んでいる期間の日なので、外れた時刻は持たない（`null`）。
 * 今日から続く分に入っている日は足さない（そちらで持つ）。
 */
export function addIslandRange(islands: IslandDays, loaded: DayRange, main: DayRange | null): Map<JstDay, number | null> {
  const next = new Map(islands)
  const span = daysBetween(loaded.from, loaded.to)
  for (let i = 0; i <= span; i++) {
    const day = addDays(loaded.from, i)
    if (!inRange(day, main)) next.set(day, null)
  }
  return next
}

/**
 * 選んでいる期間が変わったときに、期間で読んだ日の「外れた時刻」を付け直す。
 * 新しい期間に入る日は `null`（持ち続ける）、外れた日は今の時刻（既に外れていた日は元の時刻のまま）。
 * 何も変わらなければ同じ Map を返す（描き直しを起こさない）。
 */
export function holdIslands(islands: IslandDays, active: DayRange | null, nowMs: number): IslandDays {
  let changed = false
  const next = new Map(islands)
  for (const [day, releasedAt] of islands) {
    const want = inRange(day, active) ? null : (releasedAt ?? nowMs)
    if (want !== releasedAt) {
      next.set(day, want)
      changed = true
    }
  }
  return changed ? next : islands
}

/** 期間から外れて `keepMs` 以上たった日（捨てる日）。 */
export function expiredIslandDays(islands: IslandDays, nowMs: number, keepMs: number): JstDay[] {
  const out: JstDay[] = []
  for (const [day, releasedAt] of islands) {
    if (releasedAt !== null && nowMs - releasedAt >= keepMs) out.push(day)
  }
  return out
}

/**
 * 地震カードの 2 つの日。`origin` は発生時刻の日（期間の絞りと同じ軸）、`newest` は最新の報の日（どの日の取得で届いたかに近い軸）。
 * 読めなければ null。
 */
export function quakeCardDays(q: JMAQuake): { origin: JstDay | null; newest: JstDay | null } {
  // カードは更新のたびに作り直される（同じ参照の中身は変わらない）ので、参照ごとに控える。
  // 一覧の出し分けは電文が届くたびに全件へ掛かるので、控えないと 1 年分で数千回の日時の読み直しになる
  const hit = cardDaysCache.get(q)
  if (hit !== undefined) return hit
  const o = parseJstTimeMs(q.earthquake.time)
  const n = parseJstTimeMs(q.issue.time)
  const days = { origin: Number.isFinite(o) ? jstDayOf(o) : null, newest: Number.isFinite(n) ? jstDayOf(n) : null }
  cardDaysCache.set(q, days)
  return days
}
const cardDaysCache = new WeakMap<JMAQuake, { origin: JstDay | null; newest: JstDay | null }>()

/**
 * 地震カードを一覧に出すか（期間で読んだ地震は、その期間を選んでいる間だけ出す。2026-11-08 選択「一覧には出さない (Recommended)」）。
 *
 * 隠すのは、期間で読んだ日に発生した・報が届いた地震のうち、今日から続く分に報が届いておらず、いまの期間にも入らないものだけ。
 * - 最新の報の日が今日から続く分に入っていれば出す（窓の端で日をまたいだ地震を落とさない）
 * - 期間で読んだ日に関わらない地震（ライブで届いた・保存してあった報など）は、日付によらず出す（ここで触らない）
 * - 時刻を読めない地震は出す（絞りの外で黙って消さない）
 *
 * @param mainFrom 今日から続く分の一番古い日。まだ読めていなければ、読みに行った上端の日
 */
export function isHistoryCardShown(
  days: { origin: JstDay | null; newest: JstDay | null }, mainFrom: JstDay, active: DayRange | null, islands: IslandDays,
): boolean {
  if (days.newest !== null && days.newest >= mainFrom) return true
  const fromIsland = (days.origin !== null && islands.has(days.origin)) || (days.newest !== null && islands.has(days.newest))
  if (!fromIsland) return true
  return days.origin !== null && inRange(days.origin, active)
}

/** 捨てる日に発生した・報が届いた地震のうち、今日から続く分に報が届いていないもの（期間で読んだ日を捨てるときに一覧から外す）。 */
export function isEvictedCard(days: { origin: JstDay | null; newest: JstDay | null }, mainFrom: JstDay, drop: ReadonlySet<JstDay>): boolean {
  // 最新の報の時刻を読めない地震は捨てない（出し分けでも出す側に倒している。黙って消さない）
  if (days.newest === null) return false
  const inDrop = (days.origin !== null && drop.has(days.origin)) || drop.has(days.newest)
  return inDrop && days.newest < mainFrom
}

/**
 * 日付を指定した期間の欄を打ったときの範囲。打った欄はそのままにして、反対の欄を寄せる。
 * - 前後が逆になったら、反対の欄を同じ日へ（2026-11-07 ユーザー選択「もう片方を同じ日に寄せる (Recommended)」）
 * - 両端を含めて `PERIOD_MAX_DAYS` 日を超えたら、反対の欄をその内へ（2026-11-08 選択「寄せて注記も出す」）
 *
 * - 寄せた先は今日より後にしない（日付の欄が選べるのは今日まで）
 *
 * @returns 寄せた範囲と、長さの上限で寄せたか（注記「期間は90日までです。」を出す）
 */
export function clampPeriodRange(from: JstDay, to: JstDay, edited: 'from' | 'to', today: JstDay): { from: JstDay; to: JstDay; clampedByLength: boolean } {
  // 日付として読めない値（壊れた保存値など）は寄せずにそのまま返す（ここで投げると画面ごと落ちる。読めない期間は絞りが何も当てない）
  if (!Number.isFinite(jstDayStartMs(from)) || !Number.isFinite(jstDayStartMs(to))) return { from, to, clampedByLength: false }
  if (from > to) return edited === 'from' ? { from, to: from, clampedByLength: false } : { from: to, to, clampedByLength: false }
  if (daysBetween(from, to) <= PERIOD_MAX_DAYS - 1) return { from, to, clampedByLength: false }
  if (edited === 'to') return { from: addDays(to, -(PERIOD_MAX_DAYS - 1)), to, clampedByLength: true }
  const end = addDays(from, PERIOD_MAX_DAYS - 1)
  return { from, to: end < today ? end : today, clampedByLength: true }
}
