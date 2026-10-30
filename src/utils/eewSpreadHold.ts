/**
 * 緊急地震速報の自動解除を、揺れ検知の束が広がっている間は待たせる（eew-spec §7「検知が広がっている間は待つ」）。
 *
 * 自動解除の時刻（{@link calcEEWCancelTime}）は「有感半径に S 波が届くまで＋30 秒」の見積もりで、揺れが実際に
 * まだ広がっているかは見ていない。強震モニタの検知の束に点が加わり続けている間は、その事実を見て解除を延ばす
 * （2026-10-31 ユーザー発言「検知している間というよりは広がってる間は続いてほしい」）。
 *
 * - 待つのは、束に**最後に点が加わってから** {@link EEW_SPREAD_GRACE_MS}（2026-10-31 ユーザー選択
 *   「点が加わらなくなって30秒 (Recommended)」）。束が生きているだけでは待たない
 * - 延ばすのは、式の解除時刻から {@link EEW_SPREAD_HOLD_MAX_MS} まで（2026-10-31 ユーザー選択「式の解除時刻＋5分 (Recommended)」）。
 *   束が別の揺れを取り込んで点が加わり続けても、それより長くは残さない
 * - 式の解除時刻は下限として残す。検知が無い・強震モニタが止まっている地震は今までどおり式で消える
 *
 * 束とその EEW を結ぶ条件は、束が EEW の震央から有感半径（{@link eewFeltRadiusKm}。別地点の吸収と同じ値）の内で、
 * 発生時刻の {@link ORIGIN_MATCH_BEFORE_MS} 前〜{@link ORIGIN_MATCH_AFTER_MS} 後に始まったこと。値は評価台で
 * 測ったときの結び付け方と同じ（実測は eew-spec §7）。
 */
import type { EEWAlert } from '../types/earthquake'
import { calcEEWCancelTime, eewFeltRadiusKm, eewSortTimeMs, isProvisionalHypocenter } from './eew'
import { hasKnownEpicenter, haversineKm } from './geo'

/** 束に最後に点が加わってから、解除まで待つ長さ */
export const EEW_SPREAD_GRACE_MS = 30_000
/** 式の解除時刻から延ばせる上限 */
export const EEW_SPREAD_HOLD_MAX_MS = 300_000
/** 束の始まりが EEW の発生時刻よりこれだけ前でも、その地震の束とみなす（検知と発生時刻のずれの分） */
const ORIGIN_MATCH_BEFORE_MS = 10_000
/** 束の始まりが EEW の発生時刻からこれより後なら、その地震の束とみなさない */
const ORIGIN_MATCH_AFTER_MS = 90_000
/** 最後に見てからこれだけ経った束は捨てる（上限の 5 分を超えて覚えておく意味が無い） */
const FORGET_AFTER_MS = 15 * 60_000
/**
 * データ時刻がこれより大きく飛んだら、前の束を捨てる。束の id は検知器を作り直すと `e0` から振り直されるので、
 * 時間軸が変わったのに覚えたままだと、新しい束を古い束の続きと取り違える
 */
const TIME_JUMP_RESET_MS = 60_000

/** 係が読む検知の欄（`EnsembleDetection` の一部） */
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

/**
 * 検知の束ごとに、始まり・最後に点が加わった時刻・位置を覚える係。
 *
 * **束の始まりは「係が初めて見た時刻」。** 揺れの最中にページを開いた・再生を途中から始めたときはその時点が
 * 始まりになり、発生から 90 秒を過ぎていれば結び付かない（式の時刻で消える側へ倒れる）。
 */
export interface DetectionSpreadLog {
  /** 1 秒ぶんの検知を流す。`ms` はその検知のデータ時刻 */
  push(ms: number, detections: readonly SpreadDetection[]): void
  /** その EEW に結び付く束に、最後に点が加わったデータ時刻。結び付く束が無ければ null */
  lastSpreadMs(eew: EEWAlert): number | null
  /** 覚えた束を捨てる（時間軸が変わったとき） */
  reset(): void
}

export function createDetectionSpreadLog(): DetectionSpreadLog {
  const bundles = new Map<string, BundleRecord>()
  let lastMs: number | null = null
  return {
    push(ms, detections) {
      if (!Number.isFinite(ms)) return
      if (lastMs !== null && (ms < lastMs || ms - lastMs > TIME_JUMP_RESET_MS)) bundles.clear()
      lastMs = ms
      for (const d of detections) {
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
    lastSpreadMs(eew) {
      // 仮の震源（仮定震源要素・「非常に強い揺れを検知」の報）は位置も時刻も本当の震源ではないので結び付けない
      if (isProvisionalHypocenter(eew)) return null
      const { latitude, longitude, magnitude, depth } = eew.earthquake.hypocenter
      if (!hasKnownEpicenter(latitude, longitude)) return null
      const originMs = eewSortTimeMs(eew)
      if (!Number.isFinite(originMs)) return null
      const radiusKm = eewFeltRadiusKm(magnitude, depth)
      let latest: number | null = null
      for (const b of bundles.values()) {
        if (b.firstMs < originMs - ORIGIN_MATCH_BEFORE_MS || b.firstMs > originMs + ORIGIN_MATCH_AFTER_MS) continue
        if (haversineKm(b.epicenter[0], b.epicenter[1], latitude, longitude) > radiusKm) continue
        if (latest === null || b.lastAddMs > latest) latest = b.lastAddMs
      }
      return latest
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
 * - `no-bundle`: 結び付く束が無い（検知が無い・仮の震源・束が発生時刻の窓や有感半径の外）
 * - `grace-elapsed`: 束の点が加わらなくなって 30 秒が過ぎた
 * - `cap`: 式の時刻から 5 分の上限に当たった（束がまだ広がっていても消す）
 * - `formula-unknown`: 式の時刻を決められない
 */
export type EewExpiryDecision =
  | { kind: 'expire'; reason: 'no-bundle' | 'grace-elapsed' | 'cap' | 'formula-unknown' }
  | { kind: 'hold'; untilMs: number }

/**
 * 自動解除をいま行うか、いつまで待つか。
 *
 * @param formulaMs 式の解除時刻（{@link calcEEWCancelTime}）。延ばす上限の起点
 * @param nowMs いまの時刻（再生中は再生時計）
 * @param lastSpreadMs 結び付く束に最後に点が加わったデータ時刻。無ければ null
 */
export function decideEewExpiry(formulaMs: number, nowMs: number, lastSpreadMs: number | null): EewExpiryDecision {
  if (!Number.isFinite(formulaMs)) return { kind: 'expire', reason: 'formula-unknown' }
  if (lastSpreadMs === null) return { kind: 'expire', reason: 'no-bundle' }
  const graceMs = lastSpreadMs + EEW_SPREAD_GRACE_MS
  const capMs = formulaMs + EEW_SPREAD_HOLD_MAX_MS
  const untilMs = Math.min(graceMs, capMs)
  if (untilMs > nowMs) return { kind: 'hold', untilMs }
  return { kind: 'expire', reason: graceMs > capMs ? 'cap' : 'grace-elapsed' }
}

/** 最終報から積んだ自動解除（`expired` の取消）に対する判断。式の時刻は電文から求め直す */
export function decideFinalReportExpiry(eew: EEWAlert, nowMs: number, log: DetectionSpreadLog): EewExpiryDecision {
  const formulaMs = calcEEWCancelTime(eew, new Date(eew.time)).getTime()
  return decideEewExpiry(formulaMs, nowMs, log.lastSpreadMs(eew))
}
