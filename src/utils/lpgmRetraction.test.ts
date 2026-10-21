import { describe, it, expect } from 'vitest'
import type { JMALpgm } from '../types/earthquake'
import { addLpgmRetraction, applyLiveLpgm, foldLpgmHistory, isRetractedLpgm, lpgmRetractionOf, recordLpgmRetractions, type LpgmRetraction } from './lpgmRetraction'

const at = (iso: string) => Date.parse(iso)

function lpgm(o: { eventId?: string; time: string; created?: string; cancelled?: boolean; maxClass?: number }): JMALpgm {
  return {
    id: `dmdata-lpgm-${o.eventId ?? '20240101161010'}-${o.time}`,
    eventId: o.eventId ?? '20240101161010',
    time: o.time,
    ...(o.created !== undefined && { createdAtMs: at(o.created) }),
    originTime: '2024-01-01T07:10:00Z',
    maxClass: o.maxClass ?? 3,
    cancelled: o.cancelled ?? false,
  }
}

const 発表 = lpgm({ time: '2024-01-01T07:40:00Z', created: '2024-01-01T07:40:10Z' })
const 取消 = lpgm({ time: '2024-01-01T07:50:00Z', created: '2024-01-01T07:50:10Z', cancelled: true, maxClass: 0 })

describe('長周期の取消の台帳（lpgmRetraction）', () => {
  it('正: 取消より前に発表された報は取り下げ済み', () => {
    expect(isRetractedLpgm([lpgmRetractionOf(取消)], 発表)).toBe(true)
  })

  it('対照: 取消より後に発表された報（発表し直し）は採る', () => {
    const 後 = lpgm({ time: '2024-01-01T08:00:00Z', created: '2024-01-01T08:00:10Z' })
    expect(isRetractedLpgm([lpgmRetractionOf(取消)], 後)).toBe(false)
  })

  it('対照: 別の地震の報は取り下げない', () => {
    const 別 = lpgm({ eventId: '20240101170000', time: '2024-01-01T07:40:00Z' })
    expect(isRetractedLpgm([lpgmRetractionOf(取消)], 別)).toBe(false)
  })

  it('安全弁: 同じ取消は二度積まない', () => {
    const list: LpgmRetraction[] = []
    addLpgmRetraction(list, lpgmRetractionOf(取消), 20)
    addLpgmRetraction(list, lpgmRetractionOf(取消), 20)
    expect(list).toHaveLength(1)
  })

  describe('foldLpgmHistory', () => {
    it('正: 履歴に取消があれば、その地震の前の報は残らない（並びによらない）', () => {
      expect(foldLpgmHistory(new Map(), [発表, 取消], []).size).toBe(0)
      expect(foldLpgmHistory(new Map(), [取消, 発表], []).size).toBe(0)
    })

    it('正: ライブで見た取消（台帳）があれば、もっと見るで読み足した前の報を戻さない', () => {
      const ledger = [lpgmRetractionOf(取消)]
      expect(foldLpgmHistory(new Map(), [発表], ledger).size).toBe(0)
    })

    it('安全弁: 畳み込みは台帳を書き換えない（状態更新の関数の中で呼ばれても二重に積まない）', () => {
      const ledger: LpgmRetraction[] = []
      foldLpgmHistory(new Map(), [発表, 取消], ledger)
      expect(ledger).toEqual([])
    })

    it('対照: 取消の無い地震は新しい報を残す', () => {
      const 続報 = lpgm({ time: '2024-01-01T07:45:00Z', created: '2024-01-01T07:45:10Z', maxClass: 4 })
      const result = foldLpgmHistory(new Map(), [続報, 発表], [])
      expect(result.get(発表.eventId)?.maxClass).toBe(4)
    })

    it('安全弁: 既に持っている取り下げ済みの報（base）も外す', () => {
      const result = foldLpgmHistory(new Map([[発表.eventId, 発表]]), [取消], [])
      expect(result.size).toBe(0)
    })
  })

  describe('recordLpgmRetractions', () => {
    it('正: 履歴の取消だけを台帳へ積む（取消でない報は積まない）', () => {
      const ledger: LpgmRetraction[] = []
      recordLpgmRetractions([発表, 取消], ledger)
      expect(ledger).toEqual([lpgmRetractionOf(取消)])
    })

    it('安全弁: 地震を指せない取消（eventId が空・発表時刻も作成時刻も空）は積まない', () => {
      const ledger: LpgmRetraction[] = []
      recordLpgmRetractions([{ ...取消, eventId: '' }, { ...取消, time: '', createdAtMs: undefined }], ledger)
      expect(ledger).toEqual([])
    })

    // 発表時刻が空でも、作成時刻があれば前後は決められる（比べ方は作成時刻を先に見る）
    it('正: 発表時刻が空でも作成時刻のある取消は積み、その前の報を取り下げる', () => {
      const ledger: LpgmRetraction[] = []
      const 発表時刻の無い取消 = { ...取消, time: '' }
      recordLpgmRetractions([発表時刻の無い取消], ledger)
      expect(ledger).toEqual([{ eventId: 取消.eventId, time: '', createdAtMs: 取消.createdAtMs }])
      expect(isRetractedLpgm(ledger, 発表)).toBe(true)
      expect(foldLpgmHistory(new Map(), [発表, 発表時刻の無い取消], []).size).toBe(0)
    })

    // 作成時刻を持たない報（作成時刻を読めなかった報・テストボタンの報）とも比べられる。比べ方は
    // 持つ側を分へ切り捨て、持たない側は自分の発表時刻の分を使う（空の発表時刻は読まない）
    it('正: 発表時刻が空の取消は、作成時刻を持たない前の報も取り下げる', () => {
      const 作成時刻の無い報 = lpgm({ time: '2024-01-01T07:40:00Z' })
      const ledger: LpgmRetraction[] = []
      recordLpgmRetractions([{ ...取消, time: '' }], ledger)
      expect(isRetractedLpgm(ledger, 作成時刻の無い報)).toBe(true)
      expect(isRetractedLpgm(ledger, lpgm({ time: '2024-01-01T08:00:00Z' }))).toBe(false)
    })

    it('対照: 報の発表時刻が空でも作成時刻があれば比べ、取消より後の報は採る（前の報は取り下げる）', () => {
      const ledger = [lpgmRetractionOf(取消)]
      expect(isRetractedLpgm(ledger, { ...lpgm({ time: '2024-01-01T08:00:00Z', created: '2024-01-01T08:00:10Z' }), time: '' })).toBe(false)
      expect(isRetractedLpgm(ledger, { ...発表, time: '' })).toBe(true)
    })

    it('安全弁: 報の発表時刻も作成時刻も空なら取り下げ側へ倒す', () => {
      expect(isRetractedLpgm([lpgmRetractionOf(取消)], { ...発表, time: '', createdAtMs: undefined })).toBe(true)
    })

    it('対照: 発表時刻が空の取消でも、作成時刻より後に発表し直された報は採る', () => {
      const ledger: LpgmRetraction[] = []
      const 後 = lpgm({ time: '2024-01-01T08:00:00Z', created: '2024-01-01T08:00:10Z' })
      recordLpgmRetractions([{ ...取消, time: '' }], ledger)
      expect(isRetractedLpgm(ledger, 後)).toBe(false)
      expect(foldLpgmHistory(new Map(), [後, { ...取消, time: '' }], []).get(後.eventId)).toBe(後)
    })
  })

  describe('applyLiveLpgm（ライブの 1 通）', () => {
    it('正: 取消はその取消より前に発表された報を消す', () => {
      expect(applyLiveLpgm(new Map([[発表.eventId, 発表]]), 取消).size).toBe(0)
    })

    it('対照: 取消より後に発表し直された報が先に届いていれば残す', () => {
      const 後 = lpgm({ time: '2024-01-01T08:00:00Z', created: '2024-01-01T08:00:10Z' })
      expect(applyLiveLpgm(new Map([[後.eventId, 後]]), 取消).get(後.eventId)).toBe(後)
    })

    it('安全弁: 取消の発表時刻が空でも、持っている 1 通は消す', () => {
      const 時刻の無い取消 = { ...取消, time: '', createdAtMs: undefined }
      expect(applyLiveLpgm(new Map([[発表.eventId, 発表]]), 時刻の無い取消).size).toBe(0)
    })

    it('対照: 取消でない報は地震ごとの 1 通を差し替える', () => {
      const 続報 = lpgm({ time: '2024-01-01T07:45:00Z', created: '2024-01-01T07:45:10Z', maxClass: 4 })
      expect(applyLiveLpgm(new Map([[発表.eventId, 発表]]), 続報).get(発表.eventId)).toBe(続報)
    })
  })
})
