/**
 * 気象庁の震源を日ごとに控えから読む（強震モニタの評価・平常のゆらぎの表を焼くスクリプトで共有）。
 *
 * - 確定値の年の ZIP（`.cache/hypocenter-cache/zip/h<年>.zip`）を優先し、無ければ日別の震源リスト
 *   （`.cache/hypocenter-cache/<日>.html`）を読む。どちらも `build-hypocenter-catalog` と同じ控え
 * - 控えに無い日は {@link fetchDailyHypocenters} で日別の震源リストを取る（取るかどうかは呼ぶ側が決める）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { cacheDir } from './cacheDir.mjs'
import type { CatalogQuake } from './kyoshinCatalogMatch'
import { parseHypocenterRecord } from '../hypocenterRecord'
import { extractDailyHypocenterRows, parseDailyHypocenterLine } from '../hypocenterDailyRecord'

export const HYPO_DIR = cacheDir('hypocenter-cache')
const DAILY_BASE = 'https://www.data.jma.go.jp/eqev/data/daily_map'
/** 日別の震源リストを続けて取るときの間（`build-hypocenter-catalog` の `DAILY_FETCH_INTERVAL_MS` に倣う） */
export const DAILY_FETCH_INTERVAL_MS = 120
/**
 * 日別の震源リストが出そろうまで待つ日数。これより新しい日のリストを取ると、途中までの一覧を確定扱いで控えてしまう。
 * 2026-10-29 のリストは 10-31 に取って 972 件そろっていた（2 日後）。1 日ぶんの余裕を足して 3 日
 */
export const DAILY_SETTLE_DAYS = 3
/** 日別の震源リストを 1 件取るのを待つ上限 */
const DAILY_FETCH_TIMEOUT_MS = 30_000

/** YYYYMMDD の日から `delta` 日ずらした日（YYYYMMDD） */
export function shiftDay(day: string, delta: number): string {
  const t = Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8)) + delta * 86_400_000
  return new Date(t).toISOString().slice(0, 10).replace(/-/g, '')
}

/** 日本時間の今日（YYYYMMDD） */
export function todayJst(nowMs = Date.now()): string {
  return new Date(nowMs + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, '')
}

/** 日本時間の今日（YYYYMMDD）から見て、日別の震源リストが出そろったとみなせる最後の日。これより新しい日は取らない */
export function settledDay(todayJst: string): string {
  return shiftDay(todayJst, -DAILY_SETTLE_DAYS)
}

export type QuakeSource = '確定値' | '日別の震源リスト'
export interface DayQuakes { source: QuakeSource; quakes: CatalogQuake[]; unreadable: number }

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

/** その日（日本時間の YYYYMMDD）の震源を控えから読む。確定値を優先し、無ければ日別の震源リスト。どちらも無ければ null。読めなかった行も数える。 */
export function readDayHypocenters(day: string): DayQuakes | null {
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
export async function fetchDailyHypocenters(day: string): Promise<void> {
  const res = await fetch(`${DAILY_BASE}/${day}.html`, { signal: AbortSignal.timeout(DAILY_FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${day} の震源リストを取れませんでした（HTTP ${res.status}）`)
  const html = await res.text()
  if (extractDailyHypocenterRows(html).length === 0) throw new Error(`${day} の震源リストが 0 件でした（控えません）`)
  mkdirSync(HYPO_DIR, { recursive: true })
  writeFileSync(join(HYPO_DIR, `${day}.html`), html, 'utf8')
}
