// 地震情報の入口の判定（震度の補い・据え置き・控えの更新・報を当てたあとのカード）を固定する。アプリと中継が同じものを使う
// （docs/relay-server-design.md §6.7。2026-11-04 ユーザー選択「アプリと同じに出す (Recommended)」）。
import { describe, it, expect, vi } from 'vitest'
import type { EarthquakePoint, IntensityScale, JMAQuake } from '../types/earthquake'
import {
  type QuakeIntensityCache, fillQuakeIntensity, findQuakeCancelTarget, isQuakeReportHeldBack, noteQuakeIntensity, quakeCardAfterReport,
} from './quakeNotifyTracker'
import type { QuakeRetraction } from './quakeMerge'
import { log } from './logger'

const area = (addr: string, scale: IntensityScale): EarthquakePoint => ({ pref: '', addr, isArea: true, scale })

function makeQuake(o: {
  type?: JMAQuake['issue']['type']; time?: string; maxScale?: IntensityScale; points?: EarthquakePoint[]; cancelled?: boolean
} = {}): JMAQuake {
  const type = o.type ?? '震度速報'
  const withHypo = type !== '震度速報'
  const time = o.time ?? '2026-01-01T07:22:30Z'
  return {
    kind: 'quake',
    id: 'dmdata-quake-20260101162200-1',
    eventKey: '20260101162200',
    time,
    ...(o.cancelled && { cancelled: true }),
    issue: { source: 'dmdata', time, type, correct: 'なし' },
    earthquake: {
      time: '2026-01-01T07:22:00Z',
      hypocenter: {
        name: withHypo ? '石川県能登地方' : '',
        latitude: withHypo ? 37.5 : -200,
        longitude: withHypo ? 137.2 : -200,
        depth: withHypo ? 10 : -1,
        magnitude: withHypo ? 5.2 : NaN,
      },
      maxScale: o.maxScale ?? 45,
      domesticTsunami: 'なし',
    },
    points: o.points ?? [area('石川県能登', 45), area('石川県加賀', 30)],
  } as JMAQuake
}

/** 震度を持たない震源情報（VXSE52） */
const hypoOnly = (time = '2026-01-01T07:24:00Z') => makeQuake({ type: '震源情報', time, maxScale: -1, points: [] })

describe('fillQuakeIntensity', () => {
  // 正: 震度を持たない報を、控えた震度速報の震度で補い、補った印を付ける
  it('震度を持たない報は控えの震度で補い、印を付ける', () => {
    const cache: QuakeIntensityCache = new Map()
    noteQuakeIntensity(cache, makeQuake(), { heldBack: false, retracted: false, cancelTarget: undefined })
    const filled = fillQuakeIntensity(hypoOnly(), cache)
    expect(filled.earthquake.maxScale).toBe(45)
    expect(filled.points).toHaveLength(2)
    expect(filled.intensityFromCache).toBe(true)
  })

  // 対照: 震度を持つ報・控えの無い地震はそのまま返す（同じ参照）
  it('震度を持つ報と、控えの無い地震はそのまま返す', () => {
    const cache: QuakeIntensityCache = new Map()
    noteQuakeIntensity(cache, makeQuake(), { heldBack: false, retracted: false, cancelTarget: undefined })
    const withIntensity = makeQuake({ type: '震源・震度情報', maxScale: 30, points: [area('石川県能登', 30)] })
    expect(fillQuakeIntensity(withIntensity, cache)).toBe(withIntensity)
    const other = { ...hypoOnly(), eventKey: '20260101170000', id: 'dmdata-quake-20260101170000-1' }
    expect(fillQuakeIntensity(other, cache)).toBe(other)
  })
})

describe('noteQuakeIntensity', () => {
  // 安全弁: 据え置いた報・取消より前の報の震度は控えない（裏口からカードへ入り込むため）
  it('据え置いた報・取消より前の報は控えない', () => {
    const cache: QuakeIntensityCache = new Map()
    noteQuakeIntensity(cache, makeQuake(), { heldBack: true, retracted: false, cancelTarget: undefined })
    noteQuakeIntensity(cache, makeQuake(), { heldBack: false, retracted: true, cancelTarget: undefined })
    expect(cache.size).toBe(0)
  })

  // 対照: 震度速報でない報は控えない
  it('震度速報でない報は控えない', () => {
    const cache: QuakeIntensityCache = new Map()
    noteQuakeIntensity(cache, makeQuake({ type: '震源・震度情報' }), { heldBack: false, retracted: false, cancelTarget: undefined })
    expect(cache.size).toBe(0)
  })

  // 正: 震度速報の取消は、取消より前に発表された控えだけを捨てる
  it('震度速報の取消は、取消より前の控えを捨て、後に発表し直された控えは残す', () => {
    const earlier: QuakeIntensityCache = new Map()
    noteQuakeIntensity(earlier, makeQuake({ time: '2026-01-01T07:22:30Z' }), { heldBack: false, retracted: false, cancelTarget: undefined })
    noteQuakeIntensity(earlier, makeQuake({ cancelled: true, time: '2026-01-01T07:30:00Z', maxScale: -1, points: [] }), { heldBack: false, retracted: false, cancelTarget: undefined })
    expect(earlier.size).toBe(0)

    const later: QuakeIntensityCache = new Map()
    noteQuakeIntensity(later, makeQuake({ time: '2026-01-01T07:40:00Z' }), { heldBack: false, retracted: false, cancelTarget: undefined })
    noteQuakeIntensity(later, makeQuake({ cancelled: true, time: '2026-01-01T07:30:00Z', maxScale: -1, points: [] }), { heldBack: false, retracted: false, cancelTarget: undefined })
    expect(later.size).toBe(1)
  })
})

describe('isQuakeReportHeldBack', () => {
  // 正: 取消より前の報は、既存のカードが無くても採らない
  it('取消より前に発表された報は、既存のカードが無くても据え置く', () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {})
    expect(isQuakeReportHeldBack(undefined, makeQuake(), true)).toBe(true)
    info.mockRestore()
  })

  // 対照: 既存のカードが無ければ据え置かない
  it('既存のカードが無ければ据え置かない', () => {
    expect(isQuakeReportHeldBack(undefined, makeQuake(), false)).toBe(false)
  })

  // 正: 完全版のカードの後に届いた古い速報段階の報は据え置く（統合側と同じ `quakeHoldBack`）
  it('完全版のカードの後の震度速報は据え置く', () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {})
    const card = quakeCardAfterReport({
      existing: undefined, quake: makeQuake({ type: '震源・震度情報', time: '2026-01-01T07:30:00Z' }),
      cancelTarget: undefined, retractions: [], areaPrefIndex: null, cancelledAt: new Date(0),
    })!
    expect(isQuakeReportHeldBack(card, makeQuake({ time: '2026-01-01T07:22:30Z', maxScale: 30, points: [area('福井県嶺南', 30)] }), false)).toBe(true)
    info.mockRestore()
  })
})

describe('quakeCardAfterReport', () => {
  // 正: 続報は統合する
  it('取消でない報は統合したカードを返す', () => {
    const first = quakeCardAfterReport({ existing: undefined, quake: makeQuake(), cancelTarget: undefined, retractions: [], areaPrefIndex: null, cancelledAt: new Date(0) })!
    const next = quakeCardAfterReport({
      existing: first, quake: makeQuake({ type: '震源・震度情報', time: '2026-01-01T07:26:00Z' }),
      cancelTarget: undefined, retractions: [], areaPrefIndex: null, cancelledAt: new Date(0),
    })!
    expect(next.earthquake.hypocenter.name).toBe('石川県能登地方')
  })

  // 正: 全体の取消は取消済みの印を付けたカード。対照: 当たり先が無ければ undefined
  it('全体の取消は取消済みの印を付け、当たり先が無ければ何も返さない', () => {
    const card = quakeCardAfterReport({ existing: undefined, quake: makeQuake(), cancelTarget: undefined, retractions: [], areaPrefIndex: null, cancelledAt: new Date(0) })!
    const cancel = makeQuake({ cancelled: true, time: '2026-01-01T07:30:00Z', maxScale: -1, points: [] })
    const target = findQuakeCancelTarget([card], cancel, null)
    expect(target).toBe(card)
    const retractions: QuakeRetraction[] = []
    const at = new Date('2026-01-01T07:30:05Z')
    const cancelled = quakeCardAfterReport({ existing: card, quake: cancel, cancelTarget: target, retractions, areaPrefIndex: null, cancelledAt: at })
    expect(cancelled?.cancelledAt).toEqual(at)
    expect(quakeCardAfterReport({ existing: card, quake: cancel, cancelTarget: undefined, retractions, areaPrefIndex: null, cancelledAt: at })).toBeUndefined()
  })

  // 安全弁: 取消済みのカードは取消の当たり先にしない（二重に取消表示を張らない）
  it('取消済みのカードは取消の当たり先にしない', () => {
    const card = { ...makeQuake(), cancelledAt: new Date(0) }
    expect(findQuakeCancelTarget([card], makeQuake({ cancelled: true, time: '2026-01-01T07:30:00Z', maxScale: -1, points: [] }), null)).toBeUndefined()
  })
})
