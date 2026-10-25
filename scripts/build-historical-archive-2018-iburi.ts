// 2018年北海道胆振東部地震のローカル履歴アーカイブ（public/data/historical-archives/2018-iburi.json）を
// 一次資料から機械的に生成する。
//
//   npx tsx scripts/build-historical-archive-2018-iburi.ts
//
// 気象庁防災情報XMLフォーマットの運用開始（2011年5月12日）より後の地震のため、当時配信された
// 本物のXML電文が国立情報学研究所（NII）CPS-IIPプロジェクト「気象庁防災情報XMLデータベース」に
// 残っている。地震情報はそこから取得した生XMLをアプリ本番と同じパーサー
// （src/services/dmdataParser.ts の parseEarthquakeFromXml）にそのまま通す。津波警報・注意報の
// 発表は無い（内陸直下型）。
//
// 緊急地震速報（VXSE43/45）はNIIアーカイブに1件も収録されていない。
// EEW は、予報の発表状況（fc_hist）の Wayback Machine の控えがある地震はそちらから（予報も含む全報）、
// 無い地震は警報の発表状況（pub_hist）から（警報が出た地震の全報）作る。控えは先に
// `npx tsx scripts/fetch-wayback-fc-hist.ts` で取っておく（生成は控えを読むだけ）。
//
// **他の2地震（熊本・鳥取）と違い、警報級の余震が5ヶ月以上にわたって散発している**
// （本震2018/9/6・同日余震・約1ヶ月後の余震2018/10/5・約5ヶ月半後の余震2019/2/21。
// 気象庁の発表状況一覧ページで確認済み。震度6弱以上の再委任は無いが、いずれも同じ
// 「胆振地方中東部」を震央とする一連の地震活動として扱う）。この間を連続した日付範囲で
// 全て取得すると、無関係な全国の電文まで169日分読み込むことになり、NIIサイトへの負荷・
// 実行時間の両面で非現実的。そのため取得日（historicalArchiveTargets.ts の dates）は実際にEEWが出た日の前後だけを指定する
// （間の期間は取得しない＝データが存在しないのではなく、意図的に取得対象から外している）。
//
// 地震活動ごとに変わらない処理は localEarthquakeArchiveBuilder.ts に共通化している
// （2016年熊本地震向けに書いたロジックを一般化したもの）。
//
// 出典・ライセンス:
//   - 地震情報: 気象庁防災情報XMLデータベース（国立情報学研究所 CPS-IIP, Asanobu KITAMOTO）
//     https://agora.ex.nii.ac.jp/cps/weather/report/ 、CC BY 4.0
//   - EEW: 気象庁ホームページ（緊急地震速報（警報）発表状況・緊急地震速報（予報）発表状況。後者は
//     Internet Archive の Wayback Machine に残る控え）。政府標準利用規約（第1.0版）
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { buildEewSection, buildQuakeAndTsunamiSection, finalizeArchive } from './localEarthquakeArchiveBuilder'
import { ARCHIVE_TARGETS } from './historicalArchiveTargets'

const { window: jsdomWindow } = new JSDOM('')
globalThis.DOMParser = jsdomWindow.DOMParser as unknown as typeof DOMParser

const { parseEarthquakeFromXml, parseTsunamiFromXml } = await import('../src/services/dmdataParser')

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = join(__dirname, '..', 'public', 'data', 'historical-archives', '2018-iburi.json')
const INDEX_PATH = join(__dirname, '..', 'public', 'data', 'historical-archives', 'index.json')

// 取得日・収録範囲・警報が出た地震の一覧・再生の起点・既知の欠けは historicalArchiveTargets.ts が持つ
// （取得スクリプトと同じ値を読むため）。
const TARGET = ARCHIVE_TARGETS['2018-iburi']

async function main() {
  console.log('EEW を組み立て中...')
  const eew = await buildEewSection({
    idBase: TARGET.idBase,
    pubHistBase: TARGET.pubHistBase,
    pubHistEvents: TARGET.pubHistEvents,
    dates: TARGET.dates,
    windowStart: TARGET.windowStart,
    windowEnd: TARGET.windowEnd,
    repoRoot: join(__dirname, '..'),
    knownGaps: TARGET.knownGaps,
  })

  console.log('地震情報（NIIアーカイブの実電文）を取得中...')
  const quakeTsunamiEntries = await buildQuakeAndTsunamiSection({
    dates: TARGET.dates,
    windowStart: TARGET.windowStart,
    windowEnd: TARGET.windowEnd,
    parseEarthquakeFromXml,
    parseTsunamiFromXml,
  })

  await finalizeArchive({
    id: '2018-iburi',
    label: '2018年北海道胆振東部地震',
    description:
      '2018年9月6日3時8分頃、胆振地方中東部を震源とするM6.7の地震が発生。厚真町で震度7を観測した（北海道胆振東部地震）。',
    windowStart: TARGET.windowStart,
    windowEnd: TARGET.windowEnd,
    dates: TARGET.dates,
    entries: [...eew.entries, ...quakeTsunamiEntries],
    outPath: OUT_PATH,
    indexPath: INDEX_PATH,
    replayStartTime: TARGET.replayStartTime,
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
