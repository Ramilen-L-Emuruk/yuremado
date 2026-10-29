// 組み合わせの検知器（kyoshinEnsembleTracker）の出力（EnsembleDetection[]）を、UI・音・地図フィットが
// 消費する「表示状態」へ変換する純粋ユーティリティ。
// 検知は位置・段・加わった観測点キーを持つが、地図フィット/検知点マーカーは
// 座標＋現在インデックスの点列（DetectedPoint）を要求するため、ここで memberKeys を解決する。

import { computeSiteKeys } from './kyoshinSiteKeys'
import type { EnsembleDetection } from './kyoshinEnsembleTracker'
import type { SiteCoords } from '../services/kyoshin'

/** 地図フィット・検知点マーカー・ヒストグラムが扱う観測点（座標＋現在インデックス）。 */
export interface DetectedPoint {
  /**
   * 観測点キー（`computeSiteKeys` 由来）。同一座標に複数の実体がある観測点が実在するため
   * （`buildSiteIndex` 参照）、点の同一性は座標ではなくこのキーで判断する。
   */
  key: string
  lat: number
  lng: number
  index: number
  /**
   * `index` が「現フレームは欠測で、直前の有効値を保持している」値かどうか
   * （`utils/kyoshinMissingHold.ts`）。描画側は保持中の点を半透明で描く。
   * 保持を通していない経路（テスト・保持前の生値）では undefined。
   */
  stale?: boolean
}

/** 検知の表示状態（音・自動タブ切替・自動フィットの駆動元）。 */
export interface KyoshinView {
  /** confirmed イベントが1件以上あるか */
  confirmed: boolean
  /** likely イベントが1件以上あるか（早期反応の駆動元） */
  candidate: boolean
  /**
   * confirmed 全イベントの描く点（`drawnKeys`）。**検知点マーカー・カメラの寄せ先・検知の継続判定**に使う。
   * カメラ追従（`CameraFollowsGL`）と `JapanMapGL` はこの配列が空になったことを「検知が終わった」
   * 合図として扱い、日本全体へ戻す。`drawnKeys` は検知が生きている間は空にならないので、
   * 検知が続いている最中にカメラが勝手に引くことは無い。
   */
  detectedPoints: DetectedPoint[]
  /** 主 likely イベント（最大震度が最大のもの）の描く点（候補フィット用）。 */
  candidatePoints: DetectedPoint[]
  /**
   * confirmed 以外（likely）の全イベントの描く点（検知点マーカー用）。
   * リアルタイムタブの検知カードが集計する集合（全イベント）と一致させるため、
   * detectedPoints とこの 2 本で全体を覆う。**カメラフィットには使わない**
   * （候補フィットは主 likely 1 件の candidatePoints を使う。理由は deriveKyoshinView 参照）。
   */
  unconfirmedPoints: DetectedPoint[]
  /** 主 likely イベントの ID（FitToCandidate の再フィット判定用）。無ければ null。 */
  candidateId: string | null
  /** 主 likely イベントのメンバー観測点の最大インデックス（likely 中の音レベル追跡に使う）。無ければ0。 */
  candidateMaxIndex: number
  /**
   * 主 likely イベントのメンバーのうち値を持つ点の最大インデックス。値を持つ点が無ければ（全員欠測・likely が無い）-1。
   * `candidateMaxIndex` は音の段の基準なので 0 から始めるが、こちらは震度の呼び名を付ける側（共有カードの副見出し）が使う
   * —— 0 は「震度0以下」と名乗るので、欠測を 0 と取り違えない
   */
  candidatePeakIndex: number
  /**
   * confirmed 各イベント（＝地域）の代表点と最大インデックス。地域単位の発報（新地域の検知・
   * 既存地域の再上昇で鳴らす）に使う。震源ではなくメンバー重心＋メンバー最大震度。
   */
  confirmedShocks: ConfirmedShock[]
}

/** `KyoshinView.confirmedShocks` の 1 件。 */
export interface ConfirmedShock {
  /** メンバー重心（地域単位の発報の照合に使う位置）。 */
  lat: number
  lng: number
  /** メンバー観測点の最大計測震度インデックス。 */
  index: number
  /**
   * `index` を記録した観測点そのものの座標。**カメラを寄せる先はこちら**（揺れフォーカス。
   * `map-rendering-spec.md` §6）。
   *
   * 重心と分けているのが要点。広域に広がったイベントでは重心が最も強く揺れている点から
   * 大きく離れる（2024-01-01 16:08 能登の再生で実測: 石川〜千葉に広がったイベントの重心は
   * 新潟県境付近で、震度4を記録した能登の観測点から約 140km 離れていた）。照合には重心が要る
   * （距離の閾値がそれを前提に調整されている）ため、寄り先だけを別に持つ。
   *
   * メンバーの座標が 1 つも引けないとき（観測点リストの入れ替え中に `sites` が空へゲートされる）は
   * 重心と同じ値を入れる。**イベント自体は落とさない**（理由は `deriveKyoshinView` の該当箇所）。
   */
  peak: { lat: number; lng: number }
}

/**
 * 座標キー → 観測点（座標＋現在インデックス）の索引を作る。memberKeys 解決に使う。
 * キーは検知器・床の係と同じ computeSiteKeys で構築する（座標衝突時の別実体化を揃える。
 * 同じ sites 配列を同じ順序で渡す前提のため、ずれると memberKeys の解決が食い違う）。
 *
 * @param stale 欠測ホールドで直前値を保持している点のフラグ（`indices` と同順・省略可）。
 */
export function buildSiteIndex(
  sites: SiteCoords,
  indices: number[],
  stale?: readonly boolean[],
): Map<string, DetectedPoint> {
  const byKey = new Map<string, DetectedPoint>()
  const keys = computeSiteKeys(sites as [number, number][])
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i]
    if (!s) continue
    const idx = indices[i]
    if (idx === undefined) continue
    byKey.set(keys[i], { key: keys[i], lat: s[0], lng: s[1], index: idx, stale: stale?.[i] === true })
  }
  return byKey
}

/** メンバー観測点キー列を DetectedPoint 列へ解決する（索引に無いキーは捨てる）。 */
export function resolveMembers(keys: string[], byKey: Map<string, DetectedPoint>): DetectedPoint[] {
  const pts: DetectedPoint[] = []
  for (const k of keys) {
    const p = byKey.get(k)
    if (p) pts.push(p)
  }
  return pts
}

/**
 * 検知イベント列から表示状態を導出する。
 *
 * - detectedPoints: confirmed 全イベントの描く点（`drawnKeys`）の和集合（検知点マーカー・フットプリント全体へのフィット）。
 * - candidatePoints: 主 likely イベント（最大震度が最大）1件の描く点（主候補フィットに対応）。
 *   複数 likely の和集合にすると境界が飛び跳ねるため、常に1件へ絞る。
 * - unconfirmedPoints: likely 全イベントの描く点の和集合（検知点マーカー用）。
 *   フィットに使うと境界が飛び跳ねるため用途を分ける。
 * - 震央には**フィットしない**（メンバー観測点にフィットする）。不確実な震央へ
 *   地図が飛ぶ事故を構造的に避けるため。
 *
 * `stale`（欠測ホールドで直前値を保持している点のフラグ）を渡すと、各 `DetectedPoint` に引き継がれる。
 * 描画側はそれを見て半透明で描く（`utils/kyoshinMissingHold.ts`）。
 *
 * 確信度・音の駆動に使う値（confirmed / candidate / candidateMaxIndex / confirmedShocks）は
 * 加わった点すべて（`memberKeys`）で見る。描く点を外しても「検知したかどうか」や音の段は変わらない。
 */
export function deriveKyoshinView(
  detections: readonly EnsembleDetection[],
  sites: SiteCoords,
  indices: number[],
  stale?: readonly boolean[],
): KyoshinView {
  const byKey = buildSiteIndex(sites, indices, stale)

  const confirmedEvents = detections.filter((d) => d.confidence === 'confirmed')
  const likelyEvents = detections.filter((d) => d.confidence === 'likely')

  const detectedKeys = new Set<string>()
  // 地図に描く点・カメラの寄せ先は `drawnKeys`（震度0 未満が続いた点を外したもの・空にはならない）から取る。
  // 地域の代表点（`confirmedShocks`）と主 likely の最大インデックスは、加わった点すべて（`memberKeys`）で見る
  for (const e of confirmedEvents) for (const k of e.drawnKeys) detectedKeys.add(k)

  // confirmed 以外（likely）の全イベント。
  // confirmed にも属する観測点はここから除き、detectedPoints との差集合にする（同じ観測点が
  // confirmed と likely の両方のメンバーになりうる）。除去を観測点キーで行うのが要点で、
  // 描画側で座標を見て弾くと、同一座標に複数の実体がある観測点（buildSiteIndex 参照）を
  // 取り違えて落としてしまう。
  const unconfirmedKeys = new Set<string>()
  for (const e of detections) {
    if (e.confidence === 'confirmed') continue
    for (const k of e.drawnKeys) if (!detectedKeys.has(k)) unconfirmedKeys.add(k)
  }

  // 最大震度が無い（加わった点がいま全員欠測の）検知は、ある検知より後ろに置く
  const intensityOf = (e: EnsembleDetection): number => e.maxIntensity ?? -Infinity
  const primaryLikely = likelyEvents.reduce<EnsembleDetection | null>(
    (best, e) => (!best || intensityOf(e) > intensityOf(best) ? e : best),
    null,
  )

  // 主 likely イベントのメンバー最大インデックス（likely 中の音レベル追跡の基準値作りに使う）
  let candidatePeakIndex = -1
  if (primaryLikely) {
    for (const k of primaryLikely.memberKeys) {
      const p = byKey.get(k)
      if (p && p.index > candidatePeakIndex) candidatePeakIndex = p.index
    }
  }
  const candidateMaxIndex = Math.max(0, candidatePeakIndex)

  // confirmed 各イベント（地域）の代表点＋メンバー最大インデックス（地域単位発報の入力）と、
  // その最大を記録した観測点の座標（揺れフォーカスの寄り先）。
  const confirmedShocks = confirmedEvents.flatMap<ConfirmedShock>((e) => {
    // 同じ最大値が並んだときは先に現れた観測点を採る（`memberKeys` の並び順＝検知エンジンが
    // メンバーを束ねた順。どちらも「最も強く揺れている点」なので優劣を付ける根拠が無い）。
    let peak: DetectedPoint | null = null
    let sumLat = 0
    let sumLng = 0
    let n = 0
    for (const k of e.memberKeys) {
      const p = byKey.get(k)
      if (!p) continue
      sumLat += p.lat
      sumLng += p.lng
      n++
      if (peak === null || p.index > peak.index) peak = p
    }
    // 位置はメンバーの重心にする。検知の `epicenter` は束を作った 1 点の位置で、広がった揺れでは
    // メンバー全体の真ん中から外れる。地域単位の発報の距離のしきい値は重心を前提に合わせてある。
    //
    // メンバーが 1 つも索引に無いときは検知の位置へ落とす（観測点リストの入れ替え中に `sites` が空へ
    // ゲートされると起きる）。**イベントごと落としてはならない**——地域単位の発報
    // （`stepAlertRegions`）は `confirmedShocks` が空になったことを「確定が消えた」と読み、
    // 発報済み・EEW 吸収済みの記録を捨てる。捨てると入れ替えの直後に同じ地域が鳴り直す。
    // メンバーが全員欠測・索引に無いときは -1（欠測）にする。0 は計測震度 -3.0 という値なので、0 へ丸めると
    // 通知が「推定最大震度 0以下」と値があるように名乗る（`kyoshinDetectionScaleLabel` は欠測を null にする）。
    // 音の段（`kyoshinLevel`）は 0 未満を震度0 の段として扱う
    const [centroidLat, centroidLng] = n > 0 ? [sumLat / n, sumLng / n] : e.epicenter
    return [{
      lat: centroidLat,
      lng: centroidLng,
      index: peak !== null && peak.index >= 0 ? peak.index : -1,
      peak: peak ? { lat: peak.lat, lng: peak.lng } : { lat: centroidLat, lng: centroidLng },
    }]
  })

  return {
    confirmed: confirmedEvents.length > 0,
    candidate: likelyEvents.length > 0,
    detectedPoints: resolveMembers([...detectedKeys], byKey),
    candidatePoints: primaryLikely ? resolveMembers(primaryLikely.drawnKeys, byKey) : [],
    unconfirmedPoints: resolveMembers([...unconfirmedKeys], byKey),
    candidateId: primaryLikely ? primaryLikely.id : null,
    candidateMaxIndex,
    candidatePeakIndex,
    confirmedShocks,
  }
}
