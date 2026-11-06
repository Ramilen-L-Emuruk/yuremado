/**
 * 強震モニタの揺れ検知（組み合わせの検知器）へ、丸 1 日単位の秒フレームを通しで流し、
 * 出た検知を気象庁の震源（無感の地震も入る）と突き合わせて精度を測る。
 *
 *   npx tsx scripts/eval-kyoshin-continuous.ts --days=YYYYMMDD[,…] | --from=YYYYMMDD --to=YYYYMMDD [--dry-run] [--fetch] [--max-days=N] [--max-fetch-hours=N]
 *
 * `bench-kyoshin` が地震の前後の窓（数分）を測るのに対し、こちらは**地震を選ばずに 1 日を丸ごと**流す。
 * 「確かな段まで上がった検知のうち、本物の地震に当たるのはどれだけか」「観測網の中で起きた地震のうち、検知できたのはどれだけか」を、
 * 地震の多い日も静かな日も同じ物差しで数えるためのもの。
 *
 * - 秒フレームは `build-kyoshin-quiet-tables` と同じ控え `.cache/kyoshin-quiet-days/<日>-<時>.bin` を読む（形もそちら）。
 *   観測点の座標は `.cache/kyoshin-bench/sites_<版>.json`
 * - 気象庁の震源は、確定値の年の ZIP（`.cache/hypocenter-cache/zip/h<年>.zip`）か、日別の震源リスト
 *   （`.cache/hypocenter-cache/<日>.html`）から読む。どちらも `build-hypocenter-catalog` と同じ控え
 * - **控えに無いものがあれば、取ることになる件数を出して止まる。** `--fetch` を付けたときだけ取る。`--dry-run` は数えるだけ。
 *   秒フレームは 1 時間 3,600 件（西が駄目な秒は東も試す）。1 時間のうち 1 割を取れなかった時点で、その時間は打ち切る。
 *   2 時間続けて 1 秒も取れなければ、配信が無い範囲とみて取得ごと止める。日別の震源リストは 1 日 1 件で、時間より先に取る。
 *   控えに無い時間が {@link MAX_FETCH_HOURS} 時間（`--max-fetch-hours`）を超えるなら、1 件も取らずに止まる
 * - 流す日は実在する今日より前の日に限る。1 回に流す日数の上限は `--max-days`（既定 31）。震源の控えが無い日のうち、
 *   今日から {@link DAILY_SETTLE_DAYS} 日の内の日は、気象庁の日別の震源リストに後から地震が書き足されることがある（出そろっていない）ので取らずに止まる
 * - 続いた日は検知器を作り直さずに流す。前の秒との間隔が 60 秒を超えたとき（控えの無い時間の後も含む）・観測点の版が変わったとき・
 *   続いていない日の頭では作り直し、そこから {@link WARMUP_SEC} 秒は助走とする（アプリは最低 10 分の助走を付けて始めるため。
 *   `src/utils/kyoshinWarmup.ts`）。作り直した秒と直前に流した秒は、日ごとに `runs[].restarts` へ残す
 * - 結果は `.cache/kyoshin-continuous-runs/<最初の日>-<最後の日>-<日数>d.json` に書き、要約を画面に出す。数え方は次の 2 つに分かれる
 *   - **欠けの印（`summary.complete` が false・終了コード 2）を付けるもの**: 控えや震源の側が欠けたもの。控えの無い時間・点数の食い違い・
 *     読めなかった震源の行（期間の日と前日）・出そろう前かもしれない日別の震源リスト（期間の日と前日）。時間の中で数秒欠けるだけなら
 *     付けない（前の秒との間隔が 60 秒以下なら、間の秒は見ていたものとして埋める）。1 秒も無い時間は控えの無い時間と同じに数える
 *   - **印にせず、数えないもの**: 検知器が見ていなかった間。助走の間と、60 秒を超える欠けの間は「見ていた秒」（`watched`。
 *     検知器が地震を拾えた秒）から外れ、その間に見え始めた検知も、その間に起きた地震の取りこぼしも数えない（数は `summary.blindTargets`）。
 *     有感の照合（`eval-kyoshin-felt`）も `runs[].restarts` でその間の地震を数えない。M の決まっていない地震も取りこぼしの母数に入れない
 *     （数は `summary.unknownMagNearNetwork`）。控えの無い時間は両方に当たる（印が付き、その後の助走の間は数えない）
 *
 * 突き合わせの規則は評価台と同じ（`scripts/lib/kyoshinCatalogMatch.ts`）。当てはまった件数には偶然の重なりが混ざるので、
 * **同じ位置・同じ規則で、その日に検知器が見ていた全秒に当てたときに当たる割合（偶然でも当たる見込み）**を並べて出す。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cacheDir } from './lib/cacheDir.mjs'
import { kyoshinBenchCacheDir } from './lib/kyoshinBenchCache'
import { CATALOG_DEEP_FOCUS_KM, type CatalogQuake } from './lib/kyoshinCatalogMatch'
import {
  DAY_MS, JST_OFFSET_MS, MAX_GAP_MS, MISS_MIN_MAG, WARMUP_SEC, dayOf, dayStartMs, jstIso, pad, streamDays, summarizeRun,
  type DayRun, type EventRow,
} from './lib/kyoshinContinuousEval'
import { fetchHour, hourPath, loadSites, readQuietHour } from './build-kyoshin-quiet-tables'
import { DAILY_FETCH_INTERVAL_MS, DAILY_SETTLE_DAYS, fetchDailyHypocenters, readDayHypocenters, settledDay, type DayQuakes } from './lib/hypocenterDays'
import { createEnsembleDetector } from '../src/utils/kyoshinEnsembleDetector'
import { createEnsembleTracker } from '../src/utils/kyoshinEnsembleTracker'
import { validateQuietTables } from '../src/utils/kyoshinQuietTables'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const TABLES_PATH = resolve(HERE, '../public/data/kyoshin-quiet-tables.json')
const OUT_DIR = cacheDir('kyoshin-continuous-runs')
/** 2 時間続けて 1 秒も取れなければ、配信が無い範囲とみて取得を止める */
const EMPTY_HOURS_TO_STOP = 2
/**
 * 1 回に取る秒フレームの時間の上限（既定）。1 時間は最大 7,200 件（西・東）なので、48 時間で最大約 35 万件。
 * 超えるなら 1 件も取らずに止まる（`--max-fetch-hours` で上げられる）
 */
const MAX_FETCH_HOURS = 48

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit?.slice(name.length + 3)
}

/**
 * `--days` か `--from`〜`--to` から、流す日を昇順で返す。実在しない日・今日以降の日・多すぎる日数は弾く。
 * `todayJst` は日本時間の今日（YYYYMMDD）。
 */
export function resolveDays(daysArg: string | undefined, from: string | undefined, to: string | undefined, todayJst: string, maxDays: number): string[] {
  const valid = (d: string) => /^\d{8}$/.test(d) && dayOf(dayStartMs(d)) === d
  let days: string[]
  if (daysArg) {
    days = daysArg.split(',').filter(Boolean)
  } else if (from && to) {
    if (!valid(from) || !valid(to)) throw new Error(`日付は実在する日を YYYYMMDD で渡してください（${from}〜${to}）`)
    if (dayStartMs(to) < dayStartMs(from)) throw new Error(`--to が --from より前です（${from}〜${to}）`)
    days = []
    for (let t = dayStartMs(from); t <= dayStartMs(to); t += DAY_MS) days.push(dayOf(t))
  } else {
    throw new Error('流す日を --days=YYYYMMDD,… か --from=YYYYMMDD --to=YYYYMMDD で渡してください')
  }
  const bad = days.filter((d) => !valid(d))
  if (days.length === 0 || bad.length > 0) throw new Error(`日付は実在する日を YYYYMMDD で渡してください（${bad.join(',') || '空'}）`)
  const future = days.filter((d) => d >= todayJst)
  if (future.length > 0) throw new Error(`今日（${todayJst}）以降の日は流せません（${future.join(',')}）`)
  const unique = [...new Set(days)].sort()
  if (unique.length > maxDays) throw new Error(`流す日が ${unique.length} 日あります。1 回の上限は ${maxDays} 日です（増やすなら --max-days=N）`)
  return unique
}

// ---------------------------------------------------------------------------
// 気象庁の震源
// ---------------------------------------------------------------------------

// 震源の控えの読み書きは scripts/lib/hypocenterDays.ts

/** 控えた秒フレームの見出しから、使われている観測点の版を拾う */
function cfgsOf(day: string, h: number): string[] {
  // 見出しは先頭の 1 行（数十バイト）なので、1 時間ぶん（数 MB）を読まずに先頭だけ読む
  const fd = openSync(hourPath(day, h), 'r')
  try {
    const buf = Buffer.alloc(4096)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const nl = buf.subarray(0, n).indexOf(10)
    if (nl < 0) throw new Error(`${hourPath(day, h)} の見出しの行が読めません`)
    return (JSON.parse(buf.subarray(0, nl).toString('utf8')) as { cfgs: string[] }).cfgs
  } finally {
    closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// 流して数える
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const todayJst = dayOf(Date.now() + JST_OFFSET_MS)
  const maxDays = Number(arg('max-days') ?? 31)
  if (!Number.isInteger(maxDays) || maxDays < 1) throw new Error(`--max-days は 1 以上の整数で渡してください（${arg('max-days')}）`)
  const maxFetchHours = Number(arg('max-fetch-hours') ?? MAX_FETCH_HOURS)
  if (!Number.isInteger(maxFetchHours) || maxFetchHours < 0) throw new Error(`--max-fetch-hours は 0 以上の整数で渡してください（${arg('max-fetch-hours')}）`)
  const days = resolveDays(arg('days'), arg('from'), arg('to'), todayJst, maxDays)
  const dryRun = process.argv.includes('--dry-run')
  const allowFetch = process.argv.includes('--fetch') && !dryRun

  // 控えに無いものを数える（ここまでは 1 件も取らない）
  const missingHours = days.flatMap((d) => Array.from({ length: 24 }, (_, h) => ({ d, h }))).filter(({ d, h }) => !existsSync(hourPath(d, h)))
  const missingQuakeDays = days.filter((d) => readDayHypocenters(d) === null)
  const settled = settledDay(todayJst)
  const unsettled = missingQuakeDays.filter((d) => d > settled)
  if (unsettled.length > 0) throw new Error(`${settled} より新しい日の震源リストは出そろっていないことがあるので取りません（${unsettled.join(',')}）。日を改めて走らせてください`)
  // 控えにあっても、出そろう前に取った日別の震源リストかもしれない（他の道具が取った控えなど）
  const earlyCached = days.filter((d) => d > settled && readDayHypocenters(d)?.source === '日別の震源リスト')
  if (earlyCached.length > 0) console.log(`  注意: ${earlyCached.join(' ')} は控えの日別の震源リストを使う。${DAILY_SETTLE_DAYS} 日以内の日は出そろう前に取った控えかもしれない`)
  const knownCfgs = new Set(days.flatMap((d) => Array.from({ length: 24 }, (_, h) => h).filter((h) => existsSync(hourPath(d, h))).flatMap((h) => cfgsOf(d, h))))
  const missingSites = [...knownCfgs].filter((c) => !existsSync(join(kyoshinBenchCacheDir(), `sites_${c}.json`)))
  console.log(`流す日 ${days.length} 日（${days[0]}〜${days[days.length - 1]}）`)
  console.log(`  控えに無い時間 ${missingHours.length} 件 → 取ると最大 ${missingHours.length * 3600 * 2} 件（1 秒につき西・東の 2 件まで。1 時間 3,600 秒・4 並列で 1〜3 分ほど）`)
  console.log(`  震源の控えが無い日 ${missingQuakeDays.length} 件 → 取ると ${missingQuakeDays.length} 件${missingQuakeDays.length ? `（${missingQuakeDays.join(' ')}）` : ''}`)
  console.log(`  控えにある観測点の版 ${knownCfgs.size} 件・観測点リストが無い版 ${missingSites.length} 件${missingSites.length ? `（${missingSites.join(' ')}。取ると 1 版 1 件）` : ''}（まだ取っていない時間の版は数えていない）`)
  if (dryRun) return
  if ((missingHours.length > 0 || missingQuakeDays.length > 0 || missingSites.length > 0) && !allowFetch) {
    throw new Error('控えが足りないので止めます（取るなら --fetch を付けて走らせ直してください）')
  }
  if (missingHours.length > maxFetchHours) {
    throw new Error(`控えに無い時間が ${missingHours.length} 件あり、1 回に取る上限 ${maxFetchHours} 時間を超えるので 1 件も取らずに止めます（日を分けるか、--max-fetch-hours=N で上限を上げてください）`)
  }

  // 震源リストは 1 日 1 件で、取れない日（配信の範囲外）が分かるのはここなので、時間より先に取る
  for (const d of missingQuakeDays) {
    await fetchDailyHypocenters(d)
    console.log(`  ${d} の震源リストを控えた`)
    await sleep(DAILY_FETCH_INTERVAL_MS)
  }
  const short: string[] = []
  let emptyRun = 0
  for (const [i, { d, h }] of missingHours.entries()) {
    const got = await fetchHour(d, h)
    const enough = existsSync(hourPath(d, h))
    console.log(`  [${i + 1}/${missingHours.length}] ${d}-${pad(h)} 取れた ${got} 秒${enough ? '' : '（9 割に届かず控えない）'}`)
    if (!enough) short.push(`${d}-${pad(h)}`)
    emptyRun = got === 0 ? emptyRun + 1 : 0
    if (emptyRun >= EMPTY_HOURS_TO_STOP) {
      if (short.length > 0) console.log(`取れた秒が 9 割に届かず控えなかった時間 ${short.length} 件（${short.join(' ')}）`)
      throw new Error(`${EMPTY_HOURS_TO_STOP} 時間続けて 1 秒も取れませんでした（${d}-${pad(h)} まで）。配信の無い範囲か通信の障害とみて止めます`)
    }
  }
  if (short.length > 0) console.log(`取れた秒が 9 割に届かず控えなかった時間 ${short.length} 件（${short.join(' ')}）。その時間は見ていない時間として流す`)

  const tables: unknown = JSON.parse(readFileSync(TABLES_PATH, 'utf8'))
  validateQuietTables(tables)
  const tableDays = new Set(tables.days)
  const fromFrameMs = dayStartMs(days[0])

  // 期間の頭の検知が前日の地震に当たれるよう、控えにあれば前日の震源も読む（取りには行かない）
  const prev = (() => {
    try {
      return readDayHypocenters(dayOf(fromFrameMs - DAY_MS))
    } catch (e) {
      console.log(`前日の震源の控えを読めなかったので使わない: ${e instanceof Error ? e.message : e}`)
      return null
    }
  })()
  const quakes: CatalogQuake[] = prev ? [...prev.quakes] : []
  const dayQuakes = new Map<string, DayQuakes>()
  for (const day of days) {
    const q = readDayHypocenters(day)
    if (q === null) throw new Error(`${day} の震源が控えにありません`)
    dayQuakes.set(day, q)
    quakes.push(...q.quakes)
  }

  const stream = await streamDays(days, {
    hourFrames: (day, h) => {
      const p = hourPath(day, h)
      return existsSync(p) ? readQuietHour(readFileSync(p), day) : null
    },
    loadSites: (cfg) => loadSites(cfg, allowFetch),
    createTracker: (sites) => createEnsembleTracker(sites, createEnsembleDetector(sites, tables)),
    onDayStreamed: (r) => console.log(
      `  ${r.day} を流した（${r.frames} 秒${r.lostSec ? `・秒フレームの無い秒 ${r.lostSec}` : ''}` +
      `${r.missingHours.length ? `・控えの無い時間 ${r.missingHours.join(',')} 時` : ''}${r.mismatched ? `・点数が食い違った秒 ${r.mismatched}` : ''}）`,
    ),
  })
  const runs: DayRun[] = stream.days.map((s) => {
    const q = dayQuakes.get(s.day)!
    return { ...s, quakeSource: q.source, quakeCount: q.quakes.length, unreadableQuakeRows: q.unreadable, tableDay: tableDays.has(s.day) }
  })
  for (const run of runs) {
    console.log(
      `${run.day}: 流した ${run.frames} 秒${run.lostSec ? `（秒フレームの無い秒 ${run.lostSec}）` : ''}・見ていた ${run.watched} 秒（1 日の ${(run.watched / 864).toFixed(1)}%）・最長の見ていない続き ${run.longestBlindSec} 秒` +
      `・${run.quakeSource} ${run.quakeCount} 件${run.unreadableQuakeRows ? `（読めなかった行 ${run.unreadableQuakeRows}）` : ''}` +
      `${run.missingHours.length ? `・控えの無い時間 ${run.missingHours.join(',')} 時` : ''}${run.mismatched ? `・点数が食い違った秒 ${run.mismatched}` : ''}` +
      `${run.tableDay ? '・平常のゆらぎの表を焼いた日' : ''}`,
    )
  }

  // 前日の控えも、出そろう前に取った日別の震源リストかもしれない（期間の頭の検知が当たれる地震が足りなくなる）
  const prevDay = dayOf(fromFrameMs - DAY_MS)
  const earlyQuakeDays = prev?.source === '日別の震源リスト' && prevDay > settled ? [prevDay, ...earlyCached] : earlyCached
  report(days, runs, stream.events, quakes, stream.sitesOfDay, stream.watched, fromFrameMs, prev !== null, prev?.unreadable ?? 0, earlyQuakeDays)
}

function report(
  days: string[], runs: DayRun[], events: EventRow[], quakes: CatalogQuake[],
  sitesOfDay: Map<string, [number, number][]>, watched: Uint8Array, fromFrameMs: number, prevDayQuakes: boolean,
  prevDayUnreadableRows: number, earlyQuakeDays: string[],
): void {
  const { rows, confirmed, chances, missed, blindDays, summary } = summarizeRun({
    runs, events, quakes, sitesOfDay, watched, fromFrameMs, prevDayQuakes, prevDayUnreadableRows, earlyQuakeDays,
  })
  const { complete } = summary
  const likelyOnly = rows.filter((r) => r.firstConfirmedMs === null)

  console.log('')
  console.log(`期間 ${days[0]}〜${days[days.length - 1]}（${days.length} 日）・見ていた ${summary.watchedSec} 秒・作り直した直後 ${WARMUP_SEC} 秒の検知 ${summary.warmupEvents} 件は数えない`)
  console.log(`確かな段 ${confirmed.length} 件: 気象庁の震源に当たる ${summary.confirmedMatched} 件・偶然でも当たる見込み ${summary.confirmedChance.toFixed(1)} 件`)
  console.log(`早い段どまり ${likelyOnly.length} 件: 当たる ${summary.likelyOnlyMatched} 件・偶然でも当たる見込み ${summary.likelyOnlyChance.toFixed(1)} 件`)
  console.log(`見ていた間に観測網の中で起きた深さ ${CATALOG_DEEP_FOCUS_KM} km 未満の M${MISS_MIN_MAG} 以上 ${summary.targets} 件: 束が当たった ${summary.targets - summary.missed} 件・当たらなかった ${summary.missed} 件（見ていない時間に掛かった ${summary.blindTargets} 件・M が決まっていない ${summary.unknownMagNearNetwork} 件は数えていない）`)
  if (summary.deepTargets > 0) console.log(`  深さ ${CATALOG_DEEP_FOCUS_KM} km 以上の M${MISS_MIN_MAG} 以上 ${summary.deepTargets} 件（震央の真上は揺れにくいので上の数とは別）: 束が当たった ${summary.deepWithBundle} 件`)
  if (summary.noSiteDayTargets > 0) console.log(`  秒フレームが 1 つも無い日の M${MISS_MIN_MAG} 以上 ${summary.noSiteDayTargets} 件は、観測網の内外を判定できないので上の数に入れていない`)
  for (const r of confirmed.filter((r) => !r.matched)) console.log(`  当たらない確かな段 ${r.firstConfirmedAt} 点数${r.maxMembers} ${r.pos.map((x) => x.toFixed(2)).join(',')}`)
  for (const q of missed) console.log(`  束の無い地震 ${jstIso(q.t + JST_OFFSET_MS)} M${q.mag} ${q.lat.toFixed(2)},${q.lng.toFixed(2)}`)
  if (summary.tableDays.length > 0) console.log(`平常のゆらぎの表を焼いた日 ${summary.tableDays.join(' ')} が入っている（その日の誤報は少なめに出る）`)
  if (blindDays.length > 0) console.log(`欠けのある日 ${blindDays.length} 件（${blindDays.map((r) => r.day).join(' ')}）。控えの無い時間・読めなかった震源の行・点数の食い違いがある`)
  if (prevDayUnreadableRows > 0) console.log(`前日の震源の控えに読めなかった行が ${prevDayUnreadableRows} 行ある（期間の頭の検知がその地震に当たれない。欠けの印を付ける）`)
  if (earlyQuakeDays.length > 0) console.log(`出そろう前に取ったかもしれない日別の震源リストを使った日 ${earlyQuakeDays.join(' ')}（取りこぼしが少なく出うる。欠けの印を付ける）`)
  const restarts = runs.reduce((s, r) => s + r.restarts.length, 0)
  console.log(`検知器を作り直した ${restarts} 回（控えの無い時間の後・観測点の版の変わり目・${MAX_GAP_MS / 1000} 秒を超える途切れの後。各日の restarts に残す）`)
  if (!prevDayQuakes) console.log('前日の震源の控えが無いので、期間の頭の検知は前日の地震に当たれない（その分、初日の数字は不利に出る）')

  mkdirSync(OUT_DIR, { recursive: true })
  const out = join(OUT_DIR, `${days[0]}-${days[days.length - 1]}-${days.length}d.json`)
  writeFileSync(out, JSON.stringify({
    timeBasis: '*Ms の欄は控えの時刻（日本時間をそのまま UTC として数えたミリ秒）。*At の欄は日本時間の ISO 文字列',
    days, runs, warmupSec: WARMUP_SEC, tables: TABLES_PATH, summary,
    events: rows.map((r) => ({ ...r, chance: chances.get(r.id) })),
    missed: missed.map((q) => ({ at: jstIso(q.t + JST_OFFSET_MS), mag: q.mag, lat: q.lat, lng: q.lng })),
  }, null, 1) + '\n')
  console.log(`書き出した: ${out}`)
  if (!complete) process.exitCode = 2
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
