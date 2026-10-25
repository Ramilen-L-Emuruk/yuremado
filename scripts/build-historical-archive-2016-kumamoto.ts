// 2016年熊本地震のローカル履歴アーカイブ（public/data/historical-archives/2016-kumamoto.json）を
// 一次資料から機械的に生成する。
//
//   npx tsx scripts/build-historical-archive-2016-kumamoto.ts
//
// 2011年東北地方太平洋沖地震と違い、気象庁防災情報XMLフォーマットの運用開始（2011年5月12日）
// より後の地震のため、当時配信された本物のXML電文が国立情報学研究所（NII）CPS-IIPプロジェクト
// 「気象庁防災情報XMLデータベース」に残っている。地震情報（震度速報・震源に関する情報・
// 震源・震度情報・顕著な地震の震源要素更新のお知らせ）と津波は、そこから取得した生XMLを
// アプリ本番と同じパーサー（src/services/dmdataParser.ts の parseEarthquakeFromXml /
// parseTsunamiFromXml）にそのまま通す。
//
// ただし緊急地震速報（VXSE43/45）はこのNIIアーカイブに1件も収録されていない（確認済み。
// 二次配信の契約上の制限によるものと見られる）。
// EEW は、予報の発表状況（fc_hist）の Wayback Machine の控えがある地震はそちらから（予報も含む全報）、
// 無い地震は警報の発表状況（pub_hist）から（警報が出た地震の全報）作る。控えは先に
// `npx tsx scripts/fetch-wayback-fc-hist.ts` で取っておく（生成は控えを読むだけ）。
//
// 地震活動ごとに変わらない処理（NII時刻のパース・電文種別の解釈・取消電文の扱い・
// 集計の整合性チェック等）は localEarthquakeArchiveBuilder.ts に共通化している。
//
// 出典・ライセンス:
//   - 地震情報・津波: 気象庁防災情報XMLデータベース（国立情報学研究所 CPS-IIP, Asanobu KITAMOTO）
//     https://agora.ex.nii.ac.jp/cps/weather/report/ 、CC BY 4.0
//   - EEW: 気象庁ホームページ（緊急地震速報（警報）発表状況・緊急地震速報（予報）発表状況。後者は
//     Internet Archive の Wayback Machine に残る控え）。政府標準利用規約（第1.0版）
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { buildEewSection, buildQuakeAndTsunamiSection, finalizeArchive } from './localEarthquakeArchiveBuilder'
import { ARCHIVE_TARGETS } from './historicalArchiveTargets'

// dmdataParser.ts の XML パースが `new DOMParser()` をブラウザグローバルとして参照するため、
// Node.js環境ではjsdomで代替する（capture-test-scenario.ts と同じ対処）。
const { window: jsdomWindow } = new JSDOM('')
globalThis.DOMParser = jsdomWindow.DOMParser as unknown as typeof DOMParser

// jsdomの差し込みより後でないとdmdataParser.tsの読み込み時にDOMParser未定義で失敗しうるため、
// 動的importで順序を保証する。
const { parseEarthquakeFromXml, parseTsunamiFromXml } = await import('../src/services/dmdataParser')

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = join(__dirname, '..', 'public', 'data', 'historical-archives', '2016-kumamoto.json')
const INDEX_PATH = join(__dirname, '..', 'public', 'data', 'historical-archives', 'index.json')

// 取得日・収録範囲・警報が出た地震の一覧・再生の起点・既知の欠けは historicalArchiveTargets.ts が持つ
// （取得スクリプトと同じ値を読むため）。
const TARGET = ARCHIVE_TARGETS['2016-kumamoto']

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

  console.log('地震情報・津波（NIIアーカイブの実電文）を取得中...')
  const quakeTsunamiEntries = await buildQuakeAndTsunamiSection({
    dates: TARGET.dates,
    windowStart: TARGET.windowStart,
    windowEnd: TARGET.windowEnd,
    parseEarthquakeFromXml,
    parseTsunamiFromXml,
  })

  await finalizeArchive({
    id: '2016-kumamoto',
    label: '2016年熊本地震',
    description:
      '2016年4月14日21時26分頃、熊本県熊本地方を震源とするM6.5の地震（前震）が発生。同16日1時25分頃には同地方でM7.3の地震（本震）が発生し、いずれも熊本県益城町で震度7を観測した（熊本地震）。',
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
