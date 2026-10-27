import { describe, expect, it } from 'vitest'

import {
  HOST_UNREACHABLE_AFTER,
  RESOLVED_TITLE,
  ShakeTracker,
  WARNING_TITLE,
  WarningTracker,
  shakeBody,
  snapshotWarnings,
  warningNotifications,
} from './adminNotify'
import type { ShakeRecordView } from './shakeHistory'
import { listWarning, singleWarning, warningItem, plainDetail, type StatusWarning } from './statusWarnings'

const BOTH = { warnings: true, resolved: true }

function silent(boards: readonly [string, string][]): StatusWarning {
  const w = listWarning(
    'assigned-board-silent',
    '観測点に割り当てた基板が届いていない',
    boards.map(([key, since]) => warningItem(key, key, plainDetail(`観測点 st1・${since}`))),
  )
  if (w === null) throw new Error('テストの組み立てが空')
  return w
}

describe('warningNotifications', () => {
  it('対照: 見張りを始めた最初の 1 回は、出ている警告を知らせない', () => {
    expect(warningNotifications(null, snapshotWarnings([silent([['a0b7', '3 分前から']])]), BOTH)).toEqual([])
  })

  it('正: 新しく出た警告を、稼働状況の行と同じ文面で知らせる', () => {
    const prev = snapshotWarnings([])
    const next = snapshotWarnings([silent([['a0b7', '3 分前から']])])
    expect(warningNotifications(prev, next, BOTH)).toEqual([
      expect.objectContaining({
        title: WARNING_TITLE,
        body: '観測点に割り当てた基板が届いていない: a0b7（観測点 st1・3 分前から）',
      }),
    ])
  })

  it('安全弁: 経過時間だけが変わっても知らせ直さない', () => {
    const prev = snapshotWarnings([silent([['a0b7', '3 分前から']])])
    const next = snapshotWarnings([silent([['a0b7', '4 分前から']])])
    expect(warningNotifications(prev, next, BOTH)).toEqual([])
  })

  it('正: 2 枚目が黙ったら、その 1 枚だけを知らせる（1 枚目を出し直さない・解消とも言わない）', () => {
    const prev = snapshotWarnings([silent([['a0b7', '3 分前から']])])
    const next = snapshotWarnings([silent([['a0b7', '4 分前から'], ['1c8f', '1 分前から']])])
    const out = warningNotifications(prev, next, BOTH)
    expect(out).toHaveLength(1)
    expect(out[0]?.body).toBe('観測点に割り当てた基板が届いていない: 1c8f（観測点 st1・1 分前から）')
  })

  it('正: 消えた警告を、毎回変わる部分を除いた呼び名で「解消した」と知らせる', () => {
    const prev = snapshotWarnings([silent([['a0b7', '3 分前から']])])
    const out = warningNotifications(prev, snapshotWarnings([]), BOTH)
    expect(out).toEqual([
      expect.objectContaining({ title: RESOLVED_TITLE, body: '観測点に割り当てた基板が届いていない: a0b7' }),
    ])
  })

  it('正: 対象の無い警告は、出たときは行そのもの・解消したときは毎回変わる部分を除いた呼び名を本文にする', () => {
    const w = singleWarning('mseed-write', '生データの書き込みエラー', 'ENOSPC')
    const appeared = warningNotifications(snapshotWarnings([]), snapshotWarnings([w]), BOTH)
    expect(appeared[0]?.body).toBe('生データの書き込みエラー: ENOSPC')
    const resolved = warningNotifications(snapshotWarnings([w]), snapshotWarnings([]), BOTH)
    expect(resolved[0]?.body).toBe('生データの書き込みエラー')
  })

  it('対照: 切ってある種類は出さない', () => {
    const prev = snapshotWarnings([silent([['a0b7', '3 分前から']])])
    expect(warningNotifications(prev, snapshotWarnings([]), { warnings: true, resolved: false })).toEqual([])
    expect(warningNotifications(snapshotWarnings([]), prev, { warnings: false, resolved: true })).toEqual([])
  })
})

function shake(over: Partial<ShakeRecordView> = {}): ShakeRecordView {
  return {
    id: 'ev1',
    rev: 1,
    stationId: 'st1',
    stationKey: 'st1',
    startMs: 0,
    endMs: 10_000,
    sMs: null,
    pMs: null,
    peakAccelGal: 3.2,
    maxIntensity: 1.84,
    peakRatio: 12,
    verdict: 'pending',
    matchedQuake: null,
    ...over,
  }
}

describe('shakeBody', () => {
  it('正: 記録したときの文面（2026-10-27 ユーザー承認）', () => {
    expect(shakeBody(shake())).toBe('最大 震度2（計測 1.8）・照合待ち')
  })

  it('正: 照合した後は地震の名前と規模を添える', () => {
    const q = { name: '石川県能登地方', originMs: null, originPrecisionMs: null, magnitude: 4.2, depthKm: 10, maxScale: 30, distanceKm: 120 }
    expect(shakeBody(shake({ verdict: 'quake', matchedQuake: q }))).toBe('最大 震度2（計測 1.8）・地震（石川県能登地方 M4.2）')
  })

  it('安全弁: 震度を持たない揺れでは、無い値を埋めずに判定だけを言う', () => {
    expect(shakeBody(shake({ maxIntensity: null, verdict: 'unclassified' }))).not.toContain('震度')
  })
})

describe('WarningTracker', () => {
  const failTimes = (t: WarningTracker, n: number) => {
    const out = []
    for (let i = 0; i < n; i += 1) out.push(...t.onFailure(BOTH))
    return out
  }

  it('対照: 最初に読めた回は、出ている警告を知らせない', () => {
    const t = new WarningTracker()
    expect(t.onStatus([silent([['a0b7', '3 分前から']])], BOTH)).toEqual([])
  })

  it('安全弁: 読めない回が続いても、その手前までは何も言わず控えも動かさない', () => {
    const t = new WarningTracker()
    t.onStatus([silent([['a0b7', '3 分前から']])], BOTH)
    expect(failTimes(t, HOST_UNREACHABLE_AFTER - 1)).toEqual([])
    expect(t.hostUnreachable).toBe(false)
    // 戻ったとき、黙っていた基板を「解消した」と取り違えない
    expect(t.onStatus([silent([['a0b7', '4 分前から']])], BOTH)).toEqual([])
  })

  it('正: 続けて読めなければ「ホストの状態を読めない」を出し、戻ったら解消を知らせる', () => {
    const t = new WarningTracker()
    t.onStatus([], BOTH)
    expect(failTimes(t, HOST_UNREACHABLE_AFTER)).toEqual([
      expect.objectContaining({ title: WARNING_TITLE, body: 'ホストの状態を読めない' }),
    ])
    expect(t.hostUnreachable).toBe(true)
    // 読めないまま続いても出し直さない
    expect(failTimes(t, 5)).toEqual([])
    expect(t.onStatus([], BOTH)).toEqual([
      expect.objectContaining({ title: RESOLVED_TITLE, body: 'ホストの状態を読めない' }),
    ])
    expect(t.hostUnreachable).toBe(false)
  })

  it('正: 一度も読めないまま繋がらなくても知らせ、戻った回の警告は「出た」と言わない', () => {
    const t = new WarningTracker()
    expect(failTimes(t, HOST_UNREACHABLE_AFTER)).toHaveLength(1)
    const out = t.onStatus([silent([['a0b7', '3 分前から']])], BOTH)
    expect(out).toEqual([expect.objectContaining({ title: RESOLVED_TITLE, body: 'ホストの状態を読めない' })])
  })
})

describe('ShakeTracker', () => {
  it('正: 初めて見た記録（版 1）を知らせる', () => {
    expect(new ShakeTracker(0).onRecord(shake())).toEqual({
      title: '揺れを記録: st1',
      body: '最大 震度2（計測 1.8）・照合待ち',
      tag: 'seismo-shake:ev1',
    })
  })

  it('正: 判定が変わったら同じ tag で知らせ直す（ブラウザが置き換える）', () => {
    const t = new ShakeTracker(0)
    t.onRecord(shake())
    expect(t.onRecord(shake({ rev: 2, verdict: 'quake-like' }))?.tag).toBe('seismo-shake:ev1')
  })

  it('対照: 判定が同じ版が届いても知らせ直さない', () => {
    const t = new ShakeTracker(0)
    t.onRecord(shake())
    expect(t.onRecord(shake({ rev: 2 }))).toBeNull()
  })

  it('安全弁: 古い版が後から届いても、照合後の通知を古い内容へ戻さない', () => {
    const t = new ShakeTracker(0)
    t.onRecord(shake())
    t.onRecord(shake({ rev: 2, verdict: 'quake-like' }))
    expect(t.onRecord(shake({ rev: 1 }))).toBeNull()
    // 戻した版で控えが巻き戻っていれば、ここで知らせ直してしまう
    expect(t.onRecord(shake({ rev: 3, verdict: 'quake-like' }))).toBeNull()
  })

  it('正: 見張りを始める前に始まった揺れは、照合されても知らせない（2026-10-27 ユーザー承認）', () => {
    const t = new ShakeTracker(5_000)
    expect(t.onRecord(shake({ startMs: 0, rev: 1 }))).toBeNull()
    // 見張りの最中に照合されて判定が変わっても、開く前の揺れは知らせない
    expect(t.onRecord(shake({ startMs: 0, rev: 2, verdict: 'quake-like' }))).toBeNull()
    expect(t.onRecord(shake({ startMs: 0, rev: 3, verdict: 'quake' }))).toBeNull()
    // 開いた後の揺れは知らせる（対照）
    expect(t.onRecord(shake({ id: 'ev2', startMs: 6_000 }))).not.toBeNull()
  })

  it('安全弁: 見張りの最中の揺れは、記録時の版を受け取り損ねても後から届いた版で知らせる（押し出しが切れていた間）', () => {
    const t = new ShakeTracker(5_000)
    expect(t.onRecord(shake({ startMs: 6_000, rev: 2, verdict: 'quake-like' }))).toEqual(
      expect.objectContaining({ tag: 'seismo-shake:ev1' }),
    )
  })
})
