// 地図の下端の公開観測点の段で、縦の範囲を観測点どうしで揃える帳面（2026-10-19 ユーザー選択「線形で始めて測る (Recommended)」。
// 問い「公開観測点の波形の縦幅をどうそろえますか？」）。
//
// **揃えるのは公開観測点どうしだけ。** 自作地震計は単位が加速度（gal）で、速度（μm/s）の公開観測点とは比べられない。
//
// 観測点ごとの段は別々の描画の輪で 0.3 秒ごとに組み直す。各段は組むたびに「自分だけで決めた縦の範囲」（下限と自分の
// 最大の大きいほう）を書き、描くときは全員の最大を使う。**他の段の値は前の組み直しのもの**なので、揃うまで最大 0.3 秒遅れる。
//
// 縦の範囲は 2 つ別々に揃える。3 成分の段（`signed`。中心から上下に振れる）と合成の段（`magnitude`。0 から上へ伸びる）は
// 物差しが違い、同じ揺れでも合成のほうが大きい。揃えた範囲は、対数に近い曲線で縦を圧縮して描く（`verticalMap.ts`）。

/** 1 つの観測点が自分だけで決めた縦の範囲（単位は観測点の種類の単位）。 */
export interface LaneScales {
  /** 3 成分の段の縦の範囲（±この値）。 */
  readonly signed: number
  /** 合成の段の縦の範囲（0〜この値）。 */
  readonly magnitude: number
  /**
   * 縦の下限（静かさから決めた値。`waveUnit.ts` の `minScale`）。全員の最大を、縦を圧縮する曲線の折れ目に使う
   * （`verticalMap.ts`）—— 静かなときの見え方を、圧縮する前とほぼ同じに保つため。
   */
  readonly floor: number
}

export class SharedLaneScales {
  private readonly bySource = new Map<string, LaneScales>()

  /** 観測点の値を書く。**描けなかった（窓が空）なら `null` を渡して外す** —— 古い値で他の段を縛らないため。 */
  publish(sourceId: string, scales: LaneScales | null): void {
    if (scales === null) this.bySource.delete(sourceId)
    else this.bySource.set(sourceId, scales)
  }

  /** 段が消えたら外す。 */
  remove(sourceId: string): void {
    this.bySource.delete(sourceId)
  }

  /**
   * 全員の最大。**揃える材料が 1 つも無ければ `null`**（その欄は 0）。
   * **数でない・正でない値は材料にしない** —— 1 つでも `Infinity` が混ざると、全員の線が平らになる。
   */
  shared(): LaneScales | null {
    let signed = 0
    let magnitude = 0
    let floor = 0
    for (const s of this.bySource.values()) {
      if (Number.isFinite(s.signed) && s.signed > signed) signed = s.signed
      if (Number.isFinite(s.magnitude) && s.magnitude > magnitude) magnitude = s.magnitude
      if (Number.isFinite(s.floor) && s.floor > floor) floor = s.floor
    }
    return signed === 0 && magnitude === 0 ? null : { signed, magnitude, floor }
  }
}
