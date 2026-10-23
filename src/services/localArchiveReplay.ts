// DMDATA/P2PQuakeアーカイブが存在しない期間（DMDATAアーカイブの最古=2020-11-18より前等）向けの、
// アプリに同梱したローカル履歴アーカイブからの読み出し。App.tsx の fetchReplayEvents は
// findCoveringArchiveSync で対象範囲がここに収録されているか先に確認し、見つかれば
// DMDATA/P2PQuakeへ問い合わせる代わりにここから返す（ReplayFetchResult の形は共通）。
//
// DMDATAアーカイブと違い、対象期間の電文は最初から index.json 側で分かっている
// （ネットワーク越しに逐次アーカイブ一覧を取りに行く必要がない）ため、ここでは
// ウィンドウ分割・先読みを意識せず、指定範囲を一括でフィルタして返すだけでよい。
// useReplayController のプリフェッチが 1 時間ごとに呼び直しても、単に同じ配列を
// 都度フィルタし直すだけなので副作用は無い。

import type { ReplayEntry, ReplayFetchResult, QuakeHistoryResult } from '../types/replay'
import type { JMAQuake, JMATsunami } from '../types/earthquake'
import type { ReplayFetchPurpose } from '../hooks/useReplayController'
import type { HistoricalArchiveFile, HistoricalArchiveIndex, HistoricalArchiveMeta } from '../types/historicalArchive'
import { validateHistoricalArchiveIndex, validateHistoricalArchiveFile } from '../utils/historicalArchiveSchema'
import { selectQuakeHistory } from '../utils/quakeHistorySelection'
import { getAreaPrefIndexCache } from '../utils/stationCoords'
import { historyExtraKey } from './dmdataTelegramPayload'
import { fetchJsonWithTimeout } from '../utils/fetchJson'
import { log } from '../utils/logger'

const INDEX_URL = `${import.meta.env.BASE_URL}data/historical-archives/index.json`
const fileUrl = (id: string): string => `${import.meta.env.BASE_URL}data/historical-archives/${id}.json`

// index・本体とも同一セッション中は変わらない配信物のため、成功した取得結果はキャッシュする
// （日時を変えて何度も「確定」を押しても再取得しない）。ただし失敗はキャッシュしない
// （下記 loadIndex/loadFile 参照。dmdataReplay.ts の downloadArchive と同じ方針）。
let indexCache: Promise<HistoricalArchiveIndex> | null = null
const fileCache = new Map<string, Promise<HistoricalArchiveFile | null>>()

/** テスト用。テスト間で確実に状態を切り離す。 */
export function clearLocalArchiveCache(): void {
  indexCache = null
  fileCache.clear()
}

function loadIndex(): Promise<HistoricalArchiveIndex> {
  if (indexCache) return indexCache
  const promise = fetchJsonWithTimeout<unknown>(INDEX_URL, 'historical-archives index', { trackStatus: false })
    .then((raw) => {
      const { valid, skipped, malformed } = validateHistoricalArchiveIndex(raw)
      if (malformed) {
        log.error('[localArchive] index.json のトップレベルが配列ではない（配信破損）')
        // 配信そのものが壊れている可能性がある異常系。「収録アーカイブが0件」という
        // 正常な空リストとは区別し、次回呼び出しで再取得を試みられるようにする
        // （一過性の配信不具合でページをリロードするまで固定されるのを避けるため）。
        indexCache = null
      } else if (skipped > 0) {
        log.warn(`[localArchive] index.json の破損エントリ ${skipped} 件をスキップ`)
      }
      return valid
    })
    .catch((e) => {
      // 履歴アーカイブは無くても既存のDMDATA/P2PQuake経路にフォールバックできるため、
      // 取得失敗時は「収録なし」として扱い、リプレイ全体は失敗させない。
      log.error('[localArchive] index.json の取得に失敗', e)
      indexCache = null
      return []
    })
  indexCache = promise
  return promise
}

function loadFile(id: string): Promise<HistoricalArchiveFile | null> {
  const cached = fileCache.get(id)
  if (cached) return cached
  const promise = fetchJsonWithTimeout<unknown>(fileUrl(id), `historical-archive ${id}`, { trackStatus: false })
    .then((raw) => {
      const result = validateHistoricalArchiveFile(raw)
      if (!result) {
        log.error(`[localArchive] ${id}.json の検証に失敗（配信破損）`)
        return null
      }
      // ここで一度だけログに出す（loadFile はキャッシュされるため、以後の
      // fetchLocalArchiveEvents/fetchLocalArchiveQuakeHistory からの呼び出しでは再実行されない）。
      // ReplayFetchResult.skipped には反映しない: このデータは手作業で書き起こしたもので
      // DMDATA/P2PQuake のような継続的な配信物ではなく、壊れたエントリがあれば発表直後の
      // 通知ではなくコンソールログで十分検出できる。1 通ごとに何回再取得されるか不定の
      // ReplayFetchResult.skipped に載せると、本編・初期状態・先読みの都度重複加算され、
      // 実際の欠落件数より大きく見える方が実害が大きい。
      if (result.skipped > 0) {
        log.warn(`[localArchive] ${id}.json の破損エントリ ${result.skipped} 件をスキップ`)
      }
      return result.file
    })
    .catch((e) => {
      log.error(`[localArchive] ${id}.json の取得に失敗`, e)
      return null
    })
  fileCache.set(id, promise)
  promise.then(
    (file) => { if (!file) fileCache.delete(id) },
    () => { fileCache.delete(id) },
  )
  return promise
}

/** 設定タブに出す、収録済みアーカイブの一覧（表示専用）。 */
export function listHistoricalArchives(): Promise<HistoricalArchiveIndex> {
  return loadIndex()
}

/**
 * 指定範囲 [fromTime, toTime) と重なるローカル履歴アーカイブを探す（同期）。無ければ null
 * （呼び出し側はDMDATA/P2PQuakeへフォールバック）。
 *
 * 「範囲に重なるか」で判定するのは、useReplayController が「本編」だけでなく「初期状態」
 * （対象時刻から遡る 24 時間）や先読みも同じ fetchEvents 経由で問い合わせるため。対象時刻
 * そのものは収録範囲内でも、その 24 時間前は収録範囲の外に出ることがほとんどで、単純に
 * 「fromTime が収録範囲内か」だけで判定すると初期状態の問い合わせだけDMDATA/P2PQuakeへ
 * 漏れてしまう（そちらにはそもそもデータが無い時代のため、取得失敗でリプレイ全体が止まる）。
 * 収録範囲に重なる問い合わせは「その期間、収録データ上は何も無かった」という空の成功として
 * 扱えばよいため、重なりがあれば常にこのアーカイブを使う。
 *
 * **この前提は、実際に電文を集めた範囲（`coveredRanges`）の中でだけ成り立つ。**
 * 2018年北海道胆振東部地震（`build-historical-archive-2018-iburi.ts`）のように、警報級の
 * 余震が数ヶ月おきに散発する地震活動では、from/toは最初と最後のイベントを広く跨ぐ一方、
 * 実際に電文一覧を取得しているのは`DATES`に列挙した数日だけで、間の期間（例えば余震と
 * 余震の間の1ヶ月）は「取得していない」だけであり「確認して何も無かった」わけではない。
 * 問い合わせが集めた範囲に 1 秒も掛からないときは、呼び出し側が `findUncollectedArchiveSync`
 * で見分けて止める（空の成功にしない）。詳細は`docs/spec/settings-pwa-spec.md`の胆振東部アーカイブの節を参照。
 *
 * index の取得自体は非同期だが、App.tsx の fetchReplayEvents はリプレイ中に何度も（本編・
 * 初期状態・先読みのたびに）呼ばれるため、都度 await すると呼び出し順序が崩れうる。設定タブ表示用の
 * useHistoricalArchiveIndex 経由で事前に読み込み済みの index を引数で受け取り、ここでは
 * 純粋な同期検索だけを行う。
 */
export function findCoveringArchiveSync(index: HistoricalArchiveIndex, fromTime: Date, toTime: Date): HistoricalArchiveMeta | null {
  const from = fromTime.getTime()
  const to = toTime.getTime()
  return index.find((m) => new Date(m.from).getTime() < to && from < new Date(m.to).getTime()) ?? null
}

/**
 * 指定範囲 [fromTime, toTime) が収録範囲（`from`〜`to`）に重なるのに、実際に電文を集めた範囲
 * （`coveredRanges`）には 1 秒も掛からないアーカイブを返す。無ければ null。
 *
 * **一部でも集めた範囲に掛かる問い合わせは通す。** 再生の窓（本編は 1 時間・初期状態は 24 時間）は
 * 日の境目をまたぐので、掛かった分の電文は本物として返せる。集めていない側だけを見る窓が来た時点で止まる。
 */
export function findUncollectedArchiveSync(index: HistoricalArchiveIndex, fromTime: Date, toTime: Date): HistoricalArchiveMeta | null {
  const covering = findCoveringArchiveSync(index, fromTime, toTime)
  if (!covering) return null
  const from = fromTime.getTime()
  const to = toTime.getTime()
  const touchesCollected = covering.coveredRanges.some(
    (r) => new Date(r.from).getTime() < to && from < new Date(r.to).getTime(),
  )
  return touchesCollected ? null : covering
}

/**
 * `fromTime` が、収録範囲の終端（`to`）を過ぎた直後（`windowMs` 以内）にあるアーカイブを探す。
 *
 * useReplayController の先読みは 1 時間（`windowMs`）ごとに次のウィンドウを取得しに行く。
 * ローカルアーカイブの収録範囲は数十分〜1時間程度と短いため、再生を続けていると必ず終端を
 * 越える瞬間が来る。`findCoveringArchiveSync` が null を返した時点で単純にDMDATA/P2PQuakeへ
 * フォールバックすると、そちらにはそもそもデータの存在しない時代のため、無警告のまま
 * 空成功または的外れなエラー（「DMDATAアーカイブが無い」等）になる。この関数で「ついさっきまで
 * ローカルアーカイブの範囲内だった」ことを検出し、呼び出し側が専用のエラーメッセージを出せる
 * ようにする。
 */
export function findArchiveJustEndedSync(index: HistoricalArchiveIndex, fromTime: Date, windowMs: number): HistoricalArchiveMeta | null {
  const from = fromTime.getTime()
  return index.find((m) => {
    const to = new Date(m.to).getTime()
    return from >= to && from < to + windowMs
  }) ?? null
}

/**
 * 再生の窓が、電文を集めていない日だけを見るときの扱い。目的（`ReplayFetchPurpose`）で分ける。
 * - 本編: 止める（`reject`）。開始時刻そのものが集めていない日
 * - 初期状態: 空で返す（`empty`）。集めた日の 0 時ちょうどから始めると、手前 24 時間が丸ごと前日になる。
 *   本編は本物の電文を返せるのに、それで再生全体を止めることになるため
 * - 先読み: 集めていない日へ入った最初の窓だけ止め（再生中の警告に出る。再生は続く）、直前の窓も
 *   集めていなかったら空で返す。毎時の失敗が積み上がって警告と取りこぼしの数が意味を失うため
 * 集めた日に掛かる窓・アーカイブの外の窓は `fetch`（従来どおり取りに行く）。
 */
export function uncollectedFetchVerdict(
  index: HistoricalArchiveIndex,
  fromTime: Date,
  toTime: Date,
  purpose: ReplayFetchPurpose,
): { kind: 'fetch' } | { kind: 'empty' } | { kind: 'reject'; archive: HistoricalArchiveMeta } {
  const archive = findUncollectedArchiveSync(index, fromTime, toTime)
  if (!archive) return { kind: 'fetch' }
  if (purpose === 'initial') return { kind: 'empty' }
  if (purpose === 'prefetch') {
    const span = toTime.getTime() - fromTime.getTime()
    const previous = findUncollectedArchiveSync(index, new Date(fromTime.getTime() - span), fromTime)
    if (previous) return { kind: 'empty' }
  }
  return { kind: 'reject', archive }
}

/** 電文が 1 通も無く、取りこぼしも無い取得結果（集めていない日を空で返すとき）。 */
export function emptyReplayFetchResult(): ReplayFetchResult {
  return { entries: [], skippedByDay: new Map(), failedArchiveUrls: [], rateLimitedSources: [], rateLimitedTelegrams: 0 }
}

export async function fetchLocalArchiveEvents(
  meta: HistoricalArchiveMeta,
  fromTime: Date,
  toTime: Date,
): Promise<ReplayFetchResult> {
  const file = await loadFile(meta.id)
  if (!file) {
    // 一覧には載っていたが本体が読めない = 全滅扱い（dmdataReplay.ts の「全アーカイブ失敗」と同じ粒度）。
    return { entries: [], skippedByDay: new Map(), failedArchiveUrls: [fileUrl(meta.id)], rateLimitedSources: [], rateLimitedTelegrams: 0 }
  }

  const entries: ReplayEntry[] = file.entries
    .filter((e) => {
      const t = new Date(e.time).getTime()
      return t >= fromTime.getTime() && t < toTime.getTime()
    })
    .map((e) => ({ payload: e.payload, replayTime: new Date(e.time), silent: e.silent }))

  entries.sort((a, b) => a.replayTime.getTime() - b.replayTime.getTime())

  return { entries, skippedByDay: new Map(), failedArchiveUrls: [], rateLimitedSources: [], rateLimitedTelegrams: 0 }
}

const DAY_MS = 24 * 60 * 60 * 1000
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/**
 * 履歴の窓の下端。**DMDSS 版の履歴と同じく JST の日で切る**（`fetchDmdataQuakeHistory` は
 * `before` の `maxDays` 日前を含む JST 日から日次アーカイブを読む）。
 */
function historyWindowStartMs(before: Date, maxDays: number): number {
  const startDay = new Date(before.getTime() - maxDays * DAY_MS + JST_OFFSET_MS).toISOString().slice(0, 10)
  return Date.parse(`${startDay}T00:00:00+09:00`)
}

/**
 * 地震カードの履歴（`fetchReplayQuakeHistory`）のローカル版。
 *
 * **どちらの版でも `maxDays` 日（`HISTORY_WINDOW_DAYS`）を全部返し、件数では切らない**
 * （2026-10-14 ユーザー選択。DMDSS 版の履歴と同じ扱い）。地震に畳んで選び、選んだ地震の電文は
 * 窓より前のものも含めて全部返す（→ `selectQuakeHistory`）。以前は地震情報の電文を新しい順に
 * 件数で切っていて、熊本の本震直前は 52 地震のうち 18 枚しか残らず、途中で切れたカードもできていた。
 *
 * **同じ窓から津波と、帯・長周期・推計震度分布図（`extras`）も返す。** 初期状態（24 時間）で
 * 足りない分を補う材料で、DMDSS 版の履歴と同じ形にする（帯は電文ごと、長周期は地震ごとに最新 1 通。
 * 鍵は `historyExtraKey`）。
 *
 * 何も無ければ空配列で成功として返す（＝「その期間、地震は無かった」という正当な結果。
 * DMDATA/P2PQuakeへフォールバックしない）。
 */
export async function fetchLocalArchiveQuakeHistory(
  meta: HistoricalArchiveMeta,
  before: Date,
  maxDays: number,
): Promise<QuakeHistoryResult> {
  const file = await loadFile(meta.id)
  if (!file) {
    return {
      quakes: [], tsunamis: [], extras: [], skippedByDay: new Map(),
      failedArchiveUrls: [fileUrl(meta.id)], rateLimitedSources: [], rateLimitedTelegrams: 0, hasMore: false,
      oldestLoadedDay: null,
    }
  }

  // 時刻は payload 内部の event.time ではなくエントリ自身の time で見る。
  // fetchLocalArchiveEvents の replayTime 扱いと揃えるためで、event.time が欠落・不整合でも
  // 収録データの実際の発表順（＝エントリの並び順の根拠）からは外れない。
  const beforeMs = before.getTime()
  const windowStartMs = historyWindowStartMs(before, maxDays)
  const parsed = file.entries.map((entry) => ({ entry, ms: new Date(entry.time).getTime() }))
  // 読み込み時の検証（`isValidIso`）を通っているので通常は 0 件。食い違いが出たときに黙って消えないよう数える
  const unreadable = parsed.filter(({ ms }) => !Number.isFinite(ms)).length
  if (unreadable > 0) {
    log.warn(`[localArchive] ${meta.id}.json の履歴で、時刻を読めない電文 ${unreadable} 件を除きました`)
  }
  // `before` ちょうどの電文は履歴に入れない（本編の再生がその時刻から流すので、そちらで届く）
  const timed = parsed
    .filter(({ ms }) => Number.isFinite(ms) && ms < beforeMs)
    .sort((a, b) => a.ms - b.ms)

  // 地震情報は新しい順に並べて返す（P2PQuake の履歴と揃える。統合は `reportOrderKey` で並べ直すが、
  // 同じ順位の報どうしは入力の並びがそのまま効く）
  const quakeEntries = timed
    .filter(({ entry }) => entry.payload.kind === 'event' && entry.payload.event.kind === 'quake')
    .reverse()
  const quakeOf = ({ entry }: { entry: HistoricalArchiveFile['entries'][number] }) =>
    (entry.payload as { kind: 'event'; event: JMAQuake }).event
  const quakes = selectQuakeHistory(
    quakeEntries, quakeOf, ({ ms }) => ms,
    { maxEvents: null, windowStartMs },
    getAreaPrefIndexCache(),
  ).map(quakeOf)

  const inWindow = timed.filter(({ ms }) => ms >= windowStartMs)
  const tsunamis: JMATsunami[] = []
  const extraLatest = new Map<string, ReplayEntry>()
  for (const { entry, ms } of inWindow) {
    if (entry.payload.kind === 'event') {
      if (entry.payload.event.kind === 'tsunami') tsunamis.push(entry.payload.event)
      continue
    }
    const key = historyExtraKey(entry.payload)
    if (key === null) continue
    // 同じ鍵なら新しいほうを残す（長周期は地震ごとに最新 1 通。帯は電文ごとに鍵が違うので全部残る）
    const prev = extraLatest.get(key)
    if (!prev || ms >= prev.replayTime.getTime()) {
      extraLatest.set(key, { payload: entry.payload, replayTime: new Date(ms), silent: entry.silent })
    }
  }
  const extras = [...extraLatest.values()].sort((a, b) => a.replayTime.getTime() - b.replayTime.getTime())

  // **カーソルは持たない**（`oldestLoadedDay`）。ローカル履歴アーカイブは 1 ファイルで完結して
  // いて、その外に遡る先が無い。
  return {
    quakes, tsunamis, extras, skippedByDay: new Map(),
    failedArchiveUrls: [], rateLimitedSources: [], rateLimitedTelegrams: 0, hasMore: false,
    oldestLoadedDay: null,
  }
}
