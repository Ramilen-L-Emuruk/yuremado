// ホーム地点を手で入れる欄の読み取り（設定の窓「ホーム地点」。2026-10-25 ユーザー選択「緯度・経度の欄だけ (Recommended)」）。
//
// **範囲の外は丸めずに受け付けない。** 設定の検証（`useSettings.ts` の `sanitize`）は範囲の端へ寄せるが、
// 手入力で端へ寄せると、打ち間違い（経度を 1370 と打った等）が黙って別の地点になる。

/** 全角の数字・記号を半角へ寄せる（日本語入力のまま打たれても読めるように）。 */
function toHalfWidth(text: string): string {
  return text
    .replace(/[０-９．－＋]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[，、]/g, ',')
    .replace(/ー|−/g, '-')
}

/** 1 つの数として読む。読めなければ `null`。 */
export function parseCoordinateNumber(text: string): number | null {
  const t = toHalfWidth(text).trim()
  if (!/^[-+]?\d+(\.\d+)?$/.test(t)) return null
  const v = Number(t)
  return Number.isFinite(v) ? v : null
}

/** 緯度・経度として使える組か（範囲の外は受け付けない）。 */
export function isValidHomeLocation(lat: number | null, lng: number | null): boolean {
  return lat !== null && lng !== null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

/**
 * 「37.5, 137.2」のように 1 つの欄へ貼られた組を割る。地図の道具から写した形（緯度・経度の順で、
 * 読点か空白で区切る）だけを読む。組として読めなければ `null`（1 つの数として扱う）。
 */
export function splitPastedLatLng(text: string): { lat: string; lng: string } | null {
  const parts = toHalfWidth(text).trim().split(/\s*,\s*|\s+/).filter(p => p !== '')
  if (parts.length !== 2) return null
  if (parseCoordinateNumber(parts[0]) === null || parseCoordinateNumber(parts[1]) === null) return null
  return { lat: parts[0], lng: parts[1] }
}
