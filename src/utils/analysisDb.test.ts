import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { ANALYSIS_DB_MAX_ENTRIES, clearAnalysisDb, evictAnalysisForTest, readAnalysis, writeAnalysis } from './analysisDb'

describe('analysisDb', () => {
  beforeEach(async () => {
    await clearAnalysisDb()
  })

  it('書いた答えをそのまま読み戻す。同じ地震は上書きする', async () => {
    expect(await writeAnalysis('A', { eventId: 'A', v: 1 }, 10)).toBe(true)
    expect(await readAnalysis('A')).toEqual({ eventId: 'A', savedAt: 10, body: { eventId: 'A', v: 1 } })
    await writeAnalysis('A', { eventId: 'A', v: 2 }, 20)
    expect((await readAnalysis('A'))?.body).toEqual({ eventId: 'A', v: 2 })
    expect(await readAnalysis('B')).toBeNull()
  })

  it('上限を超えたら、最後に書いたのが古い地震から捨てる', async () => {
    await writeAnalysis('old', {}, 1)
    await writeAnalysis('mid', {}, 2)
    await writeAnalysis('new', {}, 3)
    // old を開き直す（書き直す）と、捨てられるのは mid になる
    await writeAnalysis('old', {}, 4)
    await evictAnalysisForTest(2)
    expect(await readAnalysis('mid')).toBeNull()
    expect(await readAnalysis('old')).not.toBeNull()
    expect(await readAnalysis('new')).not.toBeNull()
  })

  it('上限以内なら何も捨てない（対照）', async () => {
    await writeAnalysis('a', {}, 1)
    await writeAnalysis('b', {}, 2)
    await evictAnalysisForTest(2)
    expect(await readAnalysis('a')).not.toBeNull()
    expect(await readAnalysis('b')).not.toBeNull()
    expect(ANALYSIS_DB_MAX_ENTRIES).toBeGreaterThan(2)
  })
})
