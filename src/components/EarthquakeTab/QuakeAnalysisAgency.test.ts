// 解析の窓の機関ごとのタブが値を言葉・数に直す手助け。素材は中継の本番から取った能登（2024-01-01）の答え
import { describe, expect, it } from 'vitest'
import { ja } from '../../i18n/messages/ja'
import noto from '../../services/relayAnalysis.noto.fixture.json'
import { groupSolutionVersions, parseQuakeAnalysis } from '../../services/relayAnalysis'
import { evaluationWord, percentOf, unchangedAcrossVersions } from './QuakeAnalysisAgency'

const w = ja.quake.analysis
const a = parseQuakeAnalysis(noto)

describe('percentOf', () => {
  it('USGS・GEOFON は 0〜1 の割合を百分率に、EMSC・気象庁はそのまま', () => {
    expect(percentOf({ source: 'usgs' }, 0.874)).toBe(87)
    expect(percentOf({ source: 'geofon' }, 0.6)).toBe(60)
    expect(percentOf({ source: 'emsc' }, 87)).toBe(87)
    // [安全弁] 値が無い・真偽値なら出さない
    expect(percentOf({ source: 'usgs' }, undefined)).toBeNull()
    expect(percentOf({ source: 'emsc' }, true)).toBeNull()
  })
})

describe('unchangedAcrossVersions', () => {
  const usgs = groupSolutionVersions(a.solutions).find(g => g.latest.source === 'usgs')!

  it('版のあいだで表に出す値が 1 つでも違えば「変わっていない」と言わない', () => {
    // [正] 公表の時刻だけが違う版は変わっていない
    expect(unchangedAcrossVersions({ latest: usgs.latest, older: [{ ...usgs.latest, publishedAt: '2024-01-01T00:00:00Z' }] })).toBe(true)
    // [対照] Mw と節面が同じでも、深さ・補足の値（観測点数など）が違えば変わっている
    expect(unchangedAcrossVersions({ latest: usgs.latest, older: [{ ...usgs.latest, depthKm: (usgs.latest.depthKm ?? 0) + 1 }] })).toBe(false)
    expect(unchangedAcrossVersions({ latest: usgs.latest, older: [{ ...usgs.latest, extra: { ...usgs.latest.extra, stations: 999 } }] })).toBe(false)
  })
})

describe('evaluationWord', () => {
  const e = (evaluationMode: string | null, evaluationStatus: string | null) => ({ evaluationMode, evaluationStatus })

  it('取得元の決めた見直しの段階を言葉にする', () => {
    expect(evaluationWord(w, e('manual', null))).toBe(w.evaluation.manual)
    expect(evaluationWord(w, e('manual', 'confirmed'))).toBe(w.evaluation.manual)
    expect(evaluationWord(w, e('automatic', 'confirmed'))).toBe(w.evaluation.confirmed)
    expect(evaluationWord(w, e('automatic', 'preliminary'))).toBe(w.evaluation.automatic)
    expect(evaluationWord(w, e('automatic', null))).toBe(w.evaluation.automatic)
  })

  it('[安全弁] 知らない値は捨てずに、そのまま添えて出す', () => {
    expect(evaluationWord(w, e('manual', 'reviewed'))).toBe(`${w.evaluation.manual}（reviewed）`)
    expect(evaluationWord(w, e('automatic', 'rejected'))).toBe(`${w.evaluation.automatic}（rejected）`)
    expect(evaluationWord(w, e(null, 'final'))).toBe('final')
    expect(evaluationWord(w, e('semi', 'final'))).toBe('semi（final）')
    expect(evaluationWord(w, e('semi', null))).toBe('semi')
    expect(evaluationWord(w, e(null, null))).toBeNull()
  })
})
