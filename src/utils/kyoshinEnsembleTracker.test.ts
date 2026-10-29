import { describe, expect, it } from 'vitest'
import { ENSEMBLE_KEEP_MS, type DetectorFrame, type EnsembleReport } from './kyoshinEnsembleDetector'
import { createEnsembleTracker, DRAWN_FADE_MS, type EnsembleReporter } from './kyoshinEnsembleTracker'

const SITES: [number, number][] = [[35, 135], [35.1, 135], [35, 135], [36, 136]]
const T0 = Date.UTC(2026, 0, 1)

/** 秒ごとに決めた行を返す偽の束ね役 */
function scripted(rows: Record<number, EnsembleReport[]>): EnsembleReporter {
  return { push: (f: DetectorFrame) => rows[(f.ms - T0) / 1000] ?? [], setTables: () => {} }
}
const row = (tier: 'early' | 'confirmed', sites: number[], extra: Partial<EnsembleReport> = {}): EnsembleReport =>
  ({ id: 'e1', tier, lat: 35, lng: 135, startMs: T0, sites, sources: ['stat'], ...extra })
const frame = (sec: number, values = [8, 8, 8, 8]): DetectorFrame => ({ ms: T0 + sec * 1000, values: Int8Array.from(values) })

describe('組み合わせの検知のまとめ', () => {
  it('正: 確かな段の行が出たら確かな段になり、加わった観測点と支えた部分は積み上がる', () => {
    const t = createEnsembleTracker(SITES, scripted({
      0: [row('early', [0])],
      1: [row('early', [0, 1]), row('confirmed', [1], { sources: ['fast'] })],
    }))
    expect(t.push(frame(0))[0].confidence).toBe('likely')
    const d = t.push(frame(1, [8, 12, 8, 8]))[0]
    expect(d.confidence).toBe('confirmed')
    expect(d.firstConfirmedAtMs).toBe(T0 + 1000)
    expect(d.memberKeys).toEqual(['35.000,135.000', '35.100,135.000'])
    expect(d.sources.sort()).toEqual(['fast', 'stat'])
    // 段 12 = 計測震度 3.0
    expect(d.maxIntensity).toBe(3)
  })

  it('対照: 早い段の行だけが続く間は確かな段にならない', () => {
    const t = createEnsembleTracker(SITES, scripted({ 0: [row('early', [0])], 1: [row('early', [0])] }))
    t.push(frame(0))
    const d = t.push(frame(1))[0]
    expect(d.confidence).toBe('likely')
    expect(d.firstConfirmedAtMs).toBeNull()
  })

  it('安全弁: 一度確かな段になった束は、早い段の行しか出なくなっても確かな段のまま', () => {
    const t = createEnsembleTracker(SITES, scripted({ 0: [row('confirmed', [0])], 1: [row('early', [0])] }))
    t.push(frame(0))
    const d = t.push(frame(1))[0]
    expect(d.confidence).toBe('confirmed')
    expect(d.firstConfirmedAtMs).toBe(T0)
  })

  it('安全弁: 報告が途切れても寿命の間は残し、寿命を過ぎたら消す', () => {
    const keepSec = ENSEMBLE_KEEP_MS / 1000
    const t = createEnsembleTracker(SITES, scripted({ 0: [row('confirmed', [0])] }))
    t.push(frame(0))
    expect(t.push(frame(keepSec)).map(d => d.id)).toEqual(['e1'])
    expect(t.push(frame(keepSec + 1))).toEqual([])
  })

  it('座標が重なる観測点は別の点として数える', () => {
    const t = createEnsembleTracker(SITES, scripted({ 0: [row('early', [0, 2])] }))
    expect(t.push(frame(0))[0].memberKeys).toEqual(['35.000,135.000', '35.000,135.000#2'])
  })

  it('加わった点がいま全員欠測なら、最大の震度は持たない', () => {
    const t = createEnsembleTracker(SITES, scripted({ 0: [row('early', [0])] }))
    expect(t.push(frame(0, [-1, 8, 8, 8]))[0].maxIntensity).toBeNull()
  })

  it('束が 2 つあれば揺れ始めの早い順に返す', () => {
    const t = createEnsembleTracker(SITES, scripted({
      0: [row('early', [3], { id: 'e2', startMs: T0 + 500, lat: 36, lng: 136 }), row('early', [0])],
    }))
    expect(t.push(frame(0)).map(d => d.id)).toEqual(['e1', 'e2'])
  })

  describe('地図に描く点（drawnKeys）', () => {
    const fadeSec = DRAWN_FADE_MS / 1000
    /** 毎秒、点 0 と 1 の束を報告し続ける（寿命で消えないように） */
    const everySecond: EnsembleReporter = { push: () => [row('confirmed', [0, 1])], setTables: () => {} }
    /** 0 秒から lastSec 秒まで valuesAt の値を流し、最後の秒の検知を返す（段 3 は震度0 未満・段 6 は計測震度 0.0） */
    function run(lastSec: number, valuesAt: (sec: number) => number[]) {
      const t = createEnsembleTracker(SITES, everySecond)
      let d = t.push(frame(0, valuesAt(0)))[0]
      for (let s = 1; s <= lastSec; s++) d = t.push(frame(s, valuesAt(s)))[0]
      return d
    }
    const low = () => [3, 8, 8, 8]

    it('正: 震度0 未満が DRAWN_FADE_MS を超えて続いた点は描く点から外す', () => {
      const d = run(fadeSec + 1, low)
      expect(d.drawnKeys).toEqual(['35.100,135.000'])
    })

    it('対照: DRAWN_FADE_MS ちょうどまでは描く点に残す', () => {
      const d = run(fadeSec, low)
      expect(d.drawnKeys).toEqual(['35.000,135.000', '35.100,135.000'])
    })

    it('安全弁: 外した点も加わった点（memberKeys）からは外さない', () => {
      const d = run(fadeSec + 1, low)
      expect(d.memberKeys).toEqual(['35.000,135.000', '35.100,135.000'])
    })

    it('正: 外した点が震度0 以上へ戻ったら描き直す', () => {
      const d = run(fadeSec + 2, s => (s === fadeSec + 2 ? [6, 8, 8, 8] : low()))
      expect(d.drawnKeys).toEqual(['35.000,135.000', '35.100,135.000'])
    })

    it('対照: 欠測の秒は震度0 以上に数えない（描き直す理由にならない）', () => {
      // 揺れ始め（震度0 以上）の後は欠測が続き、最後の 1 秒だけ震度0 未満
      const d = run(fadeSec + 5, s => (s === 0 ? [8, 8, 8, 8] : s === fadeSec + 5 ? low() : [-1, 8, 8, 8]))
      expect(d.drawnKeys).toEqual(['35.100,135.000'])
    })

    it('安全弁: 外すと描く点が 1 つも残らないなら、最後に震度0 以上だった時刻が同じ点はすべて残す', () => {
      const d = run(fadeSec + 1, () => [3, 3, 8, 8])
      expect(d.drawnKeys).toEqual(['35.000,135.000', '35.100,135.000'])
    })

    // 2026-10-29 ユーザー選択「最後まで残っていた点だけ (Recommended)」
    it('正: 最後の描く点が外れるときは、その点だけを残す（先に外れた点を描き戻さない）', () => {
      // 点 0 は初めから震度0 未満・点 1 は 10 秒まで震度0 以上
      const d = run(10 + fadeSec + 1, s => [3, s <= 10 ? 8 : 3, 8, 8])
      expect(d.drawnKeys).toEqual(['35.100,135.000'])
      expect(d.memberKeys).toEqual(['35.000,135.000', '35.100,135.000'])
    })
  })

  it('観測点の数と値の数が食い違えば投げる', () => {
    const t = createEnsembleTracker(SITES, scripted({}))
    expect(() => t.push(frame(0, [8, 8]))).toThrow('食い違って')
  })
})
