/**
 * 強震モニタ検知エンジンの「助走」の効きを実データで測る。
 *
 * ## 何を測るか
 *
 * 助走は「供給が始まる前のフレームを検知エンジンだけへ先に食わせる」仕組み
 * （→ `src/utils/kyoshinWarmup.ts`・`docs/spec/kyoshin-detection-spec.md` §7）。
 * ここで測るのは **「その時刻から再生を始めた場合」が「ずっと再生し続けた場合」と
 * どれだけ一致するか**。一致の基準は検知の段階（confirmed / likely / なし）と最大震度で、
 * イベントの件数は見ない（本震で生まれた古いイベントは助走の範囲外になるため、
 * 遡りの長さに素直に比例してしまう）。
 *
 * 検知エンジンのユニットテストは合成フレームなので、実地震の立ち上がり方は捕まえられない。
 * `npm run bench-kyoshin` は窓の**先頭から**流すので、「途中から入る」形は測れない。
 * この 2 つの隙間を埋めるのがこのスクリプト。
 *
 * ## 使い方
 *
 * ```bash
 * # 窓と、その手前 15 分を取得する（初回のみ。7 本 × 30 分 ≒ 12600 フレーム・数分）
 * npx tsx scripts/measure-kyoshin-warmup.ts --fetch
 *
 * # 助走の長さを変えて一致率を見る
 * npx tsx scripts/measure-kyoshin-warmup.ts --warmups=0,180,300,600
 *
 * # 実装と同じ「60 秒ブロックで遡り、静穏で打ち切る」方式で測る
 * npx tsx scripts/measure-kyoshin-warmup.ts --adaptive
 *
 * # 同じ方式で、静穏でも遡る最低の長さ（ブロック数）だけを変えて比べる
 * npx tsx scripts/measure-kyoshin-warmup.ts --min-blocks=1,3,5,7,10
 * ```
 *
 * キャッシュの置き場は `npm run bench-kyoshin` と同じ（既定はメインの checkout の `.cache/kyoshin-bench`・
 * 環境変数 `KYOSHIN_BENCH_CACHE` で変えられる。決め方は `scripts/lib/kyoshinBenchCache.ts`）。観測点リストもそちらと共有する。平常のゆらぎの表は
 * `public/data/kyoshin-quiet-tables.json`（`--tables=` で差し替えられる）。
 *
 * ## 測定に使う窓
 *
 * 大地震 7 本。**地震発生の 1 分後から 12.5 分後まで**を 30 秒刻みで走査する（164 点）。
 * 揺れが完全に収まった後は「ずっと再生」でも検知が消えるので、そこは測っても差が出ない。
 *
 * **窓の手前に、遡りの上限と同じ長さ（15 分）を足してから流す。** 足さないと、遡った先が窓の始まりで
 * 頭打ちになり、そこから流した結果と「ずっと再生し続けた場合」（これも窓の始まりから流す）が同じものになって、
 * 一致が水増しされる（足さずに測ると、最低 10 分で 164/164 に見えた。足すと 157/164）。
 * 手前の窓は `--fetch` が `warmup-pre-<label>.json` へ取る。観測点リストの版が本体と違うフレームは外す。
 * 手前の窓が無い窓・窓か手前の取れた秒が 9 割を切る窓は測らずに飛ばす（秒の位置は添字ではなく時刻で引く）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { kyoshinBenchCacheDir } from './lib/kyoshinBenchCache'
import { createEnsembleDetector } from '../src/utils/kyoshinEnsembleDetector'
import { createEnsembleTracker, type EnsembleDetection } from '../src/utils/kyoshinEnsembleTracker'
import { validateQuietTables, type QuietTables } from '../src/utils/kyoshinQuietTables'
import {
  WARMUP_BLOCK_SEC, WARMUP_MAX_BLOCKS, mayStopWarmup, isQuietFrame,
} from '../src/utils/kyoshinWarmup'

const CACHE_DIR = kyoshinBenchCacheDir()
const REALTIME_BASE = (edge: 'west' | 'east'): string =>
  `https://weather-kyoshin.${edge}.edge.storage-yahoo.jp/RealTimeData`
const SITELIST_BASE = 'https://weather-kyoshin.west.edge.storage-yahoo.jp/SiteList'
/** 取得の同時実行数（`bench-kyoshin` と同じ）。 */
const FETCH_CONCURRENCY = 24

interface Frame { ms: number; ts: string; indices: number[]; cfg: string }

/**
 * 測定に使う窓。`start` は JST の壁時計（`bench-kyoshin` の窓カタログと同じ表記）。
 *
 * `quakeAt` は窓の先頭から地震発生までの秒数。走査はここから 1 分後に始める。
 */
const WINDOWS: { label: string; start: string; seconds: number; quakeAt: number; name: string }[] = [
  { label: 'warmup-noto2024', start: '20240101160800', seconds: 780, quakeAt: 120, name: '2024/01/01 能登半島地震 M7.6' },
  { label: 'warmup-noto2023', start: '20230505144000', seconds: 900, quakeAt: 120, name: '2023/05/05 石川県能登地方 M6.3' },
  { label: 'warmup-fukushima2022', start: '20220316233400', seconds: 900, quakeAt: 120, name: '2022/03/16 福島県沖 M7.3' },
  { label: 'warmup-fukushima2021', start: '20210213230600', seconds: 900, quakeAt: 120, name: '2021/02/13 福島県沖 M7.1' },
  { label: 'warmup-hyuganada2024', start: '20240808164100', seconds: 900, quakeAt: 120, name: '2024/08/08 日向灘 M6.9' },
  { label: 'warmup-bungo2024', start: '20240417231200', seconds: 900, quakeAt: 120, name: '2024/04/17 豊後水道 M6.4' },
  { label: 'warmup-chiba2021', start: '20211007223900', seconds: 900, quakeAt: 120, name: '2021/10/07 千葉県北西部 M6.1' },
]

/** 走査の刻み（秒）。 */
const SWEEP_STEP_SEC = 30
/** 走査を始める「地震発生からの経過」（秒）。 */
const SWEEP_FROM_SEC = 60
/** 窓の手前に足す長さ（秒）。遡りの上限と同じにして、どの開始時刻でも窓の始まりで頭打ちにならないようにする。 */
const PRE_SEC = WARMUP_MAX_BLOCKS * WARMUP_BLOCK_SEC
/**
 * 窓・手前の窓それぞれで、取れていなければならない秒の割合（`bench-kyoshin` の `MIN_COVERAGE` と同じ）。
 * 手前が足りないまま測ると、遡った先が手前の始まりで頭打ちになり、一致が水増しされる
 */
const MIN_COVERAGE = 0.9

// ============================================================
// 取得
// ============================================================

/** JST の壁時計として `base` から `offsetSec` 秒進めた時刻の、取得用パス部品を作る。 */
function pathAt(base: string, offsetSec: number): { dateStr: string; ts: string; ms: number } {
  // Yahoo のパスは JST 表記。UTC の暦計算をそのまま JST の壁時計として扱う（時差を足さない）
  const t = Date.UTC(
    +base.slice(0, 4), +base.slice(4, 6) - 1, +base.slice(6, 8),
    +base.slice(8, 10), +base.slice(10, 12), +base.slice(12, 14),
  ) + offsetSec * 1000
  const dt = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  const dateStr = `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}`
  return { dateStr, ts: `${dateStr}${p(dt.getUTCHours())}${p(dt.getUTCMinutes())}${p(dt.getUTCSeconds())}`, ms: t }
}

async function fetchFrame(dateStr: string, ts: string, ms: number): Promise<Frame | null> {
  for (const edge of ['west', 'east'] as const) {
    try {
      const res = await fetch(`${REALTIME_BASE(edge)}/${dateStr}/${ts}.json`)
      if (!res.ok) continue
      const json = await res.json() as { realTimeData?: { siteConfigId?: string; intensity?: string } }
      const rt = json.realTimeData
      if (!rt || typeof rt.intensity !== 'string' || rt.intensity.length === 0) continue
      // 震度は 1 文字 1 観測点。services/kyoshin.ts と同じ変換（charCode - 100）
      return { ms, ts, indices: Array.from(rt.intensity, (c) => c.charCodeAt(0) - 100), cfg: rt.siteConfigId ?? '' }
    } catch {
      // このエッジは諦めて次へ
    }
  }
  return null
}

/** 窓の先頭から `fromSec` 秒の位置を起点に `seconds` 秒ぶんを取り、`path` へ書く（既にあれば取らない）。 */
async function fetchRange(path: string, name: string, start: string, fromSec: number, seconds: number): Promise<string | undefined> {
  if (existsSync(path)) { console.log(`  ${name}: 既にある`); return undefined }
  const targets = Array.from({ length: seconds }, (_, i) => pathAt(start, fromSec + i))
  const out: Frame[] = []
  for (let i = 0; i < targets.length; i += FETCH_CONCURRENCY) {
    const chunk = targets.slice(i, i + FETCH_CONCURRENCY)
    const got = await Promise.all(chunk.map(t => fetchFrame(t.dateStr, t.ts, t.ms)))
    for (const f of got) if (f) out.push(f)
  }
  // 足りないまま控えると、次から「既にある」として取り直さない。控えずに、次の --fetch で取り直す
  if (out.length < seconds * MIN_COVERAGE) {
    console.log(`  ${name}: ${out.length}/${seconds} しか取れなかったので控えない（--fetch で取り直す）`)
    return undefined
  }
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(path, JSON.stringify(out))
  console.log(`  ${name}: ${out.length}/${seconds} 取得 cfg=${out[0]?.cfg}`)
  return out[0]?.cfg
}

async function fetchWindow(w: typeof WINDOWS[number]): Promise<void> {
  const cfg = await fetchRange(`${CACHE_DIR}/${w.label}.json`, w.label, w.start, 0, w.seconds)
  await fetchRange(`${CACHE_DIR}/warmup-pre-${w.label}.json`, `${w.label} の手前`, w.start, -PRE_SEC, PRE_SEC)
  if (cfg && !existsSync(`${CACHE_DIR}/sites_${cfg}.json`)) {
    const res = await fetch(`${SITELIST_BASE}/sitelist_${cfg}.json`)
    // 中身を確かめてから控える（空・壊れたリストを一度控えると、以後は「既にある」で取り直さない）
    if (!res.ok) throw new Error(`観測点リスト ${cfg} を取れませんでした（HTTP ${res.status}）`)
    const raw = await res.json() as { items?: [number, number][] } | [number, number][]
    const sites = Array.isArray(raw) ? raw : (raw.items ?? [])
    if (sites.length === 0) throw new Error(`観測点リスト ${cfg} が空でした`)
    writeFileSync(`${CACHE_DIR}/sites_${cfg}.json`, JSON.stringify(sites))
    console.log(`  sites_${cfg}: 取得`)
  }
}

// ============================================================
// 測定
// ============================================================

interface Snap { tier: string; maxInt: number }

function snap(dets: readonly EnsembleDetection[]): Snap {
  const conf = dets.filter(d => d.confidence === 'confirmed')
  // 加わった点がいま全員欠測の検知（最大震度が null）は、最大震度の比べ合いから外す
  const intens = dets.flatMap(d => (d.maxIntensity === null ? [] : [d.maxIntensity]))
  return {
    tier: conf.length > 0 ? 'confirmed' : dets.length > 0 ? 'likely' : 'なし',
    maxInt: intens.length > 0 ? Math.max(...intens) : NaN,
  }
}

function same(a: Snap, b: Snap): boolean {
  if (a.tier !== b.tier) return false
  if (Number.isNaN(a.maxInt) && Number.isNaN(b.maxInt)) return true
  return Math.abs(a.maxInt - b.maxInt) < 0.1
}

/**
 * 実装と同じ規則で、どこまで遡るかを決める（`kyoshinWarmup.ts` の判定を共有する）。
 * `minBlocks` を渡したときだけ、静穏でも遡る最低の長さをそれに差し替える（静穏の判定は実装と同じ）。
 */
function adaptiveStart(frames: Frame[], at: number, minBlocks?: number): number {
  for (let b = 1; b <= WARMUP_MAX_BLOCKS; b++) {
    const head = indexAtOrAfter(frames, frames[at].ms - b * WARMUP_BLOCK_SEC * 1000)
    if (head === 0) return 0
    const stop = minBlocks === undefined
      ? mayStopWarmup(b * WARMUP_BLOCK_SEC, frames[head].indices)
      : b >= minBlocks && isQuietFrame(frames[head].indices)
    if (stop) return head
  }
  return indexAtOrAfter(frames, frames[at].ms - WARMUP_MAX_BLOCKS * WARMUP_BLOCK_SEC * 1000)
}

/**
 * `ms` 以降で最初のフレームの添字（取れなかった秒があるので、添字を秒として数えない）。
 * 全フレームより前なら 0。
 */
function indexAtOrAfter(frames: Frame[], ms: number): number {
  let lo = 0
  let hi = frames.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (frames[mid].ms < ms) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** カンマ区切りの数を読む。`ok` を満たさない値があれば止める（NaN のまま測らない） */
function parseList(arg: string, name: string, ok: (n: number) => boolean): number[] {
  const values = arg.split(',').map(Number)
  const bad = values.filter(n => !ok(n))
  // 同じ値を 2 度渡すと、列の名前を鍵にした数えが二重に足されて一致の数が水増しされる
  if (values.length === 0 || bad.length > 0 || new Set(values).size !== values.length) {
    console.error(`${name} の値が読めないか、同じ値が重なっています: ${arg}`)
    process.exit(1)
  }
  return values
}

function main(): void {
  const args = process.argv.slice(2)
  const adaptive = args.includes('--adaptive')
  const minArg = args.find(a => a.startsWith('--min-blocks='))
  const minBlocks = minArg
    ? parseList(minArg.slice('--min-blocks='.length), '--min-blocks', n => Number.isInteger(n) && n >= 1 && n <= WARMUP_MAX_BLOCKS)
    : null
  const warmupArg = args.find(a => a.startsWith('--warmups='))
  const warmups = warmupArg
    ? parseList(warmupArg.slice('--warmups='.length), '--warmups', n => Number.isInteger(n) && n >= 0 && n <= PRE_SEC)
    : [0, 180, 300, 600]
  const tablesPath = args.find(a => a.startsWith('--tables='))?.slice('--tables='.length) ?? 'public/data/kyoshin-quiet-tables.json'
  if (!existsSync(tablesPath)) { console.error(`平常のゆらぎの表 ${tablesPath} がありません`); process.exit(1) }
  const tables = JSON.parse(readFileSync(tablesPath, 'utf8')) as QuietTables
  validateQuietTables(tables)

  const columns = minBlocks ? minBlocks.map(m => `最低${m}分`) : adaptive ? ['遡って打ち切る'] : warmups.map(w => `${w}s`)
  const agree = new Map<string, number>(columns.map(c => [c, 0]))
  const fetched = new Map<string, number[]>(columns.map(c => [c, []]))
  let total = 0
  // 測らなかった窓（結論に載せる。残りの一致率を 7 窓の結果と取り違えないように）
  const skipped: string[] = []
  const skip = (w: typeof WINDOWS[number], reason: string) => { console.log(`${w.name}: ${reason}`); skipped.push(w.name) }

  for (const w of WINDOWS) {
    const path = `${CACHE_DIR}/${w.label}.json`
    const prePath = `${CACHE_DIR}/warmup-pre-${w.label}.json`
    if (!existsSync(path) || !existsSync(prePath)) { skip(w, '窓か手前の窓が無い（--fetch で取得する）'); continue }
    const body = JSON.parse(readFileSync(path, 'utf8')) as Frame[]
    const pre0 = JSON.parse(readFileSync(prePath, 'utf8')) as Frame[]
    if (body.length < w.seconds * MIN_COVERAGE) { skip(w, `窓が ${body.length}/${w.seconds} 秒しか無いので測らない（控えを消してから --fetch で取り直す）`); continue }
    // 本体の途中で観測点リストの版が替わると並びが違うフレームが混ざる（手前と違い、外すと地震の最中が欠けるので測らない）
    if (body.some(f => f.cfg !== body[0].cfg)) { skip(w, '窓の途中で観測点リストの版が替わっているので測らない'); continue }
    // 観測点リストの版が違うフレームは並びが違うので混ぜない
    const pre = pre0.filter(f => f.cfg === body[0].cfg)
    if (pre.length < pre0.length) console.log(`  ${w.label}: 手前のうち観測点リストの版が違う ${pre0.length - pre.length} フレームを外した`)
    if (pre.length < PRE_SEC * MIN_COVERAGE) { skip(w, `手前の窓が ${pre.length}/${PRE_SEC} 秒しか無いので測らない（控えを消してから --fetch で取り直す）`); continue }
    const frames = [...pre, ...body]
    const quakeIdx = indexAtOrAfter(frames, pathAt(w.start, w.quakeAt).ms)
    const sitesPath = `${CACHE_DIR}/sites_${frames[0].cfg}.json`
    if (!existsSync(sitesPath)) { skip(w, `観測点リスト（${frames[0].cfg}）が無い`); continue }
    const sites = JSON.parse(readFileSync(sitesPath, 'utf8')) as [number, number][]
    if (sites.length !== frames[0].indices.length) { skip(w, `観測点リスト（${frames[0].cfg}）の ${sites.length} 点とフレームの ${frames[0].indices.length} 点が合わない`); continue }
    // 検知器は状態を中に持つので、流し始めるたびに作り直す
    const fresh = () => {
      const tracker = createEnsembleTracker(sites, createEnsembleDetector(sites, tables))
      return (f: Frame): readonly EnsembleDetection[] => tracker.push({ ms: f.ms, values: Int8Array.from(f.indices) })
    }

    // ずっと再生し続けた場合（手前の窓の先頭から流す）
    const base: Snap[] = []
    { const advance = fresh(); for (const f of frames) base.push(snap(advance(f))) }

    const local = new Map<string, number>(columns.map(c => [c, 0]))
    let localTotal = 0
    const lastMs = frames[frames.length - 1].ms
    for (let t = frames[quakeIdx].ms + SWEEP_FROM_SEC * 1000; t <= lastMs; t += SWEEP_STEP_SEC * 1000) {
      const i = indexAtOrAfter(frames, t)
      localTotal++
      for (const [j, col] of columns.entries()) {
        const from = minBlocks
          ? adaptiveStart(frames, i, minBlocks[j])
          : adaptive
            ? adaptiveStart(frames, i)
            : indexAtOrAfter(frames, frames[i].ms - Number(col.replace('s', '')) * 1000)
        const advance = fresh()
        let got: Snap = { tier: 'なし', maxInt: NaN }
        for (let k = from; k <= i; k++) got = snap(advance(frames[k]))
        if (same(got, base[i])) local.set(col, local.get(col)! + 1)
        fetched.get(col)!.push(Math.round((frames[i].ms - frames[from].ms) / 1000))
      }
    }
    total += localTotal
    for (const col of columns) agree.set(col, agree.get(col)! + local.get(col)!)
    console.log(`${w.name}: ${columns.map(c => `${c} ${local.get(c)}/${localTotal}`).join(' ／ ')}`)
  }

  console.log(`\n===== 合計（${total} 点・測った窓 ${WINDOWS.length - skipped.length}/${WINDOWS.length}）=====`)
  if (skipped.length > 0) console.log(`  測らなかった窓: ${skipped.join('・')}（この合計は全窓の結果ではない）`)
  // 欠けたまま測った結果を、正常に測った結果と見分けられるように止める
  if (skipped.length > 0 || total === 0) process.exitCode = 1
  for (const col of columns) {
    const lens = fetched.get(col)!
    const avg = lens.length > 0 ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0
    console.log(`  ${col}: 段階＋最大震度が一致 ${agree.get(col)}/${total}（助走の長さ 平均 ${avg}s・最大 ${lens.length > 0 ? Math.max(...lens) : 0}s）`)
  }
}

// 直接実行のときだけ走らせる（定数を読むためだけの import で測定まで始めないため）。
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '')) {
  if (process.argv.includes('--fetch')) {
    console.log(`窓を取得する（キャッシュ ${CACHE_DIR}）`)
    void (async () => { for (const w of WINDOWS) await fetchWindow(w) })()
  } else {
    main()
  }
}
