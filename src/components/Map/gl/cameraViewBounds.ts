// 寄せる先のカメラ（中心・ズーム・向き・傾き）と画面の寸法から、着地したときに見える範囲を見積もる。
//
// 着地を待たずに着地先の絵を用意する 2 か所が使う —— 海底地形タイルの先読み（`utils/gebcoPrefetch.ts` の
// `buildCameraTargetTiles`）と、震度の面を前もって描く `QuakeIntensitySurfaceGL`。同じ見積もりを 2 か所に
// 書くと、片方だけ広げたときに「タイルは揃ったのに面が足りない」がずれて起きる。
//
// **見積もりは Web メルカトルの平面で行い、大きめに外れる側へ倒す。** 地球儀の投影で引いた画は実際に
// 見える範囲がこれより狭い。向きを変えた画は回した矩形の外接矩形、傾けた画は奥行きのぶん
// `1 + tan(傾き)` 倍に広げる（どちらも大きめの近似）。足りないぶんは着地してから地図が取りに行く/
// 描き直すので、見積もりが外れても失われるのは「前もって」の効き目だけ。

/** 寄せる先の画。`camera.ts` の `FlightTarget` と同じ形（camera.ts を読まないよう形だけ持つ）。 */
export interface CameraView {
  /** [経度, 緯度] */
  center: [number, number]
  zoom: number
  bearing: number
  pitch: number
}

/** メルカトル平面の矩形（世界全体を 0〜1 とした割合）。x は経度の回り込みで 0〜1 の外へ出ることがある。 */
export interface MercatorBox {
  x0: number
  x1: number
  y0: number
  y1: number
}

/** MapLibre が描くときの基準のタイルの大きさ（px）。マップズーム z で世界の幅は 512×2^z px。 */
const WORLD_TILE_PX = 512

/** メルカトルの緯度の上限（これより極側は平面に乗らない）。 */
const MAX_MERCATOR_LAT = 85.0511

/** 傾きを数える上限。地図側の上限（`JapanMapGL` の `maxPitch: 60`）と揃える。 */
const MAX_PITCH_DEG = 60

function mercatorX(lng: number): number {
  return (lng + 180) / 360
}

function mercatorYOf(lat: number): number {
  const rad = (Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat)) * Math.PI) / 180
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2
}

function latOfMercatorY(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI
}

/** 着地したときに見える範囲を、メルカトル平面の矩形で返す。寸法やズームが数でなければ null。 */
export function mercatorBoxForCamera(view: CameraView, widthPx: number, heightPx: number): MercatorBox | null {
  if (!(widthPx > 0 && heightPx > 0) || !Number.isFinite(view.zoom)) return null
  const [lng, lat] = view.center
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  const rad = ((Number.isFinite(view.bearing) ? view.bearing : 0) * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  const pitch = Number.isFinite(view.pitch) ? Math.min(Math.max(view.pitch, 0), MAX_PITCH_DEG) : 0
  const grow = 1 + Math.tan((pitch * Math.PI) / 180)
  const worldPx = WORLD_TILE_PX * 2 ** view.zoom
  const halfW = ((widthPx * cos + heightPx * sin) * grow) / 2 / worldPx
  const halfH = ((widthPx * sin + heightPx * cos) * grow) / 2 / worldPx
  const cx = mercatorX(lng)
  const cy = mercatorYOf(lat)
  return { x0: cx - halfW, x1: cx + halfW, y0: Math.max(0, cy - halfH), y1: Math.min(1, cy + halfH) }
}

/** 着地したときに見える範囲を、経緯度の矩形で返す（経度は回り込ませず -180〜180 の外へ出ることがある）。 */
export function lngLatBoundsForCamera(
  view: CameraView,
  widthPx: number,
  heightPx: number,
): { west: number; east: number; north: number; south: number } | null {
  const box = mercatorBoxForCamera(view, widthPx, heightPx)
  if (!box) return null
  return {
    west: box.x0 * 360 - 180,
    east: box.x1 * 360 - 180,
    north: latOfMercatorY(box.y0),
    south: latOfMercatorY(box.y1),
  }
}
