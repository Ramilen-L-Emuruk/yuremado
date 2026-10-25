// テストボタン用の推計震度分布図（IXAC41）を、**合成の二進電文**として書き出す
// （→ `public/data/test-telegrams/synthetic/`）。
//
// ## なぜ合成なのか
//
// 推計震度分布図はこのアプリで唯一の二進電文（BUFR）で、**国立情報学研究所のアーカイブにも
// 気象庁のサンプル電文集にも無い**。実電文は配信元の利用規約でリポジトリへ入れられないので、
// ほかのテストボタンのように「置いた電文をパーサーへ通す」形にするには、こちらで組むしかない
// （2026-10-22 ユーザー選択「合成の二進電文を作る」）。
//
// ## 何に合わせて組むか
//
// **本番の復号器（`src/utils/bufrEstimatedIntensity.ts`）が受け取る形**にそのまま合わせる。
// 記述子の並び・ビット幅・節の構造は、あちらが資料（配信資料に関する仕様 No.40102 ほか）から
// 写した読み取り順と 1 対 1 で、**読めなければここで失敗する**（書き出す前に自分で復号し直す）。
//
// **分布そのものは合成**。実電文の分布を写すことはできないので、震源を中心に距離で減衰する
// 同心円を置く。**大きさだけは実物に合わせる**（2026-10-25 ユーザー選択「実物と同じ規模で作り直す
// (Recommended)」）—— 能登本震の実電文は 518,037 セル・2 断片（511,900 ＋ 402,970 バイト）。
// 小さく作ると、分割配信の結合・50 万セルの塗りという実配信でしか通らない経路が一度も通らない。
//
// ## 分割して書き出す
//
// 実配信と同じく **1 報目を 511,900 バイトで切り、残りを続きの断片（`RRA`）にする**
// （→ `src/services/bufrTelegramAssembly.ts`）。台本はこれを本番の結合部品へ通してから読む。
import { writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeEstimatedIntensity, CELL_LAT_DEG, CELL_LON_DEG } from '../src/utils/bufrEstimatedIntensity'
import { BufrFragmentStore } from '../src/services/bufrTelegramAssembly'

/** 書き出し先。テストボタンの台本が読む場所。 */
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'test-telegrams', 'synthetic')

/**
 * 記述子の並び（IXAC41・津波ブロックなし）。**復号器の `DESCRIPTORS_HEAD` ＋
 * `DESCRIPTORS_MESH_QUARTER` と同じ並び**で、1 つでも違えばあちらが読まない。
 */
const DESCRIPTORS = [
  '1-05-000', '0-31-001', '0-08-193', '0-08-198', '0-60-003', '0-60-002', '0-60-002',
  '0-01-242', '3-01-011', '3-01-012', '0-01-240',
  '0-05-002', '0-06-002', '2-02-123', '0-07-061', '2-02-000', '0-60-001',
  '1-13-000', '0-31-002', '0-05-240', '0-06-240', '0-05-241', '0-06-241',
  '1-07-000', '0-31-001', '0-05-242', '0-06-242',
  '1-03-000', '0-31-003', '0-05-243', '0-06-243', '0-60-002',
]

/** ビット単位で書く（BUFR はオクテット境界を跨いでフィールドが並ぶ）。 */
class BitWriter {
  private bits: number[] = []
  write(value: number, width: number): void {
    if (value < 0 || value >= 2 ** width) throw new Error(`幅 ${width} ビットに収まりません: ${value}`)
    for (let i = width - 1; i >= 0; i--) this.bits.push((value >> i) & 1)
  }
  get length(): number { return this.bits.length }
  /** バイト境界まで 0 を詰めて配列にする。 */
  toBytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8))
    this.bits.forEach((b, i) => { if (b) out[i >> 3] |= 1 << (7 - (i & 7)) })
    return out
  }
}

/** 記述子（`F-XX-YYY`）を 2 オクテットへ。 */
function descriptorBytes(desc: string): [number, number] {
  const [f, x, y] = desc.split('-').map(Number)
  const v = (f << 14) | (x << 8) | y
  return [(v >> 8) & 0xff, v & 0xff]
}

/** 階級震度と計測震度の対応（凡例）。震度4〜7 の 6 行（5 と 6 は弱・強に分かれる）。 */
const GRADES: { scale: number; modifier: 0 | 1 | 2; lower: number; upper: number }[] = [
  { scale: 4, modifier: 0, lower: 35, upper: 44 },
  { scale: 5, modifier: 1, lower: 45, upper: 49 },
  { scale: 5, modifier: 2, lower: 50, upper: 54 },
  { scale: 6, modifier: 1, lower: 55, upper: 59 },
  { scale: 6, modifier: 2, lower: 60, upper: 64 },
  { scale: 7, modifier: 0, lower: 65, upper: 70 },
]

export interface SyntheticEstimatedIntensity {
  /** 地震発現時刻（UTC）。**地震カードとの結び付けはこの時刻だけ**（電文は識別子を持たない）。 */
  arrival: Date
  lat: number
  lon: number
  depthKm: number
  /** 規模（0.1 刻み。`6.5` なら 65 を書く）。 */
  magnitude: number
  /** 震央の区域コード（0-01-240）。 */
  areaCode: number
  /** いちばん強いセルの計測震度（0.1 刻み。`55` = 震度6弱）。震源から離れるほど下がる。 */
  peakSi: number
  /** 分布の広がり（度）。この距離で計測震度が 10（震度1 相当）まで落ちる。 */
  radiusDeg: number
}

/** 1 次メッシュの緯度の刻み（復号器の `LAT1`。2/3 度）。 */
const LAT1 = 2 / 3

/**
 * 組んだ電文と、**組んだ側が数えた値**。
 *
 * **検算に使う。** 復号器へ通して「読めた」だけでは、ビット幅を取り違えて途中で切れても
 * 気づけない（先頭の数セルが読めれば `count` は 0 にならない）。組んだ側の数と突き合わせる。
 */
export interface BuiltBufr {
  bytes: Uint8Array
  /** 書き込んだセルの数。 */
  cellCount: number
  /** いちばん強いセルの計測震度（0.1 刻み）。 */
  maxSi: number
}

/**
 * 震源を中心に距離で減衰する分布を組み、BUFR（IXAC41）のバイト列にする。
 *
 * **セルは 1/4 地域メッシュ**（緯度 `CELL_LAT_DEG`・経度 `CELL_LON_DEG`）。メッシュの入れ子
 * （1 次 → 2 次 → 3 次 → 1/2・1/4）は復号器の `cellLat` / `cellLon` の逆算で組む。
 */
export function buildEstimatedIntensityBufr(spec: SyntheticEstimatedIntensity): BuiltBufr {
  // セルを集める。**メッシュの入れ子ごとにまとめる**（電文の構造がそうなっている）。
  type Cell = { half: number; quarter: number; si: number }
  type Third = Map<string, Cell[]>
  const second = new Map<string, Third>()
  const steps = Math.ceil(spec.radiusDeg / CELL_LAT_DEG)
  for (let dy = -steps; dy <= steps; dy++) {
    for (let dx = -steps; dx <= steps; dx++) {
      const lat = spec.lat + dy * CELL_LAT_DEG
      const lon = spec.lon + dx * CELL_LON_DEG
      // 距離（度）。経度は緯度で縮むが、合成の分布なので簡単な近似でよい
      const dist = Math.hypot(dy * CELL_LAT_DEG, dx * CELL_LON_DEG * Math.cos((lat * Math.PI) / 180))
      if (dist > spec.radiusDeg) continue
      const si = Math.round(spec.peakSi - (spec.peakSi - 10) * (dist / spec.radiusDeg))
      if (si < 10) continue
      // 復号器の `cellLat` / `cellLon` を逆算してメッシュ番号を出す
      const p1 = Math.floor(lat / LAT1)
      const q2 = Math.floor((lat - p1 * LAT1) / (LAT1 / 8))
      const r3 = Math.floor((lat - p1 * LAT1 - q2 * (LAT1 / 8)) / (LAT1 / 80))
      const halfLat = Math.floor((lat - p1 * LAT1 - q2 * (LAT1 / 8) - r3 * (LAT1 / 80)) / (LAT1 / 160))
      const quarterLat = Math.floor((lat - p1 * LAT1 - q2 * (LAT1 / 8) - r3 * (LAT1 / 80) - halfLat * (LAT1 / 160)) / (LAT1 / 320))
      const u1 = Math.floor(lon) - 100
      const v2 = Math.floor((lon - Math.floor(lon)) * 8)
      const w3 = Math.floor((lon - Math.floor(lon) - v2 / 8) * 80)
      const halfLon = Math.floor((lon - Math.floor(lon) - v2 / 8 - w3 / 80) * 160)
      const quarterLon = Math.floor((lon - Math.floor(lon) - v2 / 8 - w3 / 80 - halfLon / 160) * 320)
      if (p1 < 0 || u1 < 0 || q2 < 0 || q2 > 7 || v2 < 0 || v2 > 7 || r3 < 0 || r3 > 9 || w3 < 0 || w3 > 9) continue
      if (halfLat < 0 || halfLat > 1 || halfLon < 0 || halfLon > 1 || quarterLat < 0 || quarterLat > 1 || quarterLon < 0 || quarterLon > 1) continue
      // 1/2 と 1/4 は「1〜4」で、下位ビットが経度・上位が緯度（復号器の `cellLat` / `cellLon`）
      const half = (halfLat << 1 | halfLon) + 1
      const quarter = (quarterLat << 1 | quarterLon) + 1
      const secondKey = `${p1},${u1},${q2},${v2}`
      const thirdKey = `${r3},${w3}`
      const thirds = second.get(secondKey) ?? new Map<string, Cell[]>()
      second.set(secondKey, thirds)
      const cells = thirds.get(thirdKey) ?? []
      thirds.set(thirdKey, cells)
      cells.push({ half, quarter, si })
    }
  }
  if (second.size === 0) throw new Error('セルが 1 つも作れませんでした')
  // **数えるのは書き込む前。** 復号結果と突き合わせて、ビット幅の取り違えで途中が切れても
  // 気づけるようにする（→ `BuiltBufr`）。
  let cellCount = 0
  let maxSi = 0
  for (const thirds of second.values()) {
    for (const cells of thirds.values()) {
      cellCount += cells.length
      for (const c of cells) maxSi = Math.max(maxSi, c.si)
    }
  }

  // ── 第4節の中身 ──
  const w = new BitWriter()
  w.write(GRADES.length, 8)
  for (const g of GRADES) {
    w.write(90, 7)            // 0-08-193 要素の修飾（実電文では常に 90）
    w.write(g.modifier, 2)    // 0-08-198
    w.write(g.scale, 4)       // 0-60-003
    w.write(g.lower, 7)       // 0-60-002 下限
    w.write(g.upper, 7)       // 0-60-002 上限
  }
  w.write(0, 7)                              // 0-01-242 電文の種類（0＝通常）
  w.write(spec.arrival.getUTCFullYear(), 12)
  w.write(spec.arrival.getUTCMonth() + 1, 4)
  w.write(spec.arrival.getUTCDate(), 6)
  w.write(spec.arrival.getUTCHours(), 5)
  w.write(spec.arrival.getUTCMinutes(), 6)
  w.write(spec.areaCode, 10)                 // 0-01-240
  w.write(Math.round(spec.lat * 100) + 9000, 15)   // 0-05-002
  w.write(Math.round(spec.lon * 100) + 18000, 16)  // 0-06-002
  w.write(spec.depthKm, 14)                  // 0-07-061
  w.write(Math.round(spec.magnitude * 10), 7)      // 0-60-001
  w.write(second.size, 16)                   // 0-31-002 2 次メッシュの数
  for (const [secondKey, thirds] of second) {
    const [p1, u1, q2, v2] = secondKey.split(',').map(Number)
    w.write(p1, 7); w.write(u1, 7)
    w.write(q2, 4); w.write(v2, 4)
    w.write(thirds.size, 8)
    for (const [thirdKey, cells] of thirds) {
      const [r3, w3] = thirdKey.split(',').map(Number)
      w.write(r3, 4); w.write(w3, 4)
      w.write(cells.length, 8)
      for (const c of cells) {
        w.write(c.half, 3); w.write(c.quarter, 3); w.write(c.si, 7)
      }
    }
  }
  const payload = w.toBytes()

  // ── 節を組む ──
  // **第4節の余りビットは復号器の許容範囲（8〜23）に入れる。** 気象庁の実装はデータの後に
  // 1 オクテット余分を置き、そこへバイト境界の詰め物と偶数オクテット揃えが乗る（→ 復号器の
  // `leftoverMin` / `leftoverMax`）。ここでは「詰め物 ＋ 1 オクテット」で 8〜15 ビットにする。
  const s4len = 4 + payload.length + 1
  const section4 = new Uint8Array(s4len)
  section4[0] = (s4len >> 16) & 0xff; section4[1] = (s4len >> 8) & 0xff; section4[2] = s4len & 0xff
  section4.set(payload, 4)

  const s1len = 18
  const section1 = new Uint8Array(s1len)
  section1[0] = 0; section1[1] = 0; section1[2] = s1len
  section1[3] = 0      // BUFR 主テーブル
  section1[4] = 34     // 発信中枢（気象庁）
  section1[6] = 0      // 更新番号
  section1[7] = 0      // 第2節なし
  section1[8] = 11     // 資料種別（地震）
  section1[9] = 2      // 資料細分種別
  const t = spec.arrival
  section1[12] = t.getUTCFullYear() % 100
  section1[13] = t.getUTCMonth() + 1
  section1[14] = t.getUTCDate()
  section1[15] = t.getUTCHours()
  section1[16] = t.getUTCMinutes()

  const s3len = 7 + DESCRIPTORS.length * 2 + (DESCRIPTORS.length % 2 === 0 ? 1 : 0)
  const section3 = new Uint8Array(s3len)
  section3[0] = (s3len >> 16) & 0xff; section3[1] = (s3len >> 8) & 0xff; section3[2] = s3len & 0xff
  section3[4] = 0; section3[5] = 1   // データサブセット数 1
  section3[6] = 0x80                 // 観測資料・非圧縮
  DESCRIPTORS.forEach((d, i) => {
    const [hi, lo] = descriptorBytes(d)
    section3[7 + i * 2] = hi
    section3[8 + i * 2] = lo
  })

  const total = 8 + s1len + s3len + s4len + 4
  const out = new Uint8Array(total)
  out.set([0x42, 0x55, 0x46, 0x52], 0)   // 'BUFR'
  out[4] = (total >> 16) & 0xff; out[5] = (total >> 8) & 0xff; out[6] = total & 0xff
  out[7] = 3                              // 版
  out.set(section1, 8)
  out.set(section3, 8 + s1len)
  out.set(section4, 8 + s1len + s3len)
  out.set([0x37, 0x37, 0x37, 0x37], total - 4)   // '7777'
  return { bytes: out, cellCount, maxSi }
}

/**
 * 1 報目の大きさ（バイト）。能登本震の実電文の 1 報目がちょうどこの長さで、残りが `RRA` で届いた。
 * 気象庁の分割の規則そのもの（どこで切るか）は確かめていないので、**実測の値をそのまま使う**。
 */
export const FIRST_FRAGMENT_BYTES = 511_900

/** 続きの断片の分割報符号（IXAC41 の遅延報。→ `bufrTelegramAssembly.ts` の `fragmentIndex`）。 */
const CONTINUATION_DESIGNATIONS = ['RRA', 'RRB', 'RRC'] as const

/** 断片のファイル名。1 報目は `<name>.bufr`、続きは `<name>.rra.bufr` のように符号を挟む。 */
export function fragmentFileName(base: string, designation: string | null): string {
  return designation === null ? `${base}.bufr` : `${base}.${designation.toLowerCase()}.bufr`
}

/** 組んだ電文を実配信と同じ大きさで切る。 */
export function splitIntoFragments(bytes: Uint8Array): { designation: string | null; bytes: Uint8Array }[] {
  const out: { designation: string | null; bytes: Uint8Array }[] = []
  for (let offset = 0, i = 0; offset < bytes.length; offset += FIRST_FRAGMENT_BYTES, i++) {
    const designation = i === 0 ? null : CONTINUATION_DESIGNATIONS[i - 1]
    if (designation === undefined) throw new Error(`断片が多すぎます（${bytes.length} バイト）`)
    out.push({ designation, bytes: bytes.subarray(offset, offset + FIRST_FRAGMENT_BYTES) })
  }
  return out
}

/**
 * 書き出す電文。**地震テストと同じ能登本震の震源**に合わせる（地震カードとは発現時刻で結び付く）。
 *
 * **続報は実電文と同じ規模**（518,037 セル・最大は震度7）に合わせる。初報はそれより狭く弱い分布にして、
 * 続報で広がる形を作る（続報で分布が差し替わることを見るため）。どちらも 2 断片になる。
 */
const TARGETS = [
  {
    base: 'estimated-intensity-1',
    label: '初報',
    // 能登本震（2024-01-01 16:10 JST = 07:10 UTC）
    spec: { arrival: new Date(Date.UTC(2024, 0, 1, 7, 10)), lat: 37.5, lon: 137.2, depthKm: 16, magnitude: 7.6, areaCode: 390, peakSi: 62, radiusDeg: 0.78 },
  },
  {
    base: 'estimated-intensity-2',
    label: '続報（分布が広がる）',
    spec: { arrival: new Date(Date.UTC(2024, 0, 1, 7, 10)), lat: 37.5, lon: 137.2, depthKm: 16, magnitude: 7.6, areaCode: 390, peakSi: 67, radiusDeg: 0.923 },
  },
] as const

/**
 * 組んだ電文を**本番の復号器へ通し、組んだ値と突き合わせる**。
 *
 * **「読めた」だけでは足りない。** ビット幅を取り違えて途中で切れても、先頭の数セルが読めれば
 * `count` は 0 にならない。発現時刻がずれれば地震カードと結び付かず（引き当ては発現時刻だけ）、
 * **画面には「ボタンが出ない」としか現れない**。
 */
function verify(built: BuiltBufr, spec: SyntheticEstimatedIntensity, file: string): void {
  const decoded = decodeEstimatedIntensity(built.bytes, 'test', new Date().toISOString(), 'IXAC41')
  if (!decoded) throw new Error(`組んだ電文を復号できませんでした: ${file}`)
  const check = (name: string, got: unknown, want: unknown): void => {
    if (got !== want) throw new Error(`${file}: ${name} が合いません（組んだ値 ${String(want)} / 読めた値 ${String(got)}）`)
  }
  check('セル数', decoded.count, built.cellCount)
  // `si` は確保長が `count` より長いことがあるので、有効な範囲だけ見る。**展開（`Math.max(...)`）は
  // 使わない** —— 実物と同じ 50 万セルでは引数が多すぎて呼び出しの積み上げが溢れる。
  check('最大計測震度', extent(decoded.si, decoded.count).max, built.maxSi)
  check('地震発現時刻', decoded.arrivalTime, spec.arrival.toISOString())
  check('震源の緯度', Math.round(decoded.hypocenter.lat * 100), Math.round(spec.lat * 100))
  check('震源の経度', Math.round(decoded.hypocenter.lon * 100), Math.round(spec.lon * 100))
  check('震源の深さ', decoded.hypocenter.depthKm, spec.depthKm)
  check('規模', Math.round(decoded.magnitude * 10), Math.round(spec.magnitude * 10))
  check('震央の区域コード', decoded.areaCode, spec.areaCode)
  check('凡例の行数', decoded.grades.length, GRADES.length)
  // **セルの位置も見る。** 件数と最大値だけでは、メッシュ番号の逆算が崩れて格子ごとずれても
  // 通る（塗られる場所だけが動くので、画面でも気づきにくい）。組んだ分布は震源を中心にした
  // 半径 `radiusDeg` の円なので、復号した座標がその範囲（セル 1 つ分の余裕つき）に収まるか見る。
  const lats = extent(decoded.lat, decoded.count)
  const lons = extent(decoded.lon, decoded.count)
  const outside = (e: { min: number; max: number }, center: number, span: number): boolean =>
    e.min < center - span || e.max > center + span
  // **経度は緯度で縮む。** 距離の判定が `経度差 × cos(緯度)` なので、経度方向は 1/cos だけ広がる
  const lonSpan = spec.radiusDeg / Math.cos((spec.lat * Math.PI) / 180) + CELL_LON_DEG
  if (outside(lats, spec.lat, spec.radiusDeg + CELL_LAT_DEG) || outside(lons, spec.lon, lonSpan)) {
    throw new Error(`${file}: セルの位置が組んだ範囲から外れています`
      + `（緯度 ${lats.min.toFixed(4)}〜${lats.max.toFixed(4)}`
      + ` / 経度 ${lons.min.toFixed(4)}〜${lons.max.toFixed(4)}`
      + ` / 震源 ${spec.lat},${spec.lon} 半径 ${spec.radiusDeg}）`)
  }
}

/** 先頭 `count` 個の最小・最大。 */
function extent(values: ArrayLike<number>, count: number): { min: number; max: number } {
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < count; i++) {
    if (values[i] < min) min = values[i]
    if (values[i] > max) max = values[i]
  }
  return { min, max }
}

/**
 * 切った断片を**本番の結合部品へ通し**、元のバイト列へ戻ることを確かめる。台本も同じ部品で
 * 組み立てるので、ここで戻らなければテストボタンでは分布が 1 セルも出ない。
 */
function verifyFragments(fragments: { designation: string | null; bytes: Uint8Array }[], whole: Uint8Array, base: string): void {
  if (fragments.length < 2) throw new Error(`${base}: 実配信と同じく 2 断片以上になる大きさで組んでください（${whole.length} バイト）`)
  const store = new BufrFragmentStore()
  let assembled: Uint8Array | null = null
  for (const f of fragments) {
    assembled = store.add(base, f.designation, f.bytes, 0)
  }
  if (assembled === null) throw new Error(`${base}: 断片を結合できませんでした`)
  if (assembled.length !== whole.length || assembled.some((b, i) => b !== whole[i])) {
    throw new Error(`${base}: 結合した電文が組んだものと一致しません`)
  }
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true })
  // **全部を検算してから書き出す。** 1 本ずつ書くと、2 本目で落ちたときに初報だけ新しくなり、
  // 初報と続報が食い違ったまま残る。
  const built = TARGETS.map((target) => {
    const b = buildEstimatedIntensityBufr(target.spec)
    verify(b, target.spec, target.base)
    const fragments = splitIntoFragments(b.bytes)
    verifyFragments(fragments, b.bytes, target.base)
    return { target, built: b, fragments }
  })
  // 前の版の断片を消す（断片の数が減ったとき、古い続きが残って台本と食い違わないように）
  for (const name of readdirSync(OUT_DIR)) {
    if (TARGETS.some(t => name.startsWith(`${t.base}.`) && name.endsWith('.bufr'))) rmSync(join(OUT_DIR, name))
  }
  for (const { target, built: b, fragments } of built) {
    for (const f of fragments) writeFileSync(join(OUT_DIR, fragmentFileName(target.base, f.designation)), f.bytes)
    const sizes = fragments.map(f => f.bytes.length).join(' ＋ ')
    console.log(`${target.base}（${target.label}）: ${b.bytes.length} バイト（${sizes}）・${b.cellCount} セル・最大計測震度 ${b.maxSi / 10}`)
  }
}

// **直接実行のときだけ走らせる。** 他のモジュールから定数を 1 つ読むための import で
// 生成処理まで走らないようにする（→ `scripts/scriptEntrypoints.test.ts`）。
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main()
}
