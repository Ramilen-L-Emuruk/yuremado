// プレート名の訳の表（src/data/plateNames.json）を作る。地図のプレート境界の吹き出しが、日本語の名前から引く。
//
// 出力: { "太平洋プレート": { "en": "Pacific plate", "pt-BR": "Placa do Pacífico", ... }, ... }（全 52 プレート × 6 言語）
//
// 訳は、その言語の利用者が実際に使う名前にする（2026-11-15 ユーザー選択「全言語で訳す (Recommended)」・「記事名に合わせる (Recommended)」）:
// 1. PB2002 のプレート（配布元 PB2002_plates.json の地名）を、Wikidata のプレートの項目と英語名で結ぶ
// 2. その項目の、各言語の Wikipedia の記事名を訳にする（英語も記事名どおり小文字の plate。同日「記事名どおり小文字の plate (Recommended)」）。
//    中国語の記事名は 1 つの字体で書かれているので、簡体・繁体は OpenCC で字形だけ変える
// 3. その言語に記事が無い欄は、記事名の型で作った訳（MISSING）を使う（同日「作った訳のまま (Recommended)」）
// Wikidata のラベルは項目を結ぶのにだけ使う。
//
// 取得は控え（.cache/plate-names）があれば行わない（無ければ合わせて 3 件: PB2002_plates.json・プレートの項目・記事名）。
// 更新方法: node scripts/build-plate-names.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { cacheDir } from './lib/cacheDir.mjs'
import { PLATE_NAMES } from './lib/plateNames.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const OUT_FILE = path.join(ROOT, 'src', 'data', 'plateNames.json')
export const PLATE_NAME_LOCALES = ['en', 'pt-BR', 'es', 'zh-Hans', 'zh-Hant', 'ko']
/** 表の言語 → Wikipedia の言語版 */
const WIKI_OF = { en: 'en', 'pt-BR': 'pt', es: 'es', 'zh-Hans': 'zh', 'zh-Hant': 'zh', ko: 'ko' }

const PLATES_URL = 'https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_plates.json'
// ラベルは項目を結ぶのに英語（?en）だけを使う。ほかの言語のラベルは表に使わない
const ITEMS_SPARQL = `
SELECT ?item ?class ?en ?pt ?ptx ?es ?zhHans ?zhHant ?zh ?ko ?ja WHERE {
  VALUES ?classLabel { "tectonic plate"@en "microplate"@en }
  ?class rdfs:label ?classLabel .
  ?item wdt:P31/wdt:P279* ?class .
  OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en) = "en") }
  OPTIONAL { ?item rdfs:label ?pt FILTER(LANG(?pt) = "pt-br") }
  OPTIONAL { ?item rdfs:label ?ptx FILTER(LANG(?ptx) = "pt") }
  OPTIONAL { ?item rdfs:label ?es FILTER(LANG(?es) = "es") }
  OPTIONAL { ?item rdfs:label ?zhHans FILTER(LANG(?zhHans) = "zh-hans") }
  OPTIONAL { ?item rdfs:label ?zhHant FILTER(LANG(?zhHant) = "zh-hant") }
  OPTIONAL { ?item rdfs:label ?zh FILTER(LANG(?zh) = "zh") }
  OPTIONAL { ?item rdfs:label ?ko FILTER(LANG(?ko) = "ko") }
  OPTIONAL { ?item rdfs:label ?ja FILTER(LANG(?ja) = "ja") }
}`
const titlesSparql = (ids) => `SELECT ?item ?site ?title WHERE {
  VALUES ?item { ${ids.map((i) => 'wd:' + i).join(' ')} }
  VALUES ?site { <https://pt.wikipedia.org/> <https://es.wikipedia.org/> <https://zh.wikipedia.org/> <https://ko.wikipedia.org/> <https://en.wikipedia.org/> }
  ?article schema:about ?item ; schema:isPartOf ?site ; schema:name ?title .
}`
const sparqlUrl = (q) => 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q)
const UA = { 'User-Agent': 'yuremado-build/1.0 (plate name translation)' }

/** PB2002 の地名が Wikidata の英語名と形の違うもの（形容詞形・正式名） */
const EN_ALIAS = {
  Africa: 'African', Amur: 'Amurian', Antarctica: 'Antarctic', Arabia: 'Arabian', Anatolia: 'Anatolian', Australia: 'Australian',
  Eurasia: 'Eurasian', India: 'Indian', 'North America': 'North American', 'South America': 'South American', Somalia: 'Somali',
  Sandwich: 'South Sandwich',
}

/**
 * その言語に Wikipedia の記事が無い欄の訳（略号 → 言語 → 訳）。記事名の型で作った（2026-11-15 ユーザー選択「一覧の案で入れる (Recommended)」・
 * 「作った訳のまま (Recommended)」。スペイン語の mar は記事名の書き方に合わせて小文字）。記事ができたら止めて見直す
 * @type {Record<string, Record<string, string>>}
 */
export const MISSING = {
  AP: { en: 'Altiplano plate' },
  BH: { 'pt-BR': 'Placa Cabeça de Pássaro' },
  BR: { 'pt-BR': 'Placa do Recife Balmoral' },
  BS: { 'pt-BR': 'Placa do Mar de Banda' },
  CR: { 'pt-BR': 'Placa do Recife Conway' },
  EA: { 'pt-BR': 'Placa de Páscoa' },
  FT: { 'pt-BR': 'Placa de Futuna', es: 'Placa de Futuna' },
  JZ: { 'pt-BR': 'Placa de Juan Fernández' },
  KE: { 'pt-BR': 'Placa de Kermadec', es: 'Placa de Kermadec' },
  MA: { es: 'Placa de las Marianas' },
  MN: { 'pt-BR': 'Placa de Manus' },
  MO: { 'pt-BR': 'Placa de Maoke' },
  MS: { 'pt-BR': 'Placa do Mar das Molucas', ko: '몰루카해판' },
  NB: { 'pt-BR': 'Placa de Bismarck do Norte', es: 'Placa de Bismarck del Norte' },
  NH: { es: 'Placa de las Nuevas Hébridas' },
  NI: { 'pt-BR': "Placa de Niuafo'ou", es: "Placa de Niuafo'ou" },
  PM: { 'pt-BR': 'Placa do Panamá' },
  RI: { 'pt-BR': 'Placa de Rivera' },
  SB: { 'pt-BR': 'Placa de Bismarck do Sul', es: 'Placa de Bismarck del Sur' },
  SL: { 'pt-BR': 'Placa de Shetland' },
  SS: { 'pt-BR': 'Placa do Mar de Salomão', es: 'Placa del mar de Salomón' },
  SW: { 'pt-BR': 'Placa de Sandwich do Sul' },
  TI: { 'pt-BR': 'Placa de Timor' },
  WL: { 'pt-BR': 'Placa de Woodlark' },
}

/** 控えを読む（無ければ取って控える）。形が違えば控えに書かず、控えが壊れていれば消し方を添えて止める */
async function cached(name, url, isValid, headers = {}) {
  const dir = cacheDir('plate-names')
  const file = path.join(dir, name)
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true })
    const res = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(60_000) })
    if (!res.ok) throw new Error(`${name} を取れなかった: ${res.status}`)
    const text = await res.text()
    let data
    try { data = JSON.parse(text) } catch { data = null }
    if (!isValid(data)) throw new Error(`${name} の応答が想定の形でない（控えには書かない）: ${text.slice(0, 200)}`)
    fs.writeFileSync(file, text)
    console.log(`取った: ${name}`)
  }
  let data
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { data = null }
  if (!isValid(data)) throw new Error(`控え ${file} が想定の形でない。消してから走らせ直すと取り直す`)
  return data
}

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]s\b/g, 's').replace(/[^a-z]/g, '').replace(/(micro)?plate$/, '')
const qid = (uri) => uri.split('/').pop()

/**
 * PB2002 の略号 → Wikidata の項目（英語名で結ぶ。同じ英語名の項目が 2 つあれば両方。Futuna）
 * @returns {Record<string, string[]>}
 */
export function matchPlateItems(pb2002, wikidata) {
  const plates = new Map(pb2002.features.map((f) => [f.properties.Code, f.properties.PlateName]))
  const enOf = new Map()
  for (const b of wikidata.results.bindings) if (b.en) enOf.set(qid(b.item.value), b.en.value)
  /** @type {Record<string, string[]>} */
  const out = {}
  for (const code of Object.keys(PLATE_NAMES)) {
    const pbName = plates.get(code)
    if (!pbName) throw new Error(`${code}: PB2002 に無い`)
    const key = norm(EN_ALIAS[pbName] ?? pbName)
    out[code] = [...enOf].filter(([, en]) => norm(en) === key).map(([id]) => id).sort()
    if (out[code].length === 0) throw new Error(`${code}（${pbName}）: Wikidata の項目に結べない`)
  }
  return out
}

/**
 * 材料から表を作る（取得はしない。テストから呼べるように）
 * @returns {Record<string, Record<string, string>>} 日本語の名前 → 言語 → 訳
 */
export function buildPlateNames(items, titles, toHans, toHant) {
  /** 項目 → 言語版 → 記事名 */
  const titleOf = {}
  for (const b of titles.results.bindings) {
    const wiki = b.site.value.match(/\/\/(\w+)\./)[1]
    ;(titleOf[qid(b.item.value)] ??= {})[wiki] = b.title.value
  }
  /** @type {Record<string, Record<string, string>>} */
  const out = {}
  const problems = []
  for (const code of Object.keys(PLATE_NAMES).sort()) {
    const ja = PLATE_NAMES[code]
    const row = {}
    for (const locale of PLATE_NAME_LOCALES) {
      const wiki = WIKI_OF[locale]
      // 同じプレートに項目が 2 つあるとき（Futuna）は、記事のある方。両方にあって違えば止める
      const found = [...new Set(items[code].map((id) => titleOf[id]?.[wiki]).filter(Boolean))]
      if (found.length > 1) { problems.push(`${code} ${locale}: 記事名が 1 つに決まらない（${found.join('・')}）`); continue }
      let title = found[0]
      // 中国語の記事名は記事ごとに簡体か繁体のどちらかで書かれている。もう一方の字体の字を含むときだけ変える
      // （既に繁体の「馬里亞納板塊」へ簡体→繁体を掛けると「里」が別の字「裡」になる）
      if (title && locale === 'zh-Hans' && toHans(title) !== title) title = toHans(title)
      if (title && locale === 'zh-Hant' && toHant(title) !== title && toHans(title) === title) title = toHant(title)
      const missing = MISSING[code]?.[locale]
      if (title && missing !== undefined) problems.push(`${code} ${locale}: 記事「${title}」ができた（MISSING の「${missing}」を見直す）`)
      else if (title) row[locale] = title
      else if (missing !== undefined) row[locale] = missing
      else problems.push(`${code} ${locale}: 記事が無く、MISSING にも無い`)
    }
    out[ja] = row
  }
  for (const [code, row] of Object.entries(MISSING)) {
    if (!(code in PLATE_NAMES)) problems.push(`MISSING の ${code}: 日本語の名前の表に無い略号`)
    for (const locale of Object.keys(row)) if (!PLATE_NAME_LOCALES.includes(locale)) problems.push(`MISSING の ${code}: 知らない言語 ${locale}`)
  }
  if (Object.keys(out).length !== Object.keys(PLATE_NAMES).length) problems.push('日本語の名前が重なっている（表の件数が略号の数と合わない）')
  if (problems.length) throw new Error(`プレート名の訳を作れない（${problems.length} 件）:\n  ${problems.join('\n  ')}`)
  return out
}

const hasBindings = (d) => Array.isArray(d?.results?.bindings) && d.results.bindings.length > 0

async function main() {
  const pb2002 = await cached('PB2002_plates.json', PLATES_URL, (d) => Array.isArray(d?.features) && d.features.length > 0)
  const wikidata = await cached('wikidata-plates.json', sparqlUrl(ITEMS_SPARQL), hasBindings, { Accept: 'application/sparql-results+json' })
  const items = matchPlateItems(pb2002, wikidata)
  const ids = [...new Set(Object.values(items).flat())].sort()
  const titles = await cached('wikipedia-titles.json', sparqlUrl(titlesSparql(ids)), hasBindings, { Accept: 'application/sparql-results+json' })
  const OpenCC = createRequire(import.meta.url)('opencc-js')
  const table = buildPlateNames(items, titles, OpenCC.Converter({ from: 'tw', to: 'cn' }), OpenCC.Converter({ from: 'cn', to: 'tw' }))
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(table, null, 2)}\n`)
  console.log(`プレート名の訳を書いた: ${Object.keys(table).length} 件 × ${PLATE_NAME_LOCALES.length} 言語 -> src/data/plateNames.json`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
