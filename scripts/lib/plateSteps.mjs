// PB2002 の「歩」（PB2002_steps.dat）が持つ 7 分類を、配布元 GeoJSON の境界線へ割り当てる。
//
// 歩は境界線の隣り合う 2 点を結ぶ短い弧で、1 歩ごとに分類が付く（同じ境界でも向きで分類が変わる）。
// 配布元の GeoJSON は分類を持たず「沈み込みか否か」しか無いので、線の各区間を歩へ端点で突き合わせ、
// 同じ分類が続く区間ごとに線を割る。
//
// 分類（原典 2001GC000252_readme.txt）: SUB 沈み込み帯／OCB 海洋の収束境界／CCB 大陸の収束境界／
// OSR 海洋の拡大軸／CRB 大陸のリフト／OTF 海洋のトランスフォーム断層／CTF 大陸のトランスフォーム断層

/** 原典の 7 分類。 */
export const PLATE_STEP_CLASSES = ['SUB', 'OCB', 'CCB', 'OSR', 'CRB', 'OTF', 'CTF']

/** 端点を同じとみなす幅（度）。歩は小数 3 桁で、配布元の座標を丸めると 1 桁ずれることがある。 */
const ENDPOINT_TOL = 0.0015

/**
 * PB2002_steps.dat の本文を読む。1 行 1 歩で、2 列目が境界の組（続きの歩は頭に `:`）、
 * 3〜6 列目が始点・終点の経度緯度、15 列目が分類（続きは頭に `:`、造山帯の中は末尾に `*`）。
 *
 * @returns {{ lon1: number, lat1: number, lon2: number, lat2: number, cls: string }[]}
 */
export function parseSteps(text) {
  const steps = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/)
    if (t.length < 15) continue
    const [lon1, lat1, lon2, lat2] = t.slice(2, 6).map(Number)
    const cls = t[14].replace(':', '').replace('*', '')
    if (![lon1, lat1, lon2, lat2].every(Number.isFinite) || !PLATE_STEP_CLASSES.includes(cls)) {
      throw new Error(`歩の行を読めません: ${line.trim()}`)
    }
    steps.push({ lon1, lat1, lon2, lat2, cls })
  }
  return steps
}

/** 歩を始点の 0.1 度格子で引けるようにする（向きは両方向で引く）。 */
export function indexSteps(steps) {
  const grid = new Map()
  const put = (lon, lat, entry) => {
    const key = `${Math.round(lon * 10)},${Math.round(lat * 10)}`
    const list = grid.get(key)
    if (list) list.push(entry)
    else grid.set(key, [entry])
  }
  for (const s of steps) {
    put(s.lon1, s.lat1, { lon2: s.lon2, lat2: s.lat2, lon1: s.lon1, lat1: s.lat1, cls: s.cls })
    put(s.lon2, s.lat2, { lon2: s.lon1, lat2: s.lat1, lon1: s.lon2, lat1: s.lat2, cls: s.cls })
  }
  return grid
}

const near = (a, b) => Math.abs(a - b) <= ENDPOINT_TOL

/** 始点 (lon,lat) の近くから出る歩のうち、`match` に合う最初のものの分類。 */
function findFrom(grid, lon, lat, match) {
  const cx = Math.round(lon * 10)
  const cy = Math.round(lat * 10)
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const e of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
        if (near(e.lon1, lon) && near(e.lat1, lat) && match(e)) return e.cls
      }
    }
  }
  return null
}

/** 経度 ±180 ちょうどの点か（配布元が日付変更線で線を割るために足した点）。 */
const onDateline = (lon) => Math.abs(lon) === 180

/**
 * 区間 [lon,lat]→[lon,lat] の分類。見つからなければ null。
 *
 * 片方の端が ±180 ちょうどなら、それは配布元が日付変更線で割るために足した点で、原典では
 * 日付変更線をまたぐ 1 歩の途中にある。もう一方の端から出て日付変更線をまたぐ歩（向こう端の経度の
 * 符号が逆で、絶対値が 170 度を超える）を探す。
 */
export function classOfSegment(grid, [lonA, latA], [lonB, latB]) {
  const direct = findFrom(grid, lonA, latA, (e) => near(e.lon2, lonB) && near(e.lat2, latB))
  if (direct) return direct
  const crosses = (from) => (e) => Math.sign(e.lon2) !== Math.sign(from) && Math.abs(e.lon2) > 170
  if (onDateline(lonB) && !onDateline(lonA)) return findFrom(grid, lonA, latA, crosses(lonA))
  if (onDateline(lonA) && !onDateline(lonB)) return findFrom(grid, lonB, latB, crosses(lonB))
  return null
}

/**
 * 1 本の線（[lon,lat] の列）を、同じ分類が続く区間ごとに割る。
 *
 * **歩に当たらない区間は、同じ線の直前の区間の分類を引き継ぐ**（先頭なら直後の区間）。
 * 当たらないのは配布元が日付変更線で線を割るために足した点の前後で、原典ではその両側が 1 つの歩。
 * 線の全区間が当たらなければ `null` を返す（推測で分類を付けない）。
 *
 * @returns {{ runs: { cls: string, coords: [number, number][] }[], unmatched: number } | null}
 */
export function splitLineByClass(grid, coords) {
  const classes = []
  for (let i = 0; i + 1 < coords.length; i++) classes.push(classOfSegment(grid, coords[i], coords[i + 1]))
  const unmatched = classes.filter((c) => c === null).length
  if (unmatched === classes.length) return null
  for (let i = 0; i < classes.length; i++) if (classes[i] === null && i > 0) classes[i] = classes[i - 1]
  for (let i = classes.length - 1; i >= 0; i--) if (classes[i] === null) classes[i] = classes[i + 1]
  const runs = []
  for (let i = 0; i < classes.length; i++) {
    const last = runs[runs.length - 1]
    if (last && last.cls === classes[i]) last.coords.push(coords[i + 1])
    else runs.push({ cls: classes[i], coords: [coords[i], coords[i + 1]] })
  }
  return { runs, unmatched }
}
