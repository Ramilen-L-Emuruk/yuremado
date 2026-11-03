// 津波予報区ごとに、海岸線が通る都道府県を求めて src/data/tsunamiZonePrefectures.ts に書く。
// 設定「通知する地域」で津波の通知を県で絞るのに使う（docs/relay-server-design.md §6.7）。
//
// 入力は生成済みの public/data/tsunami-zones.json（予報区の名前 → 海岸線の [緯度, 経度] の線）と
// public/data/prefectures.json（県の名前 → 境界の輪）。ネットワークには出ない。
// 海岸線の点を全部、県の輪に当て（輪の中か、外れたら最も近い県）、点の 1.5% 以上を占めた県をその予報区の県とする。
// 1.5% は 2026-11-03 に割合を見て決めた値。境の県が混ざる「愛知県外海」の静岡県は 1.2%、有明海に面した
// 「有明・八代海」の福岡県は 2.1% で、この間に置いた。海岸線や境界のデータを作り直したら、境の近い予報区の割合を見直す
//
// 使い方: node scripts/build-tsunami-zone-prefectures.mjs [--check]
//   --check: 書かずに、今のファイルと中身が同じかだけを見る（違えば終了コード 1）
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const zones = JSON.parse(readFileSync(join(root, 'public/data/tsunami-zones.json'), 'utf8'))
const prefs = JSON.parse(readFileSync(join(root, 'public/data/prefectures.json'), 'utf8'))
const codesText = readFileSync(join(root, 'src/data/prefectureCodes.ts'), 'utf8')
const codeOf = new Map([...codesText.matchAll(/\{ code: '(\d{2})', name: '([^']+)' \}/g)].map(m => [m[2], m[1]]))
if (codeOf.size !== 47) { console.error(`都道府県のコードが 47 件読めませんでした（${codeOf.size} 件）`); process.exit(2) }

const MIN_SHARE = 0.015

function inRing(lat, lon, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i]
    const [yj, xj] = ring[j]
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

const prefList = Object.entries(prefs).map(([name, v]) => ({ name, rings: v.rings ?? [] }))
for (const p of prefList) if (!codeOf.has(p.name)) { console.error(`県の名前がコードの表にありません: ${p.name}`); process.exit(2) }

function prefOfPoint(lat, lon) {
  for (const p of prefList) if (p.rings.some(r => inRing(lat, lon, r))) return p.name
  // 海岸線は境界の上か少し沖にあるので、輪に入らなければ最も近い頂点の県
  let best = null
  let bestD = Infinity
  for (const p of prefList) {
    for (const r of p.rings) {
      for (let i = 0; i < r.length; i += 2) {
        const d = (r[i][0] - lat) ** 2 + ((r[i][1] - lon) * Math.cos((lat * Math.PI) / 180)) ** 2
        if (d < bestD) { bestD = d; best = p.name }
      }
    }
  }
  return best
}

const out = {}
for (const [zone, lines] of Object.entries(zones).sort(([a], [b]) => a.localeCompare(b, 'ja'))) {
  const counts = new Map()
  let total = 0
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const name = prefOfPoint(line[i][0], line[i][1])
      if (!name) continue
      counts.set(name, (counts.get(name) ?? 0) + 1)
      total++
    }
  }
  const codes = [...counts].filter(([, n]) => n / total >= MIN_SHARE).map(([name]) => codeOf.get(name)).sort()
  if (codes.length === 0) { console.error(`県が 1 つも当たらない予報区: ${zone}`); process.exit(1) }
  out[zone] = codes
}

const body = `// 生成物。手で直さない（scripts/build-tsunami-zone-prefectures.mjs）。
// 津波予報区の名前 → 海岸線が通る都道府県のコード（設定「通知する地域」で津波の通知を絞るのに使う）。
export const TSUNAMI_ZONE_PREFECTURES: Readonly<Record<string, readonly string[]>> = {
${Object.entries(out).map(([k, v]) => `  ${JSON.stringify(k)}: [${v.map(c => `'${c}'`).join(', ')}],`).join('\n')}
}
`
const dest = join(root, 'src/data/tsunamiZonePrefectures.ts')
if (process.argv.includes('--check')) {
  const now = readFileSync(dest, 'utf8')
  if (now.replace(/\r\n/g, '\n') !== body) { console.error('src/data/tsunamiZonePrefectures.ts が生成し直した中身と違います'); process.exit(1) }
  console.log('一致')
} else {
  writeFileSync(dest, body)
  for (const [k, v] of Object.entries(out)) console.log(`${k}\t${v.map(c => [...codeOf].find(([, cc]) => cc === c)[0]).join('・')}`)
  console.log(`予報区 ${Object.keys(out).length} 件を書いた`)
}
