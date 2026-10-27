// 気象庁「緊急地震速報（予報）発表状況」（fc_hist）の個別ページを、Wayback Machine の控えから取る。
//
// 気象庁のサイトから fc_hist は消えているが、2016 年の一部の日は Wayback Machine に控えが残っている。
// 警報の発表状況（pub_hist）と違い、予報だけで終わった地震も、予報の報も載っている。
//
// 取得の流れは 2 段に分ける。
//
// 1. **目録（CDX）**: 日ごとに「控えのある EventID と、その控えの時刻」を引く。
//    `cdx-fc_hist-YYYYMMDD.json` として残す。**空の応答は残さない** —— 同じ問い合わせが一度は空、
//    次は 11 件を返した例がある（2016-04-18）。空を残すと「控えが無い日」と決めつけてしまう
// 2. **本体**: 目録に載ったページを 1 件ずつ取り、`fc_hist-<EventID>.html` として残す
//
// 控えはメインの checkout の `.cache/wayback-cache/` に置く（ワークツリーごとに取り直さないため）。
// 過去の控えは書き換わらないので、期限は持たない。2 回目以降は読むだけ。
//
// 取得の決まり（配信元への配慮。→ CLAUDE.md「調査で外部 API を叩くとき」）:
// - 名乗る（`USER_AGENT`）
// - 1 件ごとに 10 秒あける（`REQUEST_INTERVAL_MS`）
// - 失敗したら 30 秒あけて、最大 2 回まで取り直す
// - 5xx（HTTP 500 を含む）が**異なる URL で** 5 回続いたら止める（1 ページの取り直しで続いた 5xx は数えない）
// - 本体の取得は 30 秒、目録（CDX）の問い合わせは 120 秒で打ち切る（時間切れは失敗として数える）
// - 取り直しを含む総リクエスト数に上限を持たせ、超えそうになったら送らずに止める
// - 本体は、ページの地震発生時刻が EventID と合うときだけ控える
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseEewContentHtml } from './historicalEewParser'
import { cacheDir } from './lib/cacheDir.mjs'

export const USER_AGENT = 'yuremado-archive-build (personal research)'
export const REQUEST_INTERVAL_MS = 10_000
export const RETRY_WAIT_MS = 30_000
export const MAX_RETRIES = 2
/** 5xx が異なる URL で何回続いたら止めるか */
export const MAX_CONSECUTIVE_UNAVAILABLE = 5
/** 本体（個別ページ）の 1 件の取得を打ち切るまでの時間 */
export const REQUEST_TIMEOUT_MS = 30_000
/**
 * 目録（CDX）の問い合わせを打ち切るまでの時間。**本体より長くする。** 目録は日ごとの前方一致の検索で、
 * 応答を組み立てる側の仕事が本体の 1 ページより重い（2026-10-23 の調べでは 504 を返す日もあった）。
 * 何秒かかるかは測っていない。本体の 30 秒では、時間をかければ返る目録まで落とす恐れがあるので 4 倍にした
 */
export const CDX_TIMEOUT_MS = 120_000
/** 目録（CDX）の 1 回の問い合わせで返してもらう行数の上限。**これに達したら取りこぼしを疑って止める** */
export const CDX_LIMIT = 500

const FC_HIST_PATH = 'www.data.jma.go.jp/svd/eew/data/nc/fc_hist'

/**
 * 控えの置き場所（メインの checkout の `.cache/<name>`）。決め方は `lib/cacheDir.mjs` が持つ。
 * 名前を残してあるのは、テストがこの関数を差し替えて一時ディレクトリへ向けるため。
 */
export function mainCheckoutCacheDir(name: string): string {
  return cacheDir(name)
}

export function waybackCacheDir(): string {
  return mainCheckoutCacheDir('wayback-cache')
}

/** 目録の 1 件。 */
export interface FcHistCapture {
  /** 気象庁の EventID（ページのディレクトリ名） */
  eventId: string
  /** Wayback Machine の控えの時刻（`YYYYMMDDhhmmss`） */
  timestamp: string
  /** 控えられた元の URL（`:80` 付きのこともある。Wayback へはこの形のまま渡す） */
  original: string
}

const DATE_RE = /^\d{8}$/

export function cdxCacheName(date: string): string {
  if (!DATE_RE.test(date)) throw new Error(`日付の書式が YYYYMMDD ではありません: ${date}`)
  return `cdx-fc_hist-${date}.json`
}

export function pageCacheName(eventId: string): string {
  if (!/^\d{14}$/.test(eventId)) throw new Error(`EventID が 14 桁の数字ではありません: ${eventId}`)
  return `fc_hist-${eventId}.html`
}

/** 目録を問い合わせる URL（その日の EventID で始まるページをまとめて引く）。 */
export function cdxUrl(date: string): string {
  if (!DATE_RE.test(date)) throw new Error(`日付の書式が YYYYMMDD ではありません: ${date}`)
  const prefix = `${FC_HIST_PATH}/${date.slice(0, 4)}/${date.slice(4, 6)}/${date}`
  return `https://web.archive.org/cdx/search/cdx?url=${prefix}&matchType=prefix&output=json&fl=original,timestamp,statuscode&filter=statuscode:200&collapse=urlkey&limit=${CDX_LIMIT}`
}

/** 控えの本体を取る URL（`id_` で Wayback の書き換えを外した原本を取る）。 */
export function pageUrl(capture: FcHistCapture): string {
  return `https://web.archive.org/web/${capture.timestamp}id_/${capture.original}`
}

/**
 * CDX の応答（JSON 配列。1 行目が見出し `[original, timestamp, statuscode]`）から、その日の
 * 個別ページ（`index.html`）の控えを EventID ごとに 1 件ずつ取り出す。
 *
 * **画像（`img/reachtime.png`）など index.html 以外は捨てる。** 同じ EventID が `:80` 付きと
 * 無しで 2 回載ることがあるので、先に出たほうを採る。
 */
export function parseCdxListing(date: string, json: unknown): FcHistCapture[] {
  if (!Array.isArray(json)) throw new Error(`${date}: 目録が配列ではありません`)
  if (json.length === 0) return []
  const [header, ...rows] = json as unknown[][]
  if (!Array.isArray(header) || header[0] !== 'original' || header[1] !== 'timestamp' || header[2] !== 'statuscode') {
    throw new Error(`${date}: 目録の見出しが想定と違います: ${JSON.stringify(header)}`)
  }
  // 上限ちょうどまで返ってきたら、その先が切り捨てられている（Wayback は黙って打ち切る）
  if (rows.length >= CDX_LIMIT) throw new Error(`${date}: 目録が上限（${CDX_LIMIT} 行）まで返ってきました。取りこぼしを疑って止めます`)
  const byEventId = new Map<string, FcHistCapture>()
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 3 || row.some((c) => typeof c !== 'string')) {
      throw new Error(`${date}: 目録の行の形が想定と違います: ${JSON.stringify(row)}`)
    }
    const [original, timestamp, status] = row as string[]
    if (status !== '200') continue
    const m = original.match(/\/fc_hist\/(\d{4})\/(\d{2})\/(\d{14})\/index\.html$/)
    if (!m) continue
    const eventId = m[3]
    if (!eventId.startsWith(date)) throw new Error(`${date}: 目録に別の日の EventID が混ざっています: ${original}`)
    if (!/^\d{14}$/.test(timestamp)) throw new Error(`${date}: 控えの時刻の書式が想定と違います: ${timestamp}`)
    if (!byEventId.has(eventId)) byEventId.set(eventId, { eventId, timestamp, original })
  }
  // 行はあるのに個別ページを 1 件も拾えないのは、URL の形が変わったか、別のものを引いている
  if (rows.length > 0 && byEventId.size === 0) {
    throw new Error(`${date}: 目録に ${rows.length} 行あるのに、個別ページ（index.html）を 1 件も拾えませんでした`)
  }
  return [...byEventId.values()].sort((a, b) => a.eventId.localeCompare(b.eventId))
}

/** 控えた目録を読む。**控えが無ければ null**（「控えのある地震が 0 件」と区別する）。 */
export async function readCachedCdx(date: string): Promise<FcHistCapture[] | null> {
  let text: string
  try {
    text = await readFile(join(waybackCacheDir(), cdxCacheName(date)), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw new Error(`目録の控えを読めませんでした（${date}）: ${(err as Error).message}`, { cause: err })
  }
  return parseCdxListing(date, JSON.parse(text))
}

/** 控えた本体が「個別ページの形」をしているか。エラーページを本体として残さないために見る。 */
export function looksLikeFcHistPage(html: string): boolean {
  return html.includes('id="hypocentral_element_list"') && html.includes('id="information_list"')
}

/** 控えた本体を読む。**控えが無ければ null**。形が崩れていれば例外（黙って取り直さない）。 */
export async function readCachedPage(eventId: string): Promise<string | null> {
  let text: string
  try {
    text = await readFile(join(waybackCacheDir(), pageCacheName(eventId)), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw new Error(`本体の控えを読めませんでした（${eventId}）: ${(err as Error).message}`, { cause: err })
  }
  if (!looksLikeFcHistPage(text)) throw new Error(`本体の控えが個別ページの形をしていません（${pageCacheName(eventId)}）`)
  // 控える前と同じ検査を、読むときにも通す（手で置いた・古い仕組みで控えたページを見逃さない）
  if (!pageMatchesEventId(text, eventId)) {
    throw new Error(`本体の控えの地震発生時刻が EventID と合いません（${pageCacheName(eventId)}）`)
  }
  return text
}

/** ページの地震発生時刻と EventID の差として許す幅（前後とも） */
export const PAGE_EVENT_ID_TOLERANCE_MS = 180_000

/**
 * 取ったページが EventID の地震のものか。**震源要素の表の発生時刻が EventID と合わなければ false。**
 * 形（表の id）だけを見ると、別の地震のページを控えてしまう。
 *
 * 幅は前後 3 分。実測では EventID − 発生時刻は −25 秒〜+7.5 秒（pub_hist が秒まで書く 18 地震）、
 * fc_hist の分で切り捨てた時刻との差は最大 101 秒（2026-10-25 に控えた 161 ページ）。
 */
export function pageMatchesEventId(html: string, eventId: string): boolean {
  const origin = new Date(parseEewContentHtml(html).hypocenter.originTimeIso).getTime()
  return Math.abs(eventIdTime(eventId).getTime() - origin) <= PAGE_EVENT_ID_TOLERANCE_MS
}

/** 一時ファイルへ書いてから置き換える（書きかけを残さない）。 */
async function saveCache(name: string, text: string): Promise<void> {
  const dir = waybackCacheDir()
  const dest = join(dir, name)
  const tmp = `${dest}.${process.pid}.tmp`
  await mkdir(dir, { recursive: true })
  try {
    await writeFile(tmp, text, 'utf-8')
    await rename(tmp, dest)
  } catch (err) {
    await unlink(tmp).catch(() => undefined)
    throw err
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 取得全体を止める理由（5xx が続いた・総リクエスト数の上限に達する）。**これだけは 1 件の失敗として
 * 飛ばさず、取得全体を止める** —— 飛ばして次へ進むと、応じられない相手へ投げ続けることになる。
 */
export class WaybackUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WaybackUnavailableError'
  }
}

/** 1 回の取得の結果。 */
type FetchOutcome = { ok: true; text: string } | { ok: false; status: number | null; message: string }

export interface PoliteFetcherOptions {
  /** 1 件につき何回まで取り直すか */
  maxRetries: number
  /** 取り直しも含めて、送ってよいリクエストの総数。これを超える 1 件は送らずに止める */
  maxRequests: number
}

/**
 * 間隔・取り直し・停止の決まりを持つ取得係（`PoliteFetcher`）。**1 本の取得の流れで 1 つだけ作る**
 * （間隔・「続いた 5xx」の数・総リクエスト数は、取得の種類をまたいで数える）。
 *
 * **5xx は URL ごとに数える。** 1 ページが取り直しのたびに 500 を返すのは、その控えが壊れているだけで
 * 配信元が止まっているのではない（2026-10-25 に 5 ページで実際にあった）。それで全体を止めると、残りの
 * ページを取れない。止めるのは、**異なる URL が続けて 5xx を返した**とき —— 配信元そのものが応じていない。
 * 1 回でも 5xx 以外が返れば数え直す。
 */
export class PoliteFetcher {
  private lastRequestAt = 0
  /** 5xx を返した URL が、間に 5xx 以外を挟まずに何種類続いたか */
  private consecutiveUnavailable = 0
  /** 直前に 5xx を返した URL（同じ URL の取り直しで数を増やさないため） */
  private lastUnavailableUrl: string | null = null
  /** 実際に送ったリクエストの数（取り直しも 1 件と数える） */
  requestCount = 0

  constructor(
    private readonly options: PoliteFetcherOptions,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  private async once(url: string, timeoutMs: number): Promise<FetchOutcome> {
    if (this.requestCount >= this.options.maxRequests) {
      throw new WaybackUnavailableError(`送ったリクエストが上限（${this.options.maxRequests} 件）に達したので止めます（次: ${url}）`)
    }
    const elapsed = Date.now() - this.lastRequestAt
    if (this.requestCount > 0 && elapsed < REQUEST_INTERVAL_MS) await this.wait(REQUEST_INTERVAL_MS - elapsed)
    this.lastRequestAt = Date.now()
    this.requestCount++
    try {
      const res = await this.fetchImpl(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) })
      if (res.status >= 500) {
        if (this.lastUnavailableUrl !== url) this.consecutiveUnavailable++
        this.lastUnavailableUrl = url
      } else {
        this.consecutiveUnavailable = 0
        this.lastUnavailableUrl = null
      }
      if (!res.ok) return { ok: false, status: res.status, message: `HTTP ${res.status}` }
      return { ok: true, text: await res.text() }
    } catch (err) {
      // 時間切れ（`AbortSignal.timeout`）もここへ来る。失敗として数え、取り直しへ回す
      const timedOut = (err as Error)?.name === 'TimeoutError'
      return { ok: false, status: null, message: timedOut ? `${timeoutMs / 1000} 秒で応答が無く打ち切りました` : (err as Error).message }
    } finally {
      this.lastRequestAt = Date.now()
    }
  }

  /**
   * 取る。`accept` が false を返した応答（200 で返ったエラーページなど）も失敗として取り直す。
   * 取り直しても取れなければ例外。異なる URL で 5xx が続いた数・総リクエスト数が上限に達したら、その場で
   * `WaybackUnavailableError`。
   */
  async get(url: string, accept: (text: string) => boolean, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<string> {
    let last = ''
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      if (attempt > 0) await this.wait(RETRY_WAIT_MS)
      const outcome = await this.once(url, timeoutMs)
      if (outcome.ok && accept(outcome.text)) return outcome.text
      last = outcome.ok ? '応答の形が想定と違います' : outcome.message
      if (this.consecutiveUnavailable >= MAX_CONSECUTIVE_UNAVAILABLE) {
        throw new WaybackUnavailableError(`異なる URL で 5xx が ${MAX_CONSECUTIVE_UNAVAILABLE} 回続いたので止めます（最後: ${url}）`)
      }
    }
    throw new Error(`取得できませんでした（${url}）: ${last}`)
  }
}

/** 目録を取って控える。**空の応答は控えない**（冒頭の理由）。返すのは取り出した控えの一覧。 */
export async function fetchAndCacheCdx(date: string, fetcher: PoliteFetcher): Promise<FcHistCapture[]> {
  const text = await fetcher.get(
    cdxUrl(date),
    (t) => {
      try {
        return Array.isArray(JSON.parse(t))
      } catch {
        return false
      }
    },
    CDX_TIMEOUT_MS,
  )
  const captures = parseCdxListing(date, JSON.parse(text))
  if (captures.length > 0) await saveCache(cdxCacheName(date), text)
  return captures
}

/** 本体を取って控える。**EventID と発生時刻が合わないページは控えない**（`pageMatchesEventId`）。 */
export async function fetchAndCachePage(capture: FcHistCapture, fetcher: PoliteFetcher): Promise<string> {
  const text = await fetcher.get(pageUrl(capture), looksLikeFcHistPage)
  if (!pageMatchesEventId(text, capture.eventId)) {
    throw new Error(`取ったページの地震発生時刻が EventID（${capture.eventId}）と合わないので控えません`)
  }
  await saveCache(pageCacheName(capture.eventId), text)
  return text
}

/** 取り直しても取れなかった本体の記録（`failed-fc_hist.json`）。 */
export interface FailedPage {
  eventId: string
  url: string
  message: string
  /** 最後に試した時刻（ISO） */
  at: string
}

const FAILED_NAME = 'failed-fc_hist.json'

/**
 * 取れなかった本体の記録を読む。**記録の無い本体は「まだ取っていない」**で、記録のある本体は
 * 「取りに行って取れなかった」—— 生成はこの 2 つを分けて扱う（前者は止まる・後者は欠けとして残す）。
 */
export async function readFailedPages(): Promise<Map<string, FailedPage>> {
  let text: string
  try {
    text = await readFile(join(waybackCacheDir(), FAILED_NAME), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return new Map()
    throw new Error(`取れなかった本体の記録を読めませんでした: ${(err as Error).message}`, { cause: err })
  }
  const list = JSON.parse(text) as FailedPage[]
  if (!Array.isArray(list)) throw new Error(`取れなかった本体の記録が配列ではありません（${FAILED_NAME}）`)
  return new Map(list.map((f) => [f.eventId, f]))
}

export async function writeFailedPages(failed: Map<string, FailedPage>): Promise<void> {
  const list = [...failed.values()].sort((a, b) => a.eventId.localeCompare(b.eventId))
  await saveCache(FAILED_NAME, JSON.stringify(list, null, 2) + '\n')
}

/** EventID の日時（日本時間）。収録範囲に入るかの判定に使う。 */
export function eventIdTime(eventId: string): Date {
  const m = eventId.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/)
  if (!m) throw new Error(`EventID が 14 桁の数字ではありません: ${eventId}`)
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00`)
  if (Number.isNaN(d.getTime())) throw new Error(`EventID を日時として読めません: ${eventId}`)
  return d
}

/** 収録範囲の判定。`windowEnd` は含まない（`coveredRangesFromDates` の半開区間と揃える）。 */
export function isInWindow(eventId: string, windowStart: Date, windowEnd: Date): boolean {
  const t = eventIdTime(eventId).getTime()
  return t >= windowStart.getTime() && t < windowEnd.getTime()
}

export interface FcHistPage {
  capture: FcHistCapture
  html: string
}

export interface FcHistLoadResult {
  pages: FcHistPage[]
  /** 目録の控えが無い日（その日の地震は fc_hist から作れない） */
  datesWithoutCdx: string[]
  /** 目録には載っているが、取りに行って取れなかった本体（→ {@link readFailedPages}） */
  unavailable: FailedPage[]
}

/**
 * 生成で使う fc_hist のページを**控えだけから**読む。通信はしない。
 *
 * 目録に載っているのに本体の控えが無く、取れなかった記録も無ければ例外 —— 黙って飛ばすと、その
 * 地震だけ予報の報が欠けたアーカイブができる。先に `npx tsx scripts/fetch-wayback-fc-hist.ts` で取っておく。
 */
export async function loadFcHistPages(dates: string[], windowStart: Date, windowEnd: Date): Promise<FcHistLoadResult> {
  const pages: FcHistPage[] = []
  const datesWithoutCdx: string[] = []
  const unavailable: FailedPage[] = []
  const missing: string[] = []
  const failed = await readFailedPages()
  for (const date of [...new Set(dates)].sort()) {
    const captures = await readCachedCdx(date)
    if (captures === null) {
      datesWithoutCdx.push(date)
      continue
    }
    for (const capture of captures) {
      if (!isInWindow(capture.eventId, windowStart, windowEnd)) continue
      const html = await readCachedPage(capture.eventId)
      if (html !== null) {
        pages.push({ capture, html })
        continue
      }
      const f = failed.get(capture.eventId)
      if (f) unavailable.push(f)
      else missing.push(capture.eventId)
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `fc_hist の本体の控えが ${missing.length} 件ありません（先に scripts/fetch-wayback-fc-hist.ts で取る）: ${missing.join(', ')}`,
    )
  }
  return { pages, datesWithoutCdx, unavailable }
}
