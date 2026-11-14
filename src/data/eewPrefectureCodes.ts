import { PREFECTURES } from './prefectureCodes'
import type { PlaceNameLookup } from '../i18n/placeNames'

/**
 * 緊急地震速報の府県予報区（`EEWRegion.pref`）→ 都道府県のコード。設定「通知する地域」で緊急地震速報の通知を絞るのに使う。
 *
 * 府県予報区は都道府県名ではなく「熊本」のように「県」が付かない名前で、北海道は 4 つ（道央・道南・道北・道東）、
 * 東京は「東京」と「伊豆諸島」「小笠原」、鹿児島は「鹿児島」と「奄美」、沖縄は 4 つ（沖縄本島・大東島・宮古島・八重山）に分かれる。
 * 電文の府県予報区の符号（`Pref/Code`。例 9011・9461）は「(符号 − 9000) ÷ 10 の整数部」が都道府県のコードに当たる
 * （緊急地震速報の控えの全期間〔警報 69 日・予報 1,552 日分〕にあった 56 種すべてで確かめた）。
 */
const SPLIT: Readonly<Record<string, string>> = {
  北海道道央: '01', 北海道道南: '01', 北海道道北: '01', 北海道道東: '01',
  伊豆諸島: '13', 小笠原: '13',
  奄美: '46',
  沖縄本島: '47', 大東島: '47', 宮古島: '47', 八重山: '47',
}

export const EEW_PREFECTURE_CODES: ReadonlyMap<string, string> = new Map([
  // 「県」「府」「都」を外した名前（北海道と沖縄は分かれた名前だけが使われるので、外した名前は作らない）
  ...PREFECTURES
    .filter(p => p.code !== '01' && p.code !== '47')
    .map(p => [p.name.replace(/[都府県]$/, ''), p.code] as const),
  ...Object.entries(SPLIT),
])

/**
 * 緊急地震速報の府県予報区の名前を、出す言語の名前にする。都道府県と同じ範囲の府県予報区（「熊本」）は
 * 都道府県の訳（「熊本県」の訳）で出し、都道府県を分けた府県予報区（北海道の 4 つ・伊豆諸島・小笠原・奄美・沖縄の 4 つ）と
 * 表に無い名前は電文の名前のまま出す（訳の表に無い地名は日本語のまま。i18n-spec §5「地名の訳」）。
 * 日本語の画面では電文の名前のまま（「熊本」を「熊本県」に書き換えない）
 */
export function eewPrefDisplayName(pref: string, place: PlaceNameLookup): string {
  if (pref in SPLIT) return pref
  const code = EEW_PREFECTURE_CODES.get(pref)
  const full = code ? PREFECTURES.find(p => p.code === code)?.name : undefined
  if (!full) return pref
  const translated = place('pref', full)
  return translated === full ? pref : translated
}
