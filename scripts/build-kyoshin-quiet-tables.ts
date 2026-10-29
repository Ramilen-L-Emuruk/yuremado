/**
 * 強震モニタの「平常のゆらぎの表」（`public/data/kyoshin-quiet-tables.json`）を焼く。
 *
 *   npx tsx scripts/build-kyoshin-quiet-tables.ts [--days=YYYYMMDD,…] [--fetch] [--out=<パス>]
 *
 * 地震の無い平常の日の秒フレームを全部流し、観測点ごとに「どれくらいの上がりが普段から起きるか」を数える。
 * 数え方と表の形は `src/utils/kyoshinQuietTables.ts`。組み合わせの検知器はこの表で観測点ごとの珍しさと
 * 発火のしきい値を決めるので、**焼く日を変えたら検知器の評価（検知率・平常の日の誤報）を測り直すこと。**
 *
 * - 入力の秒フレームは控え `.cache/kyoshin-quiet-days/<日>-<時>.bin`（1 時間 1 ファイル）から読む。
 *   形は先頭に JSON 1 行 `{"cfgs":[…]}`、続けて 1 秒ごとに [秒(uint32 LE)][版の番号(uint8)][点数(uint16 LE)][震度の段+1 の uint8 × 点数]
 * - 観測点の座標はメインの checkout の `.cache/kyoshin-bench/sites_<版>.json`（`bench-kyoshin` と共有。決め方は `scripts/lib/kyoshinBenchCache.ts`）
 * - **控えに無い時間があれば、取ることになる件数を出して止まる。** `--fetch` を付けたときだけ Yahoo から取る
 *   （1 時間 3,600 件・1 日 86,400 件。西が駄目な秒は東も試すので、その分だけ増える）。取ったものは控えに残す
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cacheDir } from './lib/cacheDir.mjs'
import { kyoshinBenchCacheDir } from './lib/kyoshinBenchCache'
import { QuietTableBaker, quietSiteKey, type QuietTables } from '../src/utils/kyoshinQuietTables'

/**
 * 既定で焼く平常の日。
 * - 2022-09-18・2024-08-29: 組み合わせの検知器を作ったときに表を焼いた日（評価の dev 側の平常の日）
 * - 2026-09-11: いまの観測点リスト（2026-01-23 版）で動いている日。上の 2 日だけでは、いまの 1,725 点のうち
 *   341 点が表に載らなかったので足した（2026-10-28 ユーザー選択「新しい平常の日を 1 日取って足す」「2026-09-11」）。
 *   評価のどの窓とも前後 1 日重ならない日のうち、震源カタログの最大 M がいちばん小さい日（M3.6）
 *
 * test 側の平常の日（2021-01-08・2026-10-20）は、平常の日の誤報を測るために表の外へ置いてある。
 */
export const DEFAULT_DAYS = ['20220918', '20240829', '20260911']

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUT = resolve(HERE, '../public/data/kyoshin-quiet-tables.json')
const QUIET_DIR = cacheDir('kyoshin-quiet-days')
const SITES_DIR = kyoshinBenchCacheDir()
const REALTIME_BASE = (edge: 'west' | 'east') => `https://weather-kyoshin.${edge}.edge.storage-yahoo.jp/RealTimeData`
const SITELIST_BASE = 'https://weather-kyoshin.west.edge.storage-yahoo.jp/SiteList'
/** 取るときに同時に投げる件数。 */
const FETCH_CONCURRENCY = 4
/**
 * 1 時間・1 日それぞれで、取れていなければならない秒の割合（`bench-kyoshin` の `MIN_COVERAGE` と同じ）。
 * 一時的な通信の失敗で欠けたまま焼くと、判定できた秒が減った点が雑音の表の足切り（`FIRE_MIN_SEC`）を割って落ちる
 */
const MIN_COVERAGE = 0.9

const pad = (n: number) => String(n).padStart(2, '0')
const hourPath = (day: string, h: number) => join(QUIET_DIR, `${day}-${pad(h)}.bin`)
/** 控えの「秒」は日本時間の 0 時からの秒数。日本時間の時刻をそのまま UTC として数える（使うのは秒の間隔だけ）。 */
const dayStartMs = (day: string) => Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8))

interface Frame { ms: number; cfg: string; values: Int8Array }

/** 1 時間ぶんの控えを読む。 */
export function readQuietHour(buf: Buffer, day: string): Frame[] {
  const nl = buf.indexOf(10)
  if (nl < 0) throw new Error('控えの見出しの行が見つかりません')
  const { cfgs } = JSON.parse(buf.subarray(0, nl).toString('utf8')) as { cfgs: string[] }
  const base = dayStartMs(day)
  const frames: Frame[] = []
  let o = nl + 1
  while (o < buf.length) {
    if (o + 7 > buf.length) throw new Error(`控えの末尾が欠けています（${o} バイト目）`)
    const sec = buf.readUInt32LE(o), ci = buf[o + 4], n = buf.readUInt16LE(o + 5)
    if (o + 7 + n > buf.length) throw new Error(`控えの末尾が欠けています（${o} バイト目）`)
    const values = new Int8Array(n)
    for (let i = 0; i < n; i++) values[i] = buf[o + 7 + i] - 1
    o += 7 + n
    const cfg = cfgs[ci]
    if (cfg === undefined) throw new Error(`版の番号 ${ci} が見出しにありません`)
    frames.push({ ms: base + sec * 1000, cfg, values })
  }
  return frames
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** 1 時間ぶんを Yahoo から取って控えに書く（取れた秒が `MIN_COVERAGE` を割ったら書かない）。取れた秒数を返す。 */
async function fetchHour(day: string, h: number): Promise<number> {
  const cfgs: string[] = []
  const chunks: Buffer[] = []
  let got = 0
  for (let s = 0; s < 3600; s += FETCH_CONCURRENCY) {
    const res = await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, async (_, k) => {
      const sec = h * 3600 + s + k
      // 控えの秒は日本時間の日付と時刻。強震モニタの URL も日本時間で書く
      const ts = `${day}${pad(Math.floor(sec / 3600))}${pad(Math.floor(sec / 60) % 60)}${pad(sec % 60)}`
      for (const edge of ['west', 'east'] as const) {
        const j = await fetchJson<{ realTimeData?: { siteConfigId?: string; intensity?: string } }>(`${REALTIME_BASE(edge)}/${day}/${ts}.json`)
        const rt = j?.realTimeData
        if (rt?.intensity) return { sec, cfg: rt.siteConfigId ?? '', s: rt.intensity }
      }
      return null
    }))
    for (const r of res) {
      if (!r) continue
      let ci = cfgs.indexOf(r.cfg)
      if (ci < 0) { cfgs.push(r.cfg); ci = cfgs.length - 1 }
      const b = Buffer.alloc(7 + r.s.length)
      b.writeUInt32LE(r.sec, 0); b.writeUInt8(ci, 4); b.writeUInt16LE(r.s.length, 5)
      for (let i = 0; i < r.s.length; i++) b[7 + i] = r.s.charCodeAt(i) - 100 + 1
      chunks.push(b); got++
    }
  }
  // 足りないまま控えると、次から「控えあり」として取り直さない
  if (got < 3600 * MIN_COVERAGE) return got
  mkdirSync(QUIET_DIR, { recursive: true })
  writeFileSync(hourPath(day, h), Buffer.concat([Buffer.from(JSON.stringify({ cfgs }) + '\n'), ...chunks]))
  return got
}

const sitesCache = new Map<string, [number, number][]>()
async function loadSites(cfg: string, allowFetch: boolean): Promise<[number, number][]> {
  const hit = sitesCache.get(cfg)
  if (hit) return hit
  const path = join(SITES_DIR, `sites_${cfg}.json`)
  let sites: [number, number][]
  if (existsSync(path)) {
    sites = JSON.parse(readFileSync(path, 'utf8')) as [number, number][]
  } else if (allowFetch) {
    const raw = await fetchJson<{ items?: [number, number][] } | [number, number][]>(`${SITELIST_BASE}/sitelist_${cfg}.json`)
    if (raw === null) throw new Error(`観測点リスト ${cfg} を取れませんでした`)
    sites = (Array.isArray(raw) ? raw : (raw.items ?? [])) as [number, number][]
    // 空のリストを控えると、以後は「既にある」で読み続けて止まり続ける（手で消すまで直らない）
    if (sites.length === 0) throw new Error(`観測点リスト ${cfg} が空でした（控えません）`)
    mkdirSync(SITES_DIR, { recursive: true })
    writeFileSync(path, JSON.stringify(sites))
  } else {
    throw new Error(`観測点リスト ${path} がありません（--fetch を付けると取ります・1 件）`)
  }
  if (sites.length === 0) throw new Error(`観測点リスト ${cfg} が空です`)
  sitesCache.set(cfg, sites)
  return sites
}

function arg(name: string): string | undefined {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit?.slice(name.length + 3)
}

async function main(): Promise<void> {
  const days = (arg('days') ?? DEFAULT_DAYS.join(',')).split(',').filter(Boolean)
  const out = resolve(arg('out') ?? DEFAULT_OUT)
  const allowFetch = process.argv.includes('--fetch')
  if (days.some(d => !/^\d{8}$/.test(d))) throw new Error(`--days は YYYYMMDD をカンマで区切って渡してください（${days.join(',')}）`)

  const missing = days.flatMap(d => Array.from({ length: 24 }, (_, h) => ({ d, h }))).filter(({ d, h }) => !existsSync(hourPath(d, h)))
  if (missing.length > 0) {
    console.log(`控えに無い時間 ${missing.length} 件（${missing.map(m => `${m.d}-${pad(m.h)}`).join(' ')}）。取ると ${missing.length * 3600} 件以上のリクエストになる`)
    if (!allowFetch) throw new Error('控えが足りないので止めます（取るなら --fetch を付けて走らせ直してください）')
    const short: string[] = []
    for (const { d, h } of missing) {
      const got = await fetchHour(d, h)
      const enough = got >= 3600 * MIN_COVERAGE
      console.log(`  ${d}-${pad(h)} 取れた ${got}/3600${enough ? '' : '（足りないので控えない）'}`)
      if (!enough) short.push(`${d}-${pad(h)}`)
    }
    if (short.length > 0) throw new Error(`取れた秒が 9 割に届かない時間があるので焼きません（${short.join(' ')}）。--fetch で走らせ直すと取り直します`)
  }

  const baker = new QuietTableBaker()
  for (const day of days) {
    let frames = 0, mismatched = 0
    const cfgs = new Set<string>()
    for (let h = 0; h < 24; h++) {
      // 控えは取ったときに 1 時間 9 割を確かめているが、それより前に控えた分には掛かっていない。読むときにも確かめる
      const hourFrames = readQuietHour(readFileSync(hourPath(day, h)), day)
      if (hourFrames.length < 3600 * MIN_COVERAGE) {
        throw new Error(`${day}-${pad(h)} の控えが ${hourFrames.length}/3600 秒しかありません（その時間の控えを消してから --fetch で取り直してください）`)
      }
      for (const f of hourFrames) {
        const sites = await loadSites(f.cfg, allowFetch)
        // 観測点リストと点数が食い違う秒は、どの値がどの点か分からないので数えない
        if (sites.length !== f.values.length) { mismatched++; continue }
        // 焼く日は地震の無い平常の日を選んであるので、どの秒も数える
        baker.feed(f.ms, f.cfg, sites, f.values, true)
        frames++
        cfgs.add(f.cfg)
      }
    }
    console.log(`${day}: ${frames} 秒（1 日の ${(frames / 864).toFixed(1)}%）・観測点リスト ${[...cfgs].join(' ')}${mismatched ? `・点数が食い違って数えなかった秒 ${mismatched}` : ''}`)
    if (frames < 86_400 * MIN_COVERAGE) throw new Error(`${day} は ${frames} 秒しか数えられませんでした（1 日の 9 割に届かないので焼きません）`)
  }

  const tables = baker.result(days)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(tables) + '\n')
  console.log(`書き出した: ${out}（裾の表 ${Object.keys(tables.tails).length} 点・雑音の表 ${Object.keys(tables.fire).length} 点）`)
  for (const cfg of sitesCache.keys()) reportCoverage(tables, cfg, sitesCache.get(cfg)!)
}

/** 焼いた日の観測点リストのうち、表に載らなかった点の数を出す（載らない点は全体の確率・既定のしきい値で動く）。 */
function reportCoverage(tables: QuietTables, cfg: string, sites: [number, number][]): void {
  const keys = sites.map(quietSiteKey)
  const noTail = keys.filter(k => !tables.tails[k]).length
  const noFire = keys.filter(k => !tables.fire[k]).length
  console.log(`  観測点リスト ${cfg}（${sites.length} 点）: 裾の表に無い ${noTail} 点・雑音の表に無い ${noFire} 点`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
