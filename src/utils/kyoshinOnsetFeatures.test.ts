import { describe, expect, it } from 'vitest'
import { NONE, OnsetFeatures } from './kyoshinOnsetFeatures'

/** 1 点に `len` 秒ぶん `f(秒)` を流し、秒ごとの y・y3・y15 を返す */
function run(f: (s: number) => number, len: number) {
  const o = new OnsetFeatures(1)
  const out: { y: number; y3: number; y15: number }[] = []
  for (let s = 0; s < len; s++) {
    o.push([f(s)])
    out.push({ y: o.y[0], y3: o.y3[0], y15: o.y15[0] })
  }
  return out
}

const ON = 40

describe('15 秒の窓の上がり（y15）', () => {
  // 40 秒目に 2 段上げて保つ。上がりの基準は直前 10 秒の最小も見るので、10 秒後に上がりは 0 に戻る
  const step = run(s => (s < ON ? 4 : 6), ON + 20)

  it('正: 6 秒の窓（y）を出た後も、上がりを保っている間は 15 秒の窓（y15）に残る', () => {
    for (let d = 6; d <= 9; d++) {
      expect(step[ON + d].y).toBe(0)
      expect(step[ON + d].y15).toBe(2)
    }
  })

  it('対照: 上がった直後は 3 つの窓とも同じ段を持ち、3 秒の窓（y3）は 3 秒目に出る', () => {
    expect(step[ON]).toEqual({ y: 2, y3: 2, y15: 2 })
    expect(step[ON + 3].y3).toBe(0)
    expect(step[ON + 5].y).toBe(2)
  })

  it('安全弁: 上がりを保てなくなったら、15 秒の窓の内でも y15 は 0 に戻る', () => {
    expect(step[ON + 10].y15).toBe(0)
    expect(step[ON + 14].y15).toBe(0)
  })

  it('安全弁: 欠測の秒は 3 つとも判定できない', () => {
    const gap = run(s => (s < ON ? 4 : s === ON + 2 ? -1 : 6), ON + 5)
    expect(gap[ON + 2]).toEqual({ y: NONE, y3: NONE, y15: NONE })
  })
})
