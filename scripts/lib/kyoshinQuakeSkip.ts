/**
 * 平常のゆらぎの表を焼くとき、震源リストの地震の揺れが届いた秒を点ごとに外す（設計書§56）。
 *
 * 焼く日は「最大 M がいちばん小さい日」でも、小さな地震は毎日数百件起きている。その揺れの上がりを「普段」と数えると、
 * 地震の多い所（余震の続く所）の点ほど揺れの珍しさを低く見て、本物の小さな地震で点数が立たない。
 * 外すのは、揺れの届く範囲（{@link catalogReachKm}）の点で、発生 {@link QUAKE_SKIP_LEAD_SEC} 秒前から
 * 「震源距離 ÷ {@link QUAKE_SKIP_VS_KMPS} km/s ＋ {@link QUAKE_SKIP_TAIL_SEC} 秒」後まで。
 */
import { haversineKm } from '../../src/utils/geo'
import { catalogReachKm, type CatalogQuake } from './kyoshinCatalogMatch'

/** 発生の何秒前から外すか（震源リストの発生時刻の誤差の分） */
export const QUAKE_SKIP_LEAD_SEC = 5
/** 揺れが届くまでを見積もる速さ（km/s。S 波より遅めに置いて、届く前に外し終えないようにする） */
export const QUAKE_SKIP_VS_KMPS = 3
/** 届いてから外し続ける秒数 */
export const QUAKE_SKIP_TAIL_SEC = 20

/**
 * 点ごとに、外す区間を持っておき、時刻の順に {@link maskAt} で「いま外す点」の印を返す。
 * `frameOffsetMs` は震源の発生時刻（UTC のミリ秒）を秒フレームの ms へ直す差（控えの秒フレームは日本時間の時刻を UTC として数える）。
 */
export class QuakeSkipper {
  private readonly spans: [number, number][][]
  private readonly ptr: Int32Array
  private readonly mask: Uint8Array
  private lastMs = -Infinity

  constructor(sites: readonly (readonly [number, number])[], quakes: readonly CatalogQuake[], frameOffsetMs: number) {
    this.spans = sites.map(() => [])
    for (const q of quakes) {
      // 数でない時刻・位置の区間が 1 件でも入ると、その点の読み飛ばしが止まって以後の外しが黙って効かなくなる
      if (!Number.isFinite(q.t) || !Number.isFinite(q.lat) || !Number.isFinite(q.lng)) throw new Error(`震源の時刻か位置が数ではありません（${JSON.stringify(q)}）`)
      const reach = catalogReachKm(q.mag, q.depth)
      const t0 = q.t + frameOffsetMs
      sites.forEach(([lat, lng], i) => {
        const epi = haversineKm(q.lat, q.lng, lat, lng)
        if (epi > reach) return
        const km = Number.isFinite(q.depth) ? Math.hypot(epi, q.depth) : epi
        this.spans[i].push([t0 - QUAKE_SKIP_LEAD_SEC * 1000, t0 + (km / QUAKE_SKIP_VS_KMPS + QUAKE_SKIP_TAIL_SEC) * 1000])
      })
    }
    for (const s of this.spans) s.sort((a, b) => a[0] - b[0])
    this.ptr = new Int32Array(sites.length)
    this.mask = new Uint8Array(sites.length)
  }

  /** `ms`（秒フレームの時刻）に外す点の印（1 = 外す）。時刻は増える順に渡す。返す配列は次の呼び出しで書き換わる */
  maskAt(ms: number): Uint8Array {
    if (ms < this.lastMs) throw new Error(`時刻が巻き戻りました（${this.lastMs} → ${ms}）`)
    this.lastMs = ms
    for (let i = 0; i < this.spans.length; i++) {
      const s = this.spans[i]
      let p = this.ptr[i]
      // 始めの順に並べてあるので、終わった区間を先頭から読み飛ばす。終わりの順は前後するので、いま掛かる区間は始めが ms 以前のものを全部見る
      while (p < s.length && s[p][1] <= ms) p++
      this.ptr[i] = p
      let on = 0
      for (let k = p; k < s.length && s[k][0] <= ms; k++) if (s[k][1] > ms) { on = 1; break }
      this.mask[i] = on
    }
    return this.mask
  }
}
