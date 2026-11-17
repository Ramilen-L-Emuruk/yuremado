import type { Messages } from '../messages'
import { intensityLabel, isValidIntensityScale } from '../../utils/intensity'

/**
 * 日本語以外の語表が画面の辞書から引く語。**読み上げの訳は画面の訳と同じ語にする**（2026-11-17 ユーザー選択
 * 「この案で入れる (Recommended)」の表。情報の名前・震度・地方名を画面と言い分けない）。
 */

/** 震度の呼び方（画面の `formats.intensity`。「5 Lower」「5弱」など） */
export function intensityIn(m: Messages): (scale: number) => string {
  return (scale) => intensityLabel(scale, m.formats)
}

/**
 * 「程度以上」を付けるか。画面の `intensityLabelWithApproxAbove` と同じ条件（読める震度で 0 より大きいときだけ）。
 * 付けるときの語順は言語ごとに違うので、付け方は呼び出し側の関数が持つ
 */
export function showsApproxAbove(scale: number, orAbove: boolean): boolean {
  return orAbove && isValidIntensityScale(scale) && scale > 0
}

/**
 * 緊急地震速報の警報の対象地方の名前（画面の地図の地方名 `map.regionName`。地方予報区の 14 地方すべてに訳がある）。
 * 表に無い名前（気象庁が地方を増やしたとき）は電文の名前のまま
 */
export function regionNameIn(m: Messages): (name: string) => string {
  const table: Readonly<Record<string, string>> = m.map.regionName
  return (name) => table[name] ?? name
}

/** 「12:40」（英語・ポルトガル語・スペイン語の時刻） */
export function clockTime(hour: number, minute: number): string {
  return `${hour}:${String(minute).padStart(2, '0')}`
}
