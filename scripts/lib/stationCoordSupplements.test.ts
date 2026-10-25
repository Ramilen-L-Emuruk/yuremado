// 手で補った観測点の座標（stationCoordSupplements.mjs）と、生成済みの座標表の突き合わせ。
// 表だけ直して `build-station-coords.mjs` を回し忘れると、補ったはずの観測点が地図に出ない。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { STATION_COORD_SUPPLEMENTS, UNRESOLVED_STATIONS } from './stationCoordSupplements.mjs'

const coords = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'data', 'station-coords.json'), 'utf8'),
) as {
  stations: Record<string, [number, number, number?]>
  unlisted: Record<string, [number, number, number?]>
  regionNames: string[]
}

describe('手で補った観測点の座標', () => {
  it('正: 表の全行が座標表に載っている（上流に現れたものは上流の値で載る）', () => {
    const missing = STATION_COORD_SUPPLEMENTS
      .map((s) => `${s.pref}|${s.name}`)
      .filter((key) => !(key in coords.unlisted) && !(key in coords.stations))
    expect(missing).toEqual([])
  })

  it('正: 座標表へ入った値は表の値を 0.001 度へ丸めたもので、区域も表のとおり', () => {
    for (const s of STATION_COORD_SUPPLEMENTS) {
      const entry = coords.unlisted[`${s.pref}|${s.name}`]
      if (!entry) continue // 上流に現れて上流の値が入っている
      expect(entry[0]).toBeCloseTo(s.lat, 3)
      expect(entry[1]).toBeCloseTo(s.lon, 3)
      expect(coords.regionNames[entry[2] as number]).toBe(s.area)
    }
  })

  it('対照: 同じ観測点を 2 度書いていない', () => {
    const keys = STATION_COORD_SUPPLEMENTS.map((s) => `${s.pref}|${s.name}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('安全弁: 引けなかった観測点を、推測の座標で座標表へ入れていない', () => {
    for (const s of UNRESOLVED_STATIONS) {
      const key = `${s.pref}|${s.name}`
      expect(key in coords.unlisted || key in coords.stations).toBe(false)
    }
  })
})
