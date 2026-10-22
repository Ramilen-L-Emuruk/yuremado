// ホーム画面に置くアイコンの PNG 4 本（180・192・512・maskable の 512）を、public/icons/icon.svg から作る。
//
// iOS のホーム画面（apple-touch-icon）は PNG を前提にしていて、SVG を渡したときに使われる保証が無い。
// Android の maskable も、ランチャーによっては SVG を読まないので PNG を置く。元の絵は SVG 1 枚に保ち、PNG はそこから作る。
//
// 2 通りに焼く。
//   - 角丸のまま（icon-192.png・icon-512.png）: manifest の `any`。角の外は透明のまま
//   - 全面を塗る（icon-180.png・icon-maskable-512.png）: apple-touch-icon と manifest の `maskable`。
//     角は端末の側が切るので、透明の角を残すと iOS では黒く埋まり、maskable では背景が欠ける。
//     maskable だけは絵を少し縮めて、切り抜かれても残る範囲へ収める（下の MASKABLE_SCALE）
//
// 使い方: node scripts/build-app-icons.mjs
// 元の SVG を描き直したら実行し、出来た PNG もコミットする。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg, initWasm } from '@resvg/resvg-wasm'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const iconsDir = path.join(root, 'public', 'icons')
const svg = fs.readFileSync(path.join(iconsDir, 'icon.svg'), 'utf8')

// 全面を塗る版は、背景の角丸だけを外す。**置き換えが効いたかを確かめる** —— SVG を描き直して
// 角丸の書き方が変わると、黙って角丸のまま焼いてしまう。
const ROUNDED_BACKGROUND = /<rect width="512" height="512" fill="#12151a" rx="80"\/>/
if (!ROUNDED_BACKGROUND.test(svg)) {
  console.error('icon.svg の背景の書き方が想定と違うため、全面を塗る版を作れません（ROUNDED_BACKGROUND を直してください）')
  process.exit(1)
}
const FULL_BACKGROUND = '<rect width="512" height="512" fill="#12151a"/>'
const fullBleedSvg = svg.replace(ROUNDED_BACKGROUND, FULL_BACKGROUND)

// maskable はさらに、背景より後ろの絵を中心へ 0.9 倍に縮める。端末が切り抜いても残ると約束されるのは
// 中心から半径 40%（512 なら 204.8）の円だけで、元の絵は波形の左端（丸い線端まで）が中心から 207 ある。
// 0.9 倍で 186 になる。apple-touch-icon（iOS の角丸の四角）はそこまで切らないので縮めない。
const MASKABLE_SCALE = 0.9
const maskableSvg = fullBleedSvg
  .replace(FULL_BACKGROUND, `${FULL_BACKGROUND}<g transform="translate(256 256) scale(${MASKABLE_SCALE}) translate(-256 -256)">`)
  .replace('</svg>', '</g></svg>')

await initWasm(fs.readFileSync(path.join(root, 'node_modules', '@resvg', 'resvg-wasm', 'index_bg.wasm')))

const outputs = [
  { file: 'icon-180.png', size: 180, source: fullBleedSvg },
  { file: 'icon-192.png', size: 192, source: svg },
  { file: 'icon-512.png', size: 512, source: svg },
  { file: 'icon-maskable-512.png', size: 512, source: maskableSvg },
]

for (const { file, size, source } of outputs) {
  const png = new Resvg(source, { fitTo: { mode: 'width', value: size } }).render().asPng()
  fs.writeFileSync(path.join(iconsDir, file), png)
  console.log(`書き出した: public/icons/${file}（${size}×${size}・${png.length} バイト）`)
}
