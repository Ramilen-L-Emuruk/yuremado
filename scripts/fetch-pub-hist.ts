// ローカル履歴アーカイブ用に、気象庁「緊急地震速報（警報）発表状況」（pub_hist）の個別ページを取って
// メインの checkout の `.cache/jma-pub-hist-cache/` に控える。生成（build-historical-archive-*.ts）は
// 控えを読むだけで、控えが無ければ止まる。取得はここに分ける。
//
//   npx tsx scripts/fetch-pub-hist.ts --dry-run   # 送る予定の URL と件数だけ出す
//   npx tsx scripts/fetch-pub-hist.ts             # 取る（控えにあるもの・fc_hist から報を作れた地震は取らない）
//
// 取るのは「警報が出た地震のうち、予報の発表状況（fc_hist）から報を作れなかったもの」だけ（`planEewSection`）。
// 取得の決まり: 名乗る・1 件ごとに 10 秒あける・1 件を 30 秒で打ち切る・取り直しは 1 件につき 1 回まで・
// 5xx が続いたら止める。**取り直しを含めた総数が `MAX_REQUESTS` を超える計画なら送らない。**
// 1 件でも取れなければ終了コード 1。取れなかったページは `failed-pub-hist.json` に残す。
// 地震の一覧・取得日・収録範囲は historicalArchiveTargets.ts（生成と同じ値）。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eventIdOfPubHistDir, looksLikeEewPage, planEewSection, pubHistUrl, savePubHistCache } from './localEarthquakeArchiveBuilder'
import { ARCHIVE_IDS, ARCHIVE_TARGETS } from './historicalArchiveTargets'
import { PoliteFetcher, WaybackUnavailableError, mainCheckoutCacheDir, pageMatchesEventId } from './waybackFcHist'

/** 1 件につき何回まで取り直すか */
export const PUB_HIST_MAX_RETRIES = 1
/** 1 回の実行で送ってよいリクエストの上限（取り直しも含む） */
export const MAX_REQUESTS = 16

const FAILED_PATH = () => join(mainCheckoutCacheDir('jma-pub-hist-cache'), 'failed-pub-hist.json')

interface FailedPubHist {
  dir: string
  url: string
  message: string
  at: string
}

async function readFailed(): Promise<Map<string, FailedPubHist>> {
  try {
    const list = JSON.parse(await readFile(FAILED_PATH(), 'utf-8')) as FailedPubHist[]
    if (!Array.isArray(list)) throw new Error('failed-pub-hist.json が配列ではありません')
    return new Map(list.map((f) => [f.dir, f]))
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return new Map()
    throw err
  }
}

async function writeFailed(failed: Map<string, FailedPubHist>): Promise<void> {
  const dest = FAILED_PATH()
  await mkdir(resolve(dest, '..'), { recursive: true })
  const tmp = `${dest}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify([...failed.values()].sort((a, b) => a.dir.localeCompare(b.dir)), null, 2) + '\n', 'utf-8')
  await rename(tmp, dest)
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run')
  const plan: { dir: string; url: string }[] = []
  for (const id of ARCHIVE_IDS) {
    const t = ARCHIVE_TARGETS[id]
    const p = await planEewSection({
      idBase: t.idBase,
      pubHistBase: t.pubHistBase,
      pubHistEvents: t.pubHistEvents,
      dates: t.dates,
      windowStart: t.windowStart,
      windowEnd: t.windowEnd,
      repoRoot: resolve(fileURLToPath(import.meta.url), '..', '..'),
    })
    const pending = new Set(p.pubHistToFetch)
    for (const e of p.pubHistEvents) {
      const url = pubHistUrl(t.pubHistBase, e.dir)
      if (pending.has(url)) plan.push({ dir: e.dir, url })
    }
  }
  for (const { url } of plan) console.log(`  ${url}`)
  const worst = plan.length * (1 + PUB_HIST_MAX_RETRIES)
  console.log(`送る予定: ${plan.length} 件（取り直しを含めた最大 ${worst} 件。上限 ${MAX_REQUESTS}）`)
  if (dryRun) return 0
  if (worst > MAX_REQUESTS) throw new Error(`取り直しを含めた最大件数が上限（${MAX_REQUESTS}）を超えるので取りません`)

  const fetcher = new PoliteFetcher({ maxRetries: PUB_HIST_MAX_RETRIES, maxRequests: MAX_REQUESTS })
  const failed = await readFailed()
  let failures = 0
  try {
    for (const [i, { dir, url }] of plan.entries()) {
      try {
        const html = await fetcher.get(url, looksLikeEewPage)
        if (!pageMatchesEventId(html, eventIdOfPubHistDir(dir))) {
          throw new Error(`取ったページの地震発生時刻が EventID と合わないので控えません`)
        }
        await savePubHistCache(dir, html)
        failed.delete(dir)
        console.log(`  ${i + 1}/${plan.length}: ${dir}`)
      } catch (err) {
        if (err instanceof WaybackUnavailableError) throw err
        failures++
        failed.set(dir, { dir, url, message: (err as Error).message, at: new Date().toISOString() })
        console.warn(`  ${i + 1}/${plan.length}: ${dir} は取れませんでした: ${(err as Error).message}`)
      }
    }
  } finally {
    await writeFailed(failed)
    console.log(`送ったリクエスト ${fetcher.requestCount} 件（取れなかったページ: この実行で ${failures} 件・記録の合計 ${failed.size} 件）`)
  }
  return failures > 0 ? 1 : 0
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
