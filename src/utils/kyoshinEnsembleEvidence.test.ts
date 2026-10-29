import { describe, expect, it } from 'vitest'
import type { DetectorFrame, EnsembleReport } from './kyoshinEnsembleDetector'
import { ENSEMBLE_EVIDENCE_FOOTNOTE, ensembleRows, ensembleSummary } from './kyoshinEnsembleEvidence'
import { createEnsembleTracker, type EnsembleDetection } from './kyoshinEnsembleTracker'

const T0 = Date.UTC(2026, 0, 1)
/** value = -3.0 + index * 0.5。震度2 は value 1.5〜2.5（index 9〜10）、震度3 は index 11 */
const det = (over: Partial<EnsembleDetection>): EnsembleDetection => ({
  id: 'e1', confidence: 'confirmed', epicenter: [35, 135], originTimeMs: T0,
  memberKeys: ['a', 'b', 'c'], drawnKeys: ['a', 'b', 'c'], maxIntensity: 2.0, firstConfirmedAtMs: T0 + 4000,
  confirmedSnapshot: { size: 6, maxIntensity: 2.0 }, sources: ['stat', 'cluster'], lastReportMs: T0 + 5000,
  ...over,
})

describe('組み合わせの検知器の判定の根拠', () => {
  it('正: 確かな段は、確定した瞬間の点数と最大震度で 1 行にする', () => {
    expect(ensembleSummary(det({}))).toBe('6点・震度2で確定')
  })

  it('対照: いまの点数・震度が確定したときと違っても、確定した瞬間の値で言う', () => {
    expect(ensembleSummary(det({ memberKeys: ['a'], maxIntensity: -1 }))).toBe('6点・震度2で確定')
  })

  // 2026-10-29 ユーザー選択「早い段にも一行を出す」・点数はユーザー選択「点数を外す (Recommended)」
  const likely = (over: Partial<EnsembleDetection>) =>
    det({ confidence: 'likely', firstConfirmedAtMs: null, confirmedSnapshot: null, ...over })

  it('正: 早い段は、支えた部分を決まった順で並べて「…で反応」と言う', () => {
    expect(ensembleSummary(likely({ sources: ['cluster', 'stat'] }))).toBe('平常時のゆらぎ・揺れの広がりで反応')
  })

  it('対照: 早い段は点数も震度も言わない（本文の「N観測点で反応」と数を並べない）', () => {
    expect(ensembleSummary(likely({ memberKeys: ['a', 'b', 'c', 'd', 'e'], maxIntensity: 3.2, sources: ['fast'] })))
      .toBe('強い揺れの急な上昇で反応')
  })

  it('安全弁: 早い段で支えた部分が無ければ行を出さない', () => {
    expect(ensembleSummary(likely({ sources: [] }))).toBeNull()
  })

  it('安全弁: 確かな段で確定した瞬間の控えが無ければ、早い段の形へ倒さず行を出さない', () => {
    expect(ensembleSummary(det({ confirmedSnapshot: null }))).toBeNull()
  })

  it('正: 内訳は 4 行で、仕組みは決まった順・決まった呼び名で並べる', () => {
    expect(ensembleRows(det({ sources: ['sparse', 'fast', 'cluster', 'stat'] }))).toEqual([
      { label: '判定した仕組み', value: '平常時のゆらぎ・揺れの広がり・強い揺れの急な上昇・観測点の少ない地域' },
      { label: '加わった観測点', value: '3点' },
      { label: '最大震度', value: '震度2' },
      { label: '確定まで', value: '検知から4秒' },
    ])
  })

  it('対照: 早い段のあいだ「確定まで」は —、欠測で最大震度が無ければ —', () => {
    const rows = ensembleRows(det({ confidence: 'likely', firstConfirmedAtMs: null, confirmedSnapshot: null, maxIntensity: null }))
    expect(rows.find(r => r.label === '確定まで')?.value).toBe('—')
    expect(rows.find(r => r.label === '最大震度')?.value).toBe('—')
  })

  it('正: 震度0 未満のまま確かな段になったら「震度0以下」と言う（「震度—」にしない）', () => {
    const d = det({ maxIntensity: -0.8, confirmedSnapshot: { size: 3, maxIntensity: -1.2 } })
    expect(ensembleSummary(d)).toBe('3点・震度0以下で確定')
    expect(ensembleRows(d).find(r => r.label === '最大震度')?.value).toBe('震度0以下')
  })

  it('対照: 計測震度 0.0〜0.5 はいまどおり「震度0」', () => {
    expect(ensembleSummary(det({ confirmedSnapshot: { size: 3, maxIntensity: 0.2 } }))).toBe('3点・震度0で確定')
  })

  it('安全弁: 階級は計測震度から引く（0.5 刻みへ丸めると 4.4 が「5弱」になる）', () => {
    expect(ensembleSummary(det({ confirmedSnapshot: { size: 8, maxIntensity: 4.4 } }))).toBe('8点・震度4で確定')
  })

  it('安全弁: 脚注の文面は決まったまま', () => {
    expect(ENSEMBLE_EVIDENCE_FOOTNOTE).toBe('※「加わった観測点」は、上の観測点数と数え方が異なります')
  })
})

describe('束をまとめる係の、確定した瞬間の控え', () => {
  const sites: [number, number][] = [[35, 135], [35.1, 135], [35.2, 135]]
  /** 秒 0 は早い段で点 0、秒 1 は早い段（点 1）と確かな段（点 2）を同じ秒に、秒 2 以降は早い段だけ */
  const reporter = {
    setTables: () => {},
    push: (f: DetectorFrame): EnsembleReport[] => {
      const sec = (f.ms - T0) / 1000
      const base = { id: 'e1', lat: 35, lng: 135, startMs: T0 }
      if (sec === 0) return [{ ...base, tier: 'early', sites: [0], sources: ['stat'] }]
      if (sec === 1) return [{ ...base, tier: 'early', sites: [1], sources: ['stat'] }, { ...base, tier: 'confirmed', sites: [2], sources: ['cluster'] }]
      return [{ ...base, tier: 'early', sites: [0], sources: ['stat'] }]
    },
  }

  it('正: 確かな段になった秒の点をすべて足し終えた後の点数と、その秒の最大震度を控え、後で動かさない', () => {
    const tr = createEnsembleTracker(sites, reporter)
    tr.push({ ms: T0, values: Int8Array.from([8, 6, 6]) })
    const at = tr.push({ ms: T0 + 1000, values: Int8Array.from([8, 9, 10]) })
    expect(at[0].confirmedSnapshot).toEqual({ size: 3, maxIntensity: 2.0 })
    const later = tr.push({ ms: T0 + 2000, values: Int8Array.from([6, 6, 6]) })
    expect(later[0].confirmedSnapshot).toEqual({ size: 3, maxIntensity: 2.0 })
    expect(later[0].maxIntensity).toBe(0)
  })

  it('対照: 確かな段になる前は控えが無い', () => {
    const tr = createEnsembleTracker(sites, reporter)
    expect(tr.push({ ms: T0, values: Int8Array.from([8, 6, 6]) })[0].confirmedSnapshot).toBeNull()
  })
})
