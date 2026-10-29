// 同じ場所の 2 つ目の地震を見分ける（設計書§40）。**判定は検知エンジンの出力を読むだけ**で、
// 検知そのものには関与しない。
//
// 【なぜ要るか】確定している検知の内側（同じイベント・別地点として鳴った地域の内側）で次の地震が
// 起きても、検知エンジンは同じイベントへまとめ（併合）、別地点の発報も一度鳴った地域では鳴らない。
// 段が上がらなければ更新音も鳴らないので、本震の揺れが続く中の余震は音もタブ移動も無かった
// （2026-10-22 ユーザー選択「2 つ目も鳴らすよう設計する」）。
//
// 【何を見るか】確定しているイベントのメンバーで、`REONSET_QUIET_MS` の間 新しい立ち上がりが無かった
// あと、`REONSET_BURST_MS` の内に `REONSET_MIN_POINTS` 点以上が新しく立ち上がったら「2 つ目」とみなす。
// 鳴らしたら同じイベントでは `REONSET_QUIET_MS` 鳴らさない。イベントが現れてから `REONSET_QUIET_MS` も
// 鳴らさない（1 つ目の地震の立ち上がりそのもの）。
//
// 【値の根拠】余震の多い 3 窓（福島県沖 2022・トカラ列島 2025・能登 2024。計 1.5 時間）で、確定が続く
// 最中に来た M3.5 以上 162 件のうち、今の音が鳴らない 81 件の 6 件を拾い、発火 6 回のうち二度鳴りは 3 回。
// 普段の 795 窓では発火 2 回（地震に結び付く 1・二度鳴り 1）。静けさを 30 秒にすると拾う数は 9 件へ
// 増えるが、普段の窓で二度鳴りが 8 回へ増える（2026-10-24 計測・ユーザー選択「60 秒静か・3 点 (Recommended)」）。
//
// 【新しい束】組み合わせの検知器は、同じ場所の 2 つ目の揺れを別の束として出すことがある。その束は
// 現れたばかりなので上の見分け方（現れてから 60 秒は鳴らさない）では鳴らず、別地点の発報も一度鳴った
// 地域の内側では鳴らない。そこで、近く（`REONSET_NEARBY_KM` の内）の確かな束が `REONSET_QUIET_MS` 以上
// 続いている最中に、別の束が確かな段になったら、それも「2 つ目」とみなす。余震の多い 3 窓で、最中に新しい
// 束が確かな段になった 11 回のうち 7 回は音が無く、能登の 5 回は M3.9〜M5.0 の余震だった
// （2026-10-29 計測・ユーザー選択「新しい束でも鳴らす (Recommended)」）。
//
// 【同じ地震の波は外す】先の束の揺れ始めから新しい束の揺れ始めまでの間に、地震の波が先の束の位置から
// 届く距離（見かけの速さが `REONSET_WAVE_KMPS_MIN`〜`REONSET_WAVE_KMPS_MAX`）なら、それは同じ地震の揺れが
// 遠くへ届いただけとみなして鳴らさない（2026-10-29 ユーザー選択「同じ地震の波を速さで外す」）。
// 評価台の窓すべてと余震の多い 3 窓で、2 つ目の合図は 31 回から 18 回に減った（2026-10-29 計測）。外れた 13 回は
// 見かけの速さが 2.5〜4.7 km/s で、うち 12 回は新しい束の揺れ始めの前後（30 秒前〜10 秒後）に 150 km 以内の
// 気象庁の震源が無かった。1 回（2026-08-14 17:31・M3.1）は本物の別の地震だった見込みがあるが、3.0 km/s で外れた。
// 残った本物（福島県沖 2022 の本震・能登 2024 の余震）は 0.2〜1.5 km/s だった。

import type { EnsembleDetection } from './kyoshinEnsembleTracker'
import { haversineKm } from './geo'

/** 新しい立ち上がりが無かった時間がこれ以上続いてから、まとまった立ち上がりを「2 つ目」とみなす（ms） */
export const REONSET_QUIET_MS = 60_000
/** 立ち上がりを 1 つのまとまりとして数える幅（ms） */
export const REONSET_BURST_MS = 3_000
/** 「2 つ目」とみなす、まとまった新しい立ち上がりの点数 */
export const REONSET_MIN_POINTS = 3
/**
 * 新しい束を「同じ場所の 2 つ目」とみなす、続いている確かな束との距離（km。束の位置どうし）。
 * 別地点の発報が同じ地震とみなす距離（`useKyoshinAlerts` の `REGION_MATCH_KM`）と同じ値にした。これより
 * 離れた束は別地点の発報が受け持つ
 */
export const REONSET_NEARBY_KM = 300
/** 先の束から新しい束までの見かけの速さ（km/s）がこの範囲なら、同じ地震の波が届いただけとみなす */
export const REONSET_WAVE_KMPS_MIN = 2.5
export const REONSET_WAVE_KMPS_MAX = 5

interface PerEvent {
  /** イベントを初めて見たデータ時刻 */
  firstSeenMs: number
  /** 確かな段で初めて見たデータ時刻（まだなら null） */
  confirmedSinceMs: number | null
  /** メンバーが最後に新しく立ち上がったデータ時刻（無ければ firstSeenMs） */
  lastOnsetMs: number
  /** 静けさを挟んだあとの立ち上がり（データ時刻と観測点キー） */
  burst: { ms: number; key: string }[]
  /** 最後に鳴らしたデータ時刻 */
  lastFireMs: number
}

/** `stepReonset` が持ち越す状態（呼び出し側が ref で保持する）。 */
export interface ReonsetState {
  byId: Map<string, PerEvent>
  /** 前のフレームで「直近に立ち上がった」観測点 */
  prevRecent: Set<string>
  /** 直近に処理したデータ時刻（巻き戻りの検出と、同じフレームの二度渡しの判定に使う） */
  lastMs: number
  /** 直近のフレームで返した結果（同じフレームを二度渡されたときにそのまま返す） */
  lastResult: ReonsetAlert | null
}

export function createReonsetState(): ReonsetState {
  return { byId: new Map(), prevRecent: new Set(), lastMs: -Infinity, lastResult: null }
}

/** 「2 つ目」の合図。どのイベントで、どの観測点が立ち上がったか。 */
export interface ReonsetAlert {
  eventId: string
  /** 合図を出したフレームのデータ時刻（ms）。合図の印（`eventId` と組で一意）と、別地点との重複の判定に使う */
  atMs: number
  /** まとまって新しく立ち上がった観測点のキー */
  keys: string[]
}

/**
 * 1 フレーム分を取り込み、「同じ場所の 2 つ目の地震」とみなせる立ち上がりがあれば返す（1 フレーム 1 件）。
 *
 * 同じフレーム（同じデータ時刻）を二度渡しても結果は変わらない（StrictMode の二重実行で崩れない）。
 * データ時刻が巻き戻ったら（リプレイの開始・やり直し）状態を捨てる。
 *
 * @param state 呼び出し側が持ち越す状態（**この関数が破壊的に更新する**）
 * @param recentOnsetKeys 直近に立ち上がった観測点（床の係の `recentOnsetKeys`）
 * @param nowMs フレームのデータ時刻。読めないときは状態を変えずに null
 */
export function stepReonset(
  state: ReonsetState,
  detections: readonly Pick<EnsembleDetection, 'id' | 'confidence' | 'memberKeys' | 'epicenter' | 'originTimeMs'>[],
  recentOnsetKeys: Iterable<string>,
  nowMs: number,
): ReonsetAlert | null {
  if (!Number.isFinite(nowMs)) return null
  if (nowMs === state.lastMs) return state.lastResult
  if (nowMs < state.lastMs) {
    state.byId.clear()
    state.prevRecent = new Set()
    state.lastResult = null
  }
  state.lastMs = nowMs

  const recent = new Set(recentOnsetKeys)
  const newOnsets = [...recent].filter((k) => !state.prevRecent.has(k))
  state.prevRecent = recent

  let result: ReonsetAlert | null = null
  const alive = new Set<string>()
  // このフレームで確かな段になった束は、前のフレームまでの記録だけと比べる（同じフレームで確かな段に
  // なった束どうしを「続いている束」と取り違えないよう、先に記録を読んでから書き足す）
  const settledConfirmed = detections.filter((e) => {
    const since = state.byId.get(e.id)?.confirmedSinceMs
    return e.confidence === 'confirmed' && since != null && nowMs - since >= REONSET_QUIET_MS
  })
  for (const e of detections) {
    alive.add(e.id)
    let t = state.byId.get(e.id)
    if (!t) {
      t = { firstSeenMs: nowMs, confirmedSinceMs: null, lastOnsetMs: nowMs, burst: [], lastFireMs: -Infinity }
      state.byId.set(e.id, t)
    }
    if (e.confidence !== 'confirmed') continue
    if (t.confirmedSinceMs === null) {
      t.confirmedSinceMs = nowMs
      const others = settledConfirmed.filter((o) => o.id !== e.id)
      const km = (o: (typeof others)[number]) => haversineKm(o.epicenter[0], o.epicenter[1], e.epicenter[0], e.epicenter[1])
      const nearby = others.some((o) => km(o) <= REONSET_NEARBY_KM)
      const sameQuakeWave = others.some((o) => {
        const dtSec = (e.originTimeMs - o.originTimeMs) / 1000
        if (!(dtSec > 0)) return false
        const v = km(o) / dtSec
        return v >= REONSET_WAVE_KMPS_MIN && v <= REONSET_WAVE_KMPS_MAX
      })
      if (result === null && nearby && !sameQuakeWave) {
        result = { eventId: e.id, atMs: nowMs, keys: [...e.memberKeys] }
        t.lastFireMs = nowMs
        t.burst = []
        continue
      }
    }
    const members = new Set(e.memberKeys)
    const fresh = newOnsets.filter((k) => members.has(k))
    t.burst = t.burst.filter((b) => nowMs - b.ms <= REONSET_BURST_MS)
    if (fresh.length > 0) {
      // 静けさを挟まない立ち上がり（続いている揺れの中）はまとまりに数えない
      if (t.burst.length > 0 || nowMs - t.lastOnsetMs >= REONSET_QUIET_MS) {
        for (const key of fresh) t.burst.push({ ms: nowMs, key })
      }
      t.lastOnsetMs = nowMs
    }
    if (
      result === null
      && t.burst.length >= REONSET_MIN_POINTS
      && nowMs - t.lastFireMs >= REONSET_QUIET_MS
      && nowMs - t.firstSeenMs >= REONSET_QUIET_MS
    ) {
      result = { eventId: e.id, atMs: nowMs, keys: t.burst.map((b) => b.key) }
      t.lastFireMs = nowMs
      t.burst = []
    }
  }
  for (const id of state.byId.keys()) if (!alive.has(id)) state.byId.delete(id)
  state.lastResult = result
  return result
}
