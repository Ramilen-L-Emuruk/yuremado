// 公開観測点の段（地図の下端・地震カード）で、縦の範囲を観測点どうしで揃える帳面（地図の下端は 2026-10-19 ユーザー選択「線形で始めて測る (Recommended)」。
// 問い「公開観測点の波形の縦幅をどうそろえますか？」）。
//
// **揃えるのは公開観測点どうしだけ。** 自作地震計は単位が加速度（gal）で、速度（μm/s）の公開観測点とは比べられない。
//
// 観測点ごとの段は別々の描画の輪で 0.3 秒ごとに組み直す。各段は組むたびに「自分だけで決めた縦の範囲」（下限と自分の
// 最大の大きいほう）を書き、描くときは全員の最大を使う。**他の段の値は前の組み直しのもの**なので、揃うまで最大 0.3 秒遅れる。
//
// 縦の範囲は 2 つ別々に揃える。3 成分の段（`signed`。中心から上下に振れる）と合成の段（`magnitude`。0 から上へ伸びる）は
// 物差しが違い、同じ揺れでも合成のほうが大きい。揃えた範囲は、対数に近い曲線で縦を圧縮して描く（`verticalMap.ts`）。
//
// **地震カードでも使う**（カードごとに 1 冊。揃える範囲はそのカードの公開観測点の段どうし）。カードの段は列が変わったときしか
// 描き直さないので、他の段の値が変わったことを購読（`subscribe`）で受けて描き直す。

import { compressedVertical, LINEAR_VERTICAL, type VerticalMap } from './verticalMap'

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
  private readonly listeners = new Set<() => void>()
  private revision = 0

  /** 観測点の値を書く。**描けなかった（窓が空）なら `null` を渡して外す** —— 古い値で他の段を縛らないため。 */
  publish(sourceId: string, scales: LaneScales | null): void {
    const prev = this.bySource.get(sourceId)
    if (scales === null) {
      if (prev === undefined) return
      this.bySource.delete(sourceId)
    } else {
      if (prev !== undefined && sameLaneScales(prev, scales)) return
      this.bySource.set(sourceId, scales)
    }
    this.changed()
  }

  /** 段が消えたら外す。 */
  remove(sourceId: string): void {
    if (this.bySource.delete(sourceId)) this.changed()
  }

  /**
   * 書かれた値が変わったら呼ぶ（`useSyncExternalStore` の購読の形）。**値が同じなら呼ばない** ——
   * 地震カードの段は、他の段の値が変わったときだけ描き直す。各段が書くのは揃える前の自分の値なので、描き直して
   * 書き直しても値は変わらず、知らせが循環しない。
   * 地図の下端の段は 0.3 秒ごとに組み直すので購読しない。
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 書かれた値が変わるたびに 1 つ進む番号（`useSyncExternalStore` の読み取り）。 */
  version(): number {
    return this.revision
  }

  private changed(): void {
    this.revision += 1
    for (const listener of this.listeners) listener()
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

function sameLaneScales(a: LaneScales, b: LaneScales): boolean {
  return Object.is(a.signed, b.signed) && Object.is(a.magnitude, b.magnitude) && Object.is(a.floor, b.floor)
}

/** 揃える段の描き方（{@link sharedPaint}）。 */
export interface SharedPaint {
  /** 3 成分の列の縦の範囲を、揃えた範囲まで広げる（狭めはしない）。 */
  widen<T extends { readonly scaleGal: number }>(built: T): T
  /** 合成の段の縦の下限（自分の下限と、揃えた合成の範囲の大きいほう）。 */
  readonly compositeMinScale: number
  /** 値を縦の位置へ写す関数。揃える段は曲線、揃えない段は線形。 */
  readonly vertical: VerticalMap
}

/**
 * 揃える段をどう描くかを決める。**地図の下端の段と地震カードの段で同じ決め方をする**（片方だけ直すと、同じ揺れが
 * 場所によって違う高さに見える）。
 *
 * @param minScale その段の縦の下限（静かさから決めた値）
 * @param sharing 揃えるなら相手の範囲（まだ誰も書いていなければ `shared` が `null`）。**揃えない段は `null`**。
 *   揃える段は相手がまだいなくても曲線で描く —— 最初の 1 回だけ線形になると、揃った瞬間に絵が跳ねる。
 */
export function sharedPaint(minScale: number, sharing: { readonly shared: LaneScales | null } | null): SharedPaint {
  const shared = sharing?.shared ?? null
  return {
    widen: (built) => (shared === null || !(shared.signed > built.scaleGal) ? built : { ...built, scaleGal: shared.signed }),
    compositeMinScale: shared === null ? minScale : Math.max(minScale, shared.magnitude),
    // 折れ目は全員の下限の最大（相手がまだいなければ自分の下限）。全段で同じ曲線にしないと、同じ値が段によって違う高さになる。
    vertical: sharing === null ? LINEAR_VERTICAL : compressedVertical(Math.max(minScale, shared?.floor ?? 0)),
  }
}
