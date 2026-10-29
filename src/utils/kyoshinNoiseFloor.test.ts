import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  FLOOR_CAP,
  FLOOR_FREEZE_MS,
  MAX_RESUME_GAP_MS,
  chronicNoiseFloor,
  extractNoiseFloors,
  hydrateNoiseFloors,
  initNoiseFloorState,
  noiseFloorKeys,
  noiseFloorsFor,
  recentOnsetKeys,
  stepNoiseFloor,
  type NoiseFloorState,
} from './kyoshinNoiseFloor'

const T0 = Date.UTC(2026, 0, 1)
/** value = -3.0 + index * 0.5 */
const idx = (value: number) => Math.round((value + 3) / 0.5)

/** 決まった種から作る擬似乱数（テストの再現性のため） */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function run(frames: { ms: number; values: number[] }[], keys: readonly string[], init = initNoiseFloorState()): NoiseFloorState {
  let st = init
  for (const f of frames) st = stepNoiseFloor(st, f.ms, f.values, keys)
  return st
}

describe('慢性ノイズ床の学習（旧エンジンから切り出したもの）', () => {
  it('正: 同じフレームを流すと、切り出す前の旧エンジンと同じ床と「今揺れ始めた点」になる（揺れ・欠測・途絶・作り直しを含む）', () => {
    // 期待値は、旧エンジン（2026-10-29 に消した kyoshinDetector.ts）へ同じフレームを流して書き取ったもの。
    // 学習の式を変えたら、ここが落ちる。意図した変更なら、新しい値で書き直す
    // 4 点。0 は静か、1 は常時騒がしい、2 は途中で揺れる、3 は座標が 1 と重なる（別のキーになる）
    const sites: [number, number][] = [[35, 135], [35.1, 135], [35.2, 135], [35.1, 135]]
    const keys = noiseFloorKeys(sites)
    const r = rng(7)
    const frames: { ms: number; values: number[] }[] = []
    let t = T0
    for (let i = 0; i < 4000; i++) {
      // 途中で途絶明け（20 秒）と作り直し（90 秒）と巻き戻りを挟む
      t += i === 1200 ? 20_000 : i === 2400 ? 90_000 : 1000
      const quiet = idx(-2.5 + Math.floor(r() * 3) * 0.5)
      const noisy = idx(0 + Math.floor(r() * 4) * 0.5)
      const shaking = i >= 1500 && i < 1530 ? idx(2.5) : idx(-2 + Math.floor(r() * 2) * 0.5)
      const missing = r() < 0.03 ? -1 : noisy
      frames.push({ ms: t, values: [quiet, noisy, shaking, missing] })
    }
    let mine = initNoiseFloorState()
    const onsets: string[] = []
    for (const f of frames) {
      mine = stepNoiseFloor(mine, f.ms, f.values, keys)
      const got = recentOnsetKeys(mine, f.values, keys)
      if (got.length > 0) onsets.push(`${f.ms - T0}:${[...got].sort().join('|')}`)
    }
    // 「今揺れ始めた点」は毎フレームの並びまで旧エンジンと同じ（3553 フレームぶんを 1 つの要約で比べる）
    expect(onsets.length).toBe(3553)
    expect(createHash('sha256').update(onsets.join('\n')).digest('hex')).toBe('c5c52412c1ec6cc59bc0ce1e989127a4d4b24f8f4c37114ec1f19b998a0a1c7d')
    const expected: Record<string, { floorMean: number; floorDev: number; floor: number }> = {
      '35.000,135.000': { floorMean: -2.00324928470059, floorDev: 0.3285260142750804, floor: -1.0176712418753489 },
      '35.100,135.000': { floorMean: 1.4873012083287767, floorDev: 0.012613130774644103, floor: 1.5 },
      '35.200,135.000': { floorMean: -1.7316805300542824, floorDev: 0.24314665990077494, floor: -1.0022405503519576 },
      '35.100,135.000#2': { floorMean: 1.4873012083287767, floorDev: 0.012613130774644103, floor: 1.5 },
    }
    expect(Object.keys(mine.sites).sort()).toEqual(Object.keys(expected).sort())
    for (const [k, e] of Object.entries(expected)) {
      const b = mine.sites[k]
      expect(b.floorMean, k).toBe(e.floorMean)
      expect(b.floorDev, k).toBe(e.floorDev)
      expect(chronicNoiseFloor(b), k).toBe(e.floor)
    }
  })

  it('正: 平常から値の高い点ほど床が上がる', () => {
    const keys = noiseFloorKeys([[35, 135], [36, 135]])
    const frames = Array.from({ length: 3600 }, (_, i) => ({ ms: T0 + i * 1000, values: [idx(-2.5), idx(i % 2 === 0 ? -0.5 : -1.0)] }))
    const [quiet, noisy] = noiseFloorsFor(run(frames, keys), keys)
    expect(noisy).toBeGreaterThan(quiet)
  })

  it('対照: 立ち上がった点は 10 分のあいだ床を学ばない', () => {
    const keys = noiseFloorKeys([[35, 135]])
    // 静かな値で慣らしてから 1 度だけ立ち上がり、そのあと高めの値が続く
    const warm = Array.from({ length: 600 }, (_, i) => ({ ms: T0 + i * 1000, values: [idx(-2.5)] }))
    const rise = [{ ms: T0 + 600_000, values: [idx(-2.5)] }, { ms: T0 + 603_000, values: [idx(1.0)] }]
    const before = run([...warm, ...rise], keys)
    const s0 = before.sites[keys[0]]
    expect(s0.triggeredAtMs).toBe(T0 + 603_000)
    // 床（0）より下の値でも、凍結の 10 分の内は学ばない
    const during = Array.from({ length: 300 }, (_, i) => ({ ms: T0 + 604_000 + i * 1000, values: [idx(-1.0)] }))
    const after = run(during, keys, before)
    expect(after.sites[keys[0]].floorMean).toBe(s0.floorMean)
    // 続けて流し、立ち上がりから 10 分を過ぎたら学び始める
    const untilFreezeEnds = Array.from({ length: 300 }, (_, i) => ({ ms: T0 + 904_000 + i * 1000, values: [idx(-1.0)] }))
    const atFreezeEnd = run(untilFreezeEnds, keys, after)
    expect(atFreezeEnd.lastDataTimeMs).toBe(T0 + 603_000 + FLOOR_FREEZE_MS)
    expect(atFreezeEnd.sites[keys[0]].floorMean).toBe(s0.floorMean)
    const later = Array.from({ length: 60 }, (_, i) => ({ ms: T0 + 1_204_000 + i * 1000, values: [idx(-1.0)] }))
    const resumed = run(later, keys, atFreezeEnd)
    expect(resumed.sites[keys[0]].floorMean).toBeGreaterThan(s0.floorMean)
  })

  it('安全弁: 床は上限 FLOOR_CAP で頭打ちになる', () => {
    expect(chronicNoiseFloor({ floorMean: 1.4, floorDev: 1 })).toBe(FLOOR_CAP)
  })

  it('安全弁: 欠測のあいだも床は残す', () => {
    const keys = noiseFloorKeys([[35, 135]])
    const frames = Array.from({ length: 600 }, (_, i) => ({ ms: T0 + i * 1000, values: [idx(i % 2 === 0 ? -0.5 : -1.0)] }))
    const st = run(frames, keys)
    const kept = stepNoiseFloor(st, T0 + 600_000, [-1], keys)
    expect(kept.sites[keys[0]].floorMean).toBe(st.sites[keys[0]].floorMean)
    expect(kept.sites[keys[0]].floorDev).toBe(st.sites[keys[0]].floorDev)
  })

  it('安全弁: 作り直し（間隔が MAX_RESUME_GAP_MS 超・巻き戻り）でも床は引き継ぎ、そのフレームは学ばない', () => {
    const keys = noiseFloorKeys([[35, 135]])
    const frames = Array.from({ length: 600 }, (_, i) => ({ ms: T0 + i * 1000, values: [idx(i % 2 === 0 ? -0.5 : -1.0)] }))
    const st = run(frames, keys)
    for (const ms of [T0 + 599_000 + MAX_RESUME_GAP_MS + 1000, T0]) {
      const next = stepNoiseFloor(st, ms, [idx(1.5)], keys)
      expect(next.sites[keys[0]].floorMean).toBe(st.sites[keys[0]].floorMean)
      expect(next.sites[keys[0]].triggeredAtMs).toBeNull()
    }
  })

  it('安全弁: 観測点の数と値の数が食い違ったら投げる', () => {
    expect(() => stepNoiseFloor(initNoiseFloorState(), T0, [1, 2], ['a'])).toThrow()
  })

  it('正: 永続化して戻すと床がそのまま戻り、壊れた値は捨てる', () => {
    const keys = noiseFloorKeys([[35, 135], [36, 135]])
    const frames = Array.from({ length: 1200 }, (_, i) => ({ ms: T0 + i * 1000, values: [idx(-2.5), idx(i % 2 === 0 ? 0 : -0.5)] }))
    const st = run(frames, keys)
    const snap = extractNoiseFloors(st)
    expect(Object.keys(snap.floors)).toEqual([keys[1]])
    const back = hydrateNoiseFloors({ floors: { ...snap.floors, broken: [Number.NaN, 0] } })
    expect(noiseFloorsFor(back, keys)[1]).toBe(noiseFloorsFor(st, keys)[1])
    expect(back.sites.broken).toBeUndefined()
  })
})
