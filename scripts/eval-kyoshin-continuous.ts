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
 *   今日から {@link DAILY_SETTLE_DAYS} 日の内の日は、気象庁の日別の震源リストが出そろっていないことがあるので取らずに止まる
 * - 続いた日は検知器を作り直さずに流す。秒が 60 秒を超えて途切れたとき・観測点の版が変わったとき・続いていない日の頭では作り直し、
 *   そこから {@link WARMUP_SEC} 秒は「見ていない」扱いにする（アプリは最低 10 分の助走を付けて始めるため。`src/utils/kyoshinWarmup.ts`）。
 *   助走の間に見え始めた検知は数えず、その間に起きた地震は取りこぼしにも数えない
 * - 結果は `.cache/kyoshin-continuous-runs/<最初の日>-<最後の日>-<日数>d.json` に書き、要約を画面に出す。
 *   欠け（控えの無い時間・読めなかった震源の行・点数の食い違い）があれば、結果に印を付けて終了コード 2 で終わる。
 *   時間の中で数秒欠けるだけなら印は付けない（60 秒以内の途切れは見ていた秒として埋める）
 *
 * 突き合わせの規則は評価台と同じ（`scripts/lib/kyoshinCatalogMatch.ts`）。当てはまった件数には偶然の重なりが混ざるので、
 * **同じ位置・同じ規則で、その日に検知器が見ていた全秒に当てたときに当たる割合（偶然でも当たる見込み）**を並べて出す。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'
import { cacheDir } from './lib/cacheDir.mjs'
import { kyoshinBenchCacheDir } from './lib/kyoshinBenchCache'
import { CATALOG_DEEP_FOCUS_KM, chanceOfMatch, matchCatalog, watchedQuakes, type CatalogQuake } from './lib/kyoshinCatalogMatch'
import { fetchHour, hourPath, loadSites, readQuietHour } from './build-kyoshin-quiet-tables'
import { parseHypocenterRecord } from './hypocenterRecord'
import { extractDailyHypocenterRows, parseDailyHypocenterLine } from './hypocenterDailyRecord'
import { createEnsembleDetector } from '../src/utils/kyoshinEnsembleDetector'
import { createEnsembleTracker } from '../src/utils/kyoshinEnsembleTracker'
import { validateQuietTables } from '../src/utils/kyoshinQuietTables'
import { haversineKm } from '../src/utils/geo'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const TABLES_PATH = resolve(HERE, '../public/data/kyoshin-quiet-tables.json')
const HYPO_DIR = cacheDir('hypocenter-cache')
const OUT_DIR = cacheDir('kyoshin-continuous-runs')
const DAILY_BASE = 'https://www.data.jma.go.jp/eqev/data/daily_map'
/** 日別の震源リストを続けて取るときの間（`build-hypocenter-catalog` の `DAILY_FETCH_INTERVAL_MS` に倣う） */
const DAILY_FETCH_INTERVAL_MS = 120
const JST_OFFSET_MS = 9 * 3_600_000
const DAY_SEC = 86_400
const DAY_MS = DAY_SEC * 1000
/** 検知器を作り直してから「見ていない」扱いにする秒数（アプリの助走の最低の長さ `WARMUP_MIN_BLOCKS` × 60 秒と揃える） */
export const WARMUP_SEC = 600
/** 秒フレームがこれより長く途切れたら、時間が飛んだまま流さずに検知器を作り直す */
const MAX_GAP_MS = 60_000
/** 取りこぼしを数える地震の M の下限と、観測点からの距離の上限（km）。観測網の外の地震は数えない */
const MISS_MIN_MAG = 3
const MISS_MAX_SITE_KM = 50
/**
 * 日別の震源リストが出そろうまで待つ日数。これより新しい日のリストを取ると、途中までの一覧を確定扱いで控えてしまう。
 * 2026-10-29 のリストは 10-31 に取って 972 件そろっていた（2 日後）。1 日ぶんの余裕を足して 3 日
 */
const DAILY_SETTLE_DAYS = 3
/** 2 時間続けて 1 秒も取れなければ、配信が無い範囲とみて取得を止める */
const EMPTY_HOURS_TO_STOP = 2
/**
 * 1 回に取る秒フレームの時間の上限（既定）。1 時間は最大 7,200 件（西・東）なので、48 時間で最大約 35 万件。
 * 超えるなら 1 件も取らずに止まる（`--max-fetch-hours` で上げられる）
 */
const MAX_FETCH_HOURS = 48

const pad = (n: number) => String(n).padStart(2, '0')
/** 控えの時刻（日本時間をそのまま UTC として数えたミリ秒）の日の頭 */
const dayStartMs = (day: string) => Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8))
const dayOf = (frameMs: number) => new Date(frameMs).toISOString().slice(0, 10).replace(/-/g, '')
/** 控えの時刻を、日本時間と分かる ISO 文字列にする */
const jstIso = (frameMs: number) => new Date(frameMs).toISOString().slice(0, 19) + '+09:00'
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

type QuakeSource = '確定値' | '日別の震源リスト'
interface DayQuakes { source: QuakeSource; quakes: CatalogQuake[]; unreadable: number }

const zipTexts = new Map<string, string | null>()
function zipText(year: string): string | null {
  if (zipTexts.has(year)) return zipTexts.get(year) ?? null
  const path = join(HYPO_DIR, 'zip', `h${year}.zip`)
  let text: string | null = null
  if (existsSync(path)) {
    const files = Object.values(unzipSync(new Uint8Array(readFileSync(path))))
    if (files.length !== 1) throw new Error(`${path} の中身が ${files.length} 本です（1 年 1 本を前提にしています）`)
    text = new TextDecoder('latin1').decode(files[0])
  }
  zipTexts.set(year, text)
  return text
}

/** その日の震源を控えから読む。確定値を優先し、無ければ日別の震源リスト。どちらも無ければ null。読めなかった行も数える。 */
function readQuakes(day: string): DayQuakes | null {
  const text = zipText(day.slice(0, 4))
  if (text !== null) {
    const quakes: CatalogQuake[] = []
    let unreadable = 0
    const prefix = `J${day}`
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith(prefix)) continue
      const r = parseHypocenterRecord(line)
      if (r) quakes.push({ t: r.timeMs, lat: r.lat, lng: r.lng, depth: r.depth ?? NaN, mag: r.magnitude ?? NaN })
      else unreadable++
    }
    if (quakes.length > 0) return { source: '確定値', quakes, unreadable }
  }
  const html = join(HYPO_DIR, `${day}.html`)
  if (!existsSync(html)) return null
  const quakes: CatalogQuake[] = []
  let unreadable = 0
  for (const line of extractDailyHypocenterRows(readFileSync(html, 'utf8'))) {
    const r = parseDailyHypocenterLine(line)
    if (r) quakes.push({ t: r.timeMs, lat: r.lat, lng: r.lng, depth: r.depth, mag: r.magnitude ?? NaN })
    else unreadable++
  }
  // 日本で 1 日の地震が 0 件になることは無い（`build-hypocenter-catalog` の実測で最小 391 件）。0 件の控えは壊れている
  if (quakes.length === 0) throw new Error(`${html} から震源を 1 件も読めませんでした（控えが壊れている疑い。消してから --fetch で取り直してください）`)
  return { source: '日別の震源リスト', quakes, unreadable }
}

/** 日別の震源リストを 1 件取って控える。中身が 0 件なら控えない（`build-hypocenter-catalog` の `fetchDailyHtml` と同じ扱い）。 */
async function fetchDaily(day: string): Promise<void> {
  const res = await fetch(`${DAILY_BASE}/${day}.html`)
  if (!res.ok) throw new Error(`${day} の震源リストを取れませんでした（HTTP ${res.status}）`)
  const html = await res.text()
  if (extractDailyHypocenterRows(html).length === 0) throw new Error(`${day} の震源リストが 0 件でした（控えません）`)
  mkdirSync(HYPO_DIR, { recursive: true })
  writeFileSync(join(HYPO_DIR, `${day}.html`), html, 'utf8')
}

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
// 流す
// ---------------------------------------------------------------------------

export interface EventRow {
  id: string
  /** 見え始め（早い段に上がった秒）。控えの時刻（日本時間をそのまま UTC として数えたミリ秒） */
  firstLikelyMs: number
  firstConfirmedMs: number | null
  /** 束を作った検知の位置（束の間は変わらない） */
  pos: [number, number]
  maxMembers: number
  lastMs: number
  /** 検知器を作り直してから {@link WARMUP_SEC} 秒の内に見え始めた */
  inWarmup: boolean
}

interface DayRun {
  day: string
  /** 検知器へ流した秒 */
  frames: number
  /** 秒フレームが無かった秒（控えの無い時間・取れなかった秒） */
  lostSec: number
  /** 検知器が見ていた秒（流した秒から助走の間を除く） */
  watched: number
  /** 見ていなかった最長の続き（秒） */
  longestBlindSec: number
  /** 観測点リストと点数が食い違って流せなかった秒 */
  mismatched: number
  missingHours: number[]
  quakeSource: QuakeSource
  quakeCount: number
  /** 震源の控えのうち読めなかった行 */
  unreadableQuakeRows: number
  /** 平常のゆらぎの表を焼いた日（誤報の少なさを測るには甘い日） */
  tableDay: boolean
}

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
  const missingQuakeDays = days.filter((d) => readQuakes(d) === null)
  const settled = dayOf(dayStartMs(todayJst) - DAILY_SETTLE_DAYS * DAY_MS)
  const unsettled = missingQuakeDays.filter((d) => d > settled)
  if (unsettled.length > 0) throw new Error(`${settled} より新しい日の震源リストは出そろっていないことがあるので取りません（${unsettled.join(',')}）。日を改めて走らせてください`)
  // 控えにあっても、出そろう前に取った日別の震源リストかもしれない（他の道具が取った控えなど）
  const earlyCached = days.filter((d) => d > settled && readQuakes(d)?.source === '日別の震源リスト')
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
    await fetchDaily(d)
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
  const spanSec = (dayStartMs(days[days.length - 1]) - fromFrameMs) / 1000 + DAY_SEC
  /** 検知器が見ていた秒（期間の頭から 1 秒刻み） */
  const watched = new Uint8Array(spanSec)
  const events = new Map<string, EventRow>()
  const runs: DayRun[] = []
  const quakes: CatalogQuake[] = []
  /** 日ごとに使われた観測点（その日に出てきた版の和集合）。取りこぼしを数える「観測網の中」の判定に使う */
  const daySites = new Map<string, Map<string, [number, number]>>()
  const dayCfgs = new Map<string, Set<string>>()
  let cfg: string | null = null
  let sites: [number, number][] = []
  let tracker: ReturnType<typeof createEnsembleTracker> | null = null
  let restartMs = -Infinity
  let lastFrameMs = -Infinity
  // 検知器を作り直すと束の id が振り直されるので、何代目の検知器かを id に添えて重ならないようにする
  let generation = 0

  // 期間の頭の検知が前日の地震に当たれるよう、控えにあれば前日の震源も読む（取りには行かない）
  const prev = (() => {
    try {
      return readQuakes(dayOf(fromFrameMs - DAY_MS))
    } catch (e) {
      console.log(`前日の震源の控えを読めなかったので使わない: ${e instanceof Error ? e.message : e}`)
      return null
    }
  })()
  if (prev) quakes.push(...prev.quakes)

  for (const day of days) {
    const q = readQuakes(day)
    if (q === null) throw new Error(`${day} の震源が控えにありません`)
    quakes.push(...q.quakes)
    const run: DayRun = {
      day, frames: 0, lostSec: 0, watched: 0, longestBlindSec: 0, mismatched: 0, missingHours: [],
      quakeSource: q.source, quakeCount: q.quakes.length, unreadableQuakeRows: q.unreadable, tableDay: tableDays.has(day),
    }
    for (let h = 0; h < 24; h++) {
      const p = hourPath(day, h)
      if (!existsSync(p)) { run.missingHours.push(h); continue }
      for (const f of readQuietHour(readFileSync(p), day)) {
        if (f.cfg === '') throw new Error(`${day}-${pad(h)} の控えに観測点の版が書かれていない秒があります（控えを消して取り直してください）`)
        // 観測点の版が変わったとき・前の秒から途切れたとき（控えの無い時間を飛ばした・続いていない日）は作り直す
        if (f.cfg !== cfg || tracker === null || f.ms - lastFrameMs > MAX_GAP_MS) {
          if (f.cfg !== cfg) {
            sites = await loadSites(f.cfg, allowFetch)
            cfg = f.cfg
          }
          tracker = createEnsembleTracker(sites, createEnsembleDetector(sites, tables))
          restartMs = f.ms
          generation++
        }
        // 点数が食い違う秒は流せない。秒フレームが無い秒と同じ扱いにする（途切れの起点にしないので、次の正常な秒までが
        // 60 秒以内なら下で埋め、それより長ければ次の秒で検知器を作り直す）
        if (sites.length !== f.values.length) { run.mismatched++; continue }
        // 作り直さずに続けた 60 秒以内の途切れ（無い秒・食い違った秒）は、検知器が続けて見ていたものとして埋める
        // （1 秒の欠けで地震を母集団から落とさない）
        const fillFrom = restartMs === f.ms ? f.ms : lastFrameMs + 1000
        for (let t = fillFrom; t <= f.ms; t += 1000) {
          const sec = (t - fromFrameMs) / 1000
          if (t - restartMs >= WARMUP_SEC * 1000 && sec >= 0 && sec < spanSec && !watched[sec]) { watched[sec] = 1; run.watched++ }
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
    }
    // その日の、見ていなかった最長の続き
    const base = (dayStartMs(day) - fromFrameMs) / 1000
    let blind = 0
    for (let s = 0; s < DAY_SEC; s++) {
      blind = watched[base + s] ? 0 : blind + 1
      run.longestBlindSec = Math.max(run.longestBlindSec, blind)
    }
    run.lostSec = DAY_SEC - run.frames - run.mismatched
    runs.push(run)
    console.log(
      `${day}: 流した ${run.frames} 秒${run.lostSec ? `（秒フレームの無い秒 ${run.lostSec}）` : ''}・見ていた ${run.watched} 秒（1 日の ${(run.watched / 864).toFixed(1)}%）・最長の見ていない続き ${run.longestBlindSec} 秒` +
      `・${run.quakeSource} ${run.quakeCount} 件${run.unreadableQuakeRows ? `（読めなかった行 ${run.unreadableQuakeRows}）` : ''}` +
      `${run.missingHours.length ? `・控えの無い時間 ${run.missingHours.join(',')} 時` : ''}${run.mismatched ? `・点数が食い違った秒 ${run.mismatched}` : ''}` +
      `${run.tableDay ? '・平常のゆらぎの表を焼いた日' : ''}`,
    )
  }

  const sitesOfDay = new Map<string, [number, number][]>([...daySites].map(([d, m]) => [d, [...m.values()]]))
  report(days, runs, [...events.values()], quakes, sitesOfDay, watched, fromFrameMs, prev !== null)
}

function report(
  days: string[], runs: DayRun[], events: EventRow[], quakes: CatalogQuake[],
  sitesOfDay: Map<string, [number, number][]>, watched: Uint8Array, fromFrameMs: number, prevDayQuakes: boolean,
): void {
  const fromMs = fromFrameMs - JST_OFFSET_MS
  const counted = events.filter((e) => !e.inWarmup)
  const rows = counted.map((e) => {
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
  const chanceOf = (r: (typeof rows)[number]) => {
    const dayFrame = Math.floor(r.firstLikelyMs / DAY_MS) * DAY_MS
    const dayFrom = dayFrame - JST_OFFSET_MS
    const near = quakes.filter((q) => q.t >= dayFrom - DAY_MS && q.t < dayFrom + 2 * DAY_MS)
    const off = (dayFrame - fromFrameMs) / 1000
    return chanceOfMatch(r.pos, near, dayFrom, DAY_SEC, watched.subarray(off, off + DAY_SEC))
  }
  const chances = new Map(rows.map((r) => [r.id, chanceOf(r)]))
  const sumChance = (rs: typeof rows) => rs.reduce((s, r) => s + (chances.get(r.id) ?? 0), 0)

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
  // ふつうに起きる。印を付けるのは、時間ごと無い・点数が食い違った・震源の行を読めなかった日だけ
  const blindDays = runs.filter((r) => r.missingHours.length > 0 || r.mismatched > 0 || r.unreadableQuakeRows > 0)
  const complete = blindDays.length === 0
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
  }

  console.log('')
  console.log(`期間 ${days[0]}〜${days[days.length - 1]}（${days.length} 日）・見ていた ${summary.watchedSec} 秒・作り直した直後 ${WARMUP_SEC} 秒の検知 ${summary.warmupEvents} 件は数えない`)
  console.log(`確かな段 ${confirmed.length} 件: 気象庁の震源に当たる ${summary.confirmedMatched} 件・偶然でも当たる見込み ${summary.confirmedChance.toFixed(1)} 件`)
  console.log(`早い段どまり ${likelyOnly.length} 件: 当たる ${summary.likelyOnlyMatched} 件・偶然でも当たる見込み ${summary.likelyOnlyChance.toFixed(1)} 件`)
  console.log(`見ていた間に観測網の中で起きた深さ ${CATALOG_DEEP_FOCUS_KM} km 未満の M${MISS_MIN_MAG} 以上 ${shallowTargets.length} 件: 束が当たった ${shallowTargets.length - missed.length} 件・当たらなかった ${missed.length} 件（見ていない時間に掛かった ${blindTargets} 件・M が決まっていない ${unknownMag} 件は数えていない）`)
  if (deepTargets.length > 0) console.log(`  深さ ${CATALOG_DEEP_FOCUS_KM} km 以上の M${MISS_MIN_MAG} 以上 ${deepTargets.length} 件（震央の真上は揺れにくいので上の数とは別）: 束が当たった ${deepWithBundle} 件`)
  if (noSiteDayTargets > 0) console.log(`  秒フレームが 1 つも無い日の M${MISS_MIN_MAG} 以上 ${noSiteDayTargets} 件は、観測網の内外を判定できないので上の数に入れていない`)
  for (const r of confirmed.filter((r) => !r.matched)) console.log(`  当たらない確かな段 ${r.firstConfirmedAt} 点数${r.maxMembers} ${r.pos.map((x) => x.toFixed(2)).join(',')}`)
  for (const q of missed) console.log(`  束の無い地震 ${jstIso(q.t + JST_OFFSET_MS)} M${q.mag} ${q.lat.toFixed(2)},${q.lng.toFixed(2)}`)
  if (summary.tableDays.length > 0) console.log(`平常のゆらぎの表を焼いた日 ${summary.tableDays.join(' ')} が入っている（その日の誤報は少なめに出る）`)
  if (!complete) console.log(`欠けのある日 ${blindDays.length} 件（${blindDays.map((r) => r.day).join(' ')}）。控えの無い時間・読めなかった震源の行・点数の食い違いがある`)
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
