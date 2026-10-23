import type { EEWAccuracy } from '../types/earthquake'

/**
 * 緊急地震速報の震源要素の精度ランクの表（電文解説資料 Ⅱ.21 1-4-2）。
 *
 * 表示（`utils/eew.ts` の `eewEpicenterRankLabel` ほか）と読み取り（`services/dmdataParser.ts` の `parseEEWAccuracy`）が
 * 同じ表を見る。読み取りは表に無いランクを記録するので、表を 2 か所に書き写すと片方だけ古くなる。
 */

/** 震央位置・深さの精度ランク（`Epicenter@rank` / `Depth@rank`）。解説資料 Ⅱ.21 1-4-2-1。 */
export const EPICENTER_RANK_LABEL: Readonly<Record<number, string>> = {
  1: 'P波／S波レベル超え、IPF法（1点）、または仮定震源要素',
  2: 'IPF法（2点）',
  3: 'IPF法（3点／4点）',
  4: 'IPF法（5点以上）',
  5: '防災科研システム（4点以下、または精度情報なし）',
  6: '防災科研システム（5点以上）',
  // **「海域」「内陸」だけにしないこと。** 解説資料は「EPOS（海域〔観測網外〕）」
  // 「EPOS（内陸〔観測網内〕）」と書いており、括弧書きが**観測網の外か内か**を言っている。
  // 落とすと、その区別が画面から消える（「海域」だけでは何と対比しているのか分からない）。
  7: 'EPOS（海域〔観測網外〕）',
  8: 'EPOS（内陸〔観測網内〕）',
}

/** マグニチュードの精度ランク（`MagnitudeCalculation@rank`）。解説資料 Ⅱ.21 1-4-2-3。 */
export const MAGNITUDE_RANK_LABEL: Readonly<Record<number, string>> = {
  2: '防災科研システム',
  3: '全点P相',
  4: 'P相／全相混在',
  5: '全点全相',
  6: 'EPOS',
  8: 'P波／S波レベル超え、または仮定震源要素',
}

/**
 * 表に無い精度ランク（0＝不明は除く）を「欄=値」の形で挙げる。**画面には出さない**（意味の分からない値は欄を空にする。
 * → `eewEpicenterRankLabel`）。読み取りが開発者向けの記録を残すためだけに使う（2026-10-21 ユーザー承認
 * 「記録し、表外はログへ (Recommended)」）。
 */
export function unknownEewAccuracyRanks(accuracy: EEWAccuracy): string[] {
  const out: string[] = []
  const check = (field: string, rank: number | undefined, table: Readonly<Record<number, string>>) => {
    if (rank !== undefined && rank !== 0 && table[rank] === undefined) out.push(`${field}=${rank}`)
  }
  check('Epicenter@rank', accuracy.epicenterRank, EPICENTER_RANK_LABEL)
  check('Depth@rank', accuracy.depthRank, EPICENTER_RANK_LABEL)
  check('MagnitudeCalculation@rank', accuracy.magnitudeRank, MAGNITUDE_RANK_LABEL)
  return out
}
