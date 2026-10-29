// 組み合わせの検知器（v5.75.0 以降の本番と同じ呼び方）で窓を流し、検知ごとの初出を返す
// 本番と違うのは助走（窓より前のフレームを先に流すこと）を付けない点。観測点リストの版が窓の途中で替わったら、そこで打ち切って知らせる
import { readFileSync } from 'node:fs'
import { createEnsembleDetector } from '../../src/utils/kyoshinEnsembleDetector.ts'
import { createEnsembleTracker } from '../../src/utils/kyoshinEnsembleTracker.ts'
import { validateQuietTables } from '../../src/utils/kyoshinQuietTables.ts'
type Frame = { ms: number; ts?: string; indices: ArrayLike<number>; cfg: string }
const tablesPath = new URL('../../public/data/kyoshin-quiet-tables.json', import.meta.url)
const tables = JSON.parse(readFileSync(tablesPath, 'utf8'))
validateQuietTables(tables)
export type Hit = { id: string; likelyMs: number; confirmedMs: number | null; at: [number, number] }
export function runEnsemble(frames: Frame[], sites: [number, number][]): Hit[] {
  const cfg = frames[0].cfg
  const tracker = createEnsembleTracker(sites, createEnsembleDetector(sites, tables))
  const seen = new Map<string, Hit>()
  for (const f of frames) {
    if (f.cfg !== cfg) { console.error(`観測点リストの版が窓の途中で替わったので打ち切る: ${cfg} → ${f.cfg}`); break }
    for (const d of tracker.push({ ms: f.ms, values: Int8Array.from(f.indices) })) {
      let h = seen.get(d.id)
      if (!h) { h = { id: d.id, likelyMs: f.ms, confirmedMs: null, at: [d.epicenter[0], d.epicenter[1]] }; seen.set(d.id, h) }
      if (d.confidence === 'confirmed' && h.confirmedMs == null) h.confirmedMs = f.ms
    }
  }
  return [...seen.values()]
}
