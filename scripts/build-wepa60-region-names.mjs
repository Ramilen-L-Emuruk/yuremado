// 国際津波関連情報（WEPA60）の震央の地名を、気象庁の日本語の地名へ引く表を生成する。
//
// 出力: public/data/wepa60-region-names.json
//   { "MINDANAO, PHILIPPINES": "フィリピン諸島、ミンダナオ", ... }   ← 英語の地域名（大文字・空白 1 つ）→ 日本語
//
// WEPA60 の震央の 1 行目は Flinn-Engdahl の地域名（英語）で書かれる（気象庁の仕様書 No.40401 別紙）。
// 気象庁の「詳細震央地名」（防災情報XML 地震火山関連コード表のシート 43）は、同じ地域区分に
// 「コード − 1000 ＝ Flinn-Engdahl の番号」で日本語の名前を付けている（例 1259「フィリピン諸島、ミンダナオ」）。
// そこで英語の地域名 → 番号 → 気象庁の日本語、と引く。
//
// ## 取得元
//
// | # | 取得元 | 役割 |
// |---|--------|------|
// | 1 | 気象庁 防災情報XML 個別コード表（地震火山関連コード表 シート 43） | 番号 → 日本語 |
// | 2 | USGS の Flinn-Engdahl 一覧（2019-05 の Wayback の控え） | 番号 → 英語（電文と同じ古い書き方。P.N.G.・IRIAN JAYA など） |
// | 3 | Wikipedia の Flinn-Engdahl 一覧 | 番号 → 英語（今の書き方。2 に無い 730〜757 番も持つ） |
//
// 2 と 3 の英語は書き方が違うことがある（`NEW BRITAIN REGION, P.N.G.` と `New Britain Region, Papua New Guinea`）。
// 電文がどちらで来ても引けるよう、両方を同じ番号の日本語へ結ぶ。
//
// 取得したものは .cache/wepa60-sources と .cache/jma-manual に控え、2 回目からは取りに行かない。
//
// 更新方法: node scripts/build-wepa60-region-names.mjs
import { existsSync, readdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { findWorkbookInZip } from './lib/xlsx.mjs'
import { cacheDir } from './lib/cacheDir.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_FILE = join(__dirname, '..', 'public', 'data', 'wepa60-region-names.json')

const JMA_TEC_MATERIAL = 'https://xml.kishou.go.jp/tec_material.html'
const USGS_LIST_ARCHIVE = 'https://web.archive.org/web/20190525125204id_/https://earthquake.usgs.gov/learn/topics/flinn_engdahl_list.php'
const WIKIPEDIA_RAW = 'https://en.wikipedia.org/w/index.php?title=Flinn-Engdahl_regionalization&action=raw'

/** 英語の地域名を引く鍵にする（大文字・空白を 1 つに）。翻訳の側（`wepa60Translate.ts`）も同じ形で引く */
export function regionKey(name) {
  return name.toUpperCase().replace(/\s+/g, ' ').trim()
}

/** USGS の一覧（`  259  MINDANAO, PHILIPPINES` の行。名前が変わった行の頭には赤い `<` の印が付く）を番号 → 英語にする */
export function parseUsgsList(html) {
  const out = new Map()
  for (const m of html.matchAll(/^(?:<span[^>]*>&lt;<\/span>)?\s*(\d{1,3})\s{2,}([A-Z][^\n<]*?)\s*$/gm)) out.set(Number(m[1]), m[2].trim())
  return out
}

/** Wikipedia の一覧（`| 259 || Mindanao, Philippines ||`）を番号 → 英語にする */
export function parseWikipediaList(wikitext) {
  const out = new Map()
  for (const m of wikitext.matchAll(/^\|\s*(\d+)\s*\|\|\s*([^|\n]+?)\s*\|\|/gm)) out.set(Number(m[1]), m[2].trim())
  return out
}

/** 気象庁の詳細震央地名（シート 43）を番号（コード − 1000）→ 日本語にする */
export function parseJmaDetailedEpicenter(rows) {
  const out = new Map()
  for (const r of rows) {
    const code = String(r?.[0] ?? '')
    if (!/^\d{4}$/.test(code)) continue
    const name = String(r?.[1] ?? '').trim()
    if (name) out.set(Number(code) - 1000, name)
  }
  return out
}

/** 3 つの表を番号で結び、英語の地域名 → 日本語の表を作る。同じ鍵に別の日本語が当たったら止める */
export function buildRegionNames(usgs, wikipedia, jma) {
  const out = {}
  const missing = []
  for (const [list, label] of [[usgs, 'USGS'], [wikipedia, 'Wikipedia']]) {
    for (const [n, en] of list) {
      const ja = jma.get(n)
      if (!ja) { missing.push(`${label} ${n} ${en}`); continue }
      const key = regionKey(en)
      if (out[key] && out[key] !== ja) throw new Error(`同じ地域名に別の日本語が当たりました: ${key}（${out[key]} と ${ja}）`)
      out[key] = ja
    }
  }
  return { names: out, missing }
}

async function cached(dir, file, url, label, asBytes = false) {
  const path = join(dir, file)
  if (existsSync(path)) return asBytes ? new Uint8Array(await readFile(path)) : readFile(path, 'utf8')
  console.log(`${label} を取得します: ${url}`)
  const res = await fetch(url, { headers: { 'user-agent': 'yuremado-build' }, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`${label} を取得できません（HTTP ${res.status}）`)
  const body = asBytes ? new Uint8Array(await res.arrayBuffer()) : await res.text()
  await writeFile(path, body)
  return body
}

async function jmaCodeZip(dir) {
  const local = readdirSync(dir).filter(f => /^jmaxml_\d+_Code\.zip$/i.test(f)).sort().at(-1)
  if (local) return new Uint8Array(await readFile(join(dir, local)))
  const index = await (await fetch(JMA_TEC_MATERIAL, { signal: AbortSignal.timeout(60_000) })).text()
  const file = /href="(jmaxml_\d+_Code\.zip)"/i.exec(index)?.[1]
  if (!file) throw new Error('気象庁 技術資料ページに個別コード表（jmaxml_*_Code.zip）へのリンクがありません')
  return cached(dir, file, new URL(file, JMA_TEC_MATERIAL).href, '気象庁 個別コード表', true)
}

async function main() {
  const sources = cacheDir('wepa60-sources')
  const usgs = parseUsgsList(await cached(sources, 'usgs-flinn-engdahl-list-2019.html', USGS_LIST_ARCHIVE, 'USGS の Flinn-Engdahl 一覧'))
  const wikipedia = parseWikipediaList(await cached(sources, 'wikipedia-flinn-engdahl.wikitext', WIKIPEDIA_RAW, 'Wikipedia の Flinn-Engdahl 一覧'))
  const zip = await jmaCodeZip(cacheDir('jma-manual'))
  const book = findWorkbookInZip(zip, (sheets) => String(sheets.get('43')?.[0]?.[0] ?? '').includes('AreaEpicenterDetail'))
  if (!book) throw new Error('個別コード表に詳細震央地名のシート（地震火山関連コード表のシート 43）がありません')
  const jma = parseJmaDetailedEpicenter(book.get('43'))

  // 下限は実測に寄せる（2026-11-08 の控えで USGS 726・Wikipedia 754・気象庁 757。USGS は 730 番以降を持たない）
  if (usgs.size < 720 || wikipedia.size < 750 || jma.size < 757) {
    throw new Error(`一覧の件数が少なすぎます（USGS ${usgs.size}・Wikipedia ${wikipedia.size}・気象庁 ${jma.size}）。書式が変わった疑い`)
  }
  const { names, missing } = buildRegionNames(usgs, wikipedia, jma)
  if (missing.length > 0) throw new Error(`気象庁の日本語が無い番号があります: ${missing.join(' / ')}`)
  const sorted = Object.fromEntries(Object.entries(names).sort(([a], [b]) => a.localeCompare(b)))
  await writeFile(OUT_FILE, `${JSON.stringify(sorted, null, 1)}\n`)
  console.log(`USGS ${usgs.size}・Wikipedia ${wikipedia.size}・気象庁 ${jma.size} 件から ${Object.keys(sorted).length} 件を ${OUT_FILE} に書き出しました`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
