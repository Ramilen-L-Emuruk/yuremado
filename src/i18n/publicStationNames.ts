import type { Locale } from './messages'
import PUBLIC_STATION_NAMES from '../data/publicStationNames.json'

/**
 * 公開観測点（気象庁の広帯域地震計）の名前の訳（地図の吹き出し・下の波形の見出し・地震カードの波形の見出しに出す）。
 * 表は `scripts/build-public-station-names.ts` が作る（20 件 × 日本語以外の 6 言語。作り方は
 * `docs/spec/data-sources-spec.md` §6「公開観測点の名前の訳」）。
 *
 * 日本語の画面と、表に無い名前（観測点の新設で増えた名前など）は、日本語の名前のまま返す。
 */
type PublicStationNameRow = Readonly<Partial<Record<Exclude<Locale, 'ja'>, string>>>
const TABLE: Readonly<Record<string, PublicStationNameRow>> = PUBLIC_STATION_NAMES

export function publicStationNameFor(locale: Locale, nameJa: string): string {
  if (locale === 'ja') return nameJa
  return TABLE[nameJa]?.[locale] ?? nameJa
}
