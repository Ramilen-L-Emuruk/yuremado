/**
 * 公開観測点の名前の訳の表（`src/data/publicStationNames.json`）を作る。日本語の名前 → 日本語以外の 6 言語。
 *
 * 作り方は震度観測点の訳と同じ部品（`docs/spec/data-sources-spec.md` §6「公開観測点の名前の訳」）:
 * - 英語・ポルトガル語・スペイン語: 読み仮名（`scripts/lib/publicStationReadings.ts`）を語の切れ目ごとにローマ字にして空白で繋ぐ
 *   （`placeNameRomaji.ts`。2026-11-16 ユーザー選択「読みからローマ字 (Recommended)」）
 * - 中国語（簡体・繁体）: 漢字の字形だけを変える（`placeNameCjk.ts`。字の対応は地名の表の辞書由来の種類から学ぶ）。
 *   仮名の名前（えりも）は作れないので、地名の表の市町村「えりも町」の訳から「町」を落とした形を使う
 *   （2026-11-16 ユーザー選択「辞書の「襟裳」にする (Recommended)」）
 * - 韓国語: 読み仮名を語の切れ目ごとにハングルにして空白で繋ぐ（`placeNameCjk.ts`）
 *
 * **取りに行かない。** 入力は `public/data/public-stations.json`（日本語の名前）・読み仮名の表・地名の表（`public/data/place-names/`）だけ。
 * 読みが無い名前・訳を作れない名前があれば、表を書き換えずに止まる（exit 1）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { romanizeKana } from './lib/placeNameRomaji'
import { hangulFromKana, hasNonConnectiveKana, learnCharMap, zhFromJapanese } from './lib/placeNameCjk'
import { PUBLIC_STATION_READINGS } from './lib/publicStationReadings'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const OUT_PATH = resolve(REPO_ROOT, 'src/data/publicStationNames.json')

export const PUBLIC_STATION_NAME_LOCALES = ['en', 'pt-BR', 'es', 'zh-Hans', 'zh-Hant', 'ko'] as const
type NameLocale = (typeof PUBLIC_STATION_NAME_LOCALES)[number]
export type PublicStationNameRow = Record<NameLocale, string>

type PlaceTable = Record<string, Record<string, string>>
const readJson = <T>(path: string): T => JSON.parse(readFileSync(resolve(REPO_ROOT, path), 'utf8')) as T

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** 仮名の名前を、地名の表の市町村（名前＋市・町・村）の訳から市町村の語を落として引く。無ければ null */
function zhFromCity(name: string, city: Readonly<Record<string, string>>): string | null {
  for (const suffix of ['市', '町', '村']) {
    const hit = city[name + suffix]
    if (hit !== undefined && hit.endsWith(suffix)) return hit.slice(0, -suffix.length)
  }
  return null
}

/**
 * 日本語の名前ごとに 6 言語の訳を作る。作れない名前は `problems` に積む（呼び手が止める）。
 * `tables` は地名の表（中国語の字の対応を学ぶのと、仮名の名前の市町村の訳を引くのに使う）
 */
export function buildPublicStationNames(
  names: readonly string[],
  tables: Readonly<Record<'zh-Hans' | 'zh-Hant', PlaceTable>>,
): { rows: Record<string, PublicStationNameRow>; problems: string[] } {
  const learned = {
    'zh-Hans': learnCharMap((['epi', 'pref', 'city', 'tsunamiArea'] as const).flatMap((k) => Object.entries(tables['zh-Hans'][k] ?? {}))),
    'zh-Hant': learnCharMap((['epi', 'pref', 'city', 'tsunamiArea'] as const).flatMap((k) => Object.entries(tables['zh-Hant'][k] ?? {}))),
  }
  const rows: Record<string, PublicStationNameRow> = {}
  const problems: string[] = []
  for (const name of [...new Set(names)].sort()) {
    const r = PUBLIC_STATION_READINGS[name]
    if (r === undefined) { problems.push(`${name}: 読み仮名が scripts/lib/publicStationReadings.ts にありません`); continue }
    if (r.parts.join('') !== name || r.parts.length !== r.kana.length) { problems.push(`${name}: 読み仮名の切れ目が名前と合いません`); continue }
    const roman = r.kana.map((k) => romanizeKana(k))
    const hangul = r.kana.map((k, i) => hangulFromKana(k, r.parts[i]))
    const zh = (locale: 'zh-Hans' | 'zh-Hant') =>
      hasNonConnectiveKana(name) ? zhFromCity(name, tables[locale].city ?? {}) : zhFromJapanese(locale, name, learned[locale])
    const en = roman.every((x) => x !== null) ? roman.map((x) => capitalize(x as string)).join(' ') : null
    const ko = hangul.every((x) => x !== null) ? hangul.join(' ') : null
    const hans = zh('zh-Hans')
    const hant = zh('zh-Hant')
    const missing = Object.entries({ en, ko, 'zh-Hans': hans, 'zh-Hant': hant }).filter(([, v]) => v === null).map(([k]) => k)
    if (missing.length > 0) { problems.push(`${name}: ${missing.join('・')} の訳を作れません`); continue }
    rows[name] = { en: en!, 'pt-BR': en!, es: en!, 'zh-Hans': hans!, 'zh-Hant': hant!, ko: ko! }
  }
  return { rows, problems }
}

function main(): void {
  const stations = readJson<{ stations: { nameJa: string }[] }>('public/data/public-stations.json').stations
  const tables = {
    'zh-Hans': readJson<PlaceTable>('public/data/place-names/zh-Hans.json'),
    'zh-Hant': readJson<PlaceTable>('public/data/place-names/zh-Hant.json'),
  }
  const { rows, problems } = buildPublicStationNames(stations.map((s) => s.nameJa), tables)
  if (problems.length > 0) {
    console.error(`公開観測点の名前の訳を作れませんでした（表は書き換えません）:\n${problems.join('\n')}`)
    process.exit(1)
  }
  writeFileSync(OUT_PATH, JSON.stringify(rows, null, 2) + '\n')
  console.log(`公開観測点の名前の訳を書いた: ${Object.keys(rows).length} 件 → ${OUT_PATH}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
