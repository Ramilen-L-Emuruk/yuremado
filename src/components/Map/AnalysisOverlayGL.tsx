import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ExpressionSpecification, GeoJSONSource } from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'
import { useMapGL } from './mapGLContext'
import { addOrderedLayer } from './gl/layerOrder'
import { isMapStyleGone } from './gl/mapStyleGone'
import {
  fetchAnalysisOverlay, MMI_COLORS, slipColorStops,
  getAnalysisOverlayRetry, setAnalysisOverlayFailure, subscribeAnalysisOverlayStatus,
  type AnalysisOverlay, type AnalysisOverlayLayer,
} from '../../services/analysisOverlay'
import { isAbortedByCaller } from '../../utils/fetchWithTimeout'
import { createLogThrottle, log } from '../../utils/logger'

/**
 * 地震カードの「MMI（USGS）」「すべり」で開く、海外の機関の解析の重ね（計画書 項目 98「地図の重ね」）。
 *
 * - MMI: USGS の ShakeMap の等値線（0.5 刻み）を、MMI の色の線で描く
 * - すべり: USGS の有限断層モデルの小区画を、0 から最大までの色の段で塗る
 *
 * 層は地図ができたときに一度だけ作り、開閉は `visibility` と中身の差し替えだけで行う
 * （開閉のたびに層を作り直さない。→ `JapanMapGL.tsx` の常時マウントの決まり）。
 * 取れた重ねの最大値（凡例の目盛りに使う）は `onLoaded` で返す。
 */

const MMI_SRC = 'analysis-mmi'
const MMI_LYR = 'analysis-mmi-line'
const SLIP_SRC = 'analysis-slip'
const SLIP_FILL = 'analysis-slip-fill'
const SLIP_LINE = 'analysis-slip-line'
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }
/** 取得の失敗の記録は 1 分に 1 回へ間引く */
const warnFetch = createLogThrottle(60_000)

/** MMI の色の式（値を四捨五入した階級の色） */
const MMI_COLOR_EXPR: ExpressionSpecification = [
  'step', ['get', 'value'],
  MMI_COLORS[0],
  ...MMI_COLORS.slice(1).flatMap((c, i) => [i + 0.5, c] as [number, string]),
]

function slipColorExpr(maxSlipM: number): ExpressionSpecification {
  const stops = slipColorStops(maxSlipM)
  return ['interpolate', ['linear'], ['get', 'slip'], ...stops.flatMap(s => [s.at, s.color] as [number, string])]
}

export function AnalysisOverlayGL({ overlay, onLoaded }: {
  /** 開いている重ね（地図が出している地震のものだけ）。null なら何も出さない */
  overlay: { layer: AnalysisOverlayLayer; url: string } | null
  /** 重ねを取れた（null は閉じた・取れなかった）。凡例が最大値を読む */
  onLoaded: (loaded: AnalysisOverlay | null) => void
}) {
  const map = useMapGL()
  const addedRef = useRef(false)
  const [loaded, setLoaded] = useState<{ url: string; overlay: AnalysisOverlay } | null>(null)

  useEffect(() => {
    if (!map) return
    map.addSource(MMI_SRC, { type: 'geojson', data: EMPTY })
    addOrderedLayer(map, {
      id: MMI_LYR,
      type: 'line',
      source: MMI_SRC,
      layout: { visibility: 'none', 'line-join': 'round' },
      // 整数の階級の線は太く、0.5 の線は細く（USGS の等値線の図と同じく、整数の線を目で追えるように）
      paint: {
        'line-color': MMI_COLOR_EXPR,
        'line-width': ['case', ['==', ['%', ['get', 'value'], 1], 0], 2.5, 1.2],
      },
    })
    map.addSource(SLIP_SRC, { type: 'geojson', data: EMPTY })
    addOrderedLayer(map, {
      id: SLIP_FILL,
      type: 'fill',
      source: SLIP_SRC,
      layout: { visibility: 'none' },
      paint: { 'fill-color': slipColorExpr(1), 'fill-opacity': 0.75 },
    })
    addOrderedLayer(map, {
      id: SLIP_LINE,
      type: 'line',
      source: SLIP_SRC,
      layout: { visibility: 'none' },
      paint: { 'line-color': 'rgba(0,0,0,0.25)', 'line-width': 0.5 },
    })
    addedRef.current = true
    return () => {
      addedRef.current = false
      if (isMapStyleGone(map)) return
      for (const id of [MMI_LYR, SLIP_LINE, SLIP_FILL]) if (map.getLayer(id)) map.removeLayer(id)
      for (const id of [MMI_SRC, SLIP_SRC]) if (map.getSource(id)) map.removeSource(id)
    }
  }, [map])

  // 開いた重ねのファイルを取る。版の URL ごとに記憶があるので、開き直しでは取り直さない。
  // 鍵は種類と版の文字列と押し直しの回数で見る（呼び出し側の参照が作り直されても取り直さない）
  const layer = overlay?.layer ?? null
  const url = overlay?.url ?? null
  // 帯の「押し直すと取り直します」で増える。増えたら同じ版を取り直す
  const retry = useSyncExternalStore(subscribeAnalysisOverlayStatus, getAnalysisOverlayRetry, getAnalysisOverlayRetry)
  useEffect(() => {
    if (layer === null || url === null) {
      setLoaded(null)
      setAnalysisOverlayFailure(null)
      return
    }
    // 取りに行く間は帯から消す（別の版・別の種類へ移った・押し直した。取れなければ出し直す）
    setAnalysisOverlayFailure(null)
    const ac = new AbortController()
    // 新しい版が取れなかったときは、同じ種類の前の版を出したままにする（消すと震度も重ねも無い地図になる）。
    // 取れなかったことは地図左上の帯に出す（前の版を出していても、新しい版は取れていないので出す）
    const fail = () => {
      setLoaded(prev => (prev && prev.overlay.layer === layer ? prev : null))
      setAnalysisOverlayFailure({ layer, url })
    }
    void fetchAnalysisOverlay(url, layer, ac.signal).then(
      (r) => {
        if (ac.signal.aborted) return
        if (r.kind === 'ok') {
          setLoaded({ url, overlay: r.overlay })
          setAnalysisOverlayFailure(null)
        } else {
          warnFetch(() => log.warn(`[analysis] 地図に重ねるファイルを取得できませんでした（${url}）: ${r.message}`))
          fail()
        }
      },
      (e: unknown) => {
        if (isAbortedByCaller(e)) return
        warnFetch(() => log.warn(`[analysis] 地図に重ねるファイルを取得できませんでした（${url}）`, e))
        fail()
      },
    )
    return () => ac.abort()
  }, [layer, url, retry])

  // 地図ごと消えたら、帯に残さない
  useEffect(() => () => setAnalysisOverlayFailure(null), [])

  // 取れた重ねを流し込み、出す層だけを見せる。**版が替わる間は、同じ種類の前の版を出し続ける**
  // （新しい版を取り終えるまで消すと、凡例と寄せ先が震源側へ戻ってから重ねへ寄り直す）。種類が違う・閉じた後は出さない
  const shown = loaded && layer !== null && loaded.overlay.layer === layer ? loaded.overlay : null
  useEffect(() => {
    onLoaded(shown)
    if (!map || !addedRef.current) return
    const mmi = shown?.layer === 'mmi' ? shown : null
    const slip = shown?.layer === 'slip' ? shown : null
    ;(map.getSource(MMI_SRC) as GeoJSONSource | undefined)?.setData(mmi ? mmi.lines : EMPTY)
    ;(map.getSource(SLIP_SRC) as GeoJSONSource | undefined)?.setData(slip ? slip.cells : EMPTY)
    if (slip) map.setPaintProperty(SLIP_FILL, 'fill-color', slipColorExpr(slip.maxSlipM))
    map.setLayoutProperty(MMI_LYR, 'visibility', mmi ? 'visible' : 'none')
    map.setLayoutProperty(SLIP_FILL, 'visibility', slip ? 'visible' : 'none')
    map.setLayoutProperty(SLIP_LINE, 'visibility', slip ? 'visible' : 'none')
  }, [map, shown, onLoaded])

  return null
}
