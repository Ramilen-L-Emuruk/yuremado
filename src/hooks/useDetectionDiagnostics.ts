import { useEffect, useRef } from 'react'
import type { SiteCoords } from '../services/kyoshin'
import { computeSiteKeys } from '../utils/kyoshinSiteKeys'
import type { EnsembleDetection } from '../utils/kyoshinEnsembleTracker'
import type { NoiseFloorSnapshot } from '../utils/kyoshinNoiseFloor'
import {
  DiagnosticCapture,
  confirmedOf,
  describeEvent,
  encodeIntensity,
  type DiagnosticRecord,
} from '../utils/detectionDiagnostics'
import { saveRecord } from '../utils/detectionDiagnosticsDb'
import { isDmdss } from '../utils/env'
import { log } from '../utils/logger'

// 揺れ検知が走ったときの「アプリが実際に見た値」を記録するフック。
// 記録の中身と切り出しの規則は utils/detectionDiagnostics.ts、保存は detectionDiagnosticsDb.ts。
//
// 記録するのは画面に出た検知（早い段・確かな段）。
//
// あわせて、**1 点のまま 30 秒続いた確かな段の束**をログへ残す（2026-10-28 ユーザー選択「カードと記憶を外す」）。
// 旧エンジンは単点のまま居座る確定を降ろしていたが、組み合わせの検知器には降ろす仕組みを足していない。
// 795 窓で数えた限り起きなかったので、起きたときに気づけるよう記録だけ置く。

/** 慢性ノイズ床の localStorage キー（`useKyoshinDetectorV2` と同じもの）。 */
const LEARNED_KEY = 'kyoshin-v3-learned'
/** 確かな段の束が 1 点のままこれだけ続いたらログへ残す（ms） */
export const SOLO_CONFIRMED_LOG_MS = 30_000

/** 保存済みの慢性ノイズ床を読む。読めなければ null（記録は残す。床が無いだけ）。 */
function readNoiseFloors(): NoiseFloorSnapshot | null {
  try {
    const raw = localStorage.getItem(LEARNED_KEY)
    return raw ? (JSON.parse(raw) as NoiseFloorSnapshot) : null
  } catch {
    return null
  }
}

/**
 * 検知の前後を記録する。
 *
 * @param detections `useKyoshinDetectorV2` の検知イベント
 * @param sites 観測点座標（`indices` と同じ並び）
 * @param indices 計測震度インデックス（生値）
 * @param dataTime 対象データ時刻（ISO 文字列）
 * @param siteConfigId 観測点リストの版
 *
 * **録画モードでも保存する**（2026-10-23 ユーザー選択「録画モード中も保存する (Recommended)」）。
 * 以前は「地震の最中に書き込みが集中する」という推測で録画モード中の保存を止めていたが、
 * 測ると保存 1 回で画面を止める同期の部分は最大 0.6ms、書き終わりまで最大 1.6ms だった
 * （2026-10-23・この PC の開発用ビルド）。保存は 1 つの揺れで多くて 1 分に 1 件。
 */
export function useDetectionDiagnostics(
  detections: readonly EnsembleDetection[],
  sites: SiteCoords,
  indices: number[],
  dataTime: string,
  siteConfigId: string | null,
): void {
  const captureRef = useRef(new DiagnosticCapture())
  /** 確かな段の束 → 1 点のまま続いている起点のデータ時刻（ログを出したら -1） */
  const soloSinceRef = useRef(new Map<string, number>())
  // フレーム到来ごとの処理で最新値を参照する（deps は dataTime だけに絞りたいため ref で持ち回す）
  const latest = useRef({ detections, sites, indices, siteConfigId })
  latest.current = { detections, sites, indices, siteConfigId }

  // 観測点集合が入れ替わったら、座標と値の対応が変わるので溜めた分を捨てる
  useEffect(() => {
    captureRef.current.reset()
    soloSinceRef.current.clear()
  }, [siteConfigId])

  useEffect(() => {
    const { detections: evs, sites: st, indices: idx, siteConfigId: cfg } = latest.current
    if (!dataTime || idx.length === 0 || st.length !== idx.length) return
    const ms = new Date(dataTime).getTime()
    if (!Number.isFinite(ms)) return

    const capture = captureRef.current
    capture.pushFrame(ms, encodeIntensity(idx))

    noteSoloConfirmed(soloSinceRef.current, evs, ms)

    // 画面に出た検知（早い段・確かな段のすべて）を記録する
    if (evs.length > 0) {
      const sites = st as [number, number][]
      const keyToIndex = new Map<string, number>()
      computeSiteKeys(sites).forEach((k, i) => keyToIndex.set(k, i))
      const noiseFloors = readNoiseFloors()
      for (const e of evs) {
        capture.open(
          {
            dataTimeMs: ms,
            siteConfigId: cfg ?? '',
            sites,
            event: describeEvent(e, keyToIndex, sites, idx),
            confirmed: confirmedOf(e),
            noiseFloors,
          },
          __APP_VERSION__,
          isDmdss ? 'dmdss' : 'standard',
        )
      }
    }
    persist(capture.takeFinished())
  }, [dataTime])

  // 画面が見えなくなったら、後ろ側が足りないままでも記録を残す。
  //
  // **アンマウントのクリーンアップだけでは足りない。** このフックはアプリ本体に付いていて、
  // タブを閉じてもリロードしても React のアンマウントは起きない（実行コンテキストごと消える）。
  // 誤検知に気づいてすぐ閉じる——この機能がいちばん使われる場面がそこなので、`visibilitychange` で
  // 拾う。`beforeunload` では非同期の保存が間に合わない。
  useEffect(() => {
    const capture = captureRef.current
    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') persist(capture.flush())
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      persist(capture.flush())
    }
  }, [])
}

/**
 * 確かな段の束が 1 点のまま {@link SOLO_CONFIRMED_LOG_MS} 続いたら、束ごとに 1 度だけログへ残す。
 *
 * @param soloSince 束の id → 1 点のまま続いている起点のデータ時刻（ログを出した束は -1）。**この関数が書き換える**
 */
export function noteSoloConfirmed(soloSince: Map<string, number>, detections: readonly EnsembleDetection[], ms: number): void {
  const alive = new Set<string>()
  for (const e of detections) {
    alive.add(e.id)
    if (e.confidence !== 'confirmed' || e.memberKeys.length !== 1) {
      // 点が増えたら数え直す。ログを出した束はそのまま（同じ束で二度出さない）
      if (soloSince.get(e.id) !== -1) soloSince.delete(e.id)
      continue
    }
    const since = soloSince.get(e.id)
    if (since === undefined) {
      soloSince.set(e.id, ms)
    } else if (since !== -1 && ms - since >= SOLO_CONFIRMED_LOG_MS) {
      soloSince.set(e.id, -1)
      const at = `${e.epicenter[0].toFixed(2)},${e.epicenter[1].toFixed(2)}`
      log.warn(
        `[diagnostics] 確かな段の束が 1 点のまま ${Math.round((ms - since) / 1000)} 秒続いています`
          + `（id=${e.id}・観測点 ${e.memberKeys[0]}・位置 ${at}・支えた部分 ${e.sources.join('/')}）`,
      )
    }
  }
  for (const id of soloSince.keys()) if (!alive.has(id)) soloSince.delete(id)
}

/**
 * 保存を 1 本の鎖に繋ぐ。
 *
 * フックはフレームごとに投げっぱなしで呼ぶため、保存が遅い・失敗が続くときに前の保存が
 * 終わらないまま次が始まりうる。並ぶ順は記録の順でなければ意味を成さない（後から読むのは時系列）。
 */
let chain: Promise<void> = Promise.resolve()

function persist(records: DiagnosticRecord[]): void {
  if (records.length === 0) return
  chain = chain.then(async () => {
    for (const r of records) {
      await saveRecord(r)
      log.info(
        `[diagnostics] 検知の前後を記録した（${new Date(r.dataTimeMs).toLocaleTimeString('ja-JP')} ${r.reachedConfidence}）`,
      )
    }
  })
}
