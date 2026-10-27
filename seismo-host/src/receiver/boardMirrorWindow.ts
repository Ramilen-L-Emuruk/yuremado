/**
 * 揺れの区間の生データから、**鏡像の見張り（`boardMirrorWatch.ts`）へ渡す組を作る**。
 *
 * - 2 軸のセンサーだけの基板: 全部の軸の列（地面で見た向きのまま）
 * - 同じ観測点の、ほかの基板の 3 軸のセンサー: 校正を戻した東・北・上（センサーごとに解いて平均）
 *
 * どちらも 20 ms の目盛りへ揃え、**0.5 秒より長い揺れ（傾き・直流）を引いてから 3 目盛りで均す**。
 * 合成波形と同じ形にすると、2 軸の基板の取り違えがそのまま合成へ混ざっている（#712）ので、比べる相手は
 * 3 軸のセンサーの生データから組み直す。
 */
import { galFromCounts } from '../intensity/units'
import type { SensorPacket } from '../protocol/types'
import { compareMirror, type MirrorComparison } from './boardMirrorWatch'
import { StationDirectory } from './stationConfig'
import type { BoardKey } from '../protocol/types'
import type { StationConfig, Vec3 } from './stationConfigTypes'

/** 目盛りの刻み（ms）。センサーの採取（100 Hz 前後）より粗く、揃えやすい。 */
export const MIRROR_GRID_MS = 20

/** 長い揺れを引く窓（片側の目盛り数。±0.5 秒）。 */
const DETREND_HALF = 25

export interface BoardMirrorComparison {
  readonly boardKey: BoardKey
  readonly comparison: MirrorComparison
}

export interface BoardMirrorWindowInput {
  readonly stationId: string
  readonly fromMs: number
  readonly toMs: number
  readonly packets: readonly SensorPacket[]
  readonly config: StationConfig
}

/** 欠けを数えずに、前後 `w` 目盛りの平均を取る（半分以上が揃わない目盛りは NaN）。 */
function movingMean(x: Float64Array, w: number): Float64Array {
  const n = x.length
  const sum = new Float64Array(n + 1)
  const count = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) {
    const v = x[i]!
    sum[i + 1] = sum[i]! + (Number.isNaN(v) ? 0 : v)
    count[i + 1] = count[i]! + (Number.isNaN(v) ? 0 : 1)
  }
  const out = new Float64Array(n).fill(Number.NaN)
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w)
    const b = Math.min(n, i + w + 1)
    const c = count[b]! - count[a]!
    if (c > w && !Number.isNaN(x[i]!)) out[i] = (sum[b]! - sum[a]!) / c
  }
  return out
}

/** 帯域の切り出し（長い揺れを引き、3 目盛りで均す）。 */
export function mirrorBand(x: Float64Array): Float64Array {
  const low = movingMean(x, DETREND_HALF)
  return movingMean(
    x.map((v, i) => v - low[i]!),
    1,
  )
}

/** 1 センサーの軸ごとの列（目盛りへ線形に補間。パケットの外・欠けは NaN）。 */
function sensorGrid(packets: readonly SensorPacket[], axisCount: number, fromMs: number, n: number): Float64Array[] {
  const out = Array.from({ length: axisCount }, () => new Float64Array(n).fill(Number.NaN))
  for (const p of packets) {
    if (!(p.sampleRateHz > 0) || p.samples.length < 2) continue
    const step = 1000 / p.sampleRateHz
    const last = p.samples.length - 1
    const i0 = Math.max(0, Math.ceil((p.firstSampleMs - fromMs) / MIRROR_GRID_MS))
    const i1 = Math.min(n - 1, Math.floor((p.firstSampleMs + last * step - fromMs) / MIRROR_GRID_MS))
    for (let i = i0; i <= i1; i++) {
      const x = (fromMs + i * MIRROR_GRID_MS - p.firstSampleMs) / step
      const k = Math.min(last - 1, Math.floor(x))
      if (k < 0) continue
      const f = x - k
      for (let j = 0; j < axisCount; j++) {
        const a = galFromCounts(p.samples[k]![j]!, p)
        const b = galFromCounts(p.samples[k + 1]![j]!, p)
        if (a === null || b === null) continue
        out[j]![i] = a + (b - a) * f
      }
    }
  }
  return out
}

const sensorKey = (boardKey: BoardKey, sensorId: string) => `${boardKey}|${sensorId}`

/**
 * 区間の中の、2 軸のセンサーだけの基板それぞれについて、いまの向きと鏡像の向きの相関を比べる。
 * 比べる相手（同じ観測点の、ほかの基板の 3 軸のセンサー）が無い観測点・パケットの無い基板は返さない。
 */
export function compareBoardsInWindow(input: BoardMirrorWindowInput): BoardMirrorComparison[] {
  const n = Math.floor((input.toMs - input.fromMs) / MIRROR_GRID_MS)
  if (n <= 0) return []
  const boards = input.config.boards.filter((b) => b.stationId === input.stationId)
  const twoAxisOnly = boards.filter((b) => b.sensors.length > 0 && b.sensors.every((s) => s.axes.length === 2))
  if (twoAxisOnly.length === 0) return []
  const directory = new StationDirectory(input.config)

  const bySensor = new Map<string, SensorPacket[]>()
  const seen = new Set<string>()
  for (const p of input.packets) {
    const dedupe = `${p.boardKey}|${p.bootId}|${p.sensorId}|${p.firstSeq}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    const k = sensorKey(p.boardKey, p.sensorId)
    const list = bySensor.get(k)
    if (list === undefined) bySensor.set(k, [p])
    else list.push(p)
  }

  // 比べる相手: 3 軸のセンサーを東・北・上へ戻し、目盛りごとに揃ったものを平均する。
  const ref: [Float64Array, Float64Array, Float64Array] = [new Float64Array(n), new Float64Array(n), new Float64Array(n)]
  const refCount = new Float64Array(n)
  for (const board of boards) {
    for (const s of board.sensors) {
      if (s.axes.length !== 3 || !s.enabled) continue
      const packets = bySensor.get(sensorKey(board.boardKey, s.sensorId))
      if (packets === undefined) continue
      const resolved = directory.resolveSensor(board.boardKey, s.sensorId, 3)
      if (!resolved.ok || resolved.calibration.unmix === null) continue
      const { unmix, axes } = resolved.calibration
      const grid = sensorGrid(packets, 3, input.fromMs, n).map((g, j) => mirrorBand(g.map((v) => v - axes[j]!.offset)))
      for (let i = 0; i < n; i++) {
        const m0 = grid[0]![i]!
        const m1 = grid[1]![i]!
        const m2 = grid[2]![i]!
        if (Number.isNaN(m0) || Number.isNaN(m1) || Number.isNaN(m2)) continue
        for (let a = 0; a < 3; a++) ref[a]![i] += unmix[a]![0]! * m0 + unmix[a]![1]! * m1 + unmix[a]![2]! * m2
        refCount[i] += 1
      }
    }
  }
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) ref[a]![i] = refCount[i]! === 0 ? Number.NaN : ref[a]![i]! / refCount[i]!
  }
  if (!refCount.some((c) => c > 0)) return []

  const out: BoardMirrorComparison[] = []
  for (const board of twoAxisOnly) {
    const signals: Float64Array[] = []
    const directions: Vec3[] = []
    for (const s of board.sensors) {
      if (!s.enabled) continue
      const packets = bySensor.get(sensorKey(board.boardKey, s.sensorId))
      if (packets === undefined) continue
      const resolved = directory.resolveSensor(board.boardKey, s.sensorId, 2)
      if (!resolved.ok) continue
      const grid = sensorGrid(packets, 2, input.fromMs, n)
      resolved.calibration.axes.forEach((axis, j) => {
        const len = Math.hypot(...axis.vector)
        directions.push([axis.vector[0] / len, axis.vector[1] / len, axis.vector[2] / len])
        signals.push(mirrorBand(grid[j]!.map((v) => (v - axis.offset) / len)))
      })
    }
    if (signals.length === 0) continue
    out.push({ boardKey: board.boardKey, comparison: compareMirror({ signals, directions, orientation: board.orientation, ref }) })
  }
  return out
}
