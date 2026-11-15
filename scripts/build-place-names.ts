/**
 * 地名の訳の表（`public/data/place-names/<言語>.json`）を作る。
 *
 * 表は言語ごとに 1 つ。中身は種類ごとに「日本語の名前 → 訳」（名前は種類の中で重ならない。重なれば止まる）。
 *
 * | 種類 | 出どころ |
 * |---|---|
 * | `epi`（震央地名）・`pref`（都道府県）・`city`（市町村）・`tsunamiArea`（津波予報区） | 気象庁 多言語サイトの辞書（全言語） |
 * | `area`（地震情報の細分区域） | 同じ名前か同じコードの震央地名（「〜地方」）が辞書にあればその訳（全言語）。無い島など 28 件は英字の言語だけ下の 2 つ |
 * | `station`（震度観測点）・`tsunamiStation`（津波観測点） | 英字の言語（英・葡・西）: 気象庁サイトの報の英語名（`enName`）を集めたもの、無ければ読み仮名から作ったローマ字（`lib/placeNameRomaji.ts`）。中国語・韓国語: 名前の字形を変えたもの・読み仮名のハングル（`lib/placeNameCjk.ts`） |
 *
 * 中国語・韓国語は辞書に無い細分区域を持たない（画面では日本語の名前のまま出る）。辞書の訳の誤りと揺れは `lib/placeNameFixes.ts` で直してから入れる。
 * ポルトガル語・スペイン語の観測点は英語と同じ英字の名前を使う（気象庁の辞書にも観測点は無い）。
 *
 * 入力（どれもメインの checkout の `.cache/` の控え。無い・件数が少なすぎる・読めない、のどれでも止まる。取り方は `.cache/jma-multi/README.md`）:
 * - `jma-multi/dict-{epi,pref,city,areatsunami}.json` — 多言語辞書
 * - `jma-bosai-en/en-pairs.json` — 報の JSON から集めた英語名（`collect-en.mjs`）
 * - `dmdata-parameter/earthquake-station-*.json`・`tsunami-station-*.json` — 観測点・区域・市町村の名前と読み仮名（日付の一番新しいもの）
 *
 * 更新方法: npx tsx scripts/build-place-names.ts
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cacheDir } from './lib/cacheDir.mjs'
import { areaEnFromKana, cityEnFromKana, stationEnFromKana, tsunamiStationEnFromKana } from './lib/placeNameRomaji'
import { fixPlaceName, leftoverForeignChars } from './lib/placeNameFixes'
import { hangulFromKana, hasNonConnectiveKana, learnCharMap, zhFromJapanese } from './lib/placeNameCjk'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(HERE, '..', 'public', 'data', 'place-names')

/** 表を作る言語と、多言語辞書の欄の名前。英字の言語は辞書の無い種類を英語の名前で埋める */
export const PLACE_NAME_LOCALES = [
  { id: 'en', field: 'english', latin: true },
  { id: 'zh-Hans', field: 'chinese_zs', latin: false },
  { id: 'zh-Hant', field: 'chinese_zt', latin: false },
  { id: 'ko', field: 'korean', latin: false },
  { id: 'pt-BR', field: 'portuguese', latin: true },
  { id: 'es', field: 'spanish', latin: true },
] as const

export const PLACE_NAME_KINDS = ['epi', 'pref', 'city', 'tsunamiArea', 'area', 'station', 'tsunamiStation'] as const
export type PlaceNameKind = (typeof PLACE_NAME_KINDS)[number]
export type PlaceNameTable = Record<PlaceNameKind, Record<string, string>>

type DictEntry = Record<string, string>
type Dict = Record<string, DictEntry>
interface EqStation { region: { code: string; name: string; kana: string }; city: { code: string; name: string; kana: string }; code: string; name: string; kana: string }
interface TsunamiStation { code: string; name: string; kana: string }
interface EnPair { code: string; name: string; kana: string | null; en: string }
export interface PlaceNameSources {
  epi: Dict; pref: Dict; city: Dict; tsunamiArea: Dict
  eqStations: EqStation[]; tsunamiStations: TsunamiStation[]
  enPairs: { area: EnPair[]; city: EnPair[]; station: EnPair[] }
}

/**
 * 辞書の訳の空白を整える（末尾の空白・2 つ続く空白・ゼロ幅の空白が混じっている。
 * ゼロ幅の空白は `\s` に入らないので先に外す。英語の震央地名「Adjacent Sea of Sakhalin」の of の直後などに入っていた）
 */
// 見えない文字を正規表現に直に書くと読めず、うっかり消されるので、文字コードから組む（U+200B〜U+200D と U+FEFF）
const ZERO_WIDTH = new RegExp(`[${String.fromCharCode(0x200b)}-${String.fromCharCode(0x200d)}${String.fromCharCode(0xfeff)}]`, 'g')
export const tidy = (s: string | undefined) => (s ?? '').replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim()

/**
 * 英字の言語の訳に残る日本語の中黒「・」（前後の空白ごと）を「, 」にする。ポルトガル語の辞書の 17 件に入っていた
 * （「Mar perto de Iki・Tsushima」。2026-11-13 ユーザー選択「17 件とも「, 」に (Recommended)」）
 */
export const latinSeparators = (s: string) => s.replace(/\s*・\s*/g, ', ')

/**
 * 英字の言語でも訳を作れず日本語のまま出す名前（読み仮名からローマ字を作れないもの）。
 * これ以外に作れない名前が出たら止める（読み仮名の変換や控えが壊れて、日本語のままの名前が黙って増えないように）
 */
export const KNOWN_UNTRANSLATED: Readonly<Record<'area' | 'station' | 'tsunamiStation', readonly string[]>> = {
  area: ['色丹島', '国後島', '択捉島', 'うるま市・金武町境界部地先の埋立地'],
  station: [],
  tsunamiStation: [],
}

/** 中国語で作れない観測点名の件数の上限（2026-11-15 の控えで 震度観測点 65・津波観測点 1） */
const ZH_UNTRANSLATED_MAX = { station: 65, tsunamiStation: 1 } as const

/**
 * 訳を作れなかった名前が、決めた範囲を超えていたら止める。英字の言語は {@link KNOWN_UNTRANSLATED}、
 * 中国語は繋ぎ以外の仮名を含む観測点名（日本語のまま出すと決めたもの）だけを許し、韓国語は 1 件も許さない
 * （中韓の細分区域は辞書に無いものを持たないので、ここでは数えない）。中国語の訳にその字体で使わない字が残っていても止める
 */
export function checkUntranslated(report: BuildReport): void {
  if (report.locale === 'zh-Hans' || report.locale === 'zh-Hant') {
    // 仮名の判定を作る側と同じ関数で許すので、判定が壊れても許す側が一緒に広がる。件数でも止める
    for (const kind of ['station', 'tsunamiStation'] as const) {
      const n = report.untranslated[kind].length
      if (n > ZH_UNTRANSLATED_MAX[kind]) throw new Error(`${report.locale} の ${kind} で訳を作れない名前が ${n} 件ある（${ZH_UNTRANSLATED_MAX[kind]} 件まで）。観測点が増えたのなら ZH_UNTRANSLATED_MAX を見直す`)
    }
  }
  const allowed = (kind: 'area' | 'station' | 'tsunamiStation', name: string) => {
    if (report.locale === 'zh-Hans' || report.locale === 'zh-Hant') return hasNonConnectiveKana(name)
    if (report.locale === 'ko') return false
    return KNOWN_UNTRANSLATED[kind].includes(name)
  }
  for (const kind of ['area', 'station', 'tsunamiStation'] as const) {
    const extra = report.untranslated[kind].filter((n) => !allowed(kind, n))
    if (extra.length) throw new Error(`${report.locale} の ${kind} で訳を作れない名前が増えた（${extra.length} 件: ${extra.slice(0, 10).join('・')}）。読み仮名の変換か控えを確かめる。日本語のまま出すと決めたなら KNOWN_UNTRANSLATED に足す`)
  }
  if (report.foreignChars.length) {
    throw new Error(`${report.locale} の訳にその字体で使わない字が残っている（${report.foreignChars.length} 件: ${report.foreignChars.slice(0, 10).join('・')}）。辞書の誤りなら lib/placeNameFixes.ts の PLACE_NAME_FIXES に直しを足す`)
  }
}

/** 名前 → 訳を入れる。同じ名前に違う訳が来たら止める（種類の中で名前が重ならない前提を確かめる） */
function put(table: Record<string, string>, kind: string, name: string, value: string): void {
  if (!value) return
  const had = table[name]
  if (had !== undefined && had !== value) throw new Error(`地名の訳が 1 つに決まらない: ${kind} の「${name}」に「${had}」と「${value}」`)
  table[name] = value
}

export interface BuildReport {
  locale: string; counts: Record<PlaceNameKind, number>; romaji: Record<'area' | 'station' | 'tsunamiStation', number>; untranslated: Record<'area' | 'station' | 'tsunamiStation', string[]>
  /** 直した後もその字体で使わない字が残っている訳（中国語だけ）。1 件でもあれば止める */
  foreignChars: string[]
}

/** 沖合の津波観測点（「釧路沖１００ｋｍＡ」）。頭の地名・距離・記号に分ける */
const OFFSHORE = { name: /^(.+)沖([０-９]+)ｋｍ([Ａ-Ｚ]?)$/, kana: /^(.+)オキ[０-９]+ｋｍ[Ａ-Ｚ]?$/ }
/** 「沖」で終わる津波観測点（「青森深浦沖」） */
const ENDS_WITH_OKI = { name: /沖$/, kana: /オキ$/ }
const halfWidth = (s: string) => s.replace(/[０-９Ａ-Ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))

/**
 * 中国語・韓国語の震度観測点と津波観測点を作る（`lib/placeNameCjk.ts`）。
 * 名前が市町村名で始まれば「市町村の訳＋残り」（中国語は続けて書き、韓国語は空白で区切る。英語の「Iwaki-shi Onahama」と同じ切り方）、
 * 始まらなければ名前全体を変える。施設の語（役場・空港など）も名前の一部として写す（2026-11-15 ユーザー選択「名前の一部として写す (Recommended)」）。
 * 「沖」は中国語は辞書と同じ字（簡体「冲」・繁体「沖」）、韓国語は「앞바다」（同日ユーザー選択「앞바다 (Recommended)」）。
 * 作れない名前（中国語は繋ぎ以外の仮名を含む・韓国語は表に無い仮名を含む）は表に入れない（画面では日本語の名前のまま出る）
 */
function buildCjkStations(
  src: PlaceNameSources,
  locale: string,
  table: PlaceNameTable,
  untranslated: Record<'station' | 'tsunamiStation', string[]>,
  cityPrefixOf: (name: string, kana: string) => EqStation['city'] | undefined,
): void {
  const ko = locale === 'ko'
  const zh = locale === 'zh-Hant' ? 'zh-Hant' : 'zh-Hans'
  const learned = ko ? new Map<string, string>() : learnCharMap((['epi', 'pref', 'city', 'tsunamiArea'] as const).flatMap((k) => Object.entries(table[k])))
  const zhOf = (name: string) => zhFromJapanese(zh, name, learned)
  /** 市町村名＋残り（残りが無ければ市町村の訳だけ）。市町村の訳は表の訳、無ければ作る */
  const withCity = (city: EqStation['city'], name: string, kana: string): string | null => {
    const rest = name.slice(city.name.length), restKana = kana.slice(city.kana.length)
    // 名前に残りがあるのに読みの残りが無い（または逆の）ときは、市町村の訳だけに縮めず作らない
    if (!rest !== !restKana) return null
    if (ko) {
      const head = table.city[city.name] ?? hangulFromKana(city.kana, city.name)
      if (!head) return null
      if (!restKana) return head
      const tail = hangulFromKana(restKana, rest)
      return tail ? `${head} ${tail}` : null
    }
    const head = table.city[city.name] ?? zhOf(city.name)
    const tail = rest ? zhOf(rest) : ''
    return head && tail !== null ? head + tail : null
  }
  const whole = (name: string, kana: string) => (ko ? hangulFromKana(kana, name) : zhOf(name))

  // 震度観測点。同じ名前の新旧の観測点（コードの付け替え）は名前と読みが同じなので、同じ訳になる
  for (const s of src.eqStations) {
    const v = s.name.startsWith(s.city.name) && s.kana.startsWith(s.city.kana) ? withCity(s.city, s.name, s.kana) : whole(s.name, s.kana)
    if (v) put(table.station, 'station', s.name, v)
    else if (!untranslated.station.includes(s.name)) untranslated.station.push(s.name)
  }
  for (const s of src.tsunamiStations) {
    let v: string | null
    const off = OFFSHORE.name.exec(s.name), offKana = OFFSHORE.kana.exec(s.kana)
    // 名前だけが沖合・「沖」の形に合い、読みが合わないものは作らない（作れない名前として数え、止める）
    if (off) {
      const dist = `${halfWidth(off[2])}km${off[3] ? ` ${halfWidth(off[3])}` : ''}`
      const head = !offKana ? null : ko ? hangulFromKana(offKana[1], off[1]) : zhOf(`${off[1]}沖`)
      v = head ? (ko ? `${head} 앞바다 ${dist}` : `${head}${dist}`) : null
    } else if (ENDS_WITH_OKI.name.test(s.name)) {
      const kanaOk = ENDS_WITH_OKI.kana.test(s.kana)
      const head = ko && kanaOk ? hangulFromKana(s.kana.replace(ENDS_WITH_OKI.kana, ''), s.name) : null
      v = !kanaOk ? null : ko ? (head ? `${head} 앞바다` : null) : zhOf(s.name)
    } else {
      const city = cityPrefixOf(s.name, s.kana)
      v = city ? withCity(city, s.name, s.kana) : whole(s.name, s.kana)
    }
    if (v) put(table.tsunamiStation, 'tsunamiStation', s.name, v)
    else untranslated.tsunamiStation.push(s.name)
  }
}

/** 1 つの言語の表を作る。入力の読み込みはしない（テストから呼べるように） */
export function buildPlaceNameTable(src: PlaceNameSources, locale: (typeof PLACE_NAME_LOCALES)[number]): { table: PlaceNameTable; report: BuildReport } {
  const table = Object.fromEntries(PLACE_NAME_KINDS.map((k) => [k, {}])) as PlaceNameTable
  const romaji = { area: 0, station: 0, tsunamiStation: 0 }
  const untranslated = { area: [] as string[], station: [] as string[], tsunamiStation: [] as string[] }
  const f = locale.field
  // 中国語・韓国語は辞書の誤りと揺れを直してから入れる（`lib/placeNameFixes.ts`）
  const dictText = (e: DictEntry, kind: string, name: string) =>
    locale.latin ? latinSeparators(tidy(e[f])) : fixPlaceName(locale.id, kind, name, tidy(e[f]))

  for (const [kind, dict] of [['epi', src.epi], ['pref', src.pref], ['city', src.city], ['tsunamiArea', src.tsunamiArea]] as const) {
    for (const e of Object.values(dict)) put(table[kind], kind, e.japanese, dictText(e, kind, e.japanese))
  }

  const epiByName = new Map(Object.values(src.epi).map((e) => [e.japanese, e]))
  const jmaEn = {
    area: new Map(src.enPairs.area.map((p) => [p.code, p.en])),
    city: new Map(src.enPairs.city.map((p) => [p.code, p.en])),
    station: new Map(src.enPairs.station.map((p) => [p.code, p.en])),
  }

  // 細分区域: 辞書（同じ名前 → 同じコードの「名前＋地方」）→ 英字の言語だけ集めた英語名 → ローマ字。
  // 辞書の訳は震央地名の項なので、直しも震央地名の種類と名前で引く（同じ地名の訳が区域と震央地名でずれないように）
  const areas = new Map<string, EqStation['region']>()
  for (const s of src.eqStations) areas.set(s.region.code, s.region)
  for (const r of areas.values()) {
    const byCode = src.epi[r.code]
    const dict = epiByName.get(r.name) ?? (byCode && byCode.japanese === `${r.name}地方` ? byCode : undefined)
    if (dict) { put(table.area, 'area', r.name, dictText(dict, 'epi', dict.japanese)); continue }
    if (!locale.latin) continue
    const collected = jmaEn.area.get(r.code)
    const made = collected ? null : areaEnFromKana(r.name, r.kana)
    if (made) romaji.area++
    const en = collected ?? made
    if (en) put(table.area, 'area', r.name, en)
    else untranslated.area.push(r.name)
  }

  // 津波観測点の名前の頭の市町村（名前が市町村名で始まり、読み仮名もその読みで始まるもの）
  const cities = new Map<string, EqStation['city']>()
  for (const s of src.eqStations) cities.set(s.city.name, s.city)
  const cityPrefixOf = (name: string, kana: string) => {
    let best: EqStation['city'] | undefined
    for (let n = Math.min(name.length - 1, 10); n >= 2 && !best; n--) {
      const c = cities.get(name.slice(0, n))
      if (c && kana.startsWith(c.kana) && kana.length > c.kana.length) best = c
    }
    return best
  }

  if (!locale.latin) {
    buildCjkStations(src, locale.id, table, untranslated, cityPrefixOf)
  } else {
    // 震度観測点: 集めた英語名 → 「市町村の英語名（集めたもの、無ければローマ字）＋残りのローマ字」。
    // 鍵は ＊ の無い名前（電文の読み取りが ＊ を外し、画面が印を付け直す）なので、英語名の末尾の * も外す。
    // 同じ名前の新旧の観測点（コードの付け替え）は同じ訳にそろえるため、集めた英語名を先に入れ、
    // ローマ字はまだ訳の無い名前にだけ作る
    for (const s of src.eqStations) {
      const collected = jmaEn.station.get(s.code)
      if (collected) put(table.station, 'station', s.name, collected.replace(/\*$/, ''))
    }
    for (const s of src.eqStations) {
      if (table.station[s.name] !== undefined) continue
      const cityEn = jmaEn.city.get(s.city.code) ?? cityEnFromKana(s.city.name, s.city.kana)
      const en = cityEn ? stationEnFromKana(s.name, s.kana, cityEn, s.city.kana) : null
      if (en) { romaji.station++; put(table.station, 'station', s.name, en) }
      else untranslated.station.push(s.name)
    }
    // 津波観測点: 名前が市町村名で始まり読み仮名も合えば、震度観測点と同じ「市町村の英語名 残り」にする
    // （「いわき市小名浜」→「Iwaki-shi Onahama」）。合わなければ 1 語
    for (const s of src.tsunamiStations) {
      const city = cityPrefixOf(s.name, s.kana)
      const cityEn = city ? jmaEn.city.get(city.code) ?? cityEnFromKana(city.name, city.kana) : null
      const en = city && cityEn ? stationEnFromKana(s.name, s.kana, cityEn, city.kana) : tsunamiStationEnFromKana(s.kana)
      if (en) { romaji.tsunamiStation++; put(table.tsunamiStation, 'tsunamiStation', s.name, en) }
      else untranslated.tsunamiStation.push(s.name)
    }
  }

  const counts = Object.fromEntries(PLACE_NAME_KINDS.map((k) => [k, Object.keys(table[k]).length])) as Record<PlaceNameKind, number>
  const foreignChars: string[] = []
  for (const kind of PLACE_NAME_KINDS) {
    for (const [name, value] of Object.entries(table[kind])) {
      const hit = leftoverForeignChars(locale.id, value)
      if (hit) foreignChars.push(`${kind} ${name}→${value}（${hit}）`)
    }
  }
  return { table, report: { locale: locale.id, counts, romaji, untranslated, foreignChars } }
}

function readJson<T>(path: string): T {
  if (!existsSync(path)) throw new Error(`控えが無い: ${path}（取り方は .cache/jma-multi/README.md）`)
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch (err) {
    throw new Error(`控えを JSON として読めない: ${path}`, { cause: err })
  }
}

/** 控えの件数が少なすぎたら止める（取得の途中で切れた控えから、訳の欠けた表を書かないように） */
function atLeast<T>(items: T[] | undefined, min: number, what: string): T[] {
  if (!Array.isArray(items) || items.length < min) throw new Error(`控えの${what}が ${items?.length ?? 0} 件しかない（${min} 件以上のはず）。控えを取り直す`)
  return items
}

/** 日付つきの控え（`<接頭>-YYYY-MM-DD.json`）のうち一番新しいもの */
function latest(dir: string, prefix: string): string {
  const hit = existsSync(dir) ? readdirSync(dir).filter((f) => new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}\\.json$`).test(f)).sort() : []
  if (hit.length === 0) throw new Error(`控えが無い: ${join(dir, `${prefix}-*.json`)}`)
  return join(dir, hit[hit.length - 1])
}

export function readSources(): PlaceNameSources {
  const multi = cacheDir('jma-multi')
  const param = cacheDir('dmdata-parameter')
  const dict = (file: string, min: number): Dict => {
    const d = readJson<Dict>(join(multi, file))
    atLeast(Object.values(d ?? {}), min, `辞書 ${file} の項目`)
    return d
  }
  const enPairs = readJson<PlaceNameSources['enPairs']>(join(cacheDir('jma-bosai-en'), 'en-pairs.json'))
  // 下限は 2026-11-13 の控えの件数のおよそ 9 割（増える分には止めない）
  atLeast(enPairs?.area, ENPAIR_MIN.area, '報の英語名（細分区域）')
  atLeast(enPairs?.city, ENPAIR_MIN.city, '報の英語名（市町村）')
  atLeast(enPairs?.station, ENPAIR_MIN.station, '報の英語名（観測点）')
  return {
    epi: dict('dict-epi.json', 300),
    pref: dict('dict-pref.json', 47),
    city: dict('dict-city.json', 1700),
    tsunamiArea: dict('dict-areatsunami.json', 90),
    eqStations: atLeast(readJson<{ items: EqStation[] }>(latest(param, 'earthquake-station')).items, 4000, '震度観測点'),
    tsunamiStations: atLeast(readJson<{ items: TsunamiStation[] }>(latest(param, 'tsunami-station')).items, 400, '津波観測点'),
    enPairs,
  }
}
/** 報の英語名の控えの下限（2026-11-13 の控えは 細分区域 148・市町村 1,362・観測点 2,738 件） */
const ENPAIR_MIN = { area: 130, city: 1200, station: 2400 }

/** キーを並べて書く（差分を読みやすくする） */
function serialize(table: PlaceNameTable): string {
  const sorted = Object.fromEntries(PLACE_NAME_KINDS.map((k) => [k, Object.fromEntries(Object.entries(table[k]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))]))
  return `${JSON.stringify(sorted)}\n`
}

function main(): void {
  const src = readSources()
  // 全言語を作り終えて確かめてから書く（途中で止まったとき、一部の言語だけ新しい表が残らないように）
  const built = PLACE_NAME_LOCALES.map((locale) => {
    const { table, report } = buildPlaceNameTable(src, locale)
    checkUntranslated(report)
    return { locale, report, text: serialize(table) }
  })
  mkdirSync(OUT_DIR, { recursive: true })
  for (const { locale, report, text } of built) {
    writeFileSync(join(OUT_DIR, `${locale.id}.json`), text)
    const c = report.counts
    console.log(`${locale.id}: ${(Buffer.byteLength(text) / 1024).toFixed(1)} KB・震央 ${c.epi}・県 ${c.pref}・市町村 ${c.city}・津波予報区 ${c.tsunamiArea}・区域 ${c.area}（ローマ字 ${report.romaji.area}）・観測点 ${c.station}（ローマ字 ${report.romaji.station}）・津波観測点 ${c.tsunamiStation}`)
    for (const [kind, names] of Object.entries(report.untranslated)) {
      if (names.length) console.log(`  訳を作れず日本語のまま: ${kind} ${names.length} 件（${names.slice(0, 10).join('・')}${names.length > 10 ? '…' : ''}）`)
    }
  }
}

/** 直接実行のときだけ動かす（理由は `scripts/build-epicenter-accents.ts` の末尾） */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}
