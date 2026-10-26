// 中継の「日の状態」—— 日と区分の組ごとに、その日の束をアプリへ出してよいかを決める。
//
// **状態は保存しない。保存するのは事実だけで、状態は事実から毎分計算し直す**（2026-10-26 ユーザー承認。
// 問い「【状態の決め方】」に選択肢「記録した事実から毎分計算し直す (Recommended)」）。
// 出来事ごとに状態を書き換える形だと、出来事を起こす処理（WebSocket・取り戻し・突き合わせ・過去分の控え）の
// どれか 1 つが書き換えを呼び忘れただけで、その日の状態が止まる。中継が丸 1 日止まっていた日も、
// 事実が 1 つも無い＝見ていない、として何もしなくても gapped になる。
//
// **最も重い失敗は、見ていなかった日を見ていたことにして、欠けた束や偽の空の束を出すこと。** アプリは閉じた日の
// 束を端末に永続的に控えるので、一度出た偽の束は版が変わるまで直らない。迷う入力は「見ていない」「まだ分からない」
// 側へ倒し、壊れた入力（存在しない日・有限でない時刻・負の件数・負の設定値）は投げる。
//
// 設計は docs/relay-server-design.md §4.6。このファイルは Cloudflare にもネットにも触れない純関数だけを置く。

export type Classification = 'telegram.earthquake' | 'eew.warning'

export type DayState =
  | 'open'
  | 'observed'
  | 'gapped'
  | 'reconciled'
  | 'confirmed-empty'
  | 'unfetched'
  | 'failed'

/** 時刻の区間。両端を含む（ミリ秒）。 */
export interface Interval {
  fromMs: number
  toMs: number
}

/**
 * DMDATA の WebSocket に繋がっていた 1 回ぶんの記録。時刻は中継の時計。
 *
 * **区間の終わりは `endedMs`、無ければ最後の心拍**（2026-10-26 ユーザー承認。問い「【見ていた時間の終わり】」に
 * 選択肢「最後に確かめた時刻で切る (Recommended)」）。Durable Object はデプロイや再起動で止められる前に
 * 何も書けないので、止められた回は `endedMs` が null のまま残る。そのとき最後の心拍から実際に切れるまでの
 * 間（最長で心拍の間隔ぶん）は見ていない側に倒す。
 */
export interface LiveSession {
  connectedMs: number
  /** 毎分の定期処理が「いま繋がっている」と確かめて書いた最後の時刻。繋がった直後は `connectedMs` を入れる */
  lastHeartbeatMs: number
  /** 中継が自分で切れたと知った回だけ入る（`sessionEndOnClose` で決める）。知らないまま止められた回は null */
  endedMs: number | null
}

export type CloseReason =
  /** 90 秒何も届かず、自分から閉じた */
  | 'watchdog'
  /** エラー・ネットワーク断で閉じた（相手からの閉じる合図を受けていない） */
  | 'error'
  /** 閉じる合図を受けて閉じた、または自分の都合で閉じた */
  | 'closed'

/**
 * 切れたと知ったときに `LiveSession.endedMs` へ入れる値。
 *
 * 見張りで閉じた回とエラーで閉じた回は、最後に何か（電文か ping）を受けた後は届いていなかったかもしれない
 * （半開きの接続）ので、そこで切る。閉じる合図を受けた回だけは閉じた時刻まで届いていた。
 */
export function sessionEndOnClose(reason: CloseReason, closeMs: number, lastReceivedMs: number): number {
  assertFinite(closeMs, 'closeMs')
  assertFinite(lastReceivedMs, 'lastReceivedMs')
  return reason === 'closed' ? closeMs : Math.min(lastReceivedMs, closeMs)
}

/** 見ていた区間の終わり。 */
export function sessionEnd(session: LiveSession): number {
  return session.endedMs ?? session.lastHeartbeatMs
}

/**
 * 突き合わせ用のアーカイブについて分かっていること。**一度立った印は戻さない**（`recordManifestCheck` が守る）。
 */
export interface ArchiveFacts {
  /** 目録にその日が載っているのを初めて見た時刻 */
  listedAtMs: number | null
  /** アーカイブ本体を取り込み、索引へ入れ終えた時刻 */
  ingestedAtMs: number | null
  /**
   * 日が終わってから `absentWaitMs` たった後に、最後まで辿れた目録を見て、その日が載っていなかった最初の時刻。
   * 「DMDATA 側に 1 通も無かった」と読んでよい根拠になる（後で載れば根拠を失う。`dayState` が `listedAtMs` を先に見る）
   */
  absentConfirmedAtMs: number | null
  /** 本体の取り込みに最後に失敗した時刻。取り込めたら意味を失う（状態の計算は `ingestedAtMs` を先に見る） */
  lastFetchFailedAtMs: number | null
}

export const EMPTY_ARCHIVE_FACTS: ArchiveFacts = {
  listedAtMs: null,
  ingestedAtMs: null,
  absentConfirmedAtMs: null,
  lastFetchFailedAtMs: null,
}

/** 日と区分の組 1 つについて、状態の計算に使う事実。 */
export interface DayFacts {
  /** JST の日（`YYYYMMDD`） */
  day: string
  classification: Classification
  /** 索引にあるその日・その区分の電文の数 */
  telegramCount: number
  /**
   * `/v2/telegram` で取り戻せた区間。時刻は DMDATA の時計（一覧の `datetime` に渡した範囲）。
   * **入れてよいのは、`gapfillDecision` が `fetch` を返し、一覧を最後のページまで辿り、欠けた本体を取り終えた回の
   * 範囲だけ。** 途中で失敗した回は区間を入れない（取れたところまでを入れると、取り損ねた時間が見ていた区間になる）。
   *
   * **区分 `eew.warning` では無視する。** 電文一覧に緊急地震速報は載らない（C2）ので、一覧で取り戻した区間は
   * 警報の覆いにならない。`/v2/gd/eew` で警報を取り戻した時間帯も数えない（2026-10-26 ユーザー承認。
   * 問い「【抜け出せない日】」に選択肢「空なら空と確定・他は待ち続ける (Recommended)」）。その一覧は最終報の
   * 後にしか更新されず、いつの時点で覆えたと言えるかを決められないため
   */
  gapfills: readonly Interval[]
  archive: ArchiveFacts
}

export interface DayStateParams {
  /**
   * WebSocket の区間を両端でこれだけ削ってから覆いを判定する（2026-10-26 ユーザー承認。問い「【時計のずれの余裕】」に
   * 選択肢「見ていた時間を両端 1 分ずつ削る (Recommended)」）。区間は中継の時計、電文の受信時刻は DMDATA の
   * 時計で測るので、ずれのぶん受け損ねた電文を「見ていた」と数えないため。段 1a の §9 の 3 で見直す
   */
  clockMarginMs: number
  /**
   * 見ていた区間が日の終わりからこれだけ先まで覆っている必要がある。遅い配信（発表から最大 59 秒）を拾う。
   * `open` を抜けるのは、そこからさらに `clockMarginMs` 後（WebSocket の区間は末尾も削られるので、その前に
   * 判定すると必ず gapped になる）
   */
  closeDelayMs: number
  /** 日が終わってから、目録に載らないことを「無い」と読むまで（DMDATA のアーカイブの遅れ D3 への備え） */
  absentWaitMs: number
  /** 日が終わってからこの間は目録を `manifestHourlyEveryMs` おきに、その後は `manifestDailyEveryMs` おきに見る */
  manifestHourlyForMs: number
  manifestHourlyEveryMs: number
  manifestDailyEveryMs: number
  /** 取り戻しで取りに行く本体がこの件数以下なら取り戻し、超えたら突き合わせに任せる */
  gapfillMaxBodies: number
  /** 取り戻しの一覧を、前の区間の終わりのこれだけ前から引く */
  gapfillLookbackMs: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * 既定値。`gapfillMaxBodies` の 40 は DMDATA の本体の上限 50req/5min（A3）を、過去分の控えと突き合わせに
 * 少し残して 1 回の 5 分に収める数（2026-10-26 ユーザー承認。問い「【取り戻すかどうか】」に選択肢
 * 「取りに行く本体の件数で決める (Recommended)」。既定 40・設定で変えられる、まで選択肢の説明に書いた）。
 */
export const DEFAULT_DAY_STATE_PARAMS: DayStateParams = {
  clockMarginMs: MINUTE,
  closeDelayMs: 10 * MINUTE,
  absentWaitMs: 48 * HOUR,
  manifestHourlyForMs: 48 * HOUR,
  manifestHourlyEveryMs: HOUR,
  manifestDailyEveryMs: 24 * HOUR,
  gapfillMaxBodies: 40,
  gapfillLookbackMs: 5 * MINUTE,
}

/**
 * 設定値を確かめる。**値を甘くする方向の誤り（負の余裕・短すぎる待ち）は、全部の日の状態を黙って甘くする**ので、
 * 設定を読んだところで必ず通す。下限の 24 時間は、DMDATA が前日分を作るまでの通常の時間（D1）より短い待ちを許さないため。
 */
export function validateDayStateParams(p: DayStateParams): void {
  for (const [name, v] of Object.entries(p)) assertFinite(v, name)
  if (p.clockMarginMs < 0) throw new Error(`clockMarginMs が負: ${p.clockMarginMs}`)
  if (p.closeDelayMs < 0) throw new Error(`closeDelayMs が負: ${p.closeDelayMs}`)
  if (p.absentWaitMs < 24 * HOUR) throw new Error(`absentWaitMs が 24 時間より短い: ${p.absentWaitMs}`)
  if (p.manifestHourlyForMs < 0) throw new Error(`manifestHourlyForMs が負: ${p.manifestHourlyForMs}`)
  if (p.manifestHourlyEveryMs <= 0 || p.manifestDailyEveryMs <= 0) throw new Error('目録を見る間隔が 0 以下')
  if (!Number.isInteger(p.gapfillMaxBodies) || p.gapfillMaxBodies < 0) {
    throw new Error(`gapfillMaxBodies が 0 以上の整数でない: ${p.gapfillMaxBodies}`)
  }
  if (p.gapfillLookbackMs < 0) throw new Error(`gapfillLookbackMs が負: ${p.gapfillLookbackMs}`)
}

function assertFinite(v: number, name: string): void {
  if (!Number.isFinite(v)) throw new Error(`${name} が有限の数でない: ${v}`)
}

const JST_OFFSET_MS = 9 * HOUR
const DAY_RE = /^(\d{4})(\d{2})(\d{2})$/

/** JST の日の始まり（UTC のミリ秒）。 */
export function jstDayStartMs(day: string): number {
  const m = DAY_RE.exec(day)
  if (m === null) throw new Error(`日の形が YYYYMMDD ではない: ${day}`)
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - JST_OFFSET_MS
  // Date.UTC は 2 月 30 日のような値を翌月へ繰り越して黙って通すので、戻して確かめる。
  if (jstDayOf(ms) !== day) throw new Error(`存在しない日: ${day}`)
  return ms
}

export function jstDayEndMs(day: string): number {
  return jstDayStartMs(day) + 24 * HOUR
}

/** 時刻が属する JST の日（`YYYYMMDD`）。 */
export function jstDayOf(ms: number): string {
  assertFinite(ms, '時刻')
  const d = new Date(ms + JST_OFFSET_MS)
  const y = String(d.getUTCFullYear()).padStart(4, '0')
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0')
  const da = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${mo}${da}`
}

/**
 * 区間の和で `target` を隙間なく覆えているか。端が接していれば繋がっているとみなす。
 * 有限でない端を持つ区間と逆向きの区間は数えない（覆っている側へ倒さない）。
 */
export function covers(intervals: readonly Interval[], target: Interval): boolean {
  assertFinite(target.fromMs, 'target.fromMs')
  assertFinite(target.toMs, 'target.toMs')
  if (target.fromMs > target.toMs) throw new Error('覆いの目標が逆向き')
  const sorted = intervals
    .filter((iv) => Number.isFinite(iv.fromMs) && Number.isFinite(iv.toMs) && iv.fromMs <= iv.toMs)
    .toSorted((a, b) => a.fromMs - b.fromMs)
  let reached = target.fromMs
  for (const iv of sorted) {
    if (iv.fromMs > reached) break
    reached = Math.max(reached, iv.toMs)
    if (reached >= target.toMs) return true
  }
  return reached >= target.toMs
}

/**
 * 覆いの判定に使う区間。WebSocket の区間だけを削り、一覧で取り戻した区間（DMDATA の時計）は削らない。
 * 区間の終わりは `nowMs` で頭打ちにする（中継の時計が進んでいたなどで未来の心拍が記録されても、まだ来ていない
 * 時間を見ていたことにしない）。
 */
export function observedIntervals(
  sessions: readonly LiveSession[],
  gapfills: readonly Interval[],
  nowMs: number,
  params: DayStateParams,
): Interval[] {
  const live = sessions.map((s) => ({
    fromMs: s.connectedMs + params.clockMarginMs,
    toMs: Math.min(sessionEnd(s), nowMs) - params.clockMarginMs,
  }))
  return [...live, ...gapfills]
}

/**
 * 状態を変えないが、起きないはずの組み合わせ。記録に残す。
 * - `telegrams-without-archive`: 索引に電文があるのに、48 時間たっても目録に載らない
 * - `listed-but-index-empty`: 隙間なく見ていたのに、目録に載っている（＝電文がある）日の索引が空（運用開始以降の日だけ）
 * - `archive-fetch-failed`: 目録に載ったのに本体の取り込みに失敗している（運用開始以降の日。前の日は `failed`）
 */
export type DayAnomaly = 'telegrams-without-archive' | 'listed-but-index-empty' | 'archive-fetch-failed'

export interface DayStateResult {
  state: DayState
  anomalies: readonly DayAnomaly[]
}

/**
 * 日の状態を事実から決める。
 *
 * @param operationStartDay 運用開始の日（中継が初めて DMDATA の WebSocket に繋がった JST の日）。まだ繋がって
 *   いなければ null で、すべての日を運用開始より前として扱う
 * @param sessions WebSocket の繋がりの記録。区分によらず共通（1 本の接続が両方の区分を運ぶ）
 */
export function dayState(
  facts: DayFacts,
  sessions: readonly LiveSession[],
  operationStartDay: string | null,
  nowMs: number,
  params: DayStateParams,
): DayStateResult {
  validateDayStateParams(params)
  assertFinite(nowMs, 'nowMs')
  if (!Number.isInteger(facts.telegramCount) || facts.telegramCount < 0) {
    throw new Error(`telegramCount が 0 以上の整数でない: ${facts.telegramCount}`)
  }
  const dayStart = jstDayStartMs(facts.day) // 形と実在を確かめる（運用開始より前の日も）
  if (operationStartDay !== null) jstDayStartMs(operationStartDay)

  const { archive } = facts
  const anomalies: DayAnomaly[] = []
  const result = (state: DayState): DayStateResult => ({ state, anomalies })

  if (archive.ingestedAtMs !== null) return result('reconciled')

  const empty = facts.telegramCount === 0
  const listed = archive.listedAtMs !== null
  // 目録に載っていれば電文があるので、「無い」の根拠は失われる。空と確かめた後で載った日も、取り込むまで空の束を
  // 引っ込める（2026-10-26 ユーザー承認。問い「【空と確定した日が後で目録に載ったとき】」に選択肢
  // 「空の束を引っ込める (Recommended)」）。
  const absent = archive.absentConfirmedAtMs !== null && !listed

  const beforeOperation = operationStartDay === null || facts.day < operationStartDay
  if (beforeOperation) {
    // 運用開始より前の日は過去分の控え（§5.4）だけが動かす。WebSocket の区間は見ない。
    if (listed && archive.lastFetchFailedAtMs !== null) return result('failed')
    if (absent) return result('confirmed-empty')
    return result('unfetched')
  }

  const dayEnd = dayStart + 24 * HOUR
  if (nowMs < dayEnd + params.closeDelayMs + params.clockMarginMs) return result('open')

  if (listed && archive.lastFetchFailedAtMs !== null) anomalies.push('archive-fetch-failed')

  // 空で、DMDATA 側にも無いと確かめた日は、見ていない時間があっても空と確定する（2026-10-26 ユーザー承認。
  // 問い「【抜け出せない日】」に選択肢「空なら空と確定・他は待ち続ける (Recommended)」）。
  // 警報の区分はアーカイブが警報の出た日にしか作られないので、これが無いと見ていない時間のあった日が永久に gapped で残る。
  if (absent && empty) return result('confirmed-empty')
  // 電文があるのにアーカイブが作られない日は本来起きない。状態は変えずに印を付け、目録は見続ける。
  if (absent && !empty) anomalies.push('telegrams-without-archive')

  const gapfills = facts.classification === 'eew.warning' ? [] : facts.gapfills
  const watched = covers(observedIntervals(sessions, gapfills, nowMs, params), {
    fromMs: dayStart,
    toMs: dayEnd + params.closeDelayMs,
  })
  // 目録に載っているのに索引が空なら、電文があったのに索引に無い。空の束は出さない。
  // 見ていない時間があった日は取り込むまでこの形が普通なので、印は「隙間なく見ていたのに」のときだけ付ける。
  if (listed && empty) {
    if (watched) anomalies.push('listed-but-index-empty')
    return result('gapped')
  }
  return result(watched ? 'observed' : 'gapped')
}

/** 束を出してよい状態。 */
export function servesBundle(state: DayState): boolean {
  return state === 'observed' || state === 'reconciled' || state === 'confirmed-empty'
}

/** アーカイブの本体を取りに行くべきか（目録に載り、まだ取り込めていない）。失敗した日も周回ごとに取り直す。 */
export function needsIngest(archive: ArchiveFacts): boolean {
  return archive.listedAtMs !== null && archive.ingestedAtMs === null
}

/**
 * 目録を見た結果。**`absent-from-complete-listing` を渡してよいのは、次をすべて満たすときだけ:**
 * 応答が成功した・最後のページまで辿れた・引いた `datetime` の範囲がその日を両側に余裕を持って含む（目録の
 * `datetime` は左端が排他・右端が包含なので、端の日は落ちうる）。取得の失敗・打ち切り・空へ丸めた応答は、
 * この関数へ渡さない（何も記録しない）。「無い」の印は戻らないので、一度の取り違えでその日が空と確定する。
 */
export type ManifestCheck =
  | { atMs: number; outcome: 'listed' }
  | { atMs: number; outcome: 'absent-from-complete-listing' }

/**
 * 目録を見た結果を事実へ書き足す。印は一度立てたら戻さない ——
 * 状態を毎分計算し直すので、印が揺れると状態も揺れて束が出たり消えたりする。
 */
export function recordManifestCheck(
  archive: ArchiveFacts,
  day: string,
  check: ManifestCheck,
  params: DayStateParams,
): ArchiveFacts {
  validateDayStateParams(params)
  assertFinite(check.atMs, 'check.atMs')
  if (check.outcome === 'listed') {
    return archive.listedAtMs === null ? { ...archive, listedAtMs: check.atMs } : archive
  }
  const waited = check.atMs >= jstDayEndMs(day) + params.absentWaitMs
  // 一度載ったのを見た日は、後で載っていなくても「無い」と読まない（目録の取り損ねの可能性のほうが高い）。
  if (waited && archive.listedAtMs === null && archive.absentConfirmedAtMs === null) {
    return { ...archive, absentConfirmedAtMs: check.atMs }
  }
  return archive
}

/**
 * その日のために次に目録を見るべき時刻。見なくてよければ null。
 *
 * confirmed-empty の後も見続ける（2026-10-26 ユーザー承認。問い「【空と確定した後】」に選択肢
 * 「見続ける・48 時間待つ (Recommended)」）。アーカイブが待ちより遅れて作られた日を偽の空のまま固めないため。
 * 目録は期間で引くので、呼び出し側は全部の日のうち最も早い時刻で 1 回引けばよい。
 */
export function nextManifestCheckMs(
  state: DayState,
  day: string,
  lastCheckMs: number | null,
  params: DayStateParams,
): number | null {
  validateDayStateParams(params)
  if (state === 'reconciled' || state === 'open') return null
  const dayEnd = jstDayEndMs(day)
  if (lastCheckMs === null) return dayEnd
  assertFinite(lastCheckMs, 'lastCheckMs')
  const every =
    lastCheckMs < dayEnd + params.manifestHourlyForMs ? params.manifestHourlyEveryMs : params.manifestDailyEveryMs
  return lastCheckMs + every
}

/** 張り直したときに取り戻す一覧の範囲と、引いてよくなる時刻。 */
export interface GapfillWindow {
  /** 一覧の `datetime` に渡す範囲（DMDATA の時計として解釈される） */
  range: Interval
  /** この時刻（中継の時計）より前に引くと、範囲の終わりが DMDATA にとってまだ来ていないことがある */
  readyAtMs: number
}

/**
 * 張り直したときの取り戻しの範囲。**起点は前の回の区間の終わり**（最後に電文を受けた時刻ではない。
 * 電文の来ない静かな夜のあとにデプロイしただけで長い切断に見えるのを防ぐ）。初めての接続なら null。
 *
 * 範囲の終わりは新しい回の始まりから `clockMarginMs` 先まで延ばす。新しい回は覆いの判定で頭を削られるので、
 * そこまで取り戻さないと削った分が穴になる。範囲が逆向きになる（時計が跳んだ）ときも null を返し、突き合わせに任せる。
 */
export function gapfillWindow(
  previous: LiveSession | null,
  current: LiveSession,
  params: DayStateParams,
): GapfillWindow | null {
  validateDayStateParams(params)
  if (previous === null) return null
  const fromMs = sessionEnd(previous) - params.gapfillLookbackMs
  const toMs = current.connectedMs + params.clockMarginMs
  assertFinite(fromMs, '取り戻しの起点')
  assertFinite(toMs, '取り戻しの終点')
  // 前の回の終わりが新しい回の始まりより大きく後（時計の跳び）なら、範囲を決められない。取り戻さず突き合わせに任せる
  // （null を返す。投げると張り直しの経路が止まる）。
  if (fromMs > toMs) return null
  return { range: { fromMs, toMs }, readyAtMs: toMs + params.clockMarginMs }
}

/**
 * 一覧を引いた結果、本体を取り戻すか、その日のアーカイブとの突き合わせに任せるか。
 *
 * @param listComplete 一覧を最後のページまで辿れたか（失敗・ページの上限での打ち切りなら false）
 * @param missingBodies 一覧にあって索引に無い電文の数
 */
export function gapfillDecision(
  listComplete: boolean,
  missingBodies: number,
  params: DayStateParams,
): 'fetch' | 'leave-to-reconciliation' {
  validateDayStateParams(params)
  if (!Number.isInteger(missingBodies) || missingBodies < 0) {
    throw new Error(`missingBodies が 0 以上の整数でない: ${missingBodies}`)
  }
  return listComplete && missingBodies <= params.gapfillMaxBodies ? 'fetch' : 'leave-to-reconciliation'
}
