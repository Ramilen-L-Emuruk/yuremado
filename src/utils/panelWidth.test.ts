import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SIDE_NARROW_QUERY, panelWidthCss, panelWidthRangePx, panelWidthRemFromPx, shownPanelWidthPx } from './panelWidth'
import { sanitize } from '../hooks/useSettings'

const PC = { viewportWidth: 1280, remPx: 16 }

describe('panelWidthRangePx', () => {
  it('下限は 20rem、上限は画面の幅からアイコンナビと地図の 360px を引いた所', () => {
    expect(panelWidthRangePx(PC)).toEqual({ min: 320, max: 1280 - 64 - 360 })
  })

  it('UI 倍率でルートの文字が大きくなると、下限もナビの取り分もその分広がる', () => {
    expect(panelWidthRangePx({ viewportWidth: 1280, remPx: 20 })).toEqual({ min: 400, max: 1280 - 80 - 360 })
  })

  it('地図を残すと下限を割る狭い画面では、上限を下限に揃える（ドラッグしても動かない）', () => {
    // 667 − 64 − 360 = 243 < 320
    expect(panelWidthRangePx({ viewportWidth: 667, remPx: 16 })).toEqual({ min: 320, max: 320 })
  })

  it('下限そのものがアイコンナビを押し出す画面では、ナビの手前で止める', () => {
    expect(panelWidthRangePx({ viewportWidth: 360, remPx: 16 })).toEqual({ min: 296, max: 296 })
  })
})

describe('shownPanelWidthPx', () => {
  it('動かしていなければ既定の幅のまま（地図を残す上限は掛けない）', () => {
    // UI 倍率 1.25 の 1024px: 35rem = 700px は「地図 360px」の上限 584px を超えるが、つまみを入れる前と同じく 700 のまま
    expect(shownPanelWidthPx(null, 35, { viewportWidth: 1024, remPx: 20 })).toBe(700)
    expect(shownPanelWidthPx(null, 35, PC)).toBe(560)
  })

  it('動かしていなくても、アイコンナビを押し出す幅にはしない', () => {
    expect(shownPanelWidthPx(null, 35, { viewportWidth: 600, remPx: 16 })).toBe(536)
  })

  it('保存した幅は、画面が狭ければ見せる幅だけを詰める', () => {
    expect(shownPanelWidthPx(50, 35, PC)).toBe(800)
    expect(shownPanelWidthPx(60, 35, PC)).toBe(856)
    expect(shownPanelWidthPx(20, 35, PC)).toBe(320)
  })
})

describe('panelWidthRemFromPx', () => {
  it('範囲に収めて rem へ直す', () => {
    expect(panelWidthRemFromPx(480, PC)).toBe(30)
    expect(panelWidthRemFromPx(100, PC)).toBe(20)
    expect(panelWidthRemFromPx(5000, PC)).toBe(53.5)
  })

  it('小数 2 桁で丸める', () => {
    expect(panelWidthRemFromPx(333, PC)).toBe(20.81)
  })
})

describe('panelWidthCss', () => {
  it('動かしていなければ変数を置かない（CSS の既定に任せる）', () => {
    expect(panelWidthCss(null)).toBeUndefined()
  })

  it('保存した幅に、下限と地図を残す上限を CSS の側で掛ける', () => {
    expect(panelWidthCss(30)).toBe('max(20rem, min(30rem, calc(100dvw - 4rem - 360px)))')
  })
})

describe('保存した幅の読み込み', () => {
  it('既定は動かしていない（null）', () => {
    const s = sanitize({})
    expect(s.panelWidthSide).toBeNull()
    expect(s.panelWidthSideNarrow).toBeNull()
  })

  it('下限より狭い値は下限へ、壊れた値は動かしていない扱いへ落とす', () => {
    expect(sanitize({ panelWidthSide: 5 }).panelWidthSide).toBe(20)
    expect(sanitize({ panelWidthSideNarrow: 'x' as unknown as number }).panelWidthSideNarrow).toBeNull()
  })

  it('画面の幅で決まる上限は保存の段では掛けない（画面を広げれば元の幅に戻る）', () => {
    expect(sanitize({ panelWidthSide: 80 }).panelWidthSide).toBe(80)
  })
})

describe('SIDE_NARROW_QUERY', () => {
  it('src/index.css の sideNarrow と同じ条件', () => {
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
    const block = css.match(/@custom-variant sideNarrow \{\s*@media ([^{]+)\{/)
    expect(block?.[1].trim()).toBe(SIDE_NARROW_QUERY)
  })
})
