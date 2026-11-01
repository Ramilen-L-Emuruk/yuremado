import { describe, it, expect } from 'vitest'
import { formatRelayGapNotices } from './relayGapNotice'

// 時刻は日本時間（vitest.config.ts の TZ）
const at = (iso: string) => Date.parse(`${iso}+09:00`)

describe('formatRelayGapNotices', () => {
  // 正: 区分ごとに何の電文かを名前で言う（2026-10-31 ユーザー選択の文面）
  it('地震・津波の区分と警報の区分を、それぞれの名前で 1 区間 1 行にする', () => {
    expect(formatRelayGapNotices([
      { classification: 'eew.warning', fromMs: at('2026-10-31T03:12:00'), toMs: at('2026-10-31T03:40:00') },
      { classification: 'telegram.earthquake', fromMs: at('2026-10-31T03:12:00'), toMs: at('2026-10-31T03:40:00') },
    ])).toEqual([
      '10/31 3:12〜3:40 の緊急地震速報（警報）が欠けている可能性（照合中）',
      '10/31 3:12〜3:40 の地震・津波の電文が欠けている可能性（照合中）',
    ])
  })

  // 正: 日をまたぐ区間は終わりにも日付を付ける（付けないと 0:20 がどの日か読めない）
  it('日をまたぐ区間は終わりにも日付を付ける', () => {
    expect(formatRelayGapNotices([
      { classification: 'telegram.earthquake', fromMs: at('2026-10-31T23:50:00'), toMs: at('2026-11-01T00:20:00') },
    ])).toEqual(['10/31 23:50〜11/1 0:20 の地震・津波の電文が欠けている可能性（照合中）'])
  })

  // 安全弁: 知らない区分も捨てずに出す（捨てると見ていない時間が「見た」に化ける）
  it('知らない区分は「電文」と言って出す', () => {
    expect(formatRelayGapNotices([
      { classification: 'unknown', fromMs: at('2026-10-31T03:12:00'), toMs: at('2026-10-31T03:40:00') },
    ])).toEqual(['10/31 3:12〜3:40 の電文が欠けている可能性（照合中）'])
  })

  // 対照: 区間が無ければ帯も無い（照合が済んだら消える）
  it('区間が無ければ行も無い', () => {
    expect(formatRelayGapNotices([])).toEqual([])
  })
})
