// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { ActionChecklist, checklistBottomReserveRem, checklistTopPadding, type ChecklistBelow } from './index'
import { log } from '../../utils/logger'

// 帯の上の余白。隅の列の下端から始め、下限 3rem、上限は「地図の高さ − 下側へ残す高さ」
// （2026-10-27 ユーザー選択「バナーを優先 (Recommended)」）。

const ALL: ChecklistBelow = { legend: true, shareRow: true, shareRowAtScreenBottom: false, banner: true }
const NONE: ChecklistBelow = { legend: false, shareRow: false, shareRowAtScreenBottom: false, banner: false }

describe('checklistBottomReserveRem', () => {
  it('全部出ていれば、帯・凡例・共有ボタン・バナーの縮まない分を足す（正）', () => {
    // 2026-10-27 実測（844×390・地図 313px・隅の下端 336px）で、帯が 0〜219px・バナーが 273〜313px に収まった値
    expect(checklistBottomReserveRem(ALL)).toBeCloseTo(8.35)
  })

  it('何も出ていなければ帯自身の見出し 1 行だけを残す（対照）', () => {
    expect(checklistBottomReserveRem(NONE)).toBe(2.5)
  })

  it('出ていないものの分は残さない（安全弁: バナーが無いときに帯を隅へ重ねすぎない）', () => {
    expect(checklistBottomReserveRem({ ...ALL, banner: false })).toBeCloseTo(5.85)
    expect(checklistBottomReserveRem({ ...ALL, legend: false })).toBeCloseTo(7.75)
    expect(checklistBottomReserveRem({ ...ALL, shareRow: false })).toBeCloseTo(5.6)
  })
})

/**
 * 組み上がった CSS の式を px の数として評価する（1rem = 16px、ホームインジケータは `safeArea` px）。
 * 式の文字列を写して比べるだけでは、括弧の抜けのような意味の誤りを捕まえられないため。
 */
function evalPx(css: string, safeArea = 0): number {
  const js = css
    .replace(/env\(safe-area-inset-bottom, 0px\)/g, `${safeArea}px`)
    .replace(/(-?[\d.]+)rem/g, (_, n: string) => String(Number(n) * 16))
    .replace(/(-?[\d.]+)px/g, '$1')
    .replace(/max\(/g, 'Math.max(')
    .replace(/min\(/g, 'Math.min(')
    .replace(/calc\(/g, '(')
  if (!/^[\d\s.+\-*(),Mathaxinm]+$/.test(js)) throw new Error(`評価できない式: ${css}`)
  return Function(`return ${js}`)() as number
}

describe('checklistTopPadding', () => {
  afterEach(() => vi.restoreAllMocks())

  it('隅の列が伸びたら、その下端から始める（正）', () => {
    expect(evalPx(checklistTopPadding(120, 600, ALL))).toBeCloseTo(120)
  })

  it('隅の列が 1 行なら下限の 3rem（対照）', () => {
    expect(evalPx(checklistTopPadding(46, 600, ALL))).toBeCloseTo(48)
  })

  it('隅の列が高く地図が低いと、残す高さの手前で止まる（安全弁）', () => {
    // 2026-10-27 実測: 地図 313px・隅の下端 336px（＋隙間 12px）で余白 179px、バナーが 273〜313px に収まった
    expect(evalPx(checklistTopPadding(348, 313, ALL))).toBeCloseTo(313 - 8.35 * 16)
    // 同じく地図 390px・バナー無しで 296.4px（帯が隅の列へ重ねすぎない）
    expect(evalPx(checklistTopPadding(348, 390, { ...ALL, banner: false }))).toBeCloseTo(390 - 5.85 * 16)
  })

  it('共有ボタンの行が画面の下端に付き、バナーが無いときは、ホームインジケータの分だけ早く止まる', () => {
    const below: ChecklistBelow = { ...NONE, shareRow: true, shareRowAtScreenBottom: true }
    const withoutInset = evalPx(checklistTopPadding(400, 313, below), 0)
    const withInset = evalPx(checklistTopPadding(400, 313, below), 21)
    expect(withoutInset).toBeCloseTo(313 - 5.25 * 16)
    // 行は 2.25rem＋21px（2.75rem より 13px 高い）になるので、上限もその分だけ下がる
    expect(withInset).toBeCloseTo(withoutInset - (21 - 8))
  })

  it('地図の高さが測れていなければ上限を掛けない', () => {
    expect(checklistTopPadding(120, null, ALL)).toBe('max(3rem, 120px)')
  })

  it('数でない値は 0 として扱い、記録する', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    expect(checklistTopPadding(Number.NaN, 600, ALL)).toBe('max(3rem, min(0px, 600px - (8.35rem)))')
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('ActionChecklist の外枠', () => {
  const base = {
    reason: 'eew' as const,
    scale: 45,
    scope: 'nationwide' as const,
    onDismiss: () => {},
    onRestore: () => {},
    topInset: 120,
    areaHeight: 600,
    below: ALL,
  }

  it('開いた帯の下限は、上の余白に見出し 1 行ぶんを足したもの', () => {
    const { container } = render(<ActionChecklist {...base} collapsed={false} />)
    const wrapper = container.firstElementChild as HTMLElement
    // jsdom は式の項の並びを入れ替えて返すので、数値に直して比べる
    expect(evalPx(wrapper.style.paddingTop)).toBeCloseTo(120)
    expect(evalPx(wrapper.style.minHeight)).toBeCloseTo(120 + 2.5 * 16)
  })

  it('畳んだボタンも同じ上の余白から始め、下限は持たない', () => {
    const { container } = render(<ActionChecklist {...base} collapsed />)
    const wrapper = container.firstElementChild as HTMLElement
    expect(evalPx(wrapper.style.paddingTop)).toBeCloseTo(120)
    expect(wrapper.style.minHeight).toBe('')
  })
})
