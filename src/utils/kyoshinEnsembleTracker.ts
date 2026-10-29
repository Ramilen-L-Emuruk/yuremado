/**
 * 組み合わせの揺れ検知器（`kyoshinEnsembleDetector.ts`）の報告を、1 つの揺れにつき 1 件の検知へまとめる。
 *
 * 束ね役は秒ごとに「その秒に出ている束」を段階ごとに 1 行ずつ返すだけで、束が前の秒に何だったかは持たない。
 * 画面・音・診断が要るのは「その揺れがいまどの段か・どの観測点が加わったか・いつ確かな段になったか」なので、
 * ここで束の id ごとに積み上げる。
 *
 * - 段階は戻さない。一度確かな段の行が出た束は、その後に早い段の行しか出なくても確かな段のまま
 * - 加わった観測点は、束が生きている間に報告された点をすべて合わせる（減らさない）
 * - 検知を消すのは、束ね役が束を捨てるのと同じとき（どの部分からも `ENSEMBLE_KEEP_MS` 報告されなかった）
 */
import { computeSiteKeys, indexToValue } from './kyoshinSiteKeys'
import { ENSEMBLE_KEEP_MS, type DetectorFrame, type EnsembleReport, type EnsembleSource } from './kyoshinEnsembleDetector'
import type { QuietTables } from './kyoshinQuietTables'

/** 束ね役のうち、ここが使う口。テストで偽物を差し込めるよう、生の束ね役ではなくこれを受け取る */
export interface EnsembleReporter {
  push(f: DetectorFrame): EnsembleReport[]
  /** 平常のゆらぎの表を差し替える（作り直さないので、揺れの最中でも検知は途切れない） */
  setTables(tables: QuietTables): void
}

export interface EnsembleDetection {
  /** 束の id。同じ揺れの間は変わらない */
  id: string
  /** 早い段（`likely`）か確かな段（`confirmed`） */
  confidence: 'likely' | 'confirmed'
  /** 束を作った検知の位置（緯度・経度）。震源の推定ではない */
  epicenter: [number, number]
  /** 束を作った検知の揺れ始め（データ時刻・ミリ秒） */
  originTimeMs: number
  /** 加わった観測点の鍵（`computeSiteKeys`）。加わった順 */
  memberKeys: string[]
  /** 加わった観測点のいまの計測震度の最大。いま全員が欠測なら null */
  maxIntensity: number | null
  /** 初めて確かな段になったデータ時刻。まだなら null */
  firstConfirmedAtMs: number | null
  /** 束を支えた部分（統計・波面・高い震度の近道・まばらな所の規則）。束が生きている間に支えたものを合わせる */
  sources: EnsembleSource[]
  /** 束ね役が最後にこの束を報告したデータ時刻 */
  lastReportMs: number
  /**
   * 確かな段になった瞬間（その秒の観測点を足し終えた後）の点数と最大震度。まだなら null。
   * 画面の「6点・震度2で確定」はこれから作る。いまの値で言うと、収まりかけた後に点数も震度も確定した時と違って見える
   */
  confirmedSnapshot: { size: number; maxIntensity: number | null } | null
}

interface State {
  id: string
  confirmed: boolean
  epicenter: [number, number]
  originTimeMs: number
  members: number[]
  memberSet: Set<number>
  firstConfirmedAtMs: number | null
  confirmedSnapshot: { size: number; maxIntensity: number | null } | null
  sources: Set<EnsembleSource>
  lastReportMs: number
}

/** 加わった観測点のいまの計測震度の最大。全員が欠測なら null */
function maxIntensityOf(members: readonly number[], values: ArrayLike<number>): number | null {
  let max: number | null = null
  for (const i of members) {
    const v = values[i]
    if (v < 0) continue
    const x = indexToValue(v)
    if (max === null || x > max) max = x
  }
  return max
}

export function createEnsembleTracker(sites: [number, number][], reporter: EnsembleReporter) {
  const keys = computeSiteKeys(sites)
  const live = new Map<string, State>()

  return {
    /** 平常のゆらぎの表を束ね役へ渡す。積み上げた検知はそのまま残す */
    setTables(tables: QuietTables): void {
      reporter.setTables(tables)
    },
    /** 1 秒ぶんを入れ、いま生きている検知を揺れ始めの早い順に返す */
    push(f: DetectorFrame): EnsembleDetection[] {
      if (f.values.length !== sites.length) throw new Error(`観測点の数（${sites.length}）と値の数（${f.values.length}）が食い違っています`)
      for (const r of reporter.push(f)) {
        let s = live.get(r.id)
        if (!s) {
          s = { id: r.id, confirmed: false, epicenter: [r.lat, r.lng], originTimeMs: r.startMs, members: [], memberSet: new Set(), firstConfirmedAtMs: null, confirmedSnapshot: null, sources: new Set(), lastReportMs: f.ms }
          live.set(r.id, s)
        }
        s.lastReportMs = f.ms
        if (r.tier === 'confirmed' && !s.confirmed) {
          s.confirmed = true
          s.firstConfirmedAtMs = f.ms
        }
        for (const i of r.sites) if (!s.memberSet.has(i)) { s.memberSet.add(i); s.members.push(i) }
        for (const src of r.sources) s.sources.add(src)
      }
      for (const [id, s] of live) if (f.ms - s.lastReportMs > ENSEMBLE_KEEP_MS) live.delete(id)
      const out: EnsembleDetection[] = []
      for (const s of live.values()) {
        const max = maxIntensityOf(s.members, f.values)
        // 確かな段になった秒の観測点をすべて足し終えてから控える（同じ秒の別の行が点を足すことがある）
        if (s.firstConfirmedAtMs === f.ms && s.confirmedSnapshot === null) s.confirmedSnapshot = { size: s.members.length, maxIntensity: max }
        out.push({
          id: s.id,
          confidence: s.confirmed ? 'confirmed' : 'likely',
          epicenter: s.epicenter,
          originTimeMs: s.originTimeMs,
          memberKeys: s.members.map(i => keys[i]),
          maxIntensity: max,
          firstConfirmedAtMs: s.firstConfirmedAtMs,
          confirmedSnapshot: s.confirmedSnapshot,
          sources: [...s.sources],
          lastReportMs: s.lastReportMs,
        })
      }
      return out.sort((a, b) => a.originTimeMs - b.originTimeMs)
    },
  }
}
