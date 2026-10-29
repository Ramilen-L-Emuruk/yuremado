/**
 * 強震モニタの揺れ検知（組み合わせの検知器・`src/utils/kyoshinEnsembleTracker.ts`）の実データ回帰ベンチ。
 *
 * Yahoo 強震モニタの過去フレームを窓ごとに再生して検知エンジンへ流し、
 *  - 気象庁が発表した地震を捉えられたか（検知率・確定までの時刻）
 *  - 地震が無いのに鳴っていないか（無関係な検知の件数）
 * を分類ごとに集計する。ユニットテスト（`src/utils/kyoshinEnsemble*.test.ts`）は合成フレームで
 * 判定ロジックを固定するが、実地震の立ち上がり方は捕まえられないため、検知エンジンを変更したら
 * こちらも回す（CLAUDE.md「特殊ケース: 強震モニタ検知エンジンを変更したとき」）。
 *
 * ## 使い方
 *
 * ```bash
 * # 未取得の窓を取得する（初回のみ。全 795 窓で数十分・キャッシュは 500MB 超）
 * npm run bench-kyoshin -- --fetch
 *
 * # 集計してベースラインとの差分を出す
 * npm run bench-kyoshin
 *
 * # 分類を絞る（付録A 相当だけを手早く見る）
 * npm run bench-kyoshin -- --only positive,major,quiet
 *
 * # 変更を受け入れてベースラインを更新する
 * npm run bench-kyoshin -- --update-baseline
 *
 * # 平常のゆらぎの表を差し替えて測る・無関係な検知を書き出す
 * npm run bench-kyoshin -- [--tables=<平常のゆらぎの表>] [--dump-unrelated=<書き出し先>]
 * ```
 *
 * 検知器は組み合わせの検知器（`src/utils/kyoshinEnsembleTracker.ts`）。表の既定は
 * `public/data/kyoshin-quiet-tables.json`。
 *
 * ```bash
 * # 窓の前へアプリと同じ規則で遡った助走を食わせてから測る（控えに無い窓だけ取る）
 * npm run bench-kyoshin -- --fetch-warmup
 * # 取らずに、投げる URL と件数だけを数える（静穏で最短に止まった場合の件数）
 * npm run bench-kyoshin -- --warmup-dry-run
 * # 控えた助走だけで測る
 * npm run bench-kyoshin -- --warmup
 * ```
 *
 * 窓は地震の 20〜30 秒前から始まるので、助走が無いと検知器は「既に揺れている」状態や、点ごとの直前のゆらぎを
 * 知らない状態から始まる。アプリは必ず助走を付けて始める（`src/utils/kyoshinWarmup.ts`）ので、検知器を比べるときは
 * こちらで測る。助走の控えは `<キャッシュ>/warmup/<窓>.json`（件数は `--warmup-dry-run` で数える。静穏でも最低 10 分ぶん遡るので、全 795 窓で最短 47.7 万件）。
 * 助走を付けた測定ではベースラインを更新しない（入れ替えるときに決める）。
 *
 * 無関係な検知は、長期震源カタログ（`public/data/hypocenter/`。無感の地震も入る）とも突き合わせ、
 * どの地震にも当てはまらないもの（ノイズの疑い）の件数を別に出す。
 *
 * ## 窓カタログ
 *
 * `scripts/kyoshin-bench/windows.json` が単一情報源。窓ごとに開始時刻・秒数・分類と、
 * **その時間帯に気象庁が発表した地震**（震央・M・深さ・最大震度）を持つ。
 * `note` には「この窓が回帰上なぜ要るか」を書く（期待を満たさなかった窓の一覧に出る）。
 *
 * | 分類 | 意味 | 見るところ |
 * |---|---|---|
 * | `positive` | 確定検知に達してほしい実地震 | 初 confirmed の時刻 |
 * | `major` | 大地震 | 初 confirmed の時刻 |
 * | `quiet` | 平常時 | 震源カタログのどの地震にも当てはまらない検知が、確かな段で 0 であること |
 * | `reported-false-positive` | 利用者が誤検知として報告した時刻・診断ログで見つかった誤検知 | 同上 |
 * | `catalog` | 気象庁発表の地震（検知率の母集団） | 分類ごとの検知率 |
 *
 * ## 「その地震を検知したか」の判定
 *
 * 検知イベントの重心が、窓に紐づくどれかの地震の震央から一定距離以内（`relatedKmFor`。深さ 100km 以上は 800km、
 * それより浅ければ M6 以上 2000km / M5 台 500km / M4 台 250km / M3 台 150km / それ未満 100km / M 不明 250km。
 * 窓ごとに `relatedKm` で上書き可）で、かつ発生時刻より後なら「その地震の検知」とする。それ以外は「無関係な検知」として別に数える。
 * **この区別が無いと、遠方の地震の窓でたまたま鳴った別地域のノイズを「検知できた」と数えてしまう**
 * （調査中に実際に起きた取り違え。トカラ列島近海の窓で東京の観測点が鳴っていた）。
 *
 * ## 注意
 *
 * - 観測点リストの版（`siteConfigId`）は年で変わる。窓ごとに先頭フレームの版を採る
 * - Yahoo が保持しているのは 2020 年以降
 * - キャッシュの置き場は環境変数 `KYOSHIN_BENCH_CACHE` で変えられる（既定 `.probe-cache`）。
 *   ワークツリーで作業するときはメインリポジトリのキャッシュを指すと再取得を避けられる
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createEnsembleDetector } from '../src/utils/kyoshinEnsembleDetector'
import { createEnsembleTracker } from '../src/utils/kyoshinEnsembleTracker'
import { validateQuietTables, type QuietTables } from '../src/utils/kyoshinQuietTables'
import { haversineKm } from '../src/utils/geo'
import { WARMUP_BLOCK_SEC, WARMUP_MAX_BLOCKS, firstContinuousIndex, mayStopWarmup } from '../src/utils/kyoshinWarmup'

const CACHE_DIR = process.env.KYOSHIN_BENCH_CACHE ?? '.probe-cache'
const WINDOWS_PATH = 'scripts/kyoshin-bench/windows.json'
const BASELINE_PATH = 'scripts/kyoshin-bench/baseline.json'
/** 同時に投げる取得リクエスト数。 */
const FETCH_CONCURRENCY = 24
/**
 * 窓として使うのに必要な取得率（取れたフレーム数 ÷ 窓の秒数）。
 *
 * **足りない窓を黙って使うと、欠測がエンジンの途絶明け・状態リセット（`MAX_DT_GAP_MS`・`MAX_RESUME_GAP_MS`）を誘発し、
 * 「検知できなかった」という結果がデータの穴だけを理由に生まれる。** そのままベースラインへ焼くと
 * 判断材料そのものが汚れるため、下回った窓は測定に使わず理由付きで報告する。
 * Yahoo 側に元から無い秒もあるため 100% は求めない（2026-08-23 の実測では 793 窓中 792 窓が 100%、残り 1 窓が 99%）。
 */
const MIN_COVERAGE = 0.9
/**
 * 検知イベントを地震に結びつける距離(km)。規模が大きいほど揺れは遠くまで届くため M で広げる。
 * 窓ごとに `relatedKm` を書けば上書きできる（大地震の窓など）。
 *
 * **狭すぎると遠地の本当の揺れを「無関係な検知」に数えてしまい、広すぎると同時刻のノイズを
 * 「その地震を検知できた」に数えてしまう。** 前者は対策の効果を過小に、後者は検知率を過大に見せる。
 *
 * 小さい地震にまで広い距離を許していたときは、M2.4 の地震の窓で 185km 離れた常習点のノイズを
 * 「その地震を検知できた」と数えていた。M2 級の揺れがそこまで届くことはない。
 *
 * **深さを見ないと逆向きに間違える。** 深発地震は震央の周りより、スラブに沿った先（太平洋側）が
 * 強く揺れる（異常震域）。規模だけで距離を決めていたとき、日本海北部 M5.6 深さ350km の窓で
 * 岩手・宮古市の検知（641km）を、渡島地方東部 M3.9 深さ130km の窓で十勝・豊頃町の検知（246km）を、
 * それぞれ「無関係」に数えていた。どちらも異常震域として起こって当然の姿だった。
 */
function relatedKmFor(mag: number, depth: number): number {
  // 深発地震は震央の周りではなく、スラブに沿った先（太平洋側）が強く揺れる＝異常震域。
  // 震央からの距離という尺度がそもそも当てはまらないので、規模を問わず広く採る。
  if (Number.isFinite(depth) && depth >= DEEP_FOCUS_KM) return 800
  if (!Number.isFinite(mag)) return 250
  if (mag >= 6) return 2000
  if (mag >= 5) return 500
  if (mag >= 4) return 250
  if (mag >= 3) return 150
  return 100
}
/**
 * 地震の発生時刻より前の検知は、その地震のものとみなさない猶予(秒)。
 * 気象庁の発生時刻は分単位までしか無いため、分の頭から遡れる幅をこれだけ許す。
 */
const BEFORE_ORIGIN_TOLERANCE_SEC = 60
/** これ以上の深さを深発地震として扱う(km)。異常震域が出るため震央からの距離が当てにならない。 */
const DEEP_FOCUS_KM = 100

const REALTIME_BASE = (edge: 'west' | 'east') =>
  `https://weather-kyoshin.${edge}.edge.storage-yahoo.jp/RealTimeData`
const SITELIST_BASE = 'https://weather-kyoshin.west.edge.storage-yahoo.jp/SiteList'

// ============================================================
// 型
// ============================================================

/** 窓に紐づく地震（気象庁発表）。 */
interface Quake {
  /** "2026/08/01 06:25:00"（JST・分単位まで） */
  time: string
  name: string
  lat: number
  lng: number
  mag: number
  depth: number
  /** 10 = 震度1、20 = 震度2 …（気象庁コード） */
  maxScale: number
}

type Category = 'positive' | 'major' | 'quiet' | 'reported-false-positive' | 'catalog'

interface WindowSpec {
  label: string
  /** yyyyMMddHHmmss（JST） */
  start: string
  seconds: number
  category: Category
  quakes: Quake[]
  /** 検知を地震に結びつける距離(km)。省略時は RELATED_KM_DEFAULT */
  relatedKm?: number
  /** カタログ窓が対象としている地震（`quakes` のどれか） */
  primary?: { time: string; name: string }
  /**
   * この窓が回帰上なぜ要るか（例: 「密網の連結の穴」「データ欠測グリッチ」）。
   * ラベルだけでは、その窓が検知エンジンのどの分岐を試しているのか分からなくなる。
   */
  note?: string
}

interface Catalog {
  version: number
  windows: WindowSpec[]
}

/** 1 フレーム分の観測データ（キャッシュに載る形）。 */
interface Frame {
  /** データ時刻(ms) */
  ms: number
  /** yyyyMMddHHmmss（表示用） */
  ts: string
  /** 観測点ごとの震度インデックス。負の値は欠測 */
  indices: number[]
  /** 観測点リストの版 */
  cfg: string
}

/** 1 窓の測定結果。ベースラインに保存する形でもある。 */
interface Result {
  /** その地震に結びついた検知の最高段階。無ければ 'none' */
  tier: 'confirmed' | 'likely' | 'none'
  /** 初めて likely 以上になった時刻（HH:MM:SS）。無ければ null */
  firstLikely: string | null
  /** 初めて confirmed になった時刻（HH:MM:SS）。無ければ null */
  firstConfirmed: string | null
  /**
   * その地震に結びついた confirmed が出ていたフレーム数（＝検知が画面に出ていた秒数）。
   *
   * **初 confirmed の時刻だけでは「検知が短くなった」を捕まえられない。** 始まりが同じでも
   * 途中で確信度が落ちれば、利用者から見た検知は縮む。確信度を降ろす仕組みを入れるときは
   * ここが唯一の歯止めになる（設計書§33 の単点降格は、この項目が無い状態で入った）。
   */
  confirmedFrames: number
  /** どの地震にも結びつかなかった検知イベントの数 */
  unrelated: number
  /**
   * そのうち confirmed まで上がった数。利用者に確かな揺れとして出た誤報はこちら（likely だけなら確定の手前で消えている）。
   * 旧ベースライン（この項目が無い頃のもの）には無い
   */
  unrelatedConfirmed?: number
  /**
   * 無関係な検知のうち、長期震源カタログ（無感も入る）のどの地震にも当てはまらなかった数と、そのうち confirmed まで
   * 上がった数（{@link inCatalog}）。照合できなかった検知（位置が無い・その年のカタログが無い）は当てはまらない側に数える。
   * 旧ベースラインには無い
   */
  unrelatedNoCatalog?: number
  unrelatedNoCatalogConfirmed?: number
  /** 無関係な検知の代表地点（最大 3 件・診断用） */
  unrelatedAt: string[]
}

// ============================================================
// 取得・キャッシュ
// ============================================================

/** JST の壁時計として `base` から `offsetSec` 秒進めた時刻の、取得用パス部品を作る。 */
function pathAt(base: string, offsetSec: number): { dateStr: string; ts: string; ms: number } {
  // Yahoo のパスは JST 表記。UTC の暦計算をそのまま JST の壁時計として扱う（時差を足さない）
  const t =
    Date.UTC(
      +base.slice(0, 4),
      +base.slice(4, 6) - 1,
      +base.slice(6, 8),
      +base.slice(8, 10),
      +base.slice(10, 12),
      +base.slice(12, 14),
    ) +
    offsetSec * 1000
  const dt = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  const dateStr = `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}`
  const ts = `${dateStr}${p(dt.getUTCHours())}${p(dt.getUTCMinutes())}${p(dt.getUTCSeconds())}`
  return { dateStr, ts, ms: t }
}

/** 1 フレームを取得する。west→east の順に試し、どちらも駄目なら null（その秒は欠落として扱う）。 */
async function fetchFrame(dateStr: string, ts: string, ms: number): Promise<Frame | null> {
  for (const edge of ['west', 'east'] as const) {
    try {
      const res = await fetch(`${REALTIME_BASE(edge)}/${dateStr}/${ts}.json`)
      if (!res.ok) continue
      const json = (await res.json()) as {
        realTimeData?: { siteConfigId?: string; intensity?: string }
      }
      const rt = json.realTimeData
      if (!rt || typeof rt.intensity !== 'string' || rt.intensity.length === 0) continue
      // 震度は 1 文字 1 観測点。services/kyoshin.ts と同じ変換（charCode - 100）
      return {
        ms,
        ts,
        indices: Array.from(rt.intensity, (c) => c.charCodeAt(0) - 100),
        cfg: rt.siteConfigId ?? '',
      }
    } catch {
      // このエッジは諦めて次へ。両方失敗したら null を返す
    }
  }
  return null
}

async function fetchWindow(w: WindowSpec): Promise<Frame[]> {
  const targets = Array.from({ length: w.seconds }, (_, i) => pathAt(w.start, i))
  const fetched: (Frame | null)[] = []
  for (let i = 0; i < targets.length; i += FETCH_CONCURRENCY) {
    const chunk = targets.slice(i, i + FETCH_CONCURRENCY)
    fetched.push(...(await Promise.all(chunk.map((t) => fetchFrame(t.dateStr, t.ts, t.ms)))))
  }
  const frames = fetched.filter((f): f is Frame => f != null)
  const path = `${CACHE_DIR}/${w.label}.json`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(frames))
  if (frames.length < w.seconds) {
    // 取れなかった秒は Yahoo 側に元から無いこともあり、通信の失敗と区別が付かない。
    // 使うかどうかは呼び出し側が MIN_COVERAGE で決めるので、ここでは事実だけ出す
    console.log(`  [${w.label}] 取得 ${frames.length}/${w.seconds}`)
  }
  return frames
}

/** 窓の前に遡った助走（`--warmup`）。止まった理由も持つ（全滅と静穏の打ち切りを見分けるため） */
interface WarmupCache {
  frames: Frame[]
  stoppedBy: 'quiet' | 'max' | 'unfetchable'
}

const warmupPath = (label: string): string => `${CACHE_DIR}/warmup/${label}.json`

/**
 * 窓の始まりより前を、アプリの助走と同じ規則で遡って取る。
 *
 * **規則は `src/utils/kyoshinWarmup.ts` の `mayStopWarmup` を使い、書き写さない**（取得元 `services/kyoshinSource.ts` の
 * 遡り方と同じ形: 60 秒のブロックを古い方へ足し、ブロックの先頭の秒が静穏で最低の長さに届いたら止める）。
 * `fetchOne` を差し替えれば、投げる先の URL と件数だけを数えられる（`--warmup-dry-run`）。
 */
async function fetchWarmup(w: WindowSpec, fetchOne: (dateStr: string, ts: string, ms: number) => Promise<Frame | null>): Promise<WarmupCache> {
  const blocks: Frame[][] = []
  let stoppedBy: WarmupCache['stoppedBy'] = 'max'
  for (let b = 1; b <= WARMUP_MAX_BLOCKS; b++) {
    const targets = Array.from({ length: WARMUP_BLOCK_SEC }, (_, i) => pathAt(w.start, -b * WARMUP_BLOCK_SEC + i))
    const got: (Frame | null)[] = []
    for (let i = 0; i < targets.length; i += FETCH_CONCURRENCY) {
      const chunk = targets.slice(i, i + FETCH_CONCURRENCY)
      got.push(...(await Promise.all(chunk.map((t) => fetchOne(t.dateStr, t.ts, t.ms)))))
    }
    const block = got.filter((f): f is Frame => f != null)
    if (block.length === 0) { stoppedBy = 'unfetchable'; break }
    blocks.unshift(block)
    if (mayStopWarmup(b * WARMUP_BLOCK_SEC, block[0].indices)) { stoppedBy = 'quiet'; break }
  }
  return { frames: blocks.flat(), stoppedBy }
}

function loadWarmup(label: string): WarmupCache | null {
  const path = warmupPath(label)
  if (!existsSync(path)) return null
  try {
    const c = JSON.parse(readFileSync(path, 'utf8')) as WarmupCache
    return Array.isArray(c.frames) ? c : null
  } catch {
    return null
  }
}

/** キャッシュの読み出し結果。「無い」「壊れている」「空」を呼び出し側で区別できるようにする。 */
type LoadResult =
  | { kind: 'ok'; frames: Frame[] }
  | { kind: 'absent' }
  | { kind: 'broken'; reason: string }

function loadFrames(label: string): LoadResult {
  const path = `${CACHE_DIR}/${label}.json`
  if (!existsSync(path)) return { kind: 'absent' }
  let frames: Frame[]
  try {
    frames = JSON.parse(readFileSync(path, 'utf8')) as Frame[]
  } catch (e) {
    // 書き込み途中で落ちた等。再取得すれば直るので「無い」と同じ扱いにするが、
    // 黙って消えると原因が追えないので理由を残す。
    return { kind: 'broken', reason: `キャッシュが壊れている（${e instanceof Error ? e.message : String(e)}）` }
  }
  if (!Array.isArray(frames) || frames.length === 0) return { kind: 'broken', reason: 'キャッシュが空' }
  return { kind: 'ok', frames }
}

const sitesCache = new Map<string, [number, number][]>()
async function loadSites(cfg: string, allowFetch: boolean): Promise<[number, number][] | null> {
  const hit = sitesCache.get(cfg)
  if (hit) return hit
  const path = `${CACHE_DIR}/sites_${cfg}.json`
  let sites: [number, number][]
  if (existsSync(path)) {
    sites = JSON.parse(readFileSync(path, 'utf8')) as [number, number][]
  } else if (allowFetch) {
    const res = await fetch(`${SITELIST_BASE}/sitelist_${cfg}.json`)
    const raw = (await res.json()) as { items?: [number, number][] } | [number, number][]
    sites = (Array.isArray(raw) ? raw : (raw.items ?? [])) as [number, number][]
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(sites))
  } else {
    return null
  }
  sitesCache.set(cfg, sites)
  return sites
}

// ============================================================
// 測定
// ============================================================

/**
 * "2026/08/01 06:25:00"(JST) → フレームと同じ物差しの ms。
 *
 * **フレームの `ms` は「日本時間の数字を UTC として読んだ値」**（`pathAt`。時差を足さない）。地震の時刻も
 * 同じ物差しへ揃える。以前はここで本当の UTC（−9 時間）へ直していて、フレームの時刻が常に 9 時間先に
 * 進んで見えたため、`relatedQuake` の「発生時刻より前の検知は数えない」判定が一度も効いていなかった
 * （2026-10-24 に #981 の計測で気づいた）。
 */
function jstToMs(s: string): number {
  const m = s.match(/(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
  if (!m) return NaN
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
}

/** 検知イベントが窓のどれかの地震に結びつくか。 */
function relatedQuake(e: Pick<Detection, 'epicenter'>, w: WindowSpec, nowMs: number, relatedKm: number | undefined): Quake | null {
  if (!e.epicenter) return null
  for (const q of w.quakes) {
    const originMs = jstToMs(q.time)
    if (Number.isNaN(originMs)) continue
    if (nowMs < originMs - BEFORE_ORIGIN_TOLERANCE_SEC * 1000) continue
    const km = relatedKm ?? relatedKmFor(q.mag, q.depth)
    if (haversineKm(e.epicenter[0], e.epicenter[1], q.lat, q.lng) <= km) return q
  }
  return null
}

/**
 * 無関係な検知を、長期震源カタログ（`public/data/hypocenter/<年>.json`。M2.0 以上と M が決まっていない地震・無感も入る）と
 * 突き合わせる。窓の `quakes` は気象庁が震度を発表した地震だけなので、無感の小さな地震による本物の揺れも「無関係」に数えられる。
 * それを分けて数え、どの地震にも当てはまらない検知（ノイズの疑い）を見えるようにする。
 *
 * 当てはまりの条件は、検知が見え始める {@link CATALOG_MATCH_BEFORE_MS} 前〜{@link CATALOG_MATCH_AFTER_MS} 後に発生し、
 * 震央が検知の位置から M に応じた距離（{@link catalogReachKm}）以内にある地震。
 */
const CATALOG_MATCH_BEFORE_MS = 120_000
const CATALOG_MATCH_AFTER_MS = 10_000
const JST_OFFSET_MS = 9 * 3_600_000
function catalogReachKm(mag: number): number {
  if (!Number.isFinite(mag) || mag < 3) return 100
  if (mag < 4) return 200
  if (mag < 5) return 400
  return 1000
}
interface CatalogQuake { t: number; lat: number; lng: number; mag: number }
const catalogYears = new Map<number, CatalogQuake[] | null>()
function catalogYear(y: number): CatalogQuake[] | null {
  if (catalogYears.has(y)) return catalogYears.get(y) ?? null
  const path = `public/data/hypocenter/${y}.json`
  let list: CatalogQuake[] | null = null
  if (existsSync(path)) {
    const r = JSON.parse(readFileSync(path, 'utf8')) as {
      count: number; startMs: number; timeScale: number; coordScale: number; magScale: number
      t: number[]; lat: number[]; lng: number[]; mag: (number | null)[]
    }
    list = []
    for (let i = 0; i < r.count; i++) {
      const m = r.mag[i]
      list.push({ t: r.startMs + (r.t[i] * 1000) / r.timeScale, lat: r.lat[i] / r.coordScale, lng: r.lng[i] / r.coordScale, mag: m === null ? NaN : m / r.magScale })
    }
  }
  catalogYears.set(y, list)
  return list
}
/** 当てはまる地震があれば true、無ければ false、その年のカタログが無ければ null（照合できない） */
function inCatalog(benchMs: number, pos: [number, number] | null): boolean | null {
  if (pos === null) return null
  const real = benchMs - JST_OFFSET_MS
  const list = catalogYear(new Date(real).getUTCFullYear())
  if (list === null) return null
  return list.some((q) => q.t >= real - CATALOG_MATCH_BEFORE_MS && q.t <= real + CATALOG_MATCH_AFTER_MS && haversineKm(pos[0], pos[1], q.lat, q.lng) <= catalogReachKm(q.mag))
}

const stationCoords = JSON.parse(readFileSync('public/data/station-coords.json', 'utf8')) as {
  stations: Record<string, [number, number, number]>
}
const stationList = Object.entries(stationCoords.stations).map(([n, v]) => ({ n, lat: v[0], lng: v[1] }))
/** 座標に最も近い震度観測点の名前（診断表示用）。 */
function nearestName(lat: number, lng: number): string {
  let best = ''
  let bd = Infinity
  for (const s of stationList) {
    const d = (s.lat - lat) ** 2 + ((s.lng - lng) * 0.8) ** 2
    if (d < bd) {
      bd = d
      best = s.n
    }
  }
  return best
}

/** 1 イベントの追跡結果。判定は窓を流し終えてから行う（下記参照）。 */
interface EventTrack {
  /** 一度でもどれかの地震に結びついたか */
  everRelated: boolean
  /** 初めて likely 以上になったフレームの時刻(ms) */
  firstLikelyMs: number
  /** 初めて confirmed になったフレームの時刻(ms)。未到達は null */
  firstConfirmedMs: number | null
  /** 最初に見えた場所（診断表示用） */
  at: string | null
  /** 最初に見えた位置（`--dump-unrelated` の書き出し用） */
  pos: [number, number] | null
}

/** `--dump-unrelated` で書き出す 1 件。時刻は評価台の時刻（日本時間をそのまま UTC として数えたミリ秒） */
interface UnrelatedDump {
  label: string
  category: string
  windowStartMs: number
  firstLikelyMs: number
  firstConfirmedMs: number | null
  pos: [number, number] | null
  at: string | null
}

function hhmmssOf(frames: Frame[], ms: number): string | null {
  const f = frames.find((x) => x.ms === ms)
  if (!f) return null
  return `${f.ts.slice(8, 10)}:${f.ts.slice(10, 12)}:${f.ts.slice(12, 14)}`
}

/** 評価台が読む検知の欄 */
interface Detection {
  id: string
  confidence: string
  epicenter: [number, number] | null
}

/** 窓 1 本ぶんの検知器。1 秒ごとにフレームを入れ、その秒の検知を返す */
type Runner = (f: Frame) => Detection[]

/** 組み合わせの検知器（`kyoshinEnsembleTracker.ts`） */
function ensembleRunner(sites: [number, number][], tables: QuietTables): Runner {
  const tracker = createEnsembleTracker(sites, createEnsembleDetector(sites, tables))
  return (f) => tracker.push({ ms: f.ms, values: Int8Array.from(f.indices) })
}

/**
 * 窓を 1 本流し、検知イベントを「その地震のもの」と「無関係なもの」に分けて数える。
 *
 * **判定はイベント単位で、窓を流し終えてから行う。** イベントの重心はメンバーが増えるたびに動くため、
 * 立ち上がり直後は震央から離れていて後から寄ってくることがある。フレームごとにその場で数えると、
 * 同じ揺れを「無関係な検知」と「その地震の検知」の両方に計上してしまう。
 */
function measure(w: WindowSpec, frames: Frame[], run: Runner, onUnrelated: (d: UnrelatedDump) => void): Result {
  const relatedKm = w.relatedKm
  const tracks = new Map<string, EventTrack>()

  // イベント ID ごとに「confirmed だったフレーム」を溜める。地震への帰属は後から立つことがあるため、
  // ここでは種別を問わず記録し、最後に「その地震に結びついたイベント」の分だけを数える
  const confirmedAt = new Map<string, number[]>()

  for (const f of frames) {
    const detections = run(f)

    for (const e of detections) {
      if (e.confidence === 'confirmed') {
        const list = confirmedAt.get(e.id)
        if (list) list.push(f.ms)
        else confirmedAt.set(e.id, [f.ms])
      }
    }

    for (const e of detections) {
      if (e.confidence !== 'likely' && e.confidence !== 'confirmed') continue
      let t = tracks.get(e.id)
      if (!t) {
        t = {
          everRelated: false,
          firstLikelyMs: f.ms,
          firstConfirmedMs: null,
          at: e.epicenter ? nearestName(e.epicenter[0], e.epicenter[1]) : null,
          pos: e.epicenter ? [e.epicenter[0], e.epicenter[1]] : null,
        }
        tracks.set(e.id, t)
      }
      if (!t.everRelated && relatedQuake(e, w, f.ms, relatedKm)) t.everRelated = true
      if (e.confidence === 'confirmed' && t.firstConfirmedMs == null) t.firstConfirmedMs = f.ms
    }
  }

  const out: Result = {
    tier: 'none', firstLikely: null, firstConfirmed: null, confirmedFrames: 0,
    unrelated: 0, unrelatedConfirmed: 0, unrelatedNoCatalog: 0, unrelatedNoCatalogConfirmed: 0, unrelatedAt: [],
  }
  let likelyMs = Infinity
  let confirmedMs = Infinity
  // 同じフレームに複数のイベントが confirmed でも「検知が出ていた 1 秒」として数える
  const shownFrames = new Set<number>()
  for (const [id, t] of tracks) {
    if (t.everRelated) {
      if (t.firstLikelyMs < likelyMs) likelyMs = t.firstLikelyMs
      if (t.firstConfirmedMs != null && t.firstConfirmedMs < confirmedMs) confirmedMs = t.firstConfirmedMs
      for (const ms of confirmedAt.get(id) ?? []) shownFrames.add(ms)
    } else {
      out.unrelated++
      if (t.firstConfirmedMs != null) out.unrelatedConfirmed = (out.unrelatedConfirmed ?? 0) + 1
      if (inCatalog(t.firstLikelyMs, t.pos) !== true) {
        out.unrelatedNoCatalog = (out.unrelatedNoCatalog ?? 0) + 1
        if (t.firstConfirmedMs != null) out.unrelatedNoCatalogConfirmed = (out.unrelatedNoCatalogConfirmed ?? 0) + 1
      }
      onUnrelated({ label: w.label, category: w.category, windowStartMs: frames[0].ms, firstLikelyMs: t.firstLikelyMs, firstConfirmedMs: t.firstConfirmedMs, pos: t.pos, at: t.at })
      if (out.unrelatedAt.length < 3) {
        const at = hhmmssOf(frames, t.firstLikelyMs)
        out.unrelatedAt.push(`${at ?? '??:??:??'} ${t.at ?? '重心なし'}`)
      }
    }
  }
  out.confirmedFrames = shownFrames.size
  if (likelyMs < Infinity) {
    out.tier = confirmedMs < Infinity ? 'confirmed' : 'likely'
    out.firstLikely = hhmmssOf(frames, likelyMs)
    out.firstConfirmed = confirmedMs < Infinity ? hhmmssOf(frames, confirmedMs) : null
  }
  return out
}

// ============================================================
// 集計・出力
// ============================================================

/** 観測点が極端に少ない海域（南西諸島・外洋の島嶼）。検知率を本土と分けて見るため。 */
const REMOTE = /西表島|与那国|宮古島|石垣|沖縄|奄美|トカラ|硫黄島|小笠原|台湾|大東|八丈島|青ヶ島|鳥島|父島/
const SCALE_LABEL: Record<number, string> = {
  10: '震度1',
  20: '震度2',
  30: '震度3',
  40: '震度4',
  45: '震度5弱',
  50: '震度5強',
  55: '震度6弱',
  60: '震度6強',
  70: '震度7',
}

function primaryQuake(w: WindowSpec): Quake | null {
  if (!w.primary) return w.quakes[0] ?? null
  return w.quakes.find((q) => q.time === w.primary?.time && q.name === w.primary?.name) ?? w.quakes[0] ?? null
}

function pct(a: number, b: number): string {
  return b === 0 ? '  -' : `${((a / b) * 100).toFixed(0).padStart(3)}%`
}

/** 分類ごとの「合格」の定義。窓ごとに満たしているかを判定する。 */
const PASS: Record<Category, { name: string; want: string; ok: (w: WindowSpec, r: Result) => boolean }> = {
  positive: {
    name: '正のコントロール',
    want: '確定検知に達する',
    ok: (_w, r) => r.tier === 'confirmed',
  },
  major: { name: '大地震', want: '確定検知に達する', ok: (_w, r) => r.tier === 'confirmed' },
  catalog: { name: '気象庁発表の地震', want: '検知率を集計する母集団', ok: () => true },
  // 無感の小さな本物の地震を拾うのは当たりと数え、早い段だけで消えた検知も数えない
  // （2026-10-29 ユーザー選択「当てはまらない確かな段 0 (Recommended)」。根拠の決定は 2026-10-28「どちらの段も当たり」）
  quiet: { name: '平常時', want: 'カタログに当てはまらない確かな段が 0', ok: (_w, r) => (r.unrelatedNoCatalogConfirmed ?? 0) === 0 },
  'reported-false-positive': {
    name: '報告された誤検知',
    want: 'カタログに当てはまらない確かな段が 0',
    ok: (_w, r) => (r.unrelatedNoCatalogConfirmed ?? 0) === 0,
  },
}

function report(rows: { w: WindowSpec; r: Result }[]): void {
  console.log('')
  console.log('=== 分類ごとの集計 ===')
  console.log('分類                      窓数  地震あり   捉えた(確定/可能性)  無関係な検知   期待どおり')
  const cats: Category[] = ['positive', 'major', 'catalog', 'quiet', 'reported-false-positive']
  for (const c of cats) {
    const sub = rows.filter((x) => x.w.category === c)
    if (sub.length === 0) continue
    const withQuake = sub.filter((x) => x.w.quakes.length > 0).length
    const conf = sub.filter((x) => x.r.tier === 'confirmed').length
    const like = sub.filter((x) => x.r.tier === 'likely').length
    const un = sub.reduce((s, x) => s + x.r.unrelated, 0)
    const pass = sub.filter((x) => PASS[c].ok(x.w, x.r)).length
    console.log(
      `${PASS[c].name.padEnd(24)}${String(sub.length).padStart(4)}${String(withQuake).padStart(9)}` +
        `${String(conf).padStart(12)} /${String(like).padStart(4)}${String(un).padStart(13)}` +
        `${String(pass).padStart(10)}/${sub.length}`,
    )
  }
  console.log('')
  for (const c of cats) {
    if (rows.some((x) => x.w.category === c)) console.log(`  ${PASS[c].name}: ${PASS[c].want}`)
  }

  // 期待を満たさなかった窓
  const failed = rows.filter((x) => x.w.category !== 'catalog' && !PASS[x.w.category].ok(x.w, x.r))
  console.log('')
  if (failed.length === 0) {
    console.log('=== 期待を満たさなかった窓: なし ===')
  } else {
    console.log(`=== 期待を満たさなかった窓: ${failed.length} ===`)
    for (const x of failed.slice(0, 40)) {
      const detail =
        x.r.unrelated > 0 ? `無関係な検知 ${x.r.unrelated}件（${x.r.unrelatedAt.join(' | ')}）` : `段階 ${x.r.tier}`
      console.log(`  ${x.w.label.padEnd(18)} ${PASS[x.w.category].name}  ${detail}`)
      if (x.w.note) console.log(`  ${' '.repeat(18)} └ ${x.w.note}`)
    }
    if (failed.length > 40) console.log(`  …ほか ${failed.length - 40} 窓`)
  }

  // カタログ窓は本土 / 離島・最大震度で切り直す
  const cat = rows.filter((x) => x.w.category === 'catalog')
  if (cat.length > 0) {
    console.log('')
    console.log('=== 気象庁発表の地震の検知率 ===')
    for (const [label, filter] of [
      ['本土', (q: Quake) => !REMOTE.test(q.name)],
      ['離島・南西諸島', (q: Quake) => REMOTE.test(q.name)],
    ] as const) {
      const sub = cat.filter((x) => {
        const q = primaryQuake(x.w)
        return q != null && filter(q)
      })
      if (sub.length === 0) continue
      const ok = sub.filter((x) => x.r.tier !== 'none').length
      console.log(`  ${label}（${sub.length}件）: ${pct(ok, sub.length)}`)
      for (const s of [10, 20, 30, 40, 45, 50, 55, 60, 70]) {
        const ss = sub.filter((x) => primaryQuake(x.w)?.maxScale === s)
        if (ss.length === 0) continue
        const o = ss.filter((x) => x.r.tier !== 'none').length
        console.log(
          `      ${(SCALE_LABEL[s] ?? String(s)).padEnd(5)}: ${String(o).padStart(3)}/${String(ss.length).padEnd(3)} = ${pct(o, ss.length)}`,
        )
      }
    }
    const un = cat.reduce((s, x) => s + x.r.unrelated, 0)
    console.log(`  （このほか、地震と無関係な検知が ${un} 件）`)
  }

  // 無関係な検知の一覧
  const noisy = rows.filter((x) => x.r.unrelated > 0)
  const total = noisy.reduce((s, x) => s + x.r.unrelated, 0)
  console.log('')
  const totalConfirmed = noisy.reduce((s, x) => s + (x.r.unrelatedConfirmed ?? 0), 0)
  console.log(`=== 無関係な検知: 全 ${total} 件 / ${noisy.length} 窓（うち confirmed まで上がったもの ${totalConfirmed} 件） ===`)
  const noCat = noisy.reduce((s, x) => s + (x.r.unrelatedNoCatalog ?? 0), 0)
  const noCatConfirmed = noisy.reduce((s, x) => s + (x.r.unrelatedNoCatalogConfirmed ?? 0), 0)
  console.log(`  震源カタログ（無感も入る）のどの地震にも当てはまらないもの: ${noCat} 件（うち confirmed ${noCatConfirmed} 件）`)
  for (const x of noisy.slice(0, 30)) {
    console.log(`  ${x.w.label.padEnd(18)} ${String(x.r.unrelated).padStart(2)}件  ${x.r.unrelatedAt.join(' | ')}`)
  }
  if (noisy.length > 30) console.log(`  …ほか ${noisy.length - 30} 窓`)
}

function diffBaseline(rows: { w: WindowSpec; r: Result }[]): boolean {
  if (!existsSync(BASELINE_PATH)) {
    console.log('')
    console.log(`ベースラインがありません（${BASELINE_PATH}）。--update-baseline で作成してください`)
    return false
  }
  const base = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as { results: Record<string, Result> }
  const changes: string[] = []
  // ベースラインにあるのに今回測れなかった窓。母集団が縮んだまま「差分なし」と出すと、
  // 検知率が静かに別のものを指す（200 窓が取得不能でも、残りに差分が無ければ「なし」になってしまう）
  const measured = new Set(rows.map((x) => x.w.label))
  for (const label of Object.keys(base.results)) {
    if (!measured.has(label)) changes.push(`  ${label.padEnd(18)} 今回は測定できていない（母集団から欠落）`)
  }
  for (const { w, r } of rows) {
    const b = base.results[w.label]
    if (!b) {
      changes.push(`  ${w.label.padEnd(18)} 新規`)
      continue
    }
    const parts: string[] = []
    if (b.tier !== r.tier) parts.push(`段階 ${b.tier} → ${r.tier}`)
    if (b.firstConfirmed !== r.firstConfirmed) parts.push(`初confirmed ${b.firstConfirmed ?? '-'} → ${r.firstConfirmed ?? '-'}`)
    if (b.firstLikely !== r.firstLikely) parts.push(`初likely ${b.firstLikely ?? '-'} → ${r.firstLikely ?? '-'}`)
    // 旧ベースライン（この項目が無い頃のもの）は undefined になる。比較から外して誤検出しない
    if (b.confirmedFrames != null && b.confirmedFrames !== r.confirmedFrames) {
      parts.push(`確定の継続 ${b.confirmedFrames} → ${r.confirmedFrames} フレーム`)
    }
    if (b.unrelated !== r.unrelated) parts.push(`無関係な検知 ${b.unrelated} → ${r.unrelated}`)
    // 平常時・誤検知の窓の合否はこの数で決まる（`PASS`）。比べないと、合否が変わっても差分に出ない
    if ((b.unrelatedNoCatalogConfirmed ?? 0) !== (r.unrelatedNoCatalogConfirmed ?? 0)) {
      parts.push(`当てはまらない確かな段 ${b.unrelatedNoCatalogConfirmed ?? 0} → ${r.unrelatedNoCatalogConfirmed ?? 0}`)
    }
    if (parts.length > 0) {
      const q = primaryQuake(w)
      const meta = q ? ` [${q.name} M${q.mag} ${SCALE_LABEL[q.maxScale] ?? q.maxScale}]` : ''
      changes.push(`  ${w.label.padEnd(18)} ${parts.join(' / ')}${meta}`)
    }
  }
  console.log('')
  if (changes.length === 0) {
    console.log('=== ベースラインとの差分: なし ===')
    return false
  }
  console.log(`=== ベースラインとの差分: ${changes.length} 窓 ===`)
  for (const c of changes) console.log(c)
  return true
}

// ============================================================
// main
// ============================================================

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const allowFetch = argv.includes('--fetch')
  const updateBaseline = argv.includes('--update-baseline')
  // 助走: --warmup で控えた分を窓の前に食わせる。--fetch-warmup で控えに無い窓だけ取る。
  // --warmup-dry-run は取らずに、最低の長さ（WARMUP_MIN_BLOCKS）ぶん投げる URL と件数だけを数える
  const warmupDryRun = argv.includes('--warmup-dry-run')
  const fetchWarmupArg = argv.includes('--fetch-warmup')
  const useWarmup = argv.includes('--warmup') || fetchWarmupArg || warmupDryRun
  if (useWarmup && updateBaseline) {
    console.error('--warmup ではベースラインを更新しません（入れ替えるときに決める）')
    process.exit(1)
  }
  const tablesPath = argv.find((a) => a.startsWith('--tables='))?.slice('--tables='.length) ?? 'public/data/kyoshin-quiet-tables.json'
  if (!existsSync(tablesPath)) {
    console.error(`平常のゆらぎの表 ${tablesPath} がありません（scripts/build-kyoshin-quiet-tables.ts で焼くか、--tables= で指す）`)
    process.exit(1)
  }
  const rawTables: unknown = JSON.parse(readFileSync(tablesPath, 'utf8'))
  validateQuietTables(rawTables)
  const tables: QuietTables = rawTables
  console.log(`平常のゆらぎの表 ${tablesPath}（焼いた日 ${tables.days.join(',') || '不明'}）`)
  const onlyArg = argv.find((a) => a.startsWith('--only'))
  let only: string[] | null = null
  if (onlyArg) {
    const raw = onlyArg.includes('=') ? onlyArg.split('=')[1] : (argv[argv.indexOf(onlyArg) + 1] ?? '')
    only = raw.split(',').filter(Boolean)
    // 値の書き忘れ・フラグの読み違え（`--only --fetch` 等）を、0 窓の無言実行にしない
    const unknown = only.filter((c) => !(c in PASS))
    if (only.length === 0 || unknown.length > 0) {
      console.error(
        `--only の指定が不正です（${unknown.join(', ') || '値なし'}）。使える分類: ${Object.keys(PASS).join(', ')}`,
      )
      process.exit(1)
    }
  }

  const catalog = JSON.parse(readFileSync(WINDOWS_PATH, 'utf8')) as Catalog
  const windows = only ? catalog.windows.filter((w) => only.includes(w.category)) : catalog.windows
  console.log(`窓 ${windows.length} / ${catalog.windows.length}（キャッシュ ${CACHE_DIR}）`)

  if (warmupDryRun) {
    // 空振り: どの秒も「静穏」の偽フレームを返し、最低の長さで止まる遡りが投げる URL を数える
    const urls: string[] = []
    const fake = async (dateStr: string, ts: string, ms: number): Promise<Frame> => {
      urls.push(`${REALTIME_BASE('west')}/${dateStr}/${ts}.json`)
      return { ms, ts, indices: [0], cfg: '' }
    }
    let need = 0
    for (const w of windows) {
      if (loadWarmup(w.label)) continue
      need++
      await fetchWarmup(w, fake)
    }
    console.log(`助走を取る窓 ${need} / ${windows.length}・投げる URL ${urls.length} 件（静穏で最短に止まった場合。揺れが続けば窓ごとに最大 ${WARMUP_MAX_BLOCKS * WARMUP_BLOCK_SEC} 件）`)
    console.log(`  先頭: ${urls[0] ?? '-'}`)
    console.log(`  末尾: ${urls[urls.length - 1] ?? '-'}`)
    console.log(`  重複: ${urls.length - new Set(urls).size} 件`)
    return
  }

  const rows: { w: WindowSpec; r: Result }[] = []
  /** 助走の様子（窓数）。止まった理由ごと・使えなかった理由ごとに数える */
  const warmupTally: Record<string, number> = {}
  const warmupLengths: number[] = []
  /** 無関係な検知の一覧。`--dump-unrelated=<ファイル>` のときだけ書き出す（震源カタログとの突き合わせ用） */
  const unrelatedDump: UnrelatedDump[] = []
  const dumpPath = argv.find((a) => a.startsWith('--dump-unrelated='))?.slice('--dump-unrelated='.length)
  /** 測定できなかった窓（ラベルと理由）。分類ごとの取りこぼしを見るため窓ごと保持する。 */
  const skipped: { w: WindowSpec; reason: string }[] = []
  /** 取得率が 100% に満たないまま測定に使った窓（欠測はあるが判断はできる範囲）。 */
  const partial: { label: string; got: number; want: number }[] = []
  let done = 0
  for (const w of windows) {
    let frames: Frame[]
    const loaded = loadFrames(w.label)
    if (loaded.kind === 'ok') frames = loaded.frames
    else if (allowFetch) frames = await fetchWindow(w)
    else {
      skipped.push({ w, reason: loaded.kind === 'broken' ? loaded.reason : '未取得' })
      continue
    }

    // 取得率が足りない窓は使わない。欠測がエンジンの状態リセットを誘発し、
    // 「検知できなかった」という結果がデータの穴だけを理由に生まれる
    if (frames.length / w.seconds < MIN_COVERAGE) {
      skipped.push({ w, reason: `取得不足 ${frames.length}/${w.seconds}` })
      continue
    }
    if (frames.length < w.seconds) partial.push({ label: w.label, got: frames.length, want: w.seconds })

    // 観測点リストの版が窓の途中で変わると座標と震度の対応が崩れる（年をまたぐ窓で起こりうる）
    const cfg = frames[0].cfg
    if (frames.some((f) => f.cfg !== cfg)) {
      skipped.push({ w, reason: '窓の途中で観測点リストの版が変わっている' })
      continue
    }
    const sites = await loadSites(cfg, allowFetch)
    if (!sites || sites.length !== frames[0].indices.length) {
      skipped.push({ w, reason: '観測点リストと震度列の長さが違う' })
      continue
    }
    // 助走: アプリと同じく、最後の大きな穴より後ろ（firstContinuousIndex）だけを使う。版が違う分は食わせない
    let lead: Frame[] = []
    if (useWarmup) {
      let cache = loadWarmup(w.label)
      if (!cache && fetchWarmupArg) {
        cache = await fetchWarmup(w, fetchFrame)
        mkdirSync(dirname(warmupPath(w.label)), { recursive: true })
        writeFileSync(warmupPath(w.label), JSON.stringify(cache))
      }
      if (!cache) {
        warmupTally['未取得'] = (warmupTally['未取得'] ?? 0) + 1
      } else {
        const all = cache.frames.filter((f) => f.ms < frames[0].ms)
        const usable = all.slice(firstContinuousIndex([...all.map((f) => f.ms), frames[0].ms]))
        lead = usable.filter((f) => f.cfg === cfg && f.indices.length === sites.length)
        const why = lead.length < usable.length ? '版が違う分を除いた' : cache.stoppedBy
        warmupTally[why] = (warmupTally[why] ?? 0) + 1
        warmupLengths.push(lead.length)
      }
    }
    try {
      const run = ensembleRunner(sites, tables)
      for (const f of lead) run(f)
      rows.push({ w, r: measure(w, frames, run, (d) => unrelatedDump.push(d)) })
    } catch (e) {
      // 1 窓の異常で全窓の結果を捨てない。原因の窓が分かる形で残して次へ進む
      skipped.push({ w, reason: `測定中に例外（${e instanceof Error ? e.message : String(e)}）` })
      continue
    }
    done++
    if (done % 100 === 0) process.stdout.write(`  …${done}/${windows.length}\n`)
  }

  if (skipped.length > 0) {
    console.log('')
    console.log(`測定できなかった窓: ${skipped.length}（未取得なら --fetch で取得できます）`)
    const byCat: Record<string, number> = {}
    for (const x of skipped) byCat[x.w.category] = (byCat[x.w.category] ?? 0) + 1
    for (const [c, n] of Object.entries(byCat)) {
      console.log(`  ${c}: ${n}/${windows.filter((w) => w.category === c).length}`)
    }
    for (const x of skipped.slice(0, 10)) console.log(`    ${x.w.label} — ${x.reason}`)
    if (skipped.length > 10) console.log(`    …ほか ${skipped.length - 10} 件`)
  }
  if (partial.length > 0) {
    console.log('')
    console.log(`欠測を含むまま測定した窓: ${partial.length}`)
    for (const x of partial.slice(0, 10)) console.log(`  ${x.label} — ${x.got}/${x.want}`)
    if (partial.length > 10) console.log(`  …ほか ${partial.length - 10} 件`)
  }

  if (useWarmup) {
    const sorted = [...warmupLengths].sort((a, b) => a - b)
    const mean = sorted.length ? Math.round(sorted.reduce((s, x) => s + x, 0) / sorted.length) : 0
    console.log('')
    console.log(`助走: ${Object.entries(warmupTally).map(([k, n]) => `${k} ${n}`).join('・')}（平均 ${mean} 秒・最短 ${sorted[0] ?? '-'}・最長 ${sorted[sorted.length - 1] ?? '-'}）`)
  }

  if (rows.length === 0) {
    console.log('')
    console.log('測定できた窓がありません。`npm run bench-kyoshin -- --fetch` で過去フレームを取得してください')
    return
  }

  report(rows)
  if (dumpPath) {
    writeFileSync(dumpPath, JSON.stringify(unrelatedDump))
    console.log(`無関係な検知 ${unrelatedDump.length} 件を ${dumpPath} へ書き出した`)
  }

  if (updateBaseline) {
    const base = existsSync(BASELINE_PATH)
      ? (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as { results: Record<string, Result> })
      : { results: {} }
    for (const { w, r } of rows) base.results[w.label] = r
    mkdirSync(dirname(BASELINE_PATH), { recursive: true })
    writeFileSync(BASELINE_PATH, JSON.stringify(base, null, 1))
    console.log('')
    console.log(`ベースラインを更新しました（${Object.keys(base.results).length} 窓）`)
    return
  }
  const changed = diffBaseline(rows)
  // 差分の有無は表示にだけ使う（CI では回さない前提。回すなら終了コードに反映すること）
  if (changed) console.log('意図した変更なら `-- --update-baseline` で受け入れてください')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
