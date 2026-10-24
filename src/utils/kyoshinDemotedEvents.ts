// 確定を降ろした検知（単点のまま居座った・孤立点の値が動かないまま続いた。設計書§33・§37）を、
// 検知カードへしばらく残すための記憶。**判定には関与しない**（検知エンジンの出力を読むだけ）。
//
// 【なぜ要るか】降ろした検知は確信度が weak になり、検知カードは weak を除いて受け取るので、
// 理由が出ないままカードが消えていた。降ろす判断そのものは正しい（設計書§33 のユーザー発言
// 「それをずっと保持し続けてしまうのが問題かな」）が、消え方に理由が無いと「検知したのに黙って
// 消えた」ように見える。理由をカードに残す（2026-10-22 ユーザー選択「理由をカードに残す (Recommended)」）。
//
// 【何秒残すか】データ時刻で `DEMOTED_CARD_MS`（2026-10-24 ユーザー選択「10 秒 (Recommended)」）。
// リプレイの早送りでも長さが変わらないよう、壁時計ではなくデータ時刻で測る。

import type { DetectionEvent } from './kyoshinDetector'

/** 降ろした検知をカードに残す長さ（データ時刻・ms）。 */
export const DEMOTED_CARD_MS = 10_000

/** `stepDemotedEvents` が持ち越す状態（呼び出し側が ref で保持する）。 */
export interface DemotedEventsState {
  /** イベント ID → 降ろしたことを最初に見たデータ時刻と、そのときのイベント。 */
  byId: Map<string, { atMs: number; event: DetectionEvent }>
  /** 直近に処理したデータ時刻（巻き戻りの検出に使う）。 */
  lastMs: number
}

export function createDemotedEventsState(): DemotedEventsState {
  return { byId: new Map(), lastMs: -Infinity }
}

/** 降ろされた確定か（確信度が weak で、降ろした印が立っている）。 */
export function isDemotedEvent(e: DetectionEvent): boolean {
  return e.confidence === 'weak' && e.gates.soloStale
}

/**
 * 1 フレーム分を取り込み、カードに残すべき「降ろした検知」を返す（降ろした時刻の古い順）。
 *
 * - 降ろした印のイベントを初めて見た時刻から `DEMOTED_CARD_MS` の間だけ返す
 * - 期間中にエンジンからイベントが消えても、最後に見た姿のまま返す（消えたときに理由も消えないため）
 * - 確定へ戻ったイベント（weak でなくなった）は、通常のカードが担うので外す
 * - 降ろした印が消えた weak（別の理由で弱まった）も外す（古い理由を出し続けない）
 * - 同じ観測点を持つ検知が weak 以外で出ていれば外す（併合で ID が変わった・同じ場所で立ち上がり
 *   直した。上の通常のカードと「取り下げ」が同じ場所について食い違って見えないように）
 * - データ時刻が巻き戻ったら（リプレイの開始・やり直し）すべて捨てる
 *
 * @param state 呼び出し側が持ち越す状態（**この関数が破壊的に更新する**）
 * @param nowMs フレームのデータ時刻。読めないとき（検知が止まって結果を空にした間は空文字が来る）は
 *   記憶を空にする。残すと 10 秒の期限が進まず、供給が戻るまでカードが出たままになる
 */
export function stepDemotedEvents(
  state: DemotedEventsState,
  detections: readonly DetectionEvent[],
  nowMs: number,
): DetectionEvent[] {
  if (!Number.isFinite(nowMs)) {
    state.byId.clear()
    return []
  }
  if (nowMs < state.lastMs) state.byId.clear()
  state.lastMs = nowMs

  const shownKeys = new Set<string>()
  for (const e of detections) {
    if (e.confidence !== 'weak') for (const k of e.memberKeys) shownKeys.add(k)
    const held = state.byId.get(e.id)
    if (isDemotedEvent(e)) {
      if (held) held.event = e
      else state.byId.set(e.id, { atMs: nowMs, event: e })
    } else if (held) {
      // 確定（または likely など）へ戻った、または別の理由の weak になった
      state.byId.delete(e.id)
    }
  }
  for (const [id, held] of state.byId) {
    if (held.event.memberKeys.some((k) => shownKeys.has(k))) state.byId.delete(id)
  }
  for (const [id, held] of state.byId) {
    if (nowMs - held.atMs > DEMOTED_CARD_MS) state.byId.delete(id)
  }
  return collect(state)
}

function collect(state: DemotedEventsState): DetectionEvent[] {
  return [...state.byId.values()].sort((a, b) => a.atMs - b.atMs).map((h) => h.event)
}
