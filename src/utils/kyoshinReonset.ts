// 同じ場所の 2 つ目の地震を見分ける（設計書§40・§51）。**判定は検知エンジンの出力を読むだけ**で、
// 検知そのものには関与しない。
//
// 【なぜ要るか】確定している検知の内側（同じイベント・別地点として鳴った地域の内側）で次の地震が
// 起きても、検知エンジンは同じイベントへまとめ（併合）、別地点の発報も一度鳴った地域では鳴らない。
// 段が上がらなければ更新音も鳴らないので、本震の揺れが続く中の余震は音もタブ移動も無かった
// （2026-10-22 ユーザー選択「2 つ目も鳴らすよう設計する」）。
//
// 【もう一度の立ち上がり】続いている確かな束の中で一度立ち上がった点が、`REONSET_QUIET_MS` 静かになってから
// もう一度立ち上がり、それが生きている束（と前に出した合図）の地震の波では説明できない（震央からの距離 ÷
// 経過秒が `REONSET_ONSET_KMPS_MIN`〜`REONSET_ONSET_KMPS_MAX` km/s に入らない）なら「新しい揺れの候補」にする。
// `REONSET_BURST_MS` の内に `REONSET_CLUSTER_KM` 以内へ `REONSET_MIN_POINTS` 点以上の候補が集まったら合図を出す。
// 束全体の静けさは待たない —— 余震が続くと束全体はいつまでも静かにならず、前の見分け方（束全体で 60 秒静か・
// 3 点）は能登 2024 の 1 週間で、束が続く最中に起きた有感地震 33 件のうち 1 件しか拾えなかった。
// 2026-11-02 ユーザー選択「この形で実装へ進む (Recommended)」。計測は設計書§51。
//
// 【新しい束】組み合わせの検知器は、同じ場所の 2 つ目の揺れを別の束として出すことがある。その束は
// 現れたばかりなので上の見分け方では鳴らず、別地点の発報も一度鳴った地域の内側では鳴らない。そこで、
// 近く（`REONSET_NEARBY_KM` の内）の確かな束が `REONSET_SETTLED_MS` 以上続いている最中に、別の束が確かな段に
// なったら、それも「2 つ目」とみなす（2026-10-29 計測・ユーザー選択「新しい束でも鳴らす (Recommended)」）。
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

/**
 * 点が前に立ち上がってからこの長さは、その点のもう一度の立ち上がりを候補に数えない（ms。同じ揺れの続きを外す）。
 * 20 秒では、17 秒差で 2 km 隣に起きた 2 つ目の地震（能登 2024-01-02 07:37 の震度3）の上がりを外していた。
 * 1 つ目の揺れの続きは {@link REONSET_GUARD_MS} と見かけの速さの判定も外すので、5 秒に縮めた
 * （2026-11-03 ユーザー選択「静けさ 5 秒・守り 20 秒で入れる (Recommended)」。計測は設計書§59）。
 * **実データではこの値より床の係の直近の窓（`RECENT_ONSET_MS` = 8 秒）が先に効く。** 同じ点がもう一度「新しい立ち上がり」に
 * なるには一度直近から外れる必要があるので、間は約 9 秒より短くならず、5 秒の判定には掛からない。
 * 直近の窓を縮めると、この値が効き始める
 */
export const REONSET_QUIET_MS = 5_000
/** 候補を 1 つのまとまりとして数える幅（ms） */
export const REONSET_BURST_MS = 3_000
/** 「2 つ目」とみなす、まとまった候補の点数 */
export const REONSET_MIN_POINTS = 2
/** まとまりとみなす候補どうしの距離（km） */
export const REONSET_CLUSTER_KM = 40
/** 候補にする点は、確かな束の位置からこの距離の内だけ（km。2 つ目の地震は 1 つ目のすぐ近くで起きる） */
export const REONSET_ONSET_NEAR_KM = 100
/** 3 点に満たないまとまりで鳴らすのは、確かな束の位置からこの距離の内だけ（km。2 点は偶然そろいやすい） */
export const REONSET_PAIR_NEAR_KM = 60
/** 立ち上がりが、生きている束の地震の波で説明できるとみなす見かけの速さ（km/s） */
export const REONSET_ONSET_KMPS_MIN = 1.5
export const REONSET_ONSET_KMPS_MAX = 8
/** 出した合図の位置と時刻を、後の立ち上がりを説明する地震として覚える長さ（ms） */
export const REONSET_EXPLAIN_MS = 120_000
/**
 * 近くの確かな束が始まってからこの長さの間に上がった点は数えない（ms）。1 つ目の地震の揺れの続き
 * （小さな地震の近くの点が間を空けてもう一度上がる形）で鳴らさないため。§51 では 60 秒を採った
 * （2026-11-02 ユーザー選択「60 秒の守りを足す (Recommended)」）。60 秒では 1 つ目の 17 秒後に起きた 2 つ目の地震を外すので、
 * {@link REONSET_QUIET_MS} を 5 秒にしたうえで 0・10・20 秒を比べ、どれも同じだけ拾えて震源に当たらない合図も増えなかったので、測った中で最も長い 20 秒にした
 * （2026-11-03 ユーザー選択「静けさ 5 秒・守り 20 秒で入れる (Recommended)」。計測は設計書§59）
 */
export const REONSET_GUARD_MS = 20_000
/** 束の揺れ始めのこの長さ前から立ち上がっていた点も、その束の中で立ち上がった点に数える（ms） */
export const REONSET_ONSET_SLACK_MS = 5_000
/** 新しい束を「2 つ目」とみなすのは、近くの確かな束がこの長さ以上続いているときだけ（ms） */
export const REONSET_SETTLED_MS = 60_000
/**
 * 新しい束を「同じ場所の 2 つ目」とみなす、続いている確かな束との距離（km。束の位置どうし）。
 * 別地点の発報が同じ地震とみなす距離（`useKyoshinAlerts` の `REGION_MATCH_KM`）と同じ値にした。これより
 * 離れた束は別地点の発報が受け持つ
 */
export const REONSET_NEARBY_KM = 300
/** 先の束から新しい束までの見かけの速さ（km/s）がこの範囲なら、同じ地震の波が届いただけとみなす */
export const REONSET_WAVE_KMPS_MIN = 2.5
export const REONSET_WAVE_KMPS_MAX = 5

/** 観測点のキー（`kyoshinSiteKeys` の `緯度,経度` か `緯度,経度#n`）から座標を読む。読めなければ null */
export function keyLatLng(key: string): [number, number] | null {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:#\d+)?$/.exec(key)
  return m ? [Number(m[1]), Number(m[2])] : null
}

/** 新しい揺れの候補（説明できない、もう一度の立ち上がり） */
interface Candidate { ms: number; key: string; lat: number; lng: number }

/** `stepReonset` が持ち越す状態（呼び出し側が ref で保持する）。 */
export interface ReonsetState {
  /** 束を確かな段で初めて見たデータ時刻（新しい束の見分けに使う） */
  confirmedSince: Map<string, number>
  /** 点が最後に「直近に立ち上がった」へ入ったデータ時刻 */
  lastEntry: Map<string, number>
  /** まだまとまりになっていない候補 */
  candidates: Candidate[]
  /** 出した合図の位置と時刻（後の立ち上がりを説明する地震として使う） */
  fired: { ms: number; lat: number; lng: number }[]
  /** 前のフレームで「直近に立ち上がった」観測点 */
  prevRecent: Set<string>
  /** 直近に処理したデータ時刻（巻き戻りの検出と、同じフレームの二度渡しの判定に使う） */
  lastMs: number
  /** 直近のフレームで返した結果（同じフレームを二度渡されたときにそのまま返す） */
  lastResult: ReonsetAlert | null
}

export function createReonsetState(): ReonsetState {
  return { confirmedSince: new Map(), lastEntry: new Map(), candidates: [], fired: [], prevRecent: new Set(), lastMs: -Infinity, lastResult: null }
}

/** 「2 つ目」の合図。どのイベントで、どの観測点が立ち上がったか。 */
export interface ReonsetAlert {
  eventId: string
  /** 合図を出したフレームのデータ時刻（ms）。合図の印（`eventId` と組で一意）と、別地点との重複の判定に使う */
  atMs: number
  /** まとまって新しく立ち上がった観測点のキー */
  keys: string[]
}

type Detection = Pick<EnsembleDetection, 'id' | 'confidence' | 'memberKeys' | 'epicenter' | 'originTimeMs'>

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
  detections: readonly Detection[],
  recentOnsetKeys: Iterable<string>,
  nowMs: number,
): ReonsetAlert | null {
  if (!Number.isFinite(nowMs)) return null
  if (nowMs === state.lastMs) return state.lastResult
  if (nowMs < state.lastMs) {
    const fresh = createReonsetState()
    Object.assign(state, fresh)
  }
  state.lastMs = nowMs

  const recent = new Set(recentOnsetKeys)
  const newOnsets = [...recent].filter((k) => !state.prevRecent.has(k))
  state.prevRecent = recent

  // 立ち上がりの記録（lastEntry）を毎フレーム進めるため、もう一度の立ち上がり側は新しい束の合図が出たフレームでも走らせる
  const bundle = newBundleAlert(state, detections, nowMs)
  const rerise = reriseAlert(state, detections, newOnsets, nowMs)
  const result = bundle ?? rerise
  state.lastResult = result
  return result
}

/** 新しい束: 近くの確かな束が続く最中に、別の束が確かな段になった */
function newBundleAlert(state: ReonsetState, detections: readonly Detection[], nowMs: number): ReonsetAlert | null {
  // このフレームで確かな段になった束は、前のフレームまでの記録だけと比べる（同じフレームで確かな段に
  // なった束どうしを「続いている束」と取り違えないよう、先に記録を読んでから書き足す）
  const settledConfirmed = detections.filter((e) => {
    const since = state.confirmedSince.get(e.id)
    return e.confidence === 'confirmed' && since != null && nowMs - since >= REONSET_SETTLED_MS
  })
  let result: ReonsetAlert | null = null
  const alive = new Set<string>()
  for (const e of detections) {
    alive.add(e.id)
    if (e.confidence !== 'confirmed' || state.confirmedSince.has(e.id)) continue
    state.confirmedSince.set(e.id, nowMs)
    if (result !== null) continue
    const others = settledConfirmed.filter((o) => o.id !== e.id)
    const km = (o: Detection) => haversineKm(o.epicenter[0], o.epicenter[1], e.epicenter[0], e.epicenter[1])
    const nearby = others.some((o) => km(o) <= REONSET_NEARBY_KM)
    const sameQuakeWave = others.some((o) => {
      const dtSec = (e.originTimeMs - o.originTimeMs) / 1000
      if (!(dtSec > 0)) return false
      const v = km(o) / dtSec
      return v >= REONSET_WAVE_KMPS_MIN && v <= REONSET_WAVE_KMPS_MAX
    })
    if (nearby && !sameQuakeWave) {
      result = { eventId: e.id, atMs: nowMs, keys: [...e.memberKeys] }
      const pos = e.epicenter
      state.fired.push({ ms: nowMs, lat: pos[0], lng: pos[1] })
    }
  }
  for (const id of state.confirmedSince.keys()) if (!alive.has(id)) state.confirmedSince.delete(id)
  return result
}

/** もう一度の立ち上がり: 束の中で一度上がった点が静けさの後に上がり、今の揺れの波で説明できない点がまとまった */
function reriseAlert(state: ReonsetState, detections: readonly Detection[], newOnsets: readonly string[], nowMs: number): ReonsetAlert | null {
  state.fired = state.fired.filter((x) => nowMs - x.ms <= REONSET_EXPLAIN_MS)
  const confirmed = detections.filter((d) => d.confidence === 'confirmed')
  // 立ち上がりを説明する地震: 生きている束の揺れ始めと、前に出した合図（揺れ始めは合図の少し前）
  const sources = [
    ...detections.map((d) => ({ lat: d.epicenter[0], lng: d.epicenter[1], t0: d.originTimeMs })),
    ...state.fired.map((x) => ({ lat: x.lat, lng: x.lng, t0: x.ms - REONSET_ONSET_SLACK_MS })),
  ]
  for (const key of newOnsets) {
    const prev = state.lastEntry.get(key)
    state.lastEntry.set(key, nowMs)
    // 初めて上がった点（1 つ目の地震の波が届いただけのことが多い）と、静けさを挟まない上がり（揺れの続き）は数えない
    if (prev == null || nowMs - prev < REONSET_QUIET_MS) continue
    const pos = keyLatLng(key)
    if (!pos) continue
    const [lat, lng] = pos
    const near = confirmed.filter((d) => haversineKm(d.epicenter[0], d.epicenter[1], lat, lng) <= REONSET_ONSET_NEAR_KM)
    // 近くの確かな束が始まってから一度上がった点の、もう一度の立ち上がりだけを数える
    if (!near.some((d) => prev >= d.originTimeMs - REONSET_ONSET_SLACK_MS)) continue
    // 近くの確かな束が始まったばかりなら、その地震の揺れの続きとみなす
    if (near.some((d) => nowMs - d.originTimeMs < REONSET_GUARD_MS)) continue
    const explained = sources.some((s) => {
      const dtSec = (nowMs - s.t0) / 1000
      if (dtSec <= 0) return false
      const v = haversineKm(s.lat, s.lng, lat, lng) / dtSec
      return v >= REONSET_ONSET_KMPS_MIN && v <= REONSET_ONSET_KMPS_MAX
    })
    if (!explained) state.candidates.push({ ms: nowMs, key, lat, lng })
  }
  state.candidates = state.candidates.filter((c) => nowMs - c.ms <= REONSET_BURST_MS)
  for (const c of state.candidates) {
    const group = state.candidates.filter((o) => haversineKm(c.lat, c.lng, o.lat, o.lng) <= REONSET_CLUSTER_KM)
    if (group.length < REONSET_MIN_POINTS) continue
    const distTo = (d: Detection) => haversineKm(d.epicenter[0], d.epicenter[1], c.lat, c.lng)
    if (group.length < 3 && !confirmed.some((d) => distTo(d) <= REONSET_PAIR_NEAR_KM)) continue
    const owner = confirmed.reduce<Detection | null>((best, d) => (best === null || distTo(d) < distTo(best) ? d : best), null)
    if (owner === null) continue
    state.fired.push({ ms: nowMs, lat: c.lat, lng: c.lng })
    const used = new Set(group)
    state.candidates = state.candidates.filter((o) => !used.has(o))
    return { eventId: owner.id, atMs: nowMs, keys: group.map((g) => g.key) }
  }
  return null
}
