/**
 * 緊急地震速報の自動解除を、揺れ検知の束が広がっている間は待たせる（eew-spec §7「検知が広がっている間は待つ」）。
 *
 * 自動解除の時刻（{@link calcEEWCancelTime}）は「有感半径に S 波が届くまで＋30 秒」の見積もりで、揺れが実際に
 * まだ広がっているかは見ていない。強震モニタの検知の束に点が加わり続けている間は、その事実を見て解除を延ばす
 * （2026-10-31 ユーザー発言「検知している間というよりは広がってる間は続いてほしい」）。
 *
 * - 待つのは、束に**最後に点が加わってから** {@link EEW_SPREAD_GRACE_MS}（2026-10-31 ユーザー選択
 *   「点が加わらなくなって30秒 (Recommended)」）。束が生きているだけでは待たない
 * - **束の最初の点へ S 波が届く見込みがそれより後なら、そこから** {@link EEW_SPREAD_GRACE_MS}（2026-11-04 ユーザー選択
 *   「S 波が通るまで待つ (Recommended)」）。遠い地震で、P 波の束が止まってから S 波の束が始まるまでの間に消さない
 * - 延ばすのは、式の解除時刻から {@link EEW_SPREAD_HOLD_MAX_MS} まで（2026-10-31 ユーザー選択「式の解除時刻＋5分 (Recommended)」）。
 *   束が別の揺れを取り込んで点が加わり続けても、それより長くは残さない
 * - 式の解除時刻は下限として残す。検知が無い・強震モニタが止まっている地震で式より延びるのは、観測網から遠い地震で
 *   最寄りの観測点へ P 波が届く見込みを待つ間だけ（下記。強震モニタが止まっていれば待たない）
 *
 * **束とその EEW は走時で結ぶ**（2026-11-04 ユーザー選択「走時で結び付ける (Recommended)」）。束の始まりが、EEW の
 * 震源から束の最初の点までの距離での P 波の到達（の {@link TRAVEL_EARLY_MS} 前）から S 波の到達（の
 * {@link TRAVEL_LATE_MS} 後）までに入れば、その地震の束とみなす。
 * **距離では切らない**（2026-11-06 ユーザー選択「距離で切らず走時だけで結ぶ (Recommended)」。2026-11-04 の「網の中の地震は
 * 距離でも切る (Recommended)」を覆した）。速報の震源・深さ・規模は実際と大きく外れることがあり、その値で求めた有感半径の外でも
 * 同じ地震の揺れが広がる（2026-10-25 11:09 の深発地震）。
 *
 * **観測網へ P 波が届く前には消さない。** 最寄りの観測点へ P 波が届く見込み＋{@link FIRST_ARRIVAL_WAIT_MS}（2026-11-04
 * ユーザー選択「60 秒 (Recommended)」）までは、束の有無に関わらず消さない（届いても束ができなければ、そこで消える）。
 */
import type { EEWAlert } from '../types/earthquake'
import { calcEEWCancelTime, eewSortTimeMs, isProvisionalHypocenter, UNKNOWN_DEPTH_ASSUMED_KM } from './eew'
import { hasDepth } from './formatters'
import { hasKnownEpicenter, haversineKm } from './geo'
import { travelTimeSec } from './travelTime'

/** 束に最後に点が加わってから、解除まで待つ長さ */
export const EEW_SPREAD_GRACE_MS = 30_000
/** 式の解除時刻から延ばせる上限 */
export const EEW_SPREAD_HOLD_MAX_MS = 300_000
/** 束の始まりが EEW の発生時刻よりこれだけ前でも、その地震の束とみなす（検知と発生時刻のずれの分） */
const ORIGIN_MATCH_BEFORE_MS = 10_000
/**
 * 束の始まりが、走時で求めた P 波の到達よりこれだけ早くても、その地震の束とみなす。
 * EEW の震源・発生時刻は最終報でも気象庁の決定値からずれる（2026-11-04 硫黄島近海: 震央で約 180km・深さ 10km と 150km）
 */
const TRAVEL_EARLY_MS = 30_000
/**
 * 束の始まりが、走時で求めた S 波の到達からこれより後なら、その地震の束とみなさない。
 * 近い地震では S 波の到達が数秒なので、以前の「発生から 90 秒」とほぼ同じ幅になる
 */
const TRAVEL_LATE_MS = 90_000
/**
 * 最寄りの観測点へ P 波が届く見込みから、束ができるのを待つ長さ。控えの連続期間（普段の週 19 日）で、最寄りの観測点への
 * P 波の見込みからその地震の束ができるまでの遅れは 60 秒以内が 97.2%（eew-spec §7 の実測）
 */
export const FIRST_ARRIVAL_WAIT_MS = 60_000
/** 強震モニタのデータ時刻がいまよりこれだけ古ければ、止まっているとみて観測網へ波が届くのを待たない */
const STALE_DATA_MS = 30_000
/** 最後に見てからこれだけ経った束は捨てる（上限の 5 分を超えて覚えておく意味が無い） */
const FORGET_AFTER_MS = 15 * 60_000
/**
 * データ時刻がこれより大きく飛んだら、前の束を捨てる。束の id は検知器を作り直すと `e0` から振り直されるので、
 * 時間軸が変わったのに覚えたままだと、新しい束を古い束の続きと取り違える
 */
const TIME_JUMP_RESET_MS = 60_000

/** 係が読む検知の欄（`EnsembleDetection` の一部）。`epicenter` は束の最初の点 */
export interface SpreadDetection {
  id: string
  epicenter: readonly [number, number]
  memberKeys: readonly string[]
}

interface BundleRecord {
  firstMs: number
  lastAddMs: number
  lastSeenMs: number
  size: number
  epicenter: readonly [number, number]
}

/** 結び付く束が最後に広がっていたとみなす時刻と、それが S 波の到達の見込みで決まったか */
export interface SpreadTime {
  ms: number
  /** 点が最後に加わった時刻より、束の最初の点へ S 波が届く見込みのほうが後だった */
  bySArrival: boolean
}

/**
 * 観測網へ波が届くのを待つ期限。
 * - `wait`: 最寄りの観測点へ P 波が届く見込み＋{@link FIRST_ARRIVAL_WAIT_MS}
 * - `unavailable`: 観測点の一覧がまだ無い・強震モニタのデータが止まっているので待てない
 * - null: 仮の震源・震央や発生時刻が読めない（結び付けもしない報）
 */
export type FirstArrivalWait = { kind: 'wait'; ms: number } | { kind: 'unavailable' } | null

/**
 * 検知の束ごとに、始まり・最後に点が加わった時刻・位置を覚える係。
 *
 * **束の始まりは「係が初めて見た時刻」。** 揺れの最中にページを開いた・再生を途中から始めたときはその時点が
 * 始まりになり、走時の窓を過ぎていれば結び付かない（式の時刻で消える側へ倒れる）。
 */
export interface DetectionSpreadLog {
  /** 1 秒ぶんの検知を流す。`ms` はその検知のデータ時刻。最初の点の座標が読めない束は覚えない */
  push(ms: number, detections: readonly SpreadDetection[]): void
  /** 強震モニタの観測点の座標（`[緯度, 経度]`）。最寄りの観測点へ P 波が届く見込みに使う */
  setSites(sites: readonly (readonly [number, number])[]): void
  /**
   * その EEW に結び付く束が最後に広がっていたとみなす時刻。結び付く束が無ければ null。
   * 強震モニタが止まっていれば（`nowMs` よりデータ時刻が 30 秒より古い）、S 波の見込みでは延ばさず点の追加だけで決める
   */
  lastSpread(eew: EEWAlert, nowMs: number): SpreadTime | null
  /** 観測網へ波が届くのを待つ期限（{@link FirstArrivalWait}）。`nowMs` はデータが止まっていないかを見るのに使う */
  firstArrivalWait(eew: EEWAlert, nowMs: number): FirstArrivalWait
  /** 覚えた束を捨てる（時間軸が変わったとき） */
  reset(): void
}

/** 結び付けに使う EEW の震源。仮の震源・震央や発生時刻が読めない報は null */
function eewSource(eew: EEWAlert): { lat: number; lng: number; depthKm: number; magnitude: number; originMs: number } | null {
  // 仮の震源（仮定震源要素・「非常に強い揺れを検知」の報）は位置も時刻も本当の震源ではないので結び付けない
  if (isProvisionalHypocenter(eew)) return null
  const { latitude, longitude, depth, magnitude } = eew.earthquake.hypocenter
  if (!hasKnownEpicenter(latitude, longitude)) return null
  const originMs = eewSortTimeMs(eew)
  if (!Number.isFinite(originMs)) return null
  return { lat: latitude, lng: longitude, depthKm: hasDepth(depth) ? depth : UNKNOWN_DEPTH_ASSUMED_KM, magnitude, originMs }
}

export function createDetectionSpreadLog(): DetectionSpreadLog {
  const bundles = new Map<string, BundleRecord>()
  let sites: readonly (readonly [number, number])[] = []
  let lastMs: number | null = null
  /** 震央から最も近い観測点までの距離。観測点を知らなければ null */
  function nearestSiteKm(lat: number, lng: number): number | null {
    let nearest = Infinity
    for (const [sLat, sLng] of sites) {
      const d = haversineKm(sLat, sLng, lat, lng)
      if (d < nearest) nearest = d
    }
    return Number.isFinite(nearest) ? nearest : null
  }
  /** 強震モニタのデータが止まっているか（まだ 1 秒も来ていない・いまより {@link STALE_DATA_MS} より古い） */
  function isStale(nowMs: number): boolean {
    return lastMs === null || nowMs - lastMs > STALE_DATA_MS
  }
  return {
    push(ms, detections) {
      if (!Number.isFinite(ms)) return
      if (lastMs !== null && (ms < lastMs || ms - lastMs > TIME_JUMP_RESET_MS)) bundles.clear()
      lastMs = ms
      for (const d of detections) {
        // 位置が読めない束は走時を求められない（距離 0 として扱うと震源の真上の束に化ける）
        if (!hasKnownEpicenter(d.epicenter[0], d.epicenter[1])) continue
        const b = bundles.get(d.id)
        if (!b) {
          bundles.set(d.id, { firstMs: ms, lastAddMs: ms, lastSeenMs: ms, size: d.memberKeys.length, epicenter: d.epicenter })
          continue
        }
        if (d.memberKeys.length > b.size) {
          b.size = d.memberKeys.length
          b.lastAddMs = ms
        }
        b.lastSeenMs = ms
      }
      for (const [id, b] of bundles) if (ms - b.lastSeenMs > FORGET_AFTER_MS) bundles.delete(id)
    },
    setSites(next) {
      sites = next
    },
    lastSpread(eew, nowMs) {
      const src = eewSource(eew)
      if (!src) return null
      const stale = isStale(nowMs)
      let latest: SpreadTime | null = null
      for (const b of bundles.values()) {
        // 距離では切らない。速報の震源・深さ・規模は実際と大きく外れることがあり、その値で求めた有感半径の外でも
        // 同じ地震の揺れが広がる（2026-10-25 11:09: 強震モニタの報は深さ 10km・M6.2 で有感半径 826km、
        // 気象庁の決定は深さ 470km・M7.0 で、震央から 1124km の東北で発生の 290 秒後に揺れ検知が始まった）
        const distKm = haversineKm(b.epicenter[0], b.epicenter[1], src.lat, src.lng)
        const earliestMs = src.originMs + Math.max(-ORIGIN_MATCH_BEFORE_MS, travelTimeSec('P', distKm, src.depthKm) * 1000 - TRAVEL_EARLY_MS)
        const sArrivalMs = src.originMs + travelTimeSec('S', distKm, src.depthKm) * 1000
        if (b.firstMs < earliestMs || b.firstMs > sArrivalMs + TRAVEL_LATE_MS) continue
        // P 波で始まった束は、その場所へ S 波が届くまで広がりの途中とみなす。遠い地震では P 波の束が止まってから
        // S 波の束が始まるまで 1 分以上空く（2026-11-04 硫黄島近海で 74 秒）。近い地震では S 波が数秒で届くので効かない
        // 強震モニタが止まっていれば、後から来る S 波の束はできようがないので延ばさない
        const spread: SpreadTime = !stale && sArrivalMs > b.lastAddMs ? { ms: sArrivalMs, bySArrival: true } : { ms: b.lastAddMs, bySArrival: false }
        if (latest === null || spread.ms > latest.ms) latest = spread
      }
      return latest
    },
    firstArrivalWait(eew, nowMs) {
      const src = eewSource(eew)
      if (!src) return null
      const nearest = nearestSiteKm(src.lat, src.lng)
      if (nearest === null) return { kind: 'unavailable' }
      // 強震モニタが止まっていれば束はできようがない（10-31 の決まり「止まっている地震は式の時刻で消える」）
      if (isStale(nowMs)) return { kind: 'unavailable' }
      return { kind: 'wait', ms: src.originMs + travelTimeSec('P', nearest, src.depthKm) * 1000 + FIRST_ARRIVAL_WAIT_MS }
    },
    reset() {
      bundles.clear()
      lastMs = null
    },
  }
}

/**
 * 自動解除の時刻が来たときの判断。
 *
 * 解除するときは理由を持つ（呼び出し側が記録に残す。残さないと「広がっていたのに消えた」を、結び付く束が
 * 無かったのか・点が止まっていたのか・上限に当たったのかで切り分けられない）。
 * - `no-bundle`: 結び付く束が無く、観測網へ波が届くのを待つ期限も過ぎていた（または仮の震源などで待たない報）
 * - `no-network-data`: 結び付く束が無く、観測点の一覧が無い・強震モニタが止まっているので観測網への波を待てなかった
 * - `first-arrival-elapsed`: 最寄りの観測点へ P 波が届く見込み＋60 秒を待ったうえで、束が無い・先に止まっていた
 * - `grace-elapsed`: 束の点が加わらなくなって 30 秒が過ぎた
 * - `s-arrival-elapsed`: 束の場所へ S 波が届く見込みから 30 秒が過ぎた（点はそれより前に止まっていた）
 * - `cap`: 束がまだ広がっていたが、式の時刻から 5 分の上限に当たった
 * - `cap-first-arrival`: 観測網へ波が届くのを待っていたが、式の時刻から 5 分の上限に当たった
 * - `formula-unknown`: 式の時刻を決められない
 */
export type EewExpiryReason =
  | 'no-bundle' | 'no-network-data' | 'first-arrival-elapsed' | 'grace-elapsed' | 's-arrival-elapsed'
  | 'cap' | 'cap-first-arrival' | 'formula-unknown'
export type EewExpiryDecision =
  | { kind: 'expire'; reason: EewExpiryReason }
  | { kind: 'hold'; untilMs: number }

/**
 * 自動解除をいま行うか、いつまで待つか。
 *
 * @param formulaMs 式の解除時刻（{@link calcEEWCancelTime}）。延ばす上限の起点
 * @param nowMs いまの時刻（再生中は再生時計）
 * @param spread 結び付く束が最後に広がっていたとみなす時刻（{@link DetectionSpreadLog.lastSpread}）。無ければ null
 * @param wait 観測網へ波が届くのを待つ期限（{@link DetectionSpreadLog.firstArrivalWait}）
 */
export function decideEewExpiry(formulaMs: number, nowMs: number, spread: SpreadTime | null, wait: FirstArrivalWait): EewExpiryDecision {
  if (!Number.isFinite(formulaMs)) return { kind: 'expire', reason: 'formula-unknown' }
  const capMs = formulaMs + EEW_SPREAD_HOLD_MAX_MS
  const spreadTargetMs = spread !== null && Number.isFinite(spread.ms) ? spread.ms + EEW_SPREAD_GRACE_MS : null
  const waitMs = wait?.kind === 'wait' && Number.isFinite(wait.ms) ? wait.ms : null
  // 束の広がりと観測網への波の、遅いほうまで待つ（小さな束が先に止まっても、観測網へ波が届く前には消さない）
  const bySpread = spreadTargetMs !== null && (waitMs === null || spreadTargetMs >= waitMs)
  const targetMs = bySpread ? spreadTargetMs : waitMs
  if (targetMs === null) return { kind: 'expire', reason: wait?.kind === 'unavailable' ? 'no-network-data' : 'no-bundle' }
  const untilMs = Math.min(targetMs, capMs)
  if (untilMs > nowMs) return { kind: 'hold', untilMs }
  if (targetMs > capMs) return { kind: 'expire', reason: bySpread ? 'cap' : 'cap-first-arrival' }
  // 観測網への波を待って延びたときだけ、その待ちを理由にする（束があって先に止まっていても、延ばしたのは待ちの側）
  if (!bySpread && waitMs !== null && waitMs > formulaMs) return { kind: 'expire', reason: 'first-arrival-elapsed' }
  if (spreadTargetMs !== null) return { kind: 'expire', reason: spread!.bySArrival ? 's-arrival-elapsed' : 'grace-elapsed' }
  return { kind: 'expire', reason: 'no-bundle' }
}

/** 最終報から積んだ自動解除（`expired` の取消）に対する判断。式の時刻は電文から求め直す */
export function decideFinalReportExpiry(eew: EEWAlert, nowMs: number, log: DetectionSpreadLog): EewExpiryDecision {
  const formulaMs = calcEEWCancelTime(eew, new Date(eew.time)).getTime()
  return decideEewExpiry(formulaMs, nowMs, log.lastSpread(eew, nowMs), log.firstArrivalWait(eew, nowMs))
}
