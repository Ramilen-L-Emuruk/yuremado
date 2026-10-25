// ローカル履歴アーカイブ用に、気象庁「緊急地震速報（予報）発表状況」（fc_hist）の控えを
// Wayback Machine から取る。取得の決まりと控えの置き場所は waybackFcHist.ts の冒頭。
//
//   npx tsx scripts/fetch-wayback-fc-hist.ts --dry-run          # 送る予定の URL と件数だけ出す
//   npx tsx scripts/fetch-wayback-fc-hist.ts                    # 取る（控えにあるもの・前に取れなかったものは取らない）
//   npx tsx scripts/fetch-wayback-fc-hist.ts --retry-failed     # 前に取れなかった本体も取り直す
//   npx tsx scripts/fetch-wayback-fc-hist.ts --max-retries=0    # 1 件につき取り直さない（既定は 2 回）
//   npx tsx scripts/fetch-wayback-fc-hist.ts --cdx              # 目録の控えが無い日の目録も引く
//
// **必ず先に `--dry-run` で件数を見る。** 送る予定を取り直しまで含めて数え、`MAX_REQUESTS` を超える計画なら
// 取らない。取得係にも同じ上限を渡すので、取り直しが重なっても上限を超えて送ることはない。
//
// 取り直しても取れなかった本体は `failed-fc_hist.json` に記録して先へ進む（1 件の壊れた控えで全体を
// 止めない）。**ただし 1 件でも取れなければ終了コード 1。** 5xx が続いたとき・上限に達したときは全体を
// 止める（`WaybackUnavailableError`）。取得日と収録範囲は historicalArchiveTargets.ts（生成と同じ値）。
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARCHIVE_IDS, ARCHIVE_TARGETS } from './historicalArchiveTargets'
import {
  MAX_RETRIES,
  PoliteFetcher,
  cdxUrl,
  fetchAndCacheCdx,
  fetchAndCachePage,
  isInWindow,
  pageUrl,
  readCachedCdx,
  readCachedPage,
  readFailedPages,
  waybackCacheDir,
  writeFailedPages,
  WaybackUnavailableError,
  type FcHistCapture,
} from './waybackFcHist'

/** 1 回の実行で送ってよいリクエストの上限（取り直しも含む）。 */
export const MAX_REQUESTS = 200

function parseMaxRetries(args: string[]): number {
  const arg = args.find((a) => a.startsWith('--max-retries='))
  if (!arg) return MAX_RETRIES
  const n = Number(arg.slice('--max-retries='.length))
  if (!Number.isInteger(n) || n < 0 || n > MAX_RETRIES) throw new Error(`--max-retries は 0〜${MAX_RETRIES} の整数: ${arg}`)
  return n
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const withCdx = args.includes('--cdx')
  const retryFailed = args.includes('--retry-failed')
  const maxRetries = parseMaxRetries(args)
  const failed = await readFailedPages()
  console.log(`控えの置き場所: ${waybackCacheDir()}`)

  // 1. 目録
  const cdxToFetch: string[] = []
  const capturesByDate = new Map<string, FcHistCapture[]>()
  for (const id of ARCHIVE_IDS) {
    for (const date of ARCHIVE_TARGETS[id].dates) {
      const cached = await readCachedCdx(date)
      if (cached === null) cdxToFetch.push(date)
      else capturesByDate.set(date, cached)
    }
  }
  if (cdxToFetch.length > 0) {
    console.log(`目録の控えが無い日: ${cdxToFetch.join(', ')}${withCdx ? '（引く）' : '（--cdx を付けない限り引かない）'}`)
  }

  // 2. 本体（いま分かっている目録の範囲で）
  const inWindow = (): FcHistCapture[] => {
    const out: FcHistCapture[] = []
    for (const id of ARCHIVE_IDS) {
      const t = ARCHIVE_TARGETS[id]
      for (const date of t.dates) {
        for (const c of capturesByDate.get(date) ?? []) if (isInWindow(c.eventId, t.windowStart, t.windowEnd)) out.push(c)
      }
    }
    return out
  }
  const pending = async (): Promise<FcHistCapture[]> => {
    const out: FcHistCapture[] = []
    for (const c of inWindow()) {
      if ((await readCachedPage(c.eventId)) !== null) continue
      if (failed.has(c.eventId) && !retryFailed) continue
      out.push(c)
    }
    return out
  }

  const plannedCdx = withCdx ? cdxToFetch : []
  let plannedPages = await pending()
  console.log(
    `収録範囲に入る控え: ${inWindow().length} 件（うち取りに行くもの ${plannedPages.length} 件・前に取れなかったもの ${failed.size} 件` +
      `${retryFailed ? '（取り直す）' : '（取り直さない）'}）`,
  )
  for (const d of plannedCdx) console.log(`  目録\t${cdxUrl(d)}`)
  for (const c of plannedPages) console.log(`  本体\t${pageUrl(c)}`)
  const worst = (plannedCdx.length + plannedPages.length) * (1 + maxRetries)
  console.log(
    `送る予定: ${plannedCdx.length + plannedPages.length} 件（目録 ${plannedCdx.length}・本体 ${plannedPages.length}。` +
      `1 件につき取り直し ${maxRetries} 回まで、最大 ${worst} 件。上限 ${MAX_REQUESTS}）`,
  )
  if (dryRun) return 0
  if (worst > MAX_REQUESTS) throw new Error(`取り直しを含めた最大件数が上限（${MAX_REQUESTS}）を超えるので取りません`)

  // 目録を引かないときは、計画した最大件数そのものを取得係の上限にする（計画より 1 件も多く送らない）
  const fetcher = new PoliteFetcher({ maxRetries, maxRequests: withCdx ? MAX_REQUESTS : worst })
  // 目録が取れなかった日は、例外で落とさず記録して続ける。控えが無いままなので、生成ではその日が
  // 「目録の取れなかった日」（`no-cdx-date`）になり、既知の欠けの一覧（knownGaps）との突き合わせで扱われる
  const cdxFailed: string[] = []
  for (const date of plannedCdx) {
    try {
      const captures = await fetchAndCacheCdx(date, fetcher)
      console.log(`  目録 ${date}: ${captures.length} 件${captures.length === 0 ? '（空なので控えない）' : ''}`)
      if (captures.length > 0) capturesByDate.set(date, captures)
    } catch (err) {
      if (err instanceof WaybackUnavailableError) throw err
      cdxFailed.push(date)
      console.warn(`  目録 ${date} は取れませんでした（その日は目録の取れなかった日のまま）: ${(err as Error).message}`)
    }
  }
  if (plannedCdx.length > 0) {
    // 目録が増えたぶん本体も増える。上限は送った目録の数も含めて見直す
    plannedPages = await pending()
    if (fetcher.requestCount + plannedPages.length * (1 + maxRetries) > MAX_REQUESTS) {
      throw new Error(`目録を引いた結果、本体が ${plannedPages.length} 件になり上限（${MAX_REQUESTS}）を超えるので取りません`)
    }
  }
  let done = 0
  let newlyFailed = 0
  try {
    for (const c of plannedPages) {
      done++
      try {
        await fetchAndCachePage(c, fetcher)
        failed.delete(c.eventId)
        console.log(`  本体 ${done}/${plannedPages.length}: ${c.eventId}`)
      } catch (err) {
        if (err instanceof WaybackUnavailableError) throw err
        newlyFailed++
        failed.set(c.eventId, { eventId: c.eventId, url: pageUrl(c), message: (err as Error).message, at: new Date().toISOString() })
        console.warn(`  本体 ${done}/${plannedPages.length}: ${c.eventId} は取れませんでした（記録して先へ進む）: ${(err as Error).message}`)
      }
    }
  } finally {
    // 止まった実行でも、それまでに取れなかったものは残す
    await writeFailedPages(failed)
    console.log(`送ったリクエスト ${fetcher.requestCount} 件（取れなかった本体: この実行で ${newlyFailed} 件・記録の合計 ${failed.size} 件）`)
  }
  if (cdxFailed.length > 0) console.warn(`目録の取れなかった日: ${cdxFailed.join(', ')}`)
  return newlyFailed > 0 || cdxFailed.length > 0 ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err)
      process.exit(1)
    },
  )
}
