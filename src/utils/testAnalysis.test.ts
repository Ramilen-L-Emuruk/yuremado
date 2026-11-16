import { afterEach, describe, expect, it } from 'vitest'
import { clearTestAnalyses, payloadEventIds, setTestAnalysis, testAnalysisFor } from './testAnalysis'

describe('解析テストの差し込み口', () => {
  afterEach(() => clearTestAnalyses())

  it('結び付けた EventID だけに答えを返し、リセットで消える', () => {
    setTestAnalysis('20261115120000', { eventId: 'x' })
    expect(testAnalysisFor('20261115120000')).toEqual({ eventId: 'x' })
    expect(testAnalysisFor('20240101161010')).toBeUndefined()
    clearTestAnalyses()
    expect(testAnalysisFor('20261115120000')).toBeUndefined()
  })

  it('積む中身から EventID を重複なく集める（入れ子の中も）', () => {
    const payload = { kind: 'quake', data: [{ eventId: '20261115120000' }, { eventId: '20261115120000' }], lpgm: { eventId: '20261115120001' } }
    expect(payloadEventIds(payload).sort()).toEqual(['20261115120000', '20261115120001'])
    expect(payloadEventIds(null)).toEqual([])
    expect(payloadEventIds({ eventId: '123' })).toEqual([])
  })
})
