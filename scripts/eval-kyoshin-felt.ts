/**
 * 連続評価（`eval-kyoshin-continuous`）の結果ファイルの検知を、気象庁の地震情報が出た地震（有感）と突き合わせる（設計書§58）。
 *
 *   npx tsx scripts/eval-kyoshin-felt.ts <結果の JSON> [--fetch]
 *
 * - 地震情報は DMDATA のアーカイブの控え（`telegram.earthquake` の日ごとの束）から抜き、アプリと同じ読み取り（`parseEarthquakeFromXml`）で読む。
 *   **API キーが要る**（一覧を引くため。控えに無い日の本体は `--fetch` のときだけ取り、1 回 {@link MAX_BODY} 件まで）
 * - 照合に使う発生時刻は震源リストの控え（`scripts/lib/hypocenterDays.ts`）から秒まで引く（`scripts/lib/kyoshinFeltQuakes.ts`）
 * - 結果は `<結果の JSON>` の隣に `-felt.json` を付けて書き、要約・取りこぼし（前後 5 分の束つき）・当たった地震を画面に出す。
 *   欠けがあれば結果に印（`complete: false`）を付けて終了コード 2。欠けとみなすのは、連続評価の結果自体の欠け・アーカイブの控えに無い日と
 *   一覧に載っていない日・読めなかった報（電文を読み取れない・発生時刻や EventID が無い）・震源リストの控えが無い日と読めなかった行
 * - 連続評価が秒フレームの無かった時間（`runs[].missingHours`）に起きた地震は、助走の間・終わり際と同じく数えない
 * - 結果ファイルは素の `fs` で読み書きする。連続評価の結果は `incompleteness.mjs` の印を使わず、自分の `summary.complete` で欠けを持つため
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import type { CatalogQuake } from './lib/kyoshinCatalogMatch'
import { readDayHypocenters } from './lib/hypocenterDays'
import {
  type FeltEvent, type FeltQuake, type FeltReport, archiveDaysOf, feltQuakeOf, latestPerEvent, matchFeltQuakes, segmentsOfDays,
} from './lib/kyoshinFeltQuakes'
import {
  EARTHQUAKE_CLASSIFICATION, apiAuthHeader, archiveCacheStats, dayOf, isArchiveCached, listArchive, loadArchiveTar, tarEntries,
} from './telegram-audit/archive-cache.mjs'
import { haversineKm } from '../src/utils/geo'
import { getIntensityLabel } from '../src/utils/intensity'

/** 控えに無い日の本体を 1 回に取る上限（1 週ぶんの前後 1 日を含めて 9 日。それを超えるなら範囲の取り違えを疑う） */
const MAX_BODY = 16
const JST_OFFSET_MS = 9 * 3_600_000
const DAY_MS = 86_400_000
/** 取りこぼしに添える、前後の束を探す秒数 */
const NEAR_SEC = 300
/** 連続評価の結果ファイルのうち、ここで読む欄 */
interface ContinuousResult {
  days: string[]
  warmupSec: number
  events: FeltEvent[]
  runs: { day: string; missingHours: number[] }[]
  summary: { complete: boolean }
}

async function main(): Promise<void> {
  const resultPath = process.argv[2]
  if (!resultPath || resultPath.startsWith('--')) throw new Error('連続評価の結果の JSON を 1 つ目の引数に渡してください')
  const allowFetch = process.argv.includes('--fetch')
  const result = JSON.parse(readFileSync(resultPath, 'utf8')) as ContinuousResult
  if (!Array.isArray(result.days) || !Array.isArray(result.runs) || typeof result.summary?.complete !== 'boolean') {
    throw new Error(`${resultPath} は連続評価の結果の形ではありません（days・runs・summary.complete が要る）`)
  }

  // dmdataParser.ts はブラウザの DOMParser を使うので、読み込む前に jsdom のものを置く
  globalThis.DOMParser = new JSDOM('').window.DOMParser as unknown as typeof DOMParser
  const { parseEarthquakeFromXml } = await import('../src/services/dmdataParser')
  const domParser = new DOMParser()

  const auth = apiAuthHeader()
  const before = archiveCacheStats().downloads
  const iso = (ms: number) => new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10)
  const reports: FeltReport[] = []
  /** 読めるはずの欄が読めなかった報（理由ごとの件数） */
  const invalid = new Map<string, number>()
  /** 一覧にはあるが控えに無いので読んでいない日（--fetch で取る） */
  const unseenDays: string[] = []
  /** 読むはずなのに、一覧に載っていなかった日 */
  const unlistedDays: string[] = []
  /** 読むはずの日が今日以降で、束がまだ出ていない日（流した最後の日の夜の地震の報を読めていない。欠けとして数える） */
  const notYetDays: string[] = []
  const todayJst = iso(Date.now())
  /** 有感の地震として数えないと決まった報（理由ごとの件数） */
  const skipped = new Map<string, number>()
  let telegrams = 0
  const wanted = archiveDaysOf(result.days)
  // 一覧は両端より広く引かないと端の日が返らないので、前後 1 日ずつ広く引く
  const segs = segmentsOfDays(result.days)
  const items = await listArchive({ classification: EARTHQUAKE_CLASSIFICATION, from: iso(segs[0].from - DAY_MS), to: iso(segs.at(-1)!.to + DAY_MS), auth })
  for (const day of wanted) {
    const dayItems = items.filter((it) => dayOf(it).slice(0, 10) === day)
    if (dayItems.length === 0) { (day >= todayJst ? notYetDays : unlistedDays).push(day); continue }
    for (const item of dayItems) {
      if (!isArchiveCached({ classification: EARTHQUAKE_CLASSIFICATION, item })) {
        if (!allowFetch) { unseenDays.push(day); continue }
        if (archiveCacheStats().downloads - before >= MAX_BODY) throw new Error(`本体の取得が上限 ${MAX_BODY} 件に達したので止めます`)
      }
      const tar = await loadArchiveTar({ classification: EARTHQUAKE_CLASSIFICATION, item, auth })
      for (const { name, body } of tarEntries(tar)) {
        if (!/^VXSE53_.*\.xml$/i.test(name)) continue
        telegrams++
        const xml = body.toString('utf8')
        const q = parseEarthquakeFromXml('VXSE53', xml)
        // 発生時刻は読み取りの結果に無い（`earthquake.time` は発現時刻が優先）ので、電文から直接読む
        const originTime = domParser.parseFromString(xml, 'text/xml').getElementsByTagName('OriginTime')[0]?.textContent?.trim() ?? null
        const r: FeltReport = q ? feltQuakeOf(q, originTime) : { kind: 'invalid', reason: '電文を読み取れない' }
        if (r.kind === 'invalid') invalid.set(r.reason, (invalid.get(r.reason) ?? 0) + 1)
        if (r.kind === 'skip') skipped.set(r.reason, (skipped.get(r.reason) ?? 0) + 1)
        reports.push(r)
      }
    }
  }

  const hypoByDay = new Map<string, CatalogQuake[]>()
  const noHypoDays = new Set<string>()
  let unreadableHypoRows = 0
  const catalogOf = (q: FeltQuake): CatalogQuake[] => {
    const day = iso(q.minuteMs).replace(/-/g, '')
    if (!hypoByDay.has(day)) {
      const d = readDayHypocenters(day)
      if (d === null) noHypoDays.add(day)
      unreadableHypoRows += d?.unreadable ?? 0
      hypoByDay.set(day, d?.quakes ?? [])
    }
    return hypoByDay.get(day)!
  }
  const { quakes: felt, cancelled } = latestPerEvent(reports)
  const missingHours = result.runs.flatMap((r) => r.missingHours.map((hour) => ({ day: r.day, hour })))
  const { rows, outside } = matchFeltQuakes(felt, result.events, result.days, result.warmupSec, missingHours, JST_OFFSET_MS, catalogOf)
  // 欠け: 連続評価の結果自体の欠け・読んでいない日・一覧に無い日・読めなかった報・震源リストの控えが無い日と読めなかった行
  // （震源リストに無い地震は分のまま照合するので、先の揺れの束を当たりに数えうる）
  const invalidCount = [...invalid.values()].reduce((s, n) => s + n, 0)
  const complete = result.summary.complete && unseenDays.length === 0 && unlistedDays.length === 0 && notYetDays.length === 0 && invalidCount === 0
    && noHypoDays.size === 0 && unreadableHypoRows === 0

  const jst = (ms: number) => new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 19)
  const head = (q: FeltQuake, t: number) =>
    `${jst(t)} 震度${getIntensityLabel(q.maxScale)} M${q.mag} 深さ${Number.isFinite(q.depth) ? q.depth : '不明'}km ${q.area}`
  const hits = rows.filter((r) => r.matched.length > 0)
  const misses = rows.filter((r) => r.matched.length === 0)
  const minuteOnly = rows.filter((r) => !r.fromCatalog).length
  console.log(`読んだ震源・震度情報 ${telegrams} 通・地震情報の出た地震 ${felt.length} 件（取消で落とした地震 ${cancelled} 件）`)
  console.log(`流した日の地震情報の出た地震 ${rows.length} 件: 束が当たった ${hits.length} 件・当たらなかった ${misses.length} 件（助走・終わり際・秒フレームの無い時間で数えなかった ${outside.length} 件）`)
  if (minuteOnly > 0) console.log(`  震源リストに見つからず、分のまま照合した地震 ${minuteOnly} 件`)
  if (!result.summary.complete) console.log('  連続評価の結果に欠けの印が付いている（見ていない時間がある）')
  if (noHypoDays.size > 0) console.log(`  震源リストの控えが無い日 ${[...noHypoDays].join(' ')}（その日の地震は分のまま照合した）`)
  if (unreadableHypoRows > 0) console.log(`  震源リストの控えの読めなかった行 ${unreadableHypoRows} 行`)
  if (unseenDays.length > 0) console.log(`  アーカイブの控えに無いので見ていない日 ${unseenDays.join(' ')}（--fetch で取る）`)
  if (unlistedDays.length > 0) console.log(`  アーカイブの一覧に載っていない日 ${unlistedDays.join(' ')}`)
  if (notYetDays.length > 0) console.log(`  アーカイブの束がまだ出ていない日 ${notYetDays.join(' ')}（流した最後の日の夜の地震の報を読めていない）`)
  for (const [reason, n] of skipped) console.log(`  数えなかった報 ${n} 通（${reason}）`)
  for (const [reason, n] of invalid) console.log(`  読めなかった報 ${n} 通（${reason}）`)
  const visible = result.events.filter((e) => !e.inWarmup)
  for (const r of misses) {
    const near = visible.filter((e) => Math.abs(e.firstLikelyMs - JST_OFFSET_MS - r.t) <= NEAR_SEC * 1000)
      .map((e) => `${jst(e.firstLikelyMs - JST_OFFSET_MS).slice(11)} 点数${e.maxMembers} ${Math.round(haversineKm(r.quake.lat, r.quake.lng, e.pos[0], e.pos[1]))}km${e.firstConfirmedMs != null ? ' 確かな段' : ''}`)
    console.log(`${head(r.quake, r.t)} (${r.quake.lat},${r.quake.lng})${r.fromCatalog ? '' : ' 分のまま'}`)
    console.log(near.length ? `    前後 ${NEAR_SEC / 60} 分の束: ${near.join(' / ')}` : `    前後 ${NEAR_SEC / 60} 分に束は無い`)
  }
  for (const q of outside) console.log(`${head(q, q.minuteMs)}（助走・終わり際・秒フレームの無い時間）`)
  console.log('\n当たった地震:')
  for (const r of hits) {
    const best = r.matched[0]
    const km = Math.round(haversineKm(r.quake.lat, r.quake.lng, best.pos[0], best.pos[1]))
    const dt = Math.round((best.firstLikelyMs - JST_OFFSET_MS - r.t) / 1000)
    const conf = r.matched.some((e) => e.firstConfirmedMs != null)
    console.log(`${head(r.quake, r.t)} → ${km}km・${dt}秒後・点数${best.maxMembers}・束${r.matched.length}${conf ? '・確かな段あり' : '・早い段どまり'}`)
  }

  const out = resultPath.replace(/\.json$/, '') + '-felt.json'
  writeFileSync(out, JSON.stringify({
    timeBasis: 't・minuteMs・issuedMs は UTC のミリ秒。matched の firstLikelyMs は控えの時刻（日本時間をそのまま UTC として数えたミリ秒）',
    complete, sourceComplete: result.summary.complete, unseenDays, unlistedDays, notYetDays, invalid: Object.fromEntries(invalid), skipped: Object.fromEntries(skipped),
    noHypoDays: [...noHypoDays], unreadableHypoRows, minuteOnly, telegrams, cancelled,
    rows: rows.map((r) => ({ ...r.quake, t: r.t, fromCatalog: r.fromCatalog, matched: r.matched })),
    outside,
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
