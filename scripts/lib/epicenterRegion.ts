// 座標から、いまの気象庁の震央地名を引く。
//
// 長期震源カタログの確定値（年 ZIP）は震央地名を英字でしか持たず、気象庁は日本語の対応表を
// 公表していない。そこで、いまの震央地名の区域（0Quake/JMA_Region の `震央地名.geojson`）に
// 震源の座標を当てて日本語の名前を引く（2026-10-25 ユーザー選択「座標から今の震央地名 (Recommended)」）。
//
// **引けるのは「いまの区域でいえばどこか」で、当時の気象庁が付けた名前ではない。** 区域の線は
// 年代で引き直されており、当時の英字の名前と 1 対 1 には対応しない（2024 年の実測で、英字の名前
// 267 のうち 95% 以上が 1 つの区域へ収まるのは 71）。

/** GeoJSON の座標の輪（[経度, 緯度] の並び）。 */
type Ring = readonly (readonly [number, number])[]

interface RegionShape {
  name: string
  /** 外接矩形。中を調べる前に弾くため。 */
  minLng: number
  maxLng: number
  minLat: number
  maxLat: number
  /** 外周と穴をまとめて持つ。偶奇の規則で判定するので、穴は自然に外れる。 */
  rings: Ring[]
}

export interface EpicenterRegionIndex {
  /** 区域の数（読み込めたかの確かめ用）。 */
  readonly size: number
  /** 座標を含む区域の名前。どの区域にも入らなければ `null`。 */
  lookup(lat: number, lng: number): string | null
}

interface GeoJsonFeature {
  properties?: { name?: unknown } | null
  geometry?: { type?: unknown; coordinates?: unknown } | null
}

/**
 * `震央地名.geojson` の中身から索引を作る。
 *
 * **形が想定と違えば投げる。** 黙って飛ばすと、その区域の地震が英字の名前へ落ちるだけで気づけない。
 */
export function buildEpicenterRegionIndex(geojson: unknown): EpicenterRegionIndex {
  const features = (geojson as { features?: unknown })?.features
  if (!Array.isArray(features) || features.length === 0) {
    throw new Error('震央地名の GeoJSON に区域がありません')
  }
  const shapes: RegionShape[] = []
  for (const f of features as GeoJsonFeature[]) {
    const name = f.properties?.name
    if (typeof name !== 'string' || name === '') throw new Error('震央地名の GeoJSON に名前の無い区域があります')
    const type = f.geometry?.type
    const coords = f.geometry?.coordinates
    let polygons: unknown[]
    if (type === 'Polygon') polygons = [coords]
    else if (type === 'MultiPolygon' && Array.isArray(coords)) polygons = coords
    else throw new Error(`震央地名「${name}」の形が Polygon でも MultiPolygon でもありません: ${String(type)}`)
    const rings: Ring[] = []
    for (const polygon of polygons) {
      if (!Array.isArray(polygon)) throw new Error(`震央地名「${name}」の座標が読めません`)
      for (const ring of polygon) rings.push(readRing(ring, name))
    }
    let minLng = Infinity
    let maxLng = -Infinity
    let minLat = Infinity
    let maxLat = -Infinity
    for (const ring of rings) {
      for (const [x, y] of ring) {
        if (x < minLng) minLng = x
        if (x > maxLng) maxLng = x
        if (y < minLat) minLat = y
        if (y > maxLat) maxLat = y
      }
    }
    shapes.push({ name, minLng, maxLng, minLat, maxLat, rings })
  }

  return {
    size: shapes.length,
    lookup(lat, lng) {
      // **区域が重なるときは GeoJSON の並びで先のものを採る。** 境界線の上の点は、どちらか一方に
      // 決まりさえすればよい（偶奇の規則は境界上で片側にしか入らないことがある）。
      for (const s of shapes) {
        if (lng < s.minLng || lng > s.maxLng || lat < s.minLat || lat > s.maxLat) continue
        if (insideRings(s.rings, lng, lat)) return s.name
      }
      return null
    },
  }
}

function readRing(ring: unknown, name: string): Ring {
  if (!Array.isArray(ring) || ring.length < 3) throw new Error(`震央地名「${name}」に頂点が足りない輪があります`)
  return ring.map((p) => {
    if (!Array.isArray(p) || typeof p[0] !== 'number' || typeof p[1] !== 'number') {
      throw new Error(`震央地名「${name}」に読めない頂点があります`)
    }
    return [p[0], p[1]] as const
  })
}

/** 偶奇の規則。外周と穴をまとめて数えるので、穴の中は外れる。 */
function insideRings(rings: readonly Ring[], x: number, y: number): boolean {
  let inside = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]
      const [xj, yj] = ring[j]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}
