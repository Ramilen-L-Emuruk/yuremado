import type { Locale } from './messages'

/**
 * 地名の訳。種類ごとに「電文の日本語の名前 → 訳」を持つ（生成は `scripts/build-place-names.ts`、
 * 置き場所は `public/data/place-names/<言語>.json`）。
 *
 * **このファイルは引き方だけを持ち、取得の部品を読まない。** 中継がプッシュ通知の文を組むためにこのファイルを写す
 * （中継は表を束に入れて持つ）。ブラウザで表を取りに行く部分は `placeNameLoader.ts`。
 *
 * 訳すのは画面・吹き出し・通知に出す直前だけ。座標・塗り・並び・通知の地域の絞り・読み上げには、
 * 日本語の名前をそのまま使う（表を引けなくても、出し方が変わるだけで中身は変わらない）。
 */
export type PlaceNameKind =
  /** 震央地名 */
  | 'epi'
  /** 都道府県 */
  | 'pref'
  /** 市町村 */
  | 'city'
  /** 津波予報区 */
  | 'tsunamiArea'
  /** 地震情報の細分区域 */
  | 'area'
  /** 震度観測点（＊ の無い名前） */
  | 'station'
  /** 津波観測点 */
  | 'tsunamiStation'

export const PLACE_NAME_KINDS: readonly PlaceNameKind[] = ['epi', 'pref', 'city', 'tsunamiArea', 'area', 'station', 'tsunamiStation']

export type PlaceNameTable = Readonly<Record<PlaceNameKind, Readonly<Record<string, string>>>>

/** 種類と日本語の名前から、出す名前を返す。訳が無ければ日本語の名前をそのまま返す */
export type PlaceNameLookup = (kind: PlaceNameKind, name: string) => string

/** 日本語の画面と、表をまだ引けていないときの引き方（名前をそのまま返す） */
export const JA_PLACE_NAMES: PlaceNameLookup = (_kind, name) => name

/** 表から引き方を作る */
export function placeNameLookup(table: PlaceNameTable): PlaceNameLookup {
  return (kind, name) => table[kind][name] ?? name
}

/**
 * 地図の県名・区域名のラベルを訳す言語。地図の字は事前に焼いたグリフ（`scripts/build-glyphs.mjs`）で
 * 描くので、焼き元のフォントに字のある言語だけを訳す（2026-11-13 ユーザー選択「英葡西だけ訳す (Recommended)」。
 * 中国語・韓国語は訳に使う字がフォントに無く、日本語のまま出す）。
 *
 * **`build-glyphs.mjs` がこの一覧をソースから読み、ここに並べた言語の訳の字を焼く。** 書き方（1 行の配列）を変えると読めなくなる。
 */
export const MAP_LABEL_LOCALES: readonly Locale[] = ['en', 'pt-BR', 'es']

/** 地図のラベルに使う引き方。訳さない言語では日本語の名前をそのまま返す */
export function mapLabelPlaceNames(locale: Locale, place: PlaceNameLookup): PlaceNameLookup {
  return MAP_LABEL_LOCALES.includes(locale) ? place : JA_PLACE_NAMES
}

/** 表の形を確かめる（200 でも空・別物なら失敗にして、日本語の名前のまま出す） */
export function validatePlaceNameTable(data: unknown): asserts data is PlaceNameTable {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) throw new Error('地名の表が JSON オブジェクトではありません')
  const table = data as Record<string, unknown>
  for (const kind of PLACE_NAME_KINDS) {
    const part = table[kind]
    if (part == null || typeof part !== 'object' || Array.isArray(part)) throw new Error(`地名の表に種類「${kind}」がありません`)
    if (Object.values(part as Record<string, unknown>).some((v) => typeof v !== 'string')) throw new Error(`地名の表の種類「${kind}」に文字列でない値があります`)
  }
  if (Object.keys(table.epi as object).length === 0) throw new Error('地名の表の震央地名が空です')
}
