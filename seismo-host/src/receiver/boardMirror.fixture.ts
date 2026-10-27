/**
 * 鏡像の見張り（`boardMirrorWindow.test.ts`・`boardMirrorRunner.test.ts`）のテスト用の素材。
 * 3 軸の基板 1 枚と 2 軸だけの基板 1 枚を同じ観測点に置き、合成した地面の揺れを 1 秒ずつのパケットにする。
 */
import { suggestRotation } from '../admin/calibrationSuggest'
import type { SensorPacket } from '../protocol/types'
import { IDENTITY_MATRIX, type BoardEntry, type Mat3, type StationConfig, type Vec3 } from './stationConfigTypes'

const RATE = 100
export const T0 = 1_760_000_000_000
export const SECONDS = 30
/** 1 カウントが 0.01 gal になる分解能。 */
const UG_PER_LSB = 0.01 / (1e-6 * 980.665)

/** 地面の揺れ（東・北・上、gal）。1〜5 Hz くらいの揺れを重ねる。 */
function groundAt(t: number): Vec3 {
  return [
    3 * Math.sin(2 * Math.PI * 3.1 * t) + 1.5 * Math.sin(2 * Math.PI * 1.7 * t + 1),
    2.5 * Math.sin(2 * Math.PI * 2.3 * t + 0.4) - 1.2 * Math.sin(2 * Math.PI * 4.2 * t),
    0.8 * Math.sin(2 * Math.PI * 3.7 * t + 2),
  ]
}

/** 軸 `w`（地面の座標・長さが倍率）とゼロ点 `o` で測った 1 センサーの 1 秒ずつのパケット。 */
export function packetsOf(boardKey: `mac:${string}`, sensorId: string, axes: readonly { w: Vec3; o: number }[]): SensorPacket[] {
  const out: SensorPacket[] = []
  for (let s = 0; s < SECONDS; s++) {
    const samples: number[][] = []
    for (let i = 0; i < RATE; i++) {
      const t = s + i / RATE
      const a = groundAt(t)
      samples.push(axes.map(({ w, o }) => (w[0] * a[0] + w[1] * a[1] + w[2] * a[2] + o) / 0.01))
    }
    out.push({
      version: 2,
      boardKey,
      bootId: 'b',
      sensorId,
      sensorType: 'x',
      channels: axes.map((_, j) => `a${j}`),
      ugPerLsb: UG_PER_LSB,
      fullScaleG: 2,
      sampleRateHz: RATE,
      firstSampleMs: T0 + s * 1000,
      firstSeq: s * RATE,
      overflowCount: 0,
      samples,
    })
  }
  return out
}

export const MPU = 'mac:aaaaaaaaaaaa' as const
export const IIS = 'mac:bbbbbbbbbbbb' as const

/** 2 軸のセンサー 3 個（水平 1・立てた 2）。基板の座標＝地面の座標（向きは単位行列）。 */
export const IIS_AXES: readonly (readonly Vec3[])[] = [
  [
    [1, 0, 0],
    [0, 1, 0],
  ],
  [
    [1, 0, 0.05],
    [0, 0.05, 1],
  ],
  [
    [0, 1, -0.05],
    [0.05, 0, 1],
  ],
]
export const flipZ = (v: Vec3): Vec3 => [v[0], v[1], -v[2]]

/**
 * 平置きの 2 軸の基板に 6 面法の鏡像の解を入れ、「鉛直を合わせる」で向きを作り直した設定（実際の手順と同じ形）。
 * 鏡像の解では基板の中で読む重力も裏返る（真下）ので、向きは上下逆さまに作り直される。方角は保つ。
 */
export function mirroredConfig(): StationConfig {
  const s = suggestRotation({ gravity: [0, 0, -980], rotation: IDENTITY_MATRIX, headingDeg: 90 })
  if (!s.ok) throw new Error(s.reason)
  return config(
    IIS_AXES.map((axes) => axes.map(flipZ)),
    s.rotation,
  )
}

export function config(iisAxes: readonly (readonly Vec3[])[], iisOrientation: Mat3 = IDENTITY_MATRIX): StationConfig {
  const iis: BoardEntry = {
    boardKey: IIS,
    stationId: 'st1',
    orientation: iisOrientation,
    sensors: iisAxes.map((axes, i) => ({ sensorId: `i${i}`, enabled: true, noiseDensity: null, axes: axes.map((vector) => ({ vector, offset: 0 })) })),
  }
  const mpu: BoardEntry = {
    boardKey: MPU,
    stationId: 'st1',
    orientation: IDENTITY_MATRIX,
    sensors: [{ sensorId: 'm0', enabled: true, noiseDensity: null, axes: IDENTITY_MATRIX.map((vector) => ({ vector, offset: 0 })) }],
  }
  return { stations: [{ stationId: 'st1', displayName: 'x', lat: 0, lon: 0 }], boards: [mpu, iis] }
}

/** `truth` の向きで測った生データ（MPU は単位行列で、ゼロ点がずれている）。 */
export function packets(truth: readonly (readonly Vec3[])[]): SensorPacket[] {
  return [
    ...packetsOf(MPU, 'm0', IDENTITY_MATRIX.map((w, j) => ({ w, o: [12, -30, 980] [j]! }))),
    ...truth.flatMap((axes, i) => packetsOf(IIS, `i${i}`, axes.map((w) => ({ w, o: 5 * (i + 1) })))),
  ]
}

export const window = { stationId: 'st1', fromMs: T0, toMs: T0 + SECONDS * 1000 }

