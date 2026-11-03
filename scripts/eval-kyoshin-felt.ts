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
 *   一覧に載っていない日・読めなかった報（電文を読み取れない・発生時刻や EventID が無い）・震源リストの控えが無い日と読めなかった行・
 *   最大震度の地域の代表点を 1 つでも引けない震度速報
 * - 震度速報（VXSE51）しか出ていない地震も数える（設計書§64）。同じ地震の震源・震度情報が別の EventID で出ていれば結んでそちらで数え、
 *   結べないものは最大震度を観測した地域の代表点（`public/data/subregions.json` の `label`）と時刻で束に当てる
 * - 連続評価が秒フレームの無かった時間（`runs[].missingHours`）に起きた地震は、助走の間・終わり際と同じく数えない
 * - 結果ファイルは素の `fs` で読み書きする。連続評価の結果は `incompleteness.mjs` の印を使わず、自分の `summary.complete` で欠けを持つため
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import type { CatalogQuake } from './lib/kyoshinCatalogMatch'
import { readDayHypocenters } from './lib/hypocenterDays'
import {
  type FeltEvent, type FeltQuake, type FeltReport, type ShindoOnly, type ShindoReport, archiveDaysOf, areaScalesOf, feltQuakeOf, latestPerEvent,
  latestQuakeStates, latestShindoPerEvent, linkShindo, matchFeltQuakes, matchShindoOnly, segmentsOfDays, shindoReportOf,
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
  /** 震源・震度情報の報と、その報の地域ごとの最大震度（震度速報と結ぶのに使う） */
  const quakeReports: { report: FeltReport; areas: Map<string, number> }[] = []
  const shindoReports: ShindoReport[] = []
  let telegrams51 = 0
  // 長いアーカイブ読みの後で落ちないよう、地域の代表点は先に読む
  const labels = new Map((JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../public/data/subregions.json'), 'utf8')) as
    { name: string; label: [number, number] }[]).map((a) => [a.name, a.label] as const))
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
        if (/^VXSE51_.*\.xml$/i.test(name)) {
          telegrams51++
          const xml = body.toString('utf8')
          const doc = domParser.parseFromString(xml, 'text/xml')
          const tag = (t: string) => doc.getElementsByTagName(t)[0]?.textContent?.trim() ?? null
          const r = shindoReportOf(parseEarthquakeFromXml('VXSE51', xml), tag('TargetDateTime'), tag('ReportDateTime'))
          if (r.kind === 'invalid') invalid.set(r.reason, (invalid.get(r.reason) ?? 0) + 1)
          shindoReports.push(r)
          continue
        }
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
        quakeReports.push({ report: r, areas: q ? areaScalesOf(q) : new Map() })
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
  // 震度速報だけの地震: 同じ EventID の震源・震度情報が数える側（felt）にも取消にも無いもの。数えないと決まった震源・震度情報
  // （震源の位置が決まっていない等）しか無い地震は、震度速報の側で数える（どちらでも数えないと、その地震はどこにも数えられない）
  const states = latestQuakeStates(quakeReports)
  const latest51 = latestShindoPerEvent(shindoReports)
  const stateOf = (id: string) => states.get(id)?.state
  const shindoOnly = latest51.shindo.filter((s) => stateOf(s.eventId) !== 'felt' && stateOf(s.eventId) !== 'cancel')
  const viaSkip = shindoOnly.filter((s) => stateOf(s.eventId) === 'skip').length
  // 同じ EventID の震源・震度情報が最後に取り消された地震は、その地震の情報が取り下げられたとみて震度速報の側でも数えない
  // （能登の週・普段の週とも 0 件。件数は画面と結果に出す）
  const cancelledBy53 = latest51.shindo.filter((s) => stateOf(s.eventId) === 'cancel').length
  // 自分の EventID の震度速報を持つ震源・震度情報は、別の震度速報の結び先にしない
  const own51 = new Set(shindoReports.flatMap((r) => (r.kind === 'shindo' ? [r.shindo.eventId] : r.kind === 'cancel' ? [r.eventId] : [])))
  const { unlinked, links } = linkShindo(shindoOnly, felt.map((q) => {
    const st = states.get(q.eventId)
    // felt は latestPerEvent と同じ規則で数える報なので、状態は必ず felt で引ける。引けなければ規則がずれている
    if (st?.state !== 'felt') throw new Error(`震源・震度情報 ${q.eventId} の状態が数える報になっていない（${st?.state ?? '無し'}）。報の採り方の食い違い`)
    return { eventId: q.eventId, minuteMs: q.minuteMs, areas: st.areas }
  }), new Set(felt.map((q) => q.eventId).filter((id) => own51.has(id))))
  const shindoRes = matchShindoOnly(unlinked, result.events, result.days, result.warmupSec, missingHours, JST_OFFSET_MS, (a) => labels.get(a) ?? null)
  // 欠けの印に効く（結べず、見ていた時刻の）震度速報の、代表点を引けない地域
  const unlabeledAreas = [...new Set(shindoRes.noLabel.flatMap((s) => s.topAreas).filter((a) => !labels.has(a)))]
  // 欠け: 連続評価の結果自体の欠け・読んでいない日・一覧に無い日・読めなかった報・震源リストの控えが無い日と読めなかった行
  // （震源リストに無い地震は分のまま照合するので、先の揺れの束を当たりに数えうる）
  const invalidCount = [...invalid.values()].reduce((s, n) => s + n, 0)
  const complete = result.summary.complete && unseenDays.length === 0 && unlistedDays.length === 0 && notYetDays.length === 0 && invalidCount === 0
    && noHypoDays.size === 0 && unreadableHypoRows === 0 && shindoRes.noLabel.length === 0

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
  const shindoHead = (s: ShindoOnly) => `${jst(s.minuteMs)} 震度速報 震度${getIntensityLabel(s.maxScale)} ${s.topAreas.join('・')}`
  const shindoMisses = shindoRes.rows.filter((r) => r.matched.length === 0)
  console.log(`\n読んだ震度速報 ${telegrams51} 通・震度速報だけの地震 ${shindoOnly.length} 件（震源・震度情報と結べた ${links.length} 件）`)
  console.log(`  取消で落とした震度速報 ${latest51.cancelled} 件・同じ EventID の震源・震度情報が取消になった ${cancelledBy53} 件`
    + `・同じ EventID の震源・震度情報が数えない報だけなので震度速報の側で数えた ${viaSkip} 件`)
  const shindoById = new Map(shindoOnly.map((s) => [s.eventId, s]))
  const feltById = new Map(felt.map((q) => [q.eventId, q]))
  for (const l of links) {
    const s = shindoById.get(l.eventId)!, q = feltById.get(l.to)!
    console.log(`  結んだ: ${shindoHead(s)} → 震源・震度情報 ${l.to}（${q.area}・発生の分の差 ${Math.round((q.minuteMs - s.minuteMs) / 60_000)} 分`
      + `${l.candidates > 1 ? `・候補 ${l.candidates} 件から発生の近いものを採った` : ''}）`)
  }
  console.log(`流した日の結べなかった震度速報 ${shindoRes.rows.length} 件: 束が当たった ${shindoRes.rows.length - shindoMisses.length} 件・当たらなかった ${shindoMisses.length} 件`
    + `（見ていない時間で数えなかった ${shindoRes.outside.length} 件・流していない日 ${shindoRes.unrun} 件）`)
  console.log('  震源が無いので、当たった束が同じ地震のものとは限らない（地域の代表点から 150 km・3 分の内に見え始めた束）')
  if (unlabeledAreas.length > 0) console.log(`  代表点を引けない地域: ${unlabeledAreas.join('・')}`)
  for (const s of shindoRes.noLabel) console.log(`  地域の代表点を引けない: ${shindoHead(s)}`)
  for (const r of shindoRes.rows) {
    const beams = r.matched.map((e, i) => `${jst(e.firstLikelyMs - JST_OFFSET_MS).slice(11)} 点数${e.maxMembers} ${Math.round(r.km[i])}km`)
    console.log(`${shindoHead(r.shindo)} → ${beams.length ? beams.join(' / ') : '束が当たらない'}`)
  }
  for (const s of shindoRes.outside) console.log(`${shindoHead(s)}（助走・終わり際・秒フレームの無い時間）`)
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
    shindoOnly: {
      telegrams: telegrams51, count: shindoOnly.length, cancelled: latest51.cancelled, cancelledBy53, viaSkip, links,
      rows: shindoRes.rows.map((r) => ({ ...r.shindo, matched: r.matched, km: r.km })), outside: shindoRes.outside, noLabel: shindoRes.noLabel,
      unrun: shindoRes.unrun, unlabeledAreas,
    },
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
