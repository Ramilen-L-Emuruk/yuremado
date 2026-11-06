/**
 * 連続した日の秒フレームを検知器へ流す処理（{@link streamDays}）と、出た検知を気象庁の震源と突き合わせて数える処理（{@link summarizeRun}）。
 *
 * `scripts/eval-kyoshin-continuous.ts` が使う。どちらもファイルと配信元には触れない（秒フレームの読み出し・観測点リスト・検知器は
 * 呼び出し側が渡す）ので、合成のフレームと偽の検知器でテストできる。
 *
 * 時刻は 2 種類ある。秒フレームと検知の `*Ms` は**控えの時刻**（日本時間の時計をそのまま UTC として数えたミリ秒）、
 * 気象庁の震源の `t` は実時刻（UTC のミリ秒）。突き合わせの前に {@link JST_OFFSET_MS} を引いて揃える。
 */
import { CATALOG_DEEP_FOCUS_KM, chanceOfMatch, matchCatalog, watchedQuakes, type CatalogQuake } from './kyoshinCatalogMatch'
import type { EnsembleDetection } from '../../src/utils/kyoshinEnsembleTracker'
import { haversineKm } from '../../src/utils/geo'
import type { QuakeSource } from './hypocenterDays'

export const JST_OFFSET_MS = 9 * 3_600_000
export const DAY_SEC = 86_400
export const DAY_MS = DAY_SEC * 1000
/** 検知器を作り直してから「見ていない」扱いにする秒数（アプリの助走の最低の長さ `WARMUP_MIN_BLOCKS` × 60 秒と揃える） */
export const WARMUP_SEC = 600
/**
 * 前の秒フレームとの間隔がこれより長ければ、時間が飛んだまま流さずに検知器を作り直す。
 * これ以下（欠けは最大 59 秒）なら、間の秒を見ていた秒として埋める
 */
export const MAX_GAP_MS = 60_000
/** 取りこぼしを数える地震の M の下限と、観測点からの距離の上限（km）。観測網の外の地震は数えない */
export const MISS_MIN_MAG = 3
export const MISS_MAX_SITE_KM = 50

/** 控えの時刻（日本時間をそのまま UTC として数えたミリ秒）の日の頭 */
export const dayStartMs = (day: string) => Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8))
export const dayOf = (frameMs: number) => new Date(frameMs).toISOString().slice(0, 10).replace(/-/g, '')
/** 控えの時刻を、日本時間と分かる ISO 文字列にする */
export const jstIso = (frameMs: number) => new Date(frameMs).toISOString().slice(0, 19) + '+09:00'
export const pad = (n: number) => String(n).padStart(2, '0')

// ---------------------------------------------------------------------------
// 流す
// ---------------------------------------------------------------------------

/** 控えの 1 秒（`build-kyoshin-quiet-tables` の `readQuietHour` が返す形） */
export interface QuietFrame {
  /** 控えの時刻 */
  ms: number
  /** 観測点リストの版 */
  cfg: string
  values: Int8Array
}

/** 検知器が返す検知のうち、ここで読む欄 */
export type TrackedDetection = Pick<EnsembleDetection, 'id' | 'confidence' | 'epicenter' | 'memberKeys'>

export interface StreamDeps {
  /** その日・その時（0〜23）の秒フレームを時刻順に。控えが無ければ null（1 秒も無い時間は、控えが無い時間と同じに扱う） */
  hourFrames(day: string, hour: number): Iterable<QuietFrame> | null
  /** 観測点リストの版から、観測点の座標（緯度・経度）の並び */
  loadSites(cfg: string): Promise<[number, number][]>
  /** 検知器を作る。版が変わったとき・途切れたときに作り直す */
  createTracker(sites: [number, number][]): { push(f: { ms: number; values: Int8Array }): Iterable<TrackedDetection> }
  /**
   * 1 日を流し終えるたびに呼ぶ（進み具合を出すため）。見ていた秒と見ていなかった最長の続きは、次の日の頭で埋まる分が
   * あるので全部流し終えてから数える。ここで渡す `watched`・`longestBlindSec` はまだ 0 のまま
   */
  onDayStreamed(run: Readonly<DayStream>): void
}

export interface EventRow {
  id: string
  /** 見え始め（早い段に上がった秒）。控えの時刻 */
  firstLikelyMs: number
  firstConfirmedMs: number | null
  /** 束を作った検知の位置（束の間は変わらない） */
  pos: [number, number]
  maxMembers: number
  lastMs: number
  /** 検知器を作り直してから {@link WARMUP_SEC} 秒の内に見え始めた */
  inWarmup: boolean
}

/** 検知器を作り直した点（{@link DayStream.restarts} の 1 つ）。後段の有感の照合（`kyoshinFeltQuakes.ts`）も同じ型で読む */
export interface Restart { afterMs: number | null; atMs: number }

export interface DayStream {
  day: string
  /** 検知器へ流した秒 */
  frames: number
  /** 秒フレームが無かった秒（控えの無い時間・取れなかった秒） */
  lostSec: number
  /** 検知器が見ていた秒（流した秒から助走の間を除き、前の秒との間隔が 60 秒以下の欠けを埋めたもの。日をまたいで埋めた秒はその秒の日に数える） */
  watched: number
  /** 見ていなかった最長の続き（秒） */
  longestBlindSec: number
  /** 観測点リストと点数が食い違って流せなかった秒 */
  mismatched: number
  missingHours: number[]
  /**
   * 検知器を作り直した点（いつ作り直したかは {@link streamDays}）。`afterMs` は直前に流した秒（期間の頭なら null）、`atMs` は作り直した秒。
   * `afterMs` から `atMs` までと、そこから {@link WARMUP_SEC} 秒は見ていない。後段の有感の照合が、その間の地震を数えないために読む
   */
  restarts: Restart[]
}

export interface StreamResult {
  /** 期間の頭（最初の日の 0 時）の控えの時刻 */
  fromFrameMs: number
  /** 検知器が見ていた秒（期間の頭から 1 秒刻み） */
  watched: Uint8Array
  events: EventRow[]
  days: DayStream[]
  /** 日ごとに使われた観測点（その日に出てきた版の和集合）。取りこぼしを数える「観測網の中」の判定に使う */
  sitesOfDay: Map<string, [number, number][]>
}

/**
 * 昇順の日 `days` の秒フレームを、続いた日は検知器を作り直さずに流す。
 * 前の秒との間隔が {@link MAX_GAP_MS} を超えたとき・観測点の版が変わったとき・最初の秒では作り直し、そこから {@link WARMUP_SEC} 秒は
 * 「見ていない」扱いにする。助走の間に見え始めた検知には `inWarmup` を立てる。
 * 渡された日のその時に入らない時刻・秒の刻みでない時刻の秒（控えが壊れている）は、黙って捨てずに止める。
 */
export async function streamDays(days: readonly string[], deps: StreamDeps): Promise<StreamResult> {
  const fromFrameMs = dayStartMs(days[0])
  const spanSec = (dayStartMs(days[days.length - 1]) - fromFrameMs) / 1000 + DAY_SEC
  const watched = new Uint8Array(spanSec)
  const events = new Map<string, EventRow>()
  const streams: DayStream[] = []
  const daySites = new Map<string, Map<string, [number, number]>>()
  const dayCfgs = new Map<string, Set<string>>()
  let cfg: string | null = null
  let sites: [number, number][] = []
  let tracker: ReturnType<StreamDeps['createTracker']> | null = null
  let restartMs = -Infinity
  let lastFrameMs = -Infinity
  // 検知器を作り直すと束の id が振り直されるので、何代目の検知器かを id に添えて重ならないようにする
  let generation = 0

  for (const day of days) {
    const run: DayStream = { day, frames: 0, lostSec: 0, watched: 0, longestBlindSec: 0, mismatched: 0, missingHours: [], restarts: [] }
    for (let h = 0; h < 24; h++) {
      const frames = deps.hourFrames(day, h)
      if (frames === null) { run.missingHours.push(h); continue }
      const hourStartMs = dayStartMs(day) + h * 3_600_000
      let inHour = 0
      for (const f of frames) {
        if (f.cfg === '') throw new Error(`${day}-${pad(h)} の控えに観測点の版が書かれていない秒があります（控えを消して取り直してください）`)
        if (!(f.ms >= hourStartMs && f.ms < hourStartMs + 3_600_000 && f.ms % 1000 === 0)) {
          throw new Error(`${day}-${pad(h)} の控えに、その時に入らない時刻の秒があります（${f.ms}。控えを消して取り直してください）`)
        }
        inHour++
        // 観測点の版が変わったとき・前の秒から途切れたとき（控えの無い時間を飛ばした・続いていない日）は作り直す
        if (f.cfg !== cfg || tracker === null || f.ms - lastFrameMs > MAX_GAP_MS) {
          if (f.cfg !== cfg) {
            sites = await deps.loadSites(f.cfg)
            cfg = f.cfg
          }
          tracker = deps.createTracker(sites)
          run.restarts.push({ afterMs: Number.isFinite(lastFrameMs) ? lastFrameMs : null, atMs: f.ms })
          restartMs = f.ms
          generation++
        }
        // 点数が食い違う秒は流せない。秒フレームが無い秒と同じ扱いにする（途切れの起点にしないので、次の正常な秒までが
        // 間隔が 60 秒以下なら下で埋め、それより長ければ次の秒で検知器を作り直す）
        if (sites.length !== f.values.length) { run.mismatched++; continue }
        // 作り直さずに続けた欠け（無い秒・食い違った秒。前の秒との間隔が 60 秒以下）は、検知器が続けて見ていたものとして埋める
        // （1 秒の欠けで地震を母集団から落とさない）。前の日の終わりの秒も埋まる
        const fillFrom = restartMs === f.ms ? f.ms : lastFrameMs + 1000
        for (let t = fillFrom; t <= f.ms; t += 1000) {
          const sec = (t - fromFrameMs) / 1000
          if (t - restartMs >= WARMUP_SEC * 1000 && sec >= 0 && sec < spanSec) watched[sec] = 1
        }
        lastFrameMs = f.ms
        run.frames++
        let used = dayCfgs.get(day)
        if (!used) { used = new Set(); dayCfgs.set(day, used) }
        if (!used.has(f.cfg)) {
          used.add(f.cfg)
          let m = daySites.get(day)
          if (!m) { m = new Map(); daySites.set(day, m) }
          for (const s of sites) m.set(`${s[0]},${s[1]}`, s)
        }
        for (const det of tracker.push({ ms: f.ms, values: f.values })) {
          const key = `${generation}:${det.id}`
          let e = events.get(key)
          if (!e) {
            e = { id: key, firstLikelyMs: f.ms, firstConfirmedMs: null, pos: [det.epicenter[0], det.epicenter[1]], maxMembers: 0, lastMs: f.ms, inWarmup: f.ms - restartMs < WARMUP_SEC * 1000 }
            events.set(key, e)
          }
          if (det.confidence === 'confirmed' && e.firstConfirmedMs === null) e.firstConfirmedMs = f.ms
          e.maxMembers = Math.max(e.maxMembers, det.memberKeys.length)
          e.lastMs = f.ms
        }
      }
      if (inHour === 0) run.missingHours.push(h)
    }
    run.lostSec = DAY_SEC - run.frames - run.mismatched
    streams.push(run)
    deps.onDayStreamed(run)
  }

  // 見ていた秒と、見ていなかった最長の続きは、日の終わりの秒が次の日の頭で埋まり終えてから数える
  for (const run of streams) {
    const base = (dayStartMs(run.day) - fromFrameMs) / 1000
    let blind = 0
    for (let s = 0; s < DAY_SEC; s++) {
      if (watched[base + s]) { run.watched++; blind = 0 } else blind++
      run.longestBlindSec = Math.max(run.longestBlindSec, blind)
    }
  }

  const sitesOfDay = new Map<string, [number, number][]>([...daySites].map(([d, m]) => [d, [...m.values()]]))
  return { fromFrameMs, watched, events: [...events.values()], days: streams, sitesOfDay }
}

// ---------------------------------------------------------------------------
// 数える
// ---------------------------------------------------------------------------

export interface DayRun extends DayStream {
  quakeSource: QuakeSource
  quakeCount: number
  /** 震源の控えのうち読めなかった行 */
  unreadableQuakeRows: number
  /** 平常のゆらぎの表を焼いた日（誤報の少なさを測るには甘い日） */
  tableDay: boolean
}

export interface SummaryInput {
  runs: DayRun[]
  events: EventRow[]
  /** 期間（と、控えにあれば前日）の震源 */
  quakes: CatalogQuake[]
  sitesOfDay: Map<string, [number, number][]>
  watched: Uint8Array
  fromFrameMs: number
  /** 前日の震源を読めた */
  prevDayQuakes: boolean
  /** 前日の震源の控えのうち読めなかった行（前日を読めなかったときは 0） */
  prevDayUnreadableRows: number
  /** 出そろう前に取ったかもしれない日別の震源リストを使った日（出そろう日数より新しい日で、確定値の無い日） */
  earlyQuakeDays: string[]
}

export interface MatchedRow extends EventRow {
  firstLikelyAt: string
  firstConfirmedAt: string | null
  matched: { at: string; mag: number | null; km: number } | null
}

/**
 * 助走の外の検知を気象庁の震源と突き合わせ、偶然でも当たる見込みと、取りこぼしを数える。
 */
export function summarizeRun(input: SummaryInput) {
  const { runs, events, quakes, sitesOfDay, watched, fromFrameMs, prevDayQuakes, prevDayUnreadableRows, earlyQuakeDays } = input
  const fromMs = fromFrameMs - JST_OFFSET_MS
  const counted = events.filter((e) => !e.inWarmup)
  const rows: MatchedRow[] = counted.map((e) => {
    const m = matchCatalog(e.firstLikelyMs - JST_OFFSET_MS, e.pos, quakes)
    return {
      ...e,
      firstLikelyAt: jstIso(e.firstLikelyMs),
      firstConfirmedAt: e.firstConfirmedMs === null ? null : jstIso(e.firstConfirmedMs),
      matched: m ? { at: jstIso(m.quake.t + JST_OFFSET_MS), mag: Number.isFinite(m.quake.mag) ? m.quake.mag : null, km: Math.round(m.km) } : null,
    }
  })
  const confirmed = rows.filter((r) => r.firstConfirmedMs !== null)
  const likelyOnly = rows.filter((r) => r.firstConfirmedMs === null)

  // 偶然の見込み: 検知ごとに、見え始めた日のうち検知器が見ていた秒で当たる割合を足す。震源はその日の前後だけ渡す
  const chanceOf = (r: MatchedRow) => {
    const dayFrame = Math.floor(r.firstLikelyMs / DAY_MS) * DAY_MS
    const dayFrom = dayFrame - JST_OFFSET_MS
    const near = quakes.filter((q) => q.t >= dayFrom - DAY_MS && q.t < dayFrom + 2 * DAY_MS)
    const off = (dayFrame - fromFrameMs) / 1000
    return chanceOfMatch(r.pos, near, dayFrom, DAY_SEC, watched.subarray(off, off + DAY_SEC))
  }
  const chances = new Map(rows.map((r) => [r.id, chanceOf(r)]))
  const sumChance = (rs: MatchedRow[]) => rs.reduce((s, r) => s + (chances.get(r.id) ?? 0), 0)

  // 取りこぼし: 観測網の中（いずれかの観測点から MISS_MAX_SITE_KM 以内）で、検知器が見ていた間に起きた M3 以上
  // その地震が起きた日に使われていた観測点で判定する（新しい版で増えた点で古い日の網を広げない）
  const nearNetwork = (q: CatalogQuake) =>
    (sitesOfDay.get(dayOf(q.t + JST_OFFSET_MS)) ?? []).some(([lat, lng]) => haversineKm(lat, lng, q.lat, q.lng) <= MISS_MAX_SITE_KM)
  const inSpan = (q: CatalogQuake) => q.t >= fromMs && q.t < fromMs + watched.length * 1000
  const bigNear = quakes.filter((q) => q.mag >= MISS_MIN_MAG && inSpan(q)).filter(nearNetwork)
  const targets = watchedQuakes(bigNear, fromMs, watched)
  /** 期間内・観測網の中の M3 以上のうち、見ていない時間（助走・欠け）に掛かって数えなかった地震 */
  const blindTargets = bigNear.length - targets.length
  /** 観測点を 1 つも引けなかった日（有効な秒が無い日）の M3 以上。網の内外を判定できないので、上の数のどれにも入らない */
  const noSiteDayTargets = quakes.filter((q) => q.mag >= MISS_MIN_MAG && inSpan(q) && !sitesOfDay.has(dayOf(q.t + JST_OFFSET_MS))).length
  const unknownMag = watchedQuakes(quakes.filter((q) => !Number.isFinite(q.mag) && inSpan(q)).filter(nearNetwork), fromMs, watched).length
  const hasBundle = (q: CatalogQuake) => rows.some((r) => matchCatalog(r.firstLikelyMs - JST_OFFSET_MS, r.pos, [q]) !== null)
  // 深い地震は震央の真上がほとんど揺れない（異常震域）。検知器では直せない分なので、取りこぼしの母数から外して別の行で数える
  const isDeep = (q: CatalogQuake) => Number.isFinite(q.depth) && q.depth >= CATALOG_DEEP_FOCUS_KM
  const deepTargets = targets.filter(isDeep)
  const deepWithBundle = deepTargets.filter(hasBundle).length
  const shallowTargets = targets.filter((q) => !isDeep(q))
  const missed = shallowTargets.filter((q) => !hasBundle(q))

  // 欠けの判定は日の並び方に依らない量で行う（助走は欠けに数えない）。控えは 1 時間の 9 割で保存するので、時間の中で数秒欠けるのは
  // ふつうに起きる。印を付けるのは、時間ごと無い・点数が食い違った・震源の行を読めなかった日と、前日の震源の行を読めなかった・
  // 出そろう前かもしれない震源リストを使った期間。
  // 時間の中で 60 秒を超えて途切れた後の助走は印にしない（見ていない秒として watched から外れ、日の restarts に残るので、
  // 取りこぼしの母数からも有感の照合からも外れる）
  const blindDays = runs.filter((r) => r.missingHours.length > 0 || r.mismatched > 0 || r.unreadableQuakeRows > 0)
  const complete = blindDays.length === 0 && prevDayUnreadableRows === 0 && earlyQuakeDays.length === 0
  const summary = {
    confirmed: confirmed.length, confirmedMatched: confirmed.filter((r) => r.matched).length, confirmedChance: sumChance(confirmed),
    likelyOnly: likelyOnly.length, likelyOnlyMatched: likelyOnly.filter((r) => r.matched).length, likelyOnlyChance: sumChance(likelyOnly),
    targets: shallowTargets.length, missed: missed.length, deepTargets: deepTargets.length, deepWithBundle, blindTargets, noSiteDayTargets, unknownMagNearNetwork: unknownMag,
    warmupEvents: events.length - counted.length,
    watchedSec: runs.reduce((s, r) => s + r.watched, 0), mismatchedSec: runs.reduce((s, r) => s + r.mismatched, 0),
    tableDays: runs.filter((r) => r.tableDay).map((r) => r.day),
    sources: { 確定値: runs.filter((r) => r.quakeSource === '確定値').length, 日別の震源リスト: runs.filter((r) => r.quakeSource === '日別の震源リスト').length },
    complete,
    prevDayQuakes,
    prevDayUnreadableRows,
    earlyQuakeDays,
  }
  return { rows, confirmed, chances, missed, blindDays, summary }
}
