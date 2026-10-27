import { describe, expect, it } from 'vitest'

import { problemLines } from './viewNotify'

const NONE = { hostUnreachable: false, streamDown: false, notifyError: null }

describe('problemLines', () => {
  it('対照: 不調が無ければ何も出さない', () => {
    expect(problemLines(NONE, false)).toEqual([])
  })

  it('正: 不調ごとに 1 行ずつ、承認した文で出す（2026-10-27 ユーザー承認）', () => {
    expect(
      problemLines({ hostUnreachable: true, streamDown: true, notifyError: 'Illegal constructor' }, true),
    ).toEqual([
      'ホストの状態を読めない',
      '揺れの記録を受け取れていない（繋ぎ直している）',
      '通知を出せなかった: Illegal constructor',
      '設定を保存できなかった',
    ])
  })
})
