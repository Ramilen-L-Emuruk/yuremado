// NIIアーカイブ（気象庁防災情報XMLデータベース）+ 気象庁の緊急地震速報の発表状況ページから
// 特定の地震活動のローカル履歴アーカイブを組み立てる共通処理。
// 2016年熊本地震向けに書いた build-historical-archive-2016-kumamoto.ts のロジックのうち、
// 地震活動ごとに変わらない部分（NII時刻のパース・種別ラベルの解釈・EEW の出どころの選び方・
// 集計の整合性チェック）を切り出したもの。地震活動ごとに変わる部分（EEW一覧・収録期間）は
// historicalArchiveTargets.ts が持つ。
//
// EEW の出どころは 2 つある（優先順）。
//
// 1. 予報の発表状況（fc_hist）の Wayback Machine の控え。予報・警報とも全報が載り、予報だけで
//    終わった地震も載る（2026-10-23 ユーザー承認。選んだ選択肢は「Wayback から作り直す (Recommended)」）。
//    控えが残っているのは 2016 年の一部の日だけ（waybackFcHist.ts）
// 2. 警報の発表状況（pub_hist）。警報が出た地震の全報だけ。fc_hist から報を作れなかった地震に使う
//
// **生成は控えだけを読み、配信元へは取りに行かない。** 控えは取得スクリプト（fetch-wayback-fc-hist.ts・
// fetch-pub-hist.ts）が作る。
//
// dmdataParser.ts の parseEarthquakeFromXml/parseTsunamiFromXml はこのモジュールでは
// importしない。呼び出し側で jsdom の DOMParser ポリフィルを入れてから動的importした
// 関数を引数で渡すこと（このモジュールを静的importする時点でdmdataParser.tsが先に
// 読み込まれてしまうと、ポリフィル未設定のまま失敗する）。
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fetchDayListing, fetchRawXml, flushSuppressedCacheWarnings } from './niiJmaXmlArchive'
import { buildEewEntries } from './historicalEewArchiveBuilder'
import { parseEewContentHtml } from './historicalEewParser'
import { eventIdTime, loadFcHistPages, mainCheckoutCacheDir, pageMatchesEventId } from './waybackFcHist'
import { loadCatalogYear, matchCatalogOrigin, type CatalogYear } from './catalogOriginTime'
import type { EewGapKind, KnownGap } from './historicalArchiveTargets'
import type { HistoricalArchiveEntry, HistoricalArchiveFile } from '../src/types/historicalArchive'
import type { AppEvent, EEWAlert, JMAQuake, JMATsunami } from '../src/types/earthquake'

export interface EewEventSpec {
  /** entry.id の元になる接頭辞（例: "2018osaka-mainshock"） */
  idPrefix: string
  /**
   * pub_hist の発表状況ディレクトリ名（例: "20180618075838"・"2018/09/20180906030805"）。
   * 末尾の 14 桁が気象庁の EventID。
   */
  dir: string
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

/** pub_hist のディレクトリ名から EventID（末尾の 14 桁）を取り出す。 */
export function eventIdOfPubHistDir(dir: string): string {
  const m = dir.match(/(?:^|\/)(\d{14})$/)
  if (!m) throw new Error(`pub_hist のディレクトリ名から EventID を取り出せません: "${dir}"`)
  return m[1]
}

/** pub_hist の個別ページの URL。 */
export function pubHistUrl(base: string, dir: string): string {
  return `${base}/${dir}/content/content_out.html`
}

/**
 * pub_hist のページの控え。**一度取ったページは二度取らない**（過去の発表状況は書き換わらない）。
 * 置き場所はメインの checkout の `.cache/jma-pub-hist-cache/`（ワークツリーごとに取り直さない）。
 */
export function pubHistCachePath(dir: string): string {
  return join(mainCheckoutCacheDir('jma-pub-hist-cache'), `${dir.replace(/[^0-9A-Za-z]/g, '_')}.html`)
}

export function looksLikeEewPage(html: string): boolean {
  return html.includes('id="hypocentral_element_list"') && html.includes('id="information_list"')
}

export async function readPubHistCache(dir: string): Promise<string | null> {
  let text: string
  try {
    text = await readFile(pubHistCachePath(dir), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw err
  }
  if (!looksLikeEewPage(text)) throw new Error(`pub_hist の控えが個別ページの形をしていません（${pubHistCachePath(dir)}）`)
  // 控える前と同じ検査を、読むときにも通す
  if (!pageMatchesEventId(text, eventIdOfPubHistDir(dir))) {
    throw new Error(`pub_hist の控えの地震発生時刻が EventID と合いません（${pubHistCachePath(dir)}）`)
  }
  return text
}

/**
 * pub_hist のページを控える。**失敗したら投げる** —— 控えを残せないと、生成が控えを見つけられずに止まる。
 * 取得スクリプトがそれを「取れた」と数えると、取り直しが要ることに気づけない。
 */
export async function savePubHistCache(dir: string, html: string): Promise<void> {
  const dest = pubHistCachePath(dir)
  const tmp = `${dest}.${process.pid}.tmp`
  try {
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(tmp, html, 'utf-8')
    await rename(tmp, dest)
  } catch (err) {
    await unlink(tmp).catch(() => undefined)
    throw new Error(`pub_hist の控えを残せませんでした（${dir}）: ${(err as Error).message}`, { cause: err })
  }
}

export interface EewSectionOptions {
  /** fc_hist だけにある地震の entry.id の接頭辞（例: "2016kumamoto"）。後ろに EventID が付く */
  idBase: string
  /** pub_hist の個別ページの親 URL */
  pubHistBase: string
  /** 気象庁の発表状況ページで確認済みの、警報が出た地震 */
  pubHistEvents: EewEventSpec[]
  /** fc_hist の目録を引く日（`YYYYMMDD`） */
  dates: string[]
  windowStart: Date
  windowEnd: Date
  /** リポジトリのトップ（震源カタログ public/data/hypocenter/ を読む） */
  repoRoot: string
}

/**
 * 発生時刻の決まり方。fc_hist は分までなので、震源カタログで秒を補う。補えなければ EventID の時刻
 * （地震波を検知した時刻。たいてい発生時刻の数秒後）で代える —— 分で切り捨てた時刻より近い。
 */
type OriginSource = 'page' | 'catalog' | 'event-id'

/** 生成で見つかった欠け。既知の一覧（`KnownGap`）と突き合わせる。 */
export interface EewGap {
  kind: EewGapKind
  eventId?: string
  date: string
}

export interface EewSectionPlan {
  /** fc_hist から報を作れた地震（EventID と組み立てた報） */
  fcHistBuilt: { eventId: string; entries: HistoricalArchiveEntry[]; originSource: OriginSource }[]
  /** pub_hist から作る地震（fc_hist から報を作れなかったもの） */
  pubHistEvents: EewEventSpec[]
  /** そのうち pub_hist の控えが無いページの URL（生成の前に fetch-pub-hist.ts で取る） */
  pubHistToFetch: string[]
  /** fc_hist から報を作れず、pub_hist で補う地震の EventID（fc_hist のページは読めた・読めなかったを問わない） */
  supplementedByPubHist: string[]
  /** 欠け（pub_hist でも補えなかったもの） */
  gaps: EewGap[]
  /** 震源カタログで発生時刻を補えず、EventID の時刻で代えた地震の EventID */
  eventIdTimeOrigins: string[]
  /** 震源カタログの照合で候補が 2 つ以上あった地震（EventID の時刻にいちばん近いものを採った） */
  ambiguousOrigins: { eventId: string; candidates: number }[]
}

/**
 * どの地震をどの出どころで作るかを決め、fc_hist の報を組み立てる。**通信はしない**（控えを読むだけ）。
 *
 * **pub_hist の補いから外すのは「fc_hist から報を作れた地震」だけ。** ページが読めても予報が 1 報も
 * 組めなかった地震（予測震度が全報「---」・通常の報が無い）は、警報が出た地震なら pub_hist で補う。
 */
export async function planEewSection(opts: EewSectionOptions): Promise<EewSectionPlan> {
  const fc = await loadFcHistPages(opts.dates, opts.windowStart, opts.windowEnd)
  const idPrefixByEventId = new Map(opts.pubHistEvents.map((e) => [eventIdOfPubHistDir(e.dir), e.idPrefix]))
  const catalogs = new Map<number, CatalogYear>()
  const catalogOf = async (year: number) => {
    let c = catalogs.get(year)
    if (!c) {
      c = await loadCatalogYear(opts.repoRoot, year)
      catalogs.set(year, c)
    }
    return c
  }

  const fcHistBuilt: EewSectionPlan['fcHistBuilt'] = []
  const notBuilt: { eventId: string; kind: EewGapKind }[] = []
  const eventIdTimeOrigins: string[] = []
  const ambiguousOrigins: EewSectionPlan['ambiguousOrigins'] = []

  for (const { capture, html } of fc.pages) {
    const eventId = capture.eventId
    const parsed = parseEewContentHtml(html)
    // 検知の行と取消の行しか無いページ（通常の報が 0 件）は入れずに記録する
    if (!parsed.reports.some((r) => r.reportNum > 0 && !r.isCancellation)) {
      notBuilt.push({ eventId, kind: 'no-normal-report' })
      continue
    }
    const idPrefix = idPrefixByEventId.get(eventId) ?? `${opts.idBase}-${eventId}`
    let originTimeIso = parsed.hypocenter.originTimeIso
    let originSource: OriginSource = 'page'
    if (!parsed.hypocenter.originTimeHasSeconds) {
      const match = matchCatalogOrigin(
        {
          eventIdIso: eventIdTime(eventId).toISOString(),
          minuteIso: parsed.hypocenter.originTimeIso,
          latitude: parsed.hypocenter.latitude,
          longitude: parsed.hypocenter.longitude,
          magnitude: parsed.hypocenter.magnitude,
        },
        await catalogOf(Number(eventId.slice(0, 4))),
      )
      if (match.kind === 'matched') {
        originTimeIso = match.originTimeIso
        originSource = 'catalog'
        if (match.candidates > 1) ambiguousOrigins.push({ eventId, candidates: match.candidates })
      } else {
        originSource = 'event-id'
        originTimeIso = eventIdTime(eventId).toISOString()
        eventIdTimeOrigins.push(eventId)
      }
    }
    const entries = buildEewEntries(parsed, { idPrefix, eventId, originTimeIso })
    // 予想の無い報は入れない決まり（`buildEewEntries`）なので、予測震度の欄が全報「---」の地震
    // （深発地震で確認済み）は取消の報しか残らないか、1 報も残らない。地震ごと入れずに記録する
    if (!entries.some((e) => !(e.payload as { event: EEWAlert }).event.cancelled)) {
      notBuilt.push({ eventId, kind: 'no-forecast' })
      continue
    }
    fcHistBuilt.push({ eventId, entries, originSource })
  }

  const builtIds = new Set(fcHistBuilt.map((b) => b.eventId))
  const pubHistEvents = opts.pubHistEvents.filter((e) => !builtIds.has(eventIdOfPubHistDir(e.dir)))
  const pubHistIds = new Set(pubHistEvents.map((e) => eventIdOfPubHistDir(e.dir)))
  const pubHistToFetch: string[] = []
  for (const e of pubHistEvents) {
    if ((await readPubHistCache(e.dir)) === null) pubHistToFetch.push(pubHistUrl(opts.pubHistBase, e.dir))
  }

  const candidatesForPubHist = [
    ...notBuilt.map((n) => n.eventId),
    ...fc.unavailable.map((f) => f.eventId),
  ]
  const supplementedByPubHist = candidatesForPubHist.filter((id) => pubHistIds.has(id))
  const gaps: EewGap[] = [
    ...fc.datesWithoutCdx.map((date): EewGap => ({ kind: 'no-cdx-date', date })),
    ...fc.unavailable
      .filter((f) => !pubHistIds.has(f.eventId))
      .map((f): EewGap => ({ kind: 'fc-hist-unavailable', eventId: f.eventId, date: f.eventId.slice(0, 8) })),
    ...notBuilt
      .filter((n) => !pubHistIds.has(n.eventId))
      .map((n): EewGap => ({ kind: n.kind, eventId: n.eventId, date: n.eventId.slice(0, 8) })),
  ]

  return { fcHistBuilt, pubHistEvents, pubHistToFetch, supplementedByPubHist, gaps, eventIdTimeOrigins, ambiguousOrigins }
}

function gapKey(g: { kind: EewGapKind; eventId?: string; date: string }): string {
  return `${g.kind}:${g.eventId ?? g.date}`
}

/**
 * 生成で見つかった欠けを既知の一覧と突き合わせる。**一覧に無い欠けも、一覧にあるのに出なかった欠けも止める**
 * （2026-10-25 ユーザー選択「一覧＋5 件を取り直す」）。後者は、取り直して埋まった欠けを一覧に残したままに
 * しないため —— 残すと、仕様書の「収録の限界」が実態より多い欠けを書き続ける。
 */
export function checkKnownGaps(found: EewGap[], known: KnownGap[]): void {
  const knownKeys = new Set(known.map(gapKey))
  const foundKeys = new Set(found.map(gapKey))
  const unexpected = found.filter((g) => !knownKeys.has(gapKey(g))).map(gapKey)
  const stale = known.filter((g) => !foundKeys.has(gapKey(g))).map(gapKey)
  if (unexpected.length > 0 || stale.length > 0) {
    throw new Error(
      `EEW の欠けが既知の一覧（historicalArchiveTargets.ts の knownGaps）と合いません。` +
        `一覧に無い欠け: ${unexpected.length > 0 ? unexpected.join(', ') : 'なし'}／` +
        `一覧にあるのに出なかった欠け: ${stale.length > 0 ? stale.join(', ') : 'なし'}`,
    )
  }
}

export interface EewSectionResult {
  entries: HistoricalArchiveEntry[]
  /** fc_hist から作った地震の EventID */
  fcHistEventIds: string[]
  /** pub_hist から作った地震の EventID */
  pubHistEventIds: string[]
  /** fc_hist から報を作れず、pub_hist で補った地震の EventID */
  supplementedByPubHist: string[]
  gaps: EewGap[]
  eventIdTimeOrigins: string[]
  ambiguousOrigins: { eventId: string; candidates: number }[]
}

/**
 * EEW の全報を組み立てる。fc_hist から報を作れた地震は fc_hist から（予報も含む全報）、作れなかった
 * 地震は pub_hist から（警報が出た地震の全報）作る。**控えだけを読む**（pub_hist の控えが無ければ止まる）。
 * 欠けが既知の一覧と合わなければ止まる（`checkKnownGaps`）。
 */
export async function buildEewSection(opts: EewSectionOptions & { knownGaps: KnownGap[] }): Promise<EewSectionResult> {
  const plan = await planEewSection(opts)
  if (plan.pubHistToFetch.length > 0) {
    throw new Error(
      `pub_hist の控えが ${plan.pubHistToFetch.length} 件ありません。生成は配信元へ取りに行かないので、` +
        `先に npx tsx scripts/fetch-pub-hist.ts を走らせてください: ${plan.pubHistToFetch.join(', ')}`,
    )
  }

  const entries: HistoricalArchiveEntry[] = []
  const originCounts: Record<OriginSource, number> = { page: 0, catalog: 0, 'event-id': 0 }
  for (const built of plan.fcHistBuilt) {
    originCounts[built.originSource]++
    entries.push(...built.entries)
  }
  for (const { idPrefix, dir } of plan.pubHistEvents) {
    const html = await readPubHistCache(dir)
    if (html === null) throw new Error(`${idPrefix}: pub_hist の控えがありません（${dir}）`)
    const parsed = parseEewContentHtml(html)
    if (!parsed.hypocenter.originTimeHasSeconds) throw new Error(`${idPrefix}: pub_hist の発生時刻が秒まで書かれていません（${dir}）`)
    const built = buildEewEntries(parsed, { idPrefix, eventId: eventIdOfPubHistDir(dir), originTimeIso: parsed.hypocenter.originTimeIso })
    if (built.length === 0) throw new Error(`${idPrefix}: 報が1件も生成されませんでした（pub_hist ${dir}）`)
    originCounts.page++
    entries.push(...built)
  }

  const fcHistEventIds = plan.fcHistBuilt.map((b) => b.eventId)
  const pubHistEventIds = plan.pubHistEvents.map((e) => eventIdOfPubHistDir(e.dir))
  console.log(
    `  EEW: ${entries.length}報（fc_hist ${fcHistEventIds.length}地震・pub_hist ${pubHistEventIds.length}地震。` +
      `発生時刻はページ${originCounts.page}・震源カタログ${originCounts.catalog}・EventID の時刻${originCounts['event-id']}）`,
  )
  console.log(
    `  fc_hist から報を作れず pub_hist で補った地震: ${plan.supplementedByPubHist.length > 0 ? plan.supplementedByPubHist.join(', ') : 'なし'}`,
  )
  if (plan.eventIdTimeOrigins.length > 0) {
    console.log(`  震源カタログで発生時刻を補えず EventID の時刻で代えた地震: ${plan.eventIdTimeOrigins.join(', ')}`)
  }
  if (plan.ambiguousOrigins.length > 0) {
    console.log(
      `  震源カタログの照合で候補が複数あった地震（EventID の時刻にいちばん近いものを採った）: ` +
        plan.ambiguousOrigins.map((a) => `${a.eventId}（${a.candidates}件）`).join(', '),
    )
  }
  if (plan.gaps.length > 0) console.log(`  欠け: ${plan.gaps.map(gapKey).join(', ')}`)
  checkKnownGaps(plan.gaps, opts.knownGaps)

  return {
    entries,
    fcHistEventIds,
    pubHistEventIds,
    supplementedByPubHist: plan.supplementedByPubHist,
    gaps: plan.gaps,
    eventIdTimeOrigins: plan.eventIdTimeOrigins,
    ambiguousOrigins: plan.ambiguousOrigins,
  }
}

// 地震情報・津波として取り込む対象の電文の見分け方。
//
// NIIサイトの表示ラベルは、完全一致で辞書引きするには信用できないことが分かっている
// （実際に2回踏んだ事故: 「震源・震度情報」だと思っていたら実際は「震源・震度に関する
// 情報」だった／津波系のラベルには末尾に説明のつかない"a"が付く）。そのため、まず
// 「地震・津波に関係しそうな候補」を広くキーワードで拾い、個別の種別判定は含有文字列で
// 行う。どれにも一致しない候補は黙って捨てず例外にする。
export const QUAKE_CANDIDATE_KEYWORDS = ['震度', '震源', '顕著な地震']
export const TSUNAMI_CANDIDATE_KEYWORD = '津波'

/**
 * 地震情報の種別ラベルから、より具体的なパターンを先に判定する（「震源・震度」は
 * 「震源」も含むため、判定順を間違えると全てVXSE52に丸め込まれる）。地震活動に依らず
 * NIIサイトの表示ラベル自体の解釈なので、地震ごとにカスタマイズする必要はない。
 */
export function resolveQuakeHeadType(typeLabel: string): string {
  if (typeLabel.includes('震度速報')) return 'VXSE51'
  if (typeLabel.includes('顕著な地震')) return 'VXSE61'
  if (typeLabel.includes('震源・震度')) return 'VXSE53'
  if (typeLabel.includes('震源')) return 'VXSE52'
  throw new Error(`地震情報の種別ラベルを解釈できません: "${typeLabel}"`)
}

/**
 * 津波情報の種別ラベルから電文種別を決める。パーサーは沖合（VTSE52）と沿岸（VTSE51）で
 * 観測点の扱いを変えるため、まとめて渡すわけにはいかない。
 *
 * **判定順は具体的なものを先に置く**（地震情報側と同じ理由）。「津波情報」を先に見るのは、
 * VTSE51 が解除等で「警報」の語を含むラベルを名乗りうるため —— 逆順にすると、そういう報が
 * VTSE41 として記録される。
 *
 * 沖合と沿岸の別さえ合っていれば現在のパーサーは同じに扱うが、`headType` に依存する分岐が
 * 増えたときに黙って固着しないよう、いまのうちに正しい順にしておく。
 */
export function resolveTsunamiHeadType(typeLabel: string): string {
  if (typeLabel.includes('沖合')) return 'VTSE52'
  if (typeLabel.includes('津波情報')) return 'VTSE51'
  if (typeLabel.includes('警報') || typeLabel.includes('注意報') || typeLabel.includes('予報')) return 'VTSE41'
  throw new Error(`津波情報の種別ラベルを解釈できません: "${typeLabel}"`)
}

/**
 * NIIサイトの一覧表示時刻（例: "2016-04-14 21:28:06+09"）はISO 8601ではない
 * （タイムゾーンオフセットが分無しの2桁）。`new Date()` にそのまま渡すと Invalid Date に
 * なり、Invalid Date 同士の比較は常に false を返すため、時刻ウィンドウによる絞り込みが
 * 無警告で機能しなくなる（実際に踏んだ事故）。分を補ってからパースし、それでも
 * Invalid Date ならログでは気づけないため例外にする。
 */
export function parseNiiTime(niiTime: string): Date {
  const m = niiTime.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\+(\d{2})$/)
  if (!m) throw new Error(`NII一覧の時刻表記を解釈できません: "${niiTime}"`)
  const parsed = new Date(`${m[1]}T${m[2]}+${m[3]}:00`)
  if (Number.isNaN(parsed.getTime())) throw new Error(`NII一覧の時刻をDateとして解釈できません: "${niiTime}"`)
  return parsed
}

export interface QuakeTsunamiOptions {
  /** 電文一覧を取得する日付（"YYYYMMDD"）の集合。連続した範囲でなくてもよい
   *  （散発的な余震が長期間に渡る地震活動では、実際にEEWが出た日の前後だけを
   *  指定すればよい。全期間を連続で舐めるとNIIサイトへの負荷・実行時間が過大になる）。 */
  dates: string[]
  windowStart: Date
  windowEnd: Date
  /** jsdomポリフィル設定後に動的importした dmdataParser.ts の関数をそのまま渡す。 */
  parseEarthquakeFromXml: (headType: string, xml: string) => JMAQuake | null
  parseTsunamiFromXml: (headType: string, xml: string) => JMATsunami | null
}

/**
 * 地震情報・津波を集める。
 *
 * **キャッシュの不調で間引いた件数は、どう抜けても最後に出す**（同じ原因の1件目は起きた
 * 時点で出ている）。取得が途中で失敗して例外になった実行こそ、「キャッシュが使えず毎回
 * 取りに行っていた」ことが原因の手掛かりになるため、正常終了の経路だけで出さない。
 */
export async function buildQuakeAndTsunamiSection(opts: QuakeTsunamiOptions): Promise<HistoricalArchiveEntry[]> {
  try {
    return await collectQuakeAndTsunamiEntries(opts)
  } finally {
    flushSuppressedCacheWarnings()
  }
}

async function collectQuakeAndTsunamiEntries(opts: QuakeTsunamiOptions): Promise<HistoricalArchiveEntry[]> {
  const { dates, windowStart, windowEnd, parseEarthquakeFromXml, parseTsunamiFromXml } = opts
  const entries: HistoricalArchiveEntry[] = []
  let totalCandidates = 0
  let fetched = 0
  let kept = 0
  /** 採用したうちの取消電文（内訳。`kept` に含む） */
  let keptCancelled = 0
  let skippedOutOfWindow = 0
  /** 収録範囲の終わりちょうどの電文（半開区間なので外す）。範囲の外とは別に数える */
  let skippedAtWindowEnd = 0
  /** 読めなかった電文（件数だけでなく、どの電文かを出す） */
  const parseFailures: { id: string; typeLabel: string }[] = []

  for (const date of dates) {
    console.log(`  ${date} の電文一覧を取得中...`)
    const listing = await fetchDayListing(date)
    // 全国対象の天気・警報等も含む一覧が1件も無い日は、対象日の指定ミスかサイト側の
    // 構造異常のいずれかであり、平常時でもまずあり得ない。黙って「候補0件」に進めず
    // 例外にする（候補0件そのもの＝フィルタ後の結果は正当にありうるので許容する）。
    if (listing.length === 0) throw new Error(`${date}: 電文一覧が0件でした（一覧ページの取得に問題がある可能性）`)

    const candidates = listing.filter(
      (it) => QUAKE_CANDIDATE_KEYWORDS.some((k) => it.typeLabel.includes(k)) || it.typeLabel.includes(TSUNAMI_CANDIDATE_KEYWORD),
    )
    console.log(`    候補 ${candidates.length}件`)
    totalCandidates += candidates.length

    // **収録範囲に入る電文は、どの地震のものでも全部入れる**（2026-10-23 ユーザー承認。選んだ選択肢は
    // 「窓の全地震を入れる (Recommended)」）。ライブで同じ時間を見ていれば届いていた電文なので、
    // 震央地名で絞ると、その地震活動の最中に起きた別の地震だけが再生から消える。
    // 取消電文も同じ扱いにする（2026-10-23 ユーザー承認。選んだ選択肢は「取消も収録する (Recommended)」）。
    // 取消はアプリ側がライブ・履歴とも `applyQuakeCancelToCard` で取り下げる。
    for (const item of candidates) {
      const itemTime = parseNiiTime(item.time)
      // 収録範囲は半開区間（終わりは含まない）。EEW の範囲の判定（`isInWindow`）と `coveredRanges` にそろえる
      if (itemTime.getTime() === windowEnd.getTime()) {
        skippedAtWindowEnd++
        continue
      }
      if (itemTime < windowStart || itemTime > windowEnd) {
        skippedOutOfWindow++
        continue
      }

      const xml = await fetchRawXml(item.id)
      fetched++
      await sleep(120) // 小規模なアカデミックサーバーへの配慮

      if (item.typeLabel.includes(TSUNAMI_CANDIDATE_KEYWORD)) {
        const tsunami = parseTsunamiFromXml(resolveTsunamiHeadType(item.typeLabel), xml)
        if (!tsunami) {
          parseFailures.push({ id: item.id, typeLabel: item.typeLabel })
          continue
        }
        // dmdataParser.ts の id 生成は eventId+serial を使うが、Serial が空の電文（震度速報等）
        // では固定値'1'に丸められるため、同じ地震の別種別の電文と衝突しうる。NIIの電文ID
        // （電文ごとに一意）を足して確実に一意にする。
        entries.push({ time: tsunami.time, payload: { kind: 'event', event: { ...tsunami, id: `${tsunami.id}-${item.id}` } as AppEvent } })
        kept++
        // 津波の `cancelled` は正式解除（`lifted`）も含む。取消として数えるのは取り下げだけ
        if (tsunami.cancelled && tsunami.cancelReason === 'retracted') keptCancelled++
        continue
      }

      const headType = resolveQuakeHeadType(item.typeLabel)
      const quake = parseEarthquakeFromXml(headType, xml)
      if (!quake) {
        parseFailures.push({ id: item.id, typeLabel: item.typeLabel })
        continue
      }
      entries.push({ time: quake.time, payload: { kind: 'event', event: { ...quake, id: `${quake.id}-${item.id}` } as AppEvent } })
      kept++
      if (quake.cancelled) keptCancelled++
    }
  }

  console.log(
    `  地震情報・津波: 取得${fetched}件 → 採用${kept}件（うち取消${keptCancelled}件）` +
      `（期間外${skippedOutOfWindow}件・収録範囲の終わりちょうど${skippedAtWindowEnd}件・パース失敗${parseFailures.length}件を除外）`,
  )
  for (const f of parseFailures) console.warn(`  読めなかった電文: ${f.id}（${f.typeLabel}）`)
  if (kept === 0) throw new Error('地震情報・津波が1件も採用されませんでした')
  const accountedFor = kept + skippedOutOfWindow + skippedAtWindowEnd + parseFailures.length
  if (accountedFor !== totalCandidates) {
    throw new Error(`集計の不整合: 候補${totalCandidates}件に対し内訳の合計が${accountedFor}件です`)
  }
  return entries
}

interface IndexEntry {
  id: string
  label: string
  description: string
  from: string
  to: string
  coveredRanges: { from: string; to: string }[]
  firstEventTime: string
}

/**
 * 電文一覧を取った日（`YYYYMMDD`・日本時間）から、実際に集めた範囲を作る。続いた日は 1 つにまとめ、
 * 収録範囲（`windowStart`〜`windowEnd`）で切る。**日を選んで集めたアーカイブで、間の日を「何も無かった」と
 * 取り違えないための印**（読む側は `findUncollectedArchiveSync`）。
 */
export function coveredRangesFromDates(dates: string[], windowStart: Date, windowEnd: Date): { from: string; to: string }[] {
  const DAY_MS = 24 * 60 * 60 * 1000
  const starts = [...new Set(dates)].map((d) => {
    if (!/^\d{8}$/.test(d)) throw new Error(`取得日の書式が YYYYMMDD ではありません: ${d}`)
    return new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00+09:00`).getTime()
  }).sort((a, b) => a - b)
  const merged: [number, number][] = []
  for (const s of starts) {
    const last = merged[merged.length - 1]
    if (last && last[1] === s) last[1] = s + DAY_MS
    else merged.push([s, s + DAY_MS])
  }
  const lo = windowStart.getTime()
  const hi = windowEnd.getTime()
  const ranges = merged
    .map(([s, e]) => [Math.max(s, lo), Math.min(e, hi)] as const)
    .filter(([s, e]) => s < e)
    .map(([s, e]) => ({ from: new Date(s).toISOString(), to: new Date(e).toISOString() }))
  if (ranges.length === 0) throw new Error('取得日が収録範囲に 1 日も掛かっていません')
  return ranges
}

/**
 * 既存のindex.json一覧へ新規/更新エントリを追加し、収録範囲の開始時刻(from)順に並べ替える。
 * 単純追記だと実行順（開発時にどのアーカイブを先に作ったか）でしか並ばず、設定の窓の一覧が
 * 地震の起きた順にならない（実際に発生していた不具合）。同じidが既にあれば置き換える。
 */
export function mergeIndexEntry(index: IndexEntry[], newEntry: IndexEntry): IndexEntry[] {
  return [...index.filter((e) => e.id !== newEntry.id), newEntry]
    .sort((a, b) => new Date(a.from).getTime() - new Date(b.from).getTime())
}

export interface FinalizeArchiveOptions {
  id: string
  label: string
  description: string
  windowStart: Date
  windowEnd: Date
  /** 電文一覧を取った日（`YYYYMMDD`）。集めた範囲（`coveredRanges`）はここから作る。 */
  dates: string[]
  entries: HistoricalArchiveEntry[]
  outPath: string
  indexPath: string
  /**
   * 設定の窓の「再生」ボタンの起点（`firstEventTime` として書く。ボタンはこの 1 分前から再生する）。
   * **窓の最初の報ではなく、その地震活動の最初の報を呼び出し側が明示する。** 窓の全地震を収録するようにしてから
   * （2026-10-23 ユーザー承認）、窓の最初の報は別の地震になり、本命の地震の何時間も前から再生が始まるため
   * （2026-10-25 ユーザー選択「前の起点に戻す (Recommended)」）。収録した報のどれかの時刻と一致しなければ例外
   */
  replayStartTime: string
}

/**
 * id重複チェック・ファイル書き出し・index.json更新をまとめて行う。
 * 4本のビルドスクリプト（熊本・鳥取・大阪・胆振東部）がこのブロックを個別にコピペして
 * いたことで、将来ここに検証を足したときに1本だけ直し忘れるリスクがあった
 * （レビューで指摘）。地震活動に依らない処理なのでここに集約する。
 */
export async function finalizeArchive(opts: FinalizeArchiveOptions): Promise<void> {
  const { id, label, description, windowStart, windowEnd, dates, entries, outPath, indexPath, replayStartTime } = opts

  if (entries.length === 0) throw new Error('entriesが1件もありません')

  const allEntries = [...entries].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())

  const idCounts = new Map<string, number>()
  for (const e of allEntries) {
    const eid = (e.payload as { event?: { id?: string } }).event?.id
    if (!eid) throw new Error(`idを持たないエントリがあります: ${JSON.stringify(e)}`)
    idCounts.set(eid, (idCounts.get(eid) ?? 0) + 1)
  }
  const duplicateIds = [...idCounts.entries()].filter(([, count]) => count > 1)
  if (duplicateIds.length > 0) {
    throw new Error(`id が重複しています: ${duplicateIds.map(([eid, count]) => `${eid}(${count}件)`).join(', ')}`)
  }

  const startMs = new Date(replayStartTime).getTime()
  if (Number.isNaN(startMs)) throw new Error(`再生の起点を日時として読めません: "${replayStartTime}"`)
  if (startMs < windowStart.getTime() || startMs > windowEnd.getTime()) {
    throw new Error(`再生の起点が収録範囲の外です: ${replayStartTime}`)
  }
  if (!allEntries.some((e) => new Date(e.time).getTime() === startMs)) {
    throw new Error(`再生の起点と同じ時刻の報がありません（地震の取り違えか、報の時刻の変化を疑う）: ${replayStartTime}`)
  }

  const out: HistoricalArchiveFile = {
    id,
    label,
    description,
    from: windowStart.toISOString(),
    to: windowEnd.toISOString(),
    coveredRanges: coveredRangesFromDates(dates, windowStart, windowEnd),
    firstEventTime: replayStartTime,
    entries: allEntries,
  }

  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, JSON.stringify(out, null, 2) + '\n', 'utf-8')
  console.log(`書き出し完了: ${outPath}（全${allEntries.length}件）`)

  const indexRaw = await readFile(indexPath, 'utf-8')
  const index = JSON.parse(indexRaw) as IndexEntry[]
  const newIndexEntry: IndexEntry = { id: out.id, label: out.label, description: out.description, from: out.from, to: out.to, coveredRanges: out.coveredRanges, firstEventTime: out.firstEventTime }
  const updatedIndex = mergeIndexEntry(index, newIndexEntry)
  await writeFile(indexPath, JSON.stringify(updatedIndex, null, 2) + '\n', 'utf-8')
  console.log('index.json を更新しました')
}
