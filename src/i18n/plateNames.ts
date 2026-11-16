import type { Locale } from './messages'
import PLATE_NAMES from '../data/plateNames.json'

/**
 * プレート名の訳（地図のプレート境界の吹き出しに出す）。表は `scripts/build-plate-names.mjs` が作る
 * （PB2002 の 52 プレート × 日本語以外の 6 言語。訳は各言語の Wikipedia の記事名と、記事の無い欄だけスクリプトで作った訳〈`MISSING`〉）。
 *
 * 日本語の画面と、表に無い名前（生成データの更新で増えた名前など）は、日本語の名前のまま返す。
 */
type PlateNameRow = Readonly<Partial<Record<Exclude<Locale, 'ja'>, string>>>
const TABLE: Readonly<Record<string, PlateNameRow>> = PLATE_NAMES

export function plateNameFor(locale: Locale, name: string): string {
  if (locale === 'ja') return name
  return TABLE[name]?.[locale] ?? name
}
