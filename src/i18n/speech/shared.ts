import type { Messages } from '../messages'
import type { QuakeRetractedReport, TsunamiGrade } from '../../types/earthquake'
import { intensityLabel, isValidIntensityScale } from '../../utils/intensity'
import { parseTsunamiHeight, type TsunamiHeightParts } from '../../utils/tsunami'

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

/**
 * 時刻の文字列（{@link clockTime} の形）が 1 時台か。ポルトガル語・スペイン語は 1 時だけ単数の冠詞を取る
 * （「às 12:40」に対して「à 1:40」、「a las 12:40」に対して「a la 1:40」。2026-11-17 ユーザー選択「この案で入れる (Recommended)」の 14-5）
 */
export function isOneOClock(time: string): boolean {
  return /^1:/.test(time)
}

/**
 * 地震情報の取消で、取り消された情報を名指すときの名前（画面の `quake.issueType` と、長周期は `quake.infoName.lpgm`）。
 * 読み上げの名前を画面の名前と言い分けない
 */
export function reportNameIn(m: Messages): Record<QuakeRetractedReport['issueType'], string> {
  return { ...m.quake.issueType, '長周期地震動に関する観測情報': m.quake.infoName.lpgm }
}

/** 英語の序数（1st・2nd・3rd・4th・11th・12th・13th・21st・22nd） */
export function englishOrdinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  switch (n % 10) {
    case 1: return `${n}st`
    case 2: return `${n}nd`
    case 3: return `${n}rd`
    default: return `${n}th`
  }
}

/** 漢数字の読みの終わりが持つ받침（数字の最後の桁ごと。0 は「영」、ほかは「일 이 삼 사 오 육 칠 팔 구」） */
const DIGIT_FINAL: Readonly<Record<string, { batchim: boolean; rieul: boolean }>> = {
  '0': { batchim: true, rieul: false },
  '1': { batchim: true, rieul: true },
  '2': { batchim: false, rieul: false },
  '3': { batchim: true, rieul: false },
  '4': { batchim: false, rieul: false },
  '5': { batchim: false, rieul: false },
  '6': { batchim: true, rieul: false },
  '7': { batchim: true, rieul: true },
  '8': { batchim: true, rieul: true },
  '9': { batchim: false, rieul: false },
}

/**
 * 語の終わりに받침（パッチム）があるか。助詞の形を選ぶのに使う。
 *
 * ハングルの音節なら字から読む。数字で終わるなら読みの終わりで決める —— 末尾が 0 の整数は「십・백・천・만」と
 * 位で終わる（どれも받침があり ㄹ ではない）、小数点の後や単独の 0 は「영」。ハングルでも数字でもない字（ラテン文字など）は
 * 받침が無いものとして扱う
 */
function finalSound(word: string): { batchim: boolean; rieul: boolean } {
  const s = word.replace(/[\s.,:;)）」』]+$/u, '')
  const last = s.slice(-1)
  if (!last) return { batchim: false, rieul: false }
  const code = last.charCodeAt(0)
  if (code >= 0xAC00 && code <= 0xD7A3) {
    const jong = (code - 0xAC00) % 28
    return { batchim: jong !== 0, rieul: jong === 8 }
  }
  if (/[0-9]/.test(last)) {
    if (last !== '0') return DIGIT_FINAL[last]
    // 末尾の 0 の前が 0 以外の数字なら位（십・백・천・만）で終わる。小数点の後・単独の 0 は「영」。どちらも받침がある
    return { batchim: true, rieul: false }
  }
  return { batchim: false, rieul: false }
}

/**
 * 韓国語の助詞を、直前の語の終わりで選んで付ける（2026-11-17 ユーザー選択「この案で入れる (Recommended)」の
 * 「韓国語の助詞は関数の中で選ぶ」）。`으로/로` は받침が ㄹ のときも「로」
 */
export function withKoreanParticle(word: string, particle: KoreanParticle): string {
  return `${word}${koreanParticle(word, particle)}`
}

type KoreanParticle = '을/를' | '은/는' | '이/가' | '으로/로'

/** {@link withKoreanParticle} の助詞だけ（語と助詞を別の断片に置くとき） */
export function koreanParticle(word: string, particle: KoreanParticle): string {
  const { batchim, rieul } = finalSound(word)
  switch (particle) {
    case '을/를': return batchim ? '을' : '를'
    case '은/는': return batchim ? '은' : '는'
    case '이/가': return batchim ? '이' : '가'
    case '으로/로': return batchim && !rieul ? '으로' : '로'
  }
}

/** 規模の小数点をコンマにする（ポルトガル語・スペイン語。「6.5」→「6,5」） */
export function decimalComma(value: string): string {
  return value.replace('.', ',')
}

/**
 * 津波の等級の呼び名（画面の `tsunami.grade`）。**不明は名前を言わない**（日本語の読み上げと同じ。画面の「Unknown」は読まない）。
 * 日本語の画面の辞書を引く `TSUNAMI_GRADE_NAME` は借りない（借りると日本語の名前が出る）
 */
export function tsunamiGradeNamesIn(m: Messages): Record<TsunamiGrade, string> {
  return { ...m.tsunami.grade, Unknown: '' }
}

/**
 * 等級ごとの避難の呼びかけ（画面の `tsunami.evacuationByGrade`。2026-11-10 ユーザー選択「等級ごとの訳文を出す (Recommended)」の
 * 画面の文と同じ）。`sep` は文の後ろに置く区切り（語を空白で分ける言語は空白）。不明・型の外の等級は空
 */
export function tsunamiEvacuationIn(m: Messages, sep: string): (grade: TsunamiGrade) => string {
  const table: Readonly<Record<string, string>> = m.tsunami.evacuationByGrade
  return (grade) => (Object.prototype.hasOwnProperty.call(table, grade) ? `${table[grade]}${sep}` : '')
}

/**
 * 語表の `heightToSpeech`。数の表記は `say` で言語の言い方へ組み、**この形でない表記は電文の語のまま返す**（「巨大」「高い」は
 * 語表の `nonNumericHeight` が引く。知らない表記は読み上げの関数の組が記録を残す）
 */
export function tsunamiHeightIn(say: (h: TsunamiHeightParts) => string): (description: string) => string {
  return (description) => {
    const h = parseTsunamiHeight(description)
    return h ? say(h) : description
  }
}

/**
 * 語表の `firstWaveKind`。電文の押し引き（`Initial` の「押し」「引き」）を訳し、無いとき・知らない語のときは「第一波」の訳
 * （知らない語は読み上げの関数の組が記録を残す）
 */
export function firstWaveKindIn(rise: string, drop: string, wave: string): (initial: string | undefined) => string {
  return (initial) => (initial === '押し' ? rise : initial === '引き' ? drop : wave)
}

/**
 * 観測した波高に「以上」を補う（上限を定めない値。付け方は日本語の画面の `tsunami.height` と同じ）。補う語は電文の表記の「以上」で、
 * 訳すのは語表の `heightToSpeech`（{@link parseTsunamiHeight} が読む）
 */
export function markHeightOrMore(description: string, over: boolean): string {
  return !over || description.includes('以上') || !/[\d０-９]/.test(description) ? description : `${description}以上`
}
