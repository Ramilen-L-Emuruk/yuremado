// PB2002（Bird, 2003）プレート境界モデルの GeoJSON から、
// 全球のプレート境界線を地図表示用の軽量なテーブルへ変換する。
//
// 出力: public/data/plate-boundaries.json
//   [ { "plateA": "太平洋プレート", "plateB": "オホーツクプレート", "type": "SUB",
//       "lines": [ [ [lat,lon], ... ] ] }, ... ]
//   type は原典の 7 分類（SUB・OCB・CCB・OSR・CRB・OTF・CTF。→ lib/plateSteps.mjs）。
//   **分類は配布元の GeoJSON に無い**ので、原典の PB2002_steps.dat（歩ごとの分類）を端点で突き合わせ、
//   同じ分類が続く区間ごとに線を割って 1 件にする。
//
// 遠地地震（震源が国外）を選ぶと地図は世界規模まで引くため、日本周辺だけを切り出すと
// 線が宙に浮いて見える。全球を保持しても座標は約 6,300 点（生成物で約 130KB）に収まり、
// このデータは地図初回表示時の遅延読込なので初期表示には影響しない。
//
// データ出典: PB2002 (Bird, P., 2003, "An updated digital model of plate boundaries",
//   Geochemistry Geophysics Geosystems 4(3))
//   配布元GeoJSON: https://github.com/fraxen/tectonicplates （Open Data Commons Attribution License）
//
// 更新方法: node scripts/build-plate-boundaries.mjs
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { indexSteps, parseSteps, splitLineByClass } from './lib/plateSteps.mjs'

const SOURCE_URL =
  'https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_boundaries.json'
/** 原典の歩（7 分類）。配布元の GeoJSON は分類を持たないので、原典の配布元から取る。 */
const STEPS_URL = 'http://peterbird.name/oldFTP/PB2002/PB2002_steps.dat.txt'
/** 歩に当たらない区間の割合の上限。超えたら原典か配布元の形が変わっている。 */
const MAX_UNMATCHED_RATIO = 0.01

// PB2002 のプレート略号 → 日本語表記（全 52 プレート）。
// 英語の正式名称は配布元 PB2002_plates.json の PlateName に一致させている。
const PLATE_NAMES = {
  AF: 'アフリカプレート',
  AM: 'アムールプレート',
  AN: '南極プレート',
  AP: 'アルティプラノプレート',
  AR: 'アラビアプレート',
  AS: 'エーゲ海プレート',
  AT: 'アナトリアプレート',
  AU: 'オーストラリアプレート',
  BH: 'バーズヘッドプレート',
  BR: 'バルモラルリーフプレート',
  BS: 'バンダ海プレート',
  BU: 'ビルマプレート',
  CA: 'カリブプレート',
  CL: 'カロリンプレート',
  CO: 'ココスプレート',
  CR: 'コンウェイリーフプレート',
  EA: 'イースタープレート',
  EU: 'ユーラシアプレート',
  FT: 'フツナプレート',
  GP: 'ガラパゴスプレート',
  IN: 'インドプレート',
  JF: 'フアン・デ・フカプレート',
  JZ: 'フアン・フェルナンデスプレート',
  KE: 'ケルマデックプレート',
  MA: 'マリアナプレート',
  MN: 'マヌスプレート',
  MO: 'マオケプレート',
  MS: 'モルッカ海プレート',
  NA: '北アメリカプレート',
  NB: '北ビスマルクプレート',
  ND: '北アンデスプレート',
  NH: 'ニューヘブリデスプレート',
  NI: 'ニウアフォオウプレート',
  NZ: 'ナスカプレート',
  OK: 'オホーツクプレート',
  ON: '沖縄プレート',
  PA: '太平洋プレート',
  PM: 'パナマプレート',
  PS: 'フィリピン海プレート',
  RI: 'リベラプレート',
  SA: '南アメリカプレート',
  SB: '南ビスマルクプレート',
  SC: 'スコシアプレート',
  SL: 'シェトランドプレート',
  SO: 'ソマリアプレート',
  SS: 'ソロモン海プレート',
  SU: 'スンダプレート',
  SW: 'サンドイッチプレート',
  TI: 'ティモールプレート',
  TO: 'トンガプレート',
  WL: 'ウッドラークプレート',
  YA: '揚子江プレート',
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'public', 'data')
const OUT_FILE = join(OUT_DIR, 'plate-boundaries.json')

function plateName(code) {
  return PLATE_NAMES[code] ?? code
}

/** GeoJSON の [lon,lat] を [lat,lon] に変換し、約100m精度に丸める。 */
function toLatLng([lon, lat]) {
  return [Math.round(lat * 1000) / 1000, Math.round(lon * 1000) / 1000]
}

async function main() {
  console.log(`取得中: ${SOURCE_URL}`)
  const res = await fetch(SOURCE_URL)
  if (!res.ok) throw new Error(`元データを取得できなかった: ${res.status}`)
  const geojson = await res.json()
  console.log(`取得中: ${STEPS_URL}`)
  const stepsRes = await fetch(STEPS_URL)
  if (!stepsRes.ok) throw new Error(`原典の歩を取得できなかった: ${stepsRes.status}`)
  const grid = indexSteps(parseSteps(await stepsRes.text()))

  // 配布元データは日付変更線で既に分割済み（経度は -180〜180 に収まり、隣接点の経度差が
  // 180 を超える箇所は無い）。そのため地球を一周する横線は生じず、追加の分割処理は不要。
  const segments = []
  let total = 0
  let unmatched = 0
  const unclassified = []
  for (const f of geojson.features) {
    const coords = f.geometry.coordinates
    total += coords.length - 1
    const split = splitLineByClass(grid, coords)
    const plateA = plateName(f.properties.PlateA)
    const plateB = plateName(f.properties.PlateB)
    if (!split) {
      unclassified.push(`${f.properties.PlateA}-${f.properties.PlateB}`)
      continue
    }
    unmatched += split.unmatched
    for (const run of split.runs) {
      segments.push({ plateA, plateB, type: run.cls, lines: [run.coords.map(toLatLng)] })
    }
  }
  // **分類を推測で付けない。** 1 区間も歩に当たらない線は止める（配布元か原典の形が変わっている）。
  if (unclassified.length > 0) {
    throw new Error(`原典の歩に 1 区間も当たらない境界線があります: ${unclassified.join(', ')}`)
  }
  console.log(`区間 ${total} のうち、歩に当たらず隣の分類を引き継いだもの ${unmatched}`)
  if (unmatched / total > MAX_UNMATCHED_RATIO) {
    throw new Error(`歩に当たらない区間が ${unmatched}/${total} あります。原典か配布元の座標が変わっています`)
  }

  const unknown = [...new Set(
    geojson.features.flatMap((f) => [f.properties.PlateA, f.properties.PlateB]),
  )].filter((code) => !PLATE_NAMES[code])
  if (unknown.length > 0) {
    // 配布元にプレートが追加された場合の気付き用（略号のまま表示されるため実害は無い）。
    console.warn(`対応表に無いプレートの記号（そのまま出す）: ${unknown.join(', ')}`)
  }

  console.log(`境界の線分を ${segments.length} 本取り出した`)

  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(OUT_FILE, JSON.stringify(segments))
  console.log(`${OUT_FILE} を書いた`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
