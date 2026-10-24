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

import type { DetectionEvent } from './kyoshinDetector'

/** 新しい立ち上がりが無かった時間がこれ以上続いてから、まとまった立ち上がりを「2 つ目」とみなす（ms） */
export const REONSET_QUIET_MS = 60_000
/** 立ち上がりを 1 つのまとまりとして数える幅（ms） */
export const REONSET_BURST_MS = 3_000
/** 「2 つ目」とみなす、まとまった新しい立ち上がりの点数 */
export const REONSET_MIN_POINTS = 3

interface PerEvent {
  /** イベントを初めて見たデータ時刻 */
  firstSeenMs: number
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
 * @param recentOnsetKeys 直近に立ち上がった観測点（`step()` の `recentOnsetKeys`）
 * @param nowMs フレームのデータ時刻。読めないときは状態を変えずに null
 */
export function stepReonset(
  state: ReonsetState,
  detections: readonly DetectionEvent[],
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
  for (const e of detections) {
    alive.add(e.id)
    let t = state.byId.get(e.id)
    if (!t) {
      t = { firstSeenMs: nowMs, lastOnsetMs: nowMs, burst: [], lastFireMs: -Infinity }
      state.byId.set(e.id, t)
    }
    if (e.confidence !== 'confirmed') continue
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
