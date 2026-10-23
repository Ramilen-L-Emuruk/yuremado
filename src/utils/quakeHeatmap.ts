import type { JMAQuake } from '../types/earthquake'
import { extractQuakeEventIdFromId } from './quakeMerge'
import { hasKnownEpicenter } from './geo'
import { formatMagnitude, formatMagnitudeWithCondition } from './formatters'

/** ヒートマップに出す期間（日）。 */
export const HEATMAP_DAYS = 30

/**
 * 地震の時刻が「いま」から遡って `HEATMAP_DAYS` 日の中か。**「いま」より後は外す** —— リプレイ中、
 * 再生時刻より後に起きた地震を地図に出さないため。時刻が読めないものも外す。
 */
export function isWithinHeatWindow(timeIso: string, nowMs: number): boolean {
  const t = new Date(timeIso).getTime()
  return Number.isFinite(t) && t <= nowMs && t >= nowMs - HEATMAP_DAYS * 24 * 60 * 60 * 1000
}

export interface HeatPoint {
  lat: number
  lng: number
  weight: number
  /** 震源地名。DMDSS の GD Earthquake List が返さない場合は空文字。 */
  name: string
  /** 地震の時刻（ISO 文字列）。 */
  time: string
  /** 深さ(km)。不明・未取得は -1（formatDepth が「不明」に落とす）。 */
  depth: number
  /**
   * 深さが「700km以上」という下限だけの値か（`Hypocenter.depthAtLeast`）。吹き出しで「700km以上」と出す。
   * 土台の取得元（P2PQuake・DMDATA の GD Earthquake List）は持たないので常に偽。
   */
  depthAtLeast: boolean
  /**
   * マグニチュード。**不明は -1 に揃えて持つ**（`heatMagnitude` を通す）。DMDATA の電文は不明を
   * `NaN` で持つが、`NaN` は土台のキャッシュ（JSON）を通ると `null` に化け、読み戻した側の
   * `Number(null)` が 0 になって「M0.0」と出る。
   */
  magnitude: number
  /**
   * 規模が数値で求まらないときに気象庁が添えた説明（`Hypocenter.magnitudeCondition`）。無ければ `null`。
   *
   * **「M 不明」と「Ｍ８を超える巨大地震」を見分けるための欄。** どちらも `magnitude` は数値に
   * ならないので、これが無いと最大級の地震が最も薄い点になる。`undefined` ではなく `null` で
   * 持つのは、土台のキャッシュ（JSON）を通っても欄が消えないようにするため。
   * 土台の取得元（P2PQuake・DMDATA の GD Earthquake List）は説明を返さないので、常に `null`。
   */
  magnitudeCondition: string | null
}

/**
 * 「Ｍ８を超える巨大地震」を表す説明の原文（全角）。電文解説資料の値で、
 * `bufrEstimatedIntensity.ts` の `MAG_CONDITION_HUGE` と同じ文字列（一致はテストで確かめる）。
 * あちらは二進電文の復号器なので、ヒートマップから読み込むのを避けてここにも置く。
 */
const HUGE_MAGNITUDE_CONDITION = 'Ｍ８を超える巨大地震'

/** 規模の説明が「Ｍ８を超える巨大地震」か。 */
export function isHugeMagnitudeCondition(condition: string | null): boolean {
  return condition === HUGE_MAGNITUDE_CONDITION
}

/** ヒートマップの点に持たせるマグニチュード。数値にならない値は不明（-1）へ揃える。 */
export function heatMagnitude(magnitude: number): number {
  return Number.isFinite(magnitude) ? magnitude : -1
}

// 地震の同一性判定キー。DMDSS版の id には14桁の eventId が埋め込まれておりそれを使う
// （GD Earthquake List の eventId フィールドも同じ14桁形式のため突き合わせ可能）。
// 通常版（P2PQuake）の id はこの形式を持たないため地震の時刻にフォールバックするが、
// P2PQuake の地震の時刻は分単位のため震源名まで含めて「同じ分に起きた別の地震」を分ける
// （震源名を持たない震度速報は座標も無く、ヒートマップでは hasValidHypocenter で除外される）。
// 副作用: 震源を訂正した報は訂正前後で別キーになり、1 つの地震が 2 点残ることがある。
// ヒートマップは分布の統計表示なので、別々の地震が 1 点に潰れる方を避ける選択をしている
// （カード側の統合は `quakeMerge.sameQuakeEntry` が訂正報を正しく 1 イベントにまとめる）。
export function quakeIdentityKey(q: Pick<JMAQuake, 'id' | 'earthquake'>): string {
  const dmdataEventId = extractQuakeEventIdFromId(q.id)
  return dmdataEventId ?? `${q.earthquake.time}|${q.earthquake.hypocenter.name}`
}

/**
 * 震源が未確定（震度速報段階など）のプレースホルダー座標を判定する。
 *
 * **実体は `geo.ts` の `hasKnownEpicenter`。** 同じ判定を別実装で持つと、値域の扱いが
 * 片方だけ変わったときに黙ってずれる（この判定は地図・カード・読み上げ・ヒートマップに
 * またがっている）。名前だけこのモジュールの語彙で残してある。
 */
export const hasValidHypocenter = hasKnownEpicenter

/** 重みの下限。M1 以下と不明の点はこの濃さ。 */
const MIN_WEIGHT = 0.1

// マグニチュードをヒートマップの重みに変換する。
// 震度は震源からの距離に左右され月単位の集計には向かないため、地震そのものの規模を表す
// マグニチュードを重みに採用する（M1〜M8 を 0〜1 に正規化）。
// マグニチュードは対数尺度（+1で放出エネルギーが約31.6倍）なため単純な線形では
// 大地震のインパクトが実態より圧縮されすぎる。二乗して差を強調する。
//
// 数値にならない規模は説明で分ける（2026-10-19 ユーザー承認「巨大地震を言い分ける (推奨)」）。
// - 「Ｍ８を超える巨大地震」: M8 以上と同じ最大の重み。M8 を超えて速報できないという事実なので、
//   最も薄い点にすると最大級の地震ほど分布から消える。
// - それ以外（M 不明・説明なし）: 最小の重み（土台の取得元が不明を -1 で返したときと同じ値）。
// どちらも有限の値を返す。NaN を流すとヒートマップの重みが壊れる。
export function magnitudeToWeight(magnitude: number, condition: string | null): number {
  if (isHugeMagnitudeCondition(condition)) return 1
  if (!Number.isFinite(magnitude)) return MIN_WEIGHT
  const normalized = Math.min(1, Math.max(0, (magnitude - 1) / 7))
  return Math.max(MIN_WEIGHT, normalized ** 2)
}

/**
 * 吹き出しで同じ場所に重なった点のどれを出すかの順位（大きいほど優先）。
 * 巨大地震は数値を持たないので、比べられる値（実在する最大の M より大きい 10）へ置く。
 * 不明は -1 のまま最下位。`NaN` を渡すと比較がすべて偽になり、巨大地震が選ばれなくなる。
 */
export function heatMagnitudeRank(magnitude: number, condition: string | null): number {
  if (isHugeMagnitudeCondition(condition)) return 10
  return heatMagnitude(magnitude)
}

/**
 * 吹き出しに出す規模の札。巨大地震だけは気象庁の説明（「M8を超える巨大地震」）を出し、
 * それ以外の数値にならない規模は「不明」のまま（「Ｍ不明」の説明を持っていても「M不明」とは出さない）。
 */
export function heatMagnitudeLabel(magnitude: number, condition: string | null): string {
  // 長期震源カタログは電文の種別（`@type`）を持たないので、従来どおり `M` で出す。
  if (isHugeMagnitudeCondition(condition)) return formatMagnitudeWithCondition(magnitude, condition ?? undefined, undefined)
  return formatMagnitude(magnitude, undefined)
}

/** 吹き出しの札の色。巨大地震は M8 と同じ色（最上位の段）にする。 */
export function heatMagnitudeColorValue(magnitude: number, condition: string | null): number {
  return isHugeMagnitudeCondition(condition) ? 8 : magnitude
}
