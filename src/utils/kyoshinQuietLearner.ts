/**
 * 平常のゆらぎの表を、端末に届いた強震モニタの秒フレームから学び直す係。
 *
 * 配る表（`public/data/kyoshin-quiet-tables.json`）は焼いた日のゆらぎしか知らない。観測点ごとのゆらぎは年単位で変わり
 * （2021〜2022 年の日と 2026 年の日で点ごとの率が中央 1.8〜2.0 倍ずれた）、観測点の入れ替えで表に載らない点も出る。
 * そこで、ライブで受け取った秒フレームを端末で数え足し、配る表に混ぜた表を検知器へ渡し直す。新しく取りに行く通信は無い。
 *
 * - **揺れ検知が出ている秒とその前後 `guardMs` は数えない。** 地震の揺れを「普段のゆらぎ」と覚えると、次の同じ強さの揺れを
 *   拾えなくなる。後ろ側も外すため、フレームは `guardMs` だけ遅らせてから数える
 * - 数えない秒も、上がりを測る直前の値としては表を数える部品へ渡す（飛ばすと途切れとして測り直しになる）
 * - **日本時間の 0〜23 時のどの時間帯でも `minHourSec` 秒を数え終えるまでは、混ぜた表を渡さない**（検知器は配る表のまま）。
 *   ゆらぎは昼と夜とで点ごとに 2.3〜2.9 倍違い、夜の 6 時間だけ学んだ表では、どの地震とも合わない早い段が配る表より
 *   増えた（test の組の地元の窓で 66 → 120。1 日ぶん学ぶと 9）。一度渡した後に薄まって下限を割ったら、配る表へ戻す
 *   （2026-10-28 ユーザー選択「1日の全時間帯を数えてから」）
 * - データの時刻で `rebuildEveryMs` ごとに、古い数を半減期 `halfLifeMs` で薄め、数と時間帯ごとの秒を `onSave` へ渡す
 *   （端末に残し、次に開いたときに `initial` で戻すため）。効かせてよいときは配る表と混ぜた表を `onTables` へ渡す
 * - 配る表は 1 点あたり `priorSec` 秒ぶんの重みで頭打ちにして混ぜる（`blendQuietTables`）
 */
import { blendQuietTables, isQuietCounts, QuietTableBaker, type QuietCounts, type QuietTables } from './kyoshinQuietTables'

/** 端末に残す学び直しの状態 */
export interface QuietLearnerState {
  counts: QuietCounts
  /** 日本時間の 0〜23 時それぞれで数えた秒（薄めた後の値） */
  hourSec: number[]
}

export interface QuietLearnerOptions {
  /** 配る表 */
  prior: QuietTables
  /** 端末に残しておいた状態。初めてなら null */
  initial: QuietLearnerState | null
  /** 配る表の 1 点あたりの重み（秒） */
  priorSec: number
  /** 古い数が半分の重みになるまでの時間（ミリ秒・データの時刻で測る） */
  halfLifeMs: number
  /** 揺れ検知の前後で数えない幅（ミリ秒） */
  guardMs: number
  /** 混ぜた表を作り直す間隔（ミリ秒・データの時刻で測る） */
  rebuildEveryMs: number
  /** 混ぜた表を渡し始めるのに、どの時間帯でも数え終えていなければならない秒 */
  minHourSec: number
  /** 検知器へ使わせる表を渡す（混ぜた表か、下限を割ったときは配る表そのもの） */
  onTables: (tables: QuietTables) => void
  /** 状態を渡す（端末に残す） */
  onSave: (state: QuietLearnerState) => void
}

export interface QuietLearner {
  /** 1 秒ぶんを入れる。`detecting` はこの秒に揺れ検知が出ているか */
  push(ms: number, cfg: string, sites: readonly (readonly [number, number])[], values: ArrayLike<number>, detecting: boolean): void
  /** 時間軸が変わった。遅らせていた分は捨てる（数えた分は残す） */
  reset(): void
  /** いま持っている数の写し */
  counts(): QuietCounts
}

interface Pending {
  ms: number
  cfg: string
  sites: readonly (readonly [number, number])[]
  values: Int8Array
}

/**
 * アプリで使う値。半減期と配る表の重みは、2022 年の表から 2026-09-11 を 1 日学ばせた評価台の結果で決めた
 * （test の組で、どの地震とも合わない早い段が地元の窓 66 → 9・2026-09-11 だけで焼いた表は 6）。
 * 時間帯ごとの下限 30 分は評価台で測っていない（夜の 6 時間だけでは悪化し、1 日ぶんで戻ることだけを確かめた）。
 */
export const QUIET_LEARNER_DEFAULTS = {
  priorSec: 86_400,
  halfLifeMs: 7 * 86_400_000,
  guardMs: 60_000,
  rebuildEveryMs: 3_600_000,
  minHourSec: 1_800,
} as const

/** 端末の保存領域から読み戻した値を確かめる。形が崩れていれば null（使わずに数え直す） */
export function parseQuietLearnerState(raw: unknown): QuietLearnerState | null {
  const s = raw as QuietLearnerState | null
  if (!s || typeof s !== 'object' || !isQuietCounts(s.counts)) return null
  if (!Array.isArray(s.hourSec) || s.hourSec.length !== 24) return null
  if (!s.hourSec.every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0)) return null
  return { counts: s.counts, hourSec: s.hourSec }
}

const JST_OFFSET_MS = 9 * 3_600_000
const hourOfJst = (ms: number) => Math.floor((ms + JST_OFFSET_MS) / 3_600_000) % 24

export function createQuietLearner(o: QuietLearnerOptions): QuietLearner {
  const baker = o.initial ? QuietTableBaker.fromCounts(o.initial.counts) : new QuietTableBaker()
  const hourSec = o.initial ? [...o.initial.hourSec] : new Array<number>(24).fill(0)
  if (hourSec.length !== 24) throw new Error(`時間帯ごとの秒が 24 個ではありません（${hourSec.length} 個）`)
  const queue: Pending[] = []
  let lastDetectMs = -Infinity
  /** 最後に表を作り直したデータの時刻。null はまだ 1 秒も数えていない */
  let lastRebuildMs: number | null = null
  /** いま検知器へ混ぜた表を渡しているか（下限を割ったとき配る表へ戻すため） */
  let blended = false

  /** 効かせてよければ混ぜた表を、下限を割ったら配る表を渡す */
  const publish = (counts: QuietCounts) => {
    if (hourSec.every(s => s >= o.minHourSec)) {
      o.onTables(blendQuietTables(o.prior, counts, o.priorSec))
      blended = true
    } else if (blended) {
      o.onTables(o.prior)
      blended = false
    }
  }

  const rebuild = (ms: number) => {
    if (lastRebuildMs === null) { lastRebuildMs = ms; return }
    if (ms - lastRebuildMs < o.rebuildEveryMs) return
    const factor = 0.5 ** ((ms - lastRebuildMs) / o.halfLifeMs)
    baker.decay(factor)
    for (let h = 0; h < 24; h++) hourSec[h] *= factor
    lastRebuildMs = ms
    const counts = baker.counts()
    o.onSave({ counts, hourSec: [...hourSec] })
    publish(counts)
  }

  // 残した状態で既に効かせてよいなら、始めた時点で渡す（でないと開くたびに最初の 1 時間は配る表のまま動く）
  if (o.initial) publish(baker.counts())

  return {
    push(ms, cfg, sites, values, detecting) {
      if (detecting) lastDetectMs = ms
      queue.push({ ms, cfg, sites, values: Int8Array.from(values) })
      while (queue.length > 0 && queue[0].ms <= ms - o.guardMs) {
        const f = queue.shift() as Pending
        // この秒の前後 guardMs に検知が出ていれば数えない（後ろ側は、いまの秒までに出た検知で分かる）
        const count = lastDetectMs < f.ms - o.guardMs
        baker.feed(f.ms, f.cfg, f.sites, f.values, count)
        if (count) hourSec[hourOfJst(f.ms)]++
        rebuild(f.ms)
      }
    },
    reset() {
      queue.length = 0
      lastDetectMs = -Infinity
      lastRebuildMs = null
    },
    counts: () => baker.counts(),
  }
}
