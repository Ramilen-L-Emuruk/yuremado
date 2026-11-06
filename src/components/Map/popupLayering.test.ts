// 地図の吹き出し（`.maplibregl-popup`）の重なり順を固定する（理由は src/index.css の該当箇所）。
//
// 吹き出しの z は CSS に、地図の上に重ねる部品の z は App.tsx のクラスに書いてあり、型検査もほかのテストも
// 両者の大小を見ない。片方だけ動かすと、吹き出しが行動チェックリストや凡例の上へ被る形に静かに戻る。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
const capture = readFileSync(new URL('./gl/captureMap.ts', import.meta.url), 'utf8')

function popupZ(): number {
  const m = /\.maplibregl-popup\s*\{[^}]*z-index:\s*(\d+)/.exec(css)
  expect(m).not.toBeNull()
  return Number(m![1])
}

describe('地図の吹き出しの重なり順', () => {
  // 正: 地図の上に重ねる部品（左上の状態・行動チェックリスト・凡例・特別情報の帯）より後ろ
  it('地図の上に重ねる部品の z より小さい', () => {
    const overlays = [...app.matchAll(/className="[^"]*\babsolute\b[^"]*\bz-(\d+)\b/g)].map(m => Number(m[1]))
    // 地図の上に重ねる器は 3 つ（左上の列・縦並び・低い地図で開いたチェックリスト）
    expect(overlays.filter(z => z === 99999)).toHaveLength(3)
    expect(popupZ()).toBeLessThan(99999)
  })

  // 安全弁: 地図の中の物（MapLibre の操作ボタン z 2・撮影中の静止画）より前のまま
  it('撮影中の静止画と MapLibre の操作ボタンより大きい', () => {
    const m = /const FREEZE_OVERLAY_Z_INDEX = (\d+)/.exec(capture)
    expect(m).not.toBeNull()
    expect(popupZ()).toBeGreaterThan(Number(m![1]))
    expect(popupZ()).toBeGreaterThan(2)
  })
})
