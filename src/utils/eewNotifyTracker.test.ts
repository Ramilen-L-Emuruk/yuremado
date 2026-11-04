import { describe, it, expect } from 'vitest'
import type { EEWAlert } from '../types/earthquake'
import { acceptEewReport, ACTIVE_EEW_WINDOW_MS, type EndedEew } from './eew'
import {
  decideEewReportEntry, decideEewCancelEntry, endEewOnExpiry, mergeEndedEew, stepEewAnnounce,
  eewAnnounceNotice, eewCancelNotice, eewReportCancelMs,
} from './eewNotifyTracker'

const T0 = Date.parse('2026-01-01T12:00:00Z')

function report(serial: number, overrides: Partial<EEWAlert> = {}): EEWAlert {
  const time = new Date(T0 + serial * 1000).toISOString()
  return {
    kind: 'eew',
    origin: 'dmdata',
    id: `ev1-${serial}`,
    time,
    test: false,
    issue: { eventId: 'ev1', serial: String(serial), time },
    earthquake: {
      originTime: new Date(T0 - 5000).toISOString(),
      arrivalTime: new Date(T0).toISOString(),
      condition: '',
      hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 6.0 },
    },
    severity: 'Forecast',
    cancelled: false,
    forecastMaxScale: 30,
    ...overrides,
  }
}

const base = { ended: undefined, nowMs: T0 + 10_000, checkExpired: true, clockTrusted: true }

describe('decideEewReportEntry', () => {
  it('正: 受け付けの記憶が無い地震の初報は採り、受け付けの記憶を作る', () => {
    const entry = decideEewReportEntry({ ...base, incoming: report(1), acceptance: undefined, previous: undefined })
    expect(entry.kind).toBe('accept')
    if (entry.kind !== 'accept') return
    expect(entry.sameReport).toBe(false)
    expect(entry.acceptance.serialBySeries.size).toBe(1)
    expect(entry.acceptance.notifiedIssueMs.size).toBe(1)
  })

  it('対照: 同じ経路で受け付けた報番号より小さい報は捨てる', () => {
    const acceptance = acceptEewReport(undefined, report(3))
    const entry = decideEewReportEntry({ ...base, incoming: report(2), acceptance, previous: report(3) })
    expect(entry.kind).toBe('stale')
  })

  it('安全弁: 表示中の報が取り消し済みなら、新しい報番号でも採らない（取消は終端）', () => {
    const acceptance = acceptEewReport(undefined, report(3))
    const entry = decideEewReportEntry({ ...base, incoming: report(4), acceptance, previous: { ...report(3), cancelled: true } })
    expect(entry.kind).toBe('cancelledTerminal')
  })

  it('正: 画面から消えた地震の同じ報は採らない', () => {
    const ended = mergeEndedEew(undefined, acceptEewReport(undefined, report(5)), false, T0 + 60_000, report(5), null)
    const entry = decideEewReportEntry({ ...base, nowMs: T0 + 70_000, incoming: report(5), acceptance: undefined, previous: undefined, ended })
    expect(entry.kind).toBe('ended')
  })

  it('対照: 消えた後でも、それより新しい報番号の報は採る（終わったのではなく続いている）', () => {
    const ended = mergeEndedEew(undefined, acceptEewReport(undefined, report(5)), false, T0 + 60_000, report(5), null)
    const entry = decideEewReportEntry({ ...base, nowMs: T0 + 70_000, incoming: report(6), acceptance: undefined, previous: undefined, ended })
    expect(entry.kind).toBe('accept')
  })

  it('正: 画面に出ていない地震の、自動解除の時刻を過ぎた報は採らない', () => {
    const incoming = report(1)
    const times = eewReportCancelMs(incoming)
    expect(times).not.toBeNull()
    const entry = decideEewReportEntry({ ...base, nowMs: times!.cancelMs + 1, incoming, acceptance: undefined, previous: undefined })
    expect(entry.kind).toBe('expired')
  })

  it('安全弁: 時計を信じられないときは、自動解除の時刻を過ぎて見えても採る', () => {
    const incoming = report(1)
    const times = eewReportCancelMs(incoming)!
    const entry = decideEewReportEntry({ ...base, clockTrusted: false, nowMs: times.cancelMs + 1, incoming, acceptance: undefined, previous: undefined })
    expect(entry.kind).toBe('expiredUntrusted')
    if (entry.kind === 'expiredUntrusted') expect(entry.then.kind).toBe('accept')
  })

  it('安全弁: 静かに積む報（時刻の判定を使わない）は、自動解除の時刻を過ぎていても採る', () => {
    const incoming = report(1)
    const times = eewReportCancelMs(incoming)!
    const entry = decideEewReportEntry({ ...base, checkExpired: false, nowMs: times.cancelMs + 1, incoming, acceptance: undefined, previous: undefined })
    expect(entry.kind).toBe('accept')
  })

  it('対照: 画面に出ている地震の報は、自動解除の時刻を過ぎていても採る', () => {
    const acceptance = acceptEewReport(undefined, report(1))
    const incoming = report(2)
    const times = eewReportCancelMs(incoming)!
    const entry = decideEewReportEntry({ ...base, nowMs: times.cancelMs + 1, incoming, acceptance, previous: report(1) })
    expect(entry.kind).toBe('accept')
  })
})

describe('decideEewReportEntry（経路をまたぐ報）', () => {
  const yahoo = (serial: number, over: Partial<EEWAlert> = {}) => report(serial, { origin: 'yahoo', ...over })

  it('正: 強震モニタが先に新しい報を運んだ後の電文の報は捨てずに補い、上がっていなければ同じ報として扱う', () => {
    const acceptance = acceptEewReport(undefined, yahoo(5))
    const entry = decideEewReportEntry({ ...base, incoming: report(3), acceptance, previous: yahoo(5) })
    expect(entry.kind).toBe('supplement')
    if (entry.kind === 'supplement') {
      expect(entry.sameReport).toBe(true)
      expect(entry.merged.issue?.serial).toBe('5')
    }
  })

  it('対照: 補う電文の報で区分が上がれば、同じ報として黙らせない', () => {
    const acceptance = acceptEewReport(undefined, yahoo(5))
    const entry = decideEewReportEntry({ ...base, incoming: report(3, { severity: 'Warning', forecastMaxScale: 45 }), acceptance, previous: yahoo(5) })
    expect(entry.kind).toBe('supplement')
    if (entry.kind === 'supplement') expect(entry.sameReport).toBe(false)
  })

  it('正: 別の経路から既に受けて知らせた同じ発表時刻の報は、同じ報として音・通知を止める', () => {
    const first = decideEewReportEntry({ ...base, incoming: yahoo(5), acceptance: undefined, previous: undefined })
    if (first.kind !== 'accept') throw new Error('初報を採らなかった')
    const entry = decideEewReportEntry({ ...base, incoming: report(5), acceptance: first.acceptance, previous: first.merged })
    expect(entry.kind).toBe('accept')
    if (entry.kind === 'accept') expect(entry.sameReport).toBe(true)
  })

  it('安全弁: 取消を表示中（cancelledAt）の報へ届いた報も採らない（取消は終端）', () => {
    const acceptance = acceptEewReport(undefined, report(3))
    const entry = decideEewReportEntry({ ...base, incoming: report(4), acceptance, previous: { ...report(3), cancelledAt: new Date(T0) } })
    expect(entry.kind).toBe('cancelledTerminal')
  })
})

describe('decideEewCancelEntry', () => {
  const ended: EndedEew = mergeEndedEew(undefined, acceptEewReport(undefined, report(5)), false, T0 + 60_000, report(5), null)
  const cancel = { ...report(6), cancelled: true }

  it('正: 消えた後に窓の内で届いた誤報取消は伝え、記憶に取消を載せる', () => {
    const d = decideEewCancelEntry({ incoming: cancel, ended, latest: undefined, gone: true, nowMs: T0 + 70_000 })
    expect(d?.late).not.toBeNull()
    expect(d?.ended.cancelled).toBe(true)
  })

  it('対照: 窓を過ぎた取消は記憶に載せるが、伝えない', () => {
    const d = decideEewCancelEntry({ incoming: cancel, ended, latest: undefined, gone: true, nowMs: T0 + 60_000 + ACTIVE_EEW_WINDOW_MS + 1 })
    expect(d?.late).toBeNull()
    expect(d?.ended.cancelled).toBe(true)
  })

  it('安全弁: 取消で終えた地震へ届いた 2 通目の取消は何もしない', () => {
    const d = decideEewCancelEntry({ incoming: cancel, ended: { ...ended, cancelled: true }, latest: undefined, gone: true, nowMs: T0 + 70_000 })
    expect(d).toBeNull()
  })

  it('安全弁: 画面に出ている地震（入口の写しがある）の取消は、消えた地震の記憶を触らない', () => {
    const d = decideEewCancelEntry({ incoming: cancel, ended, latest: report(6), gone: false, nowMs: T0 + 70_000 })
    expect(d).toBeNull()
  })
})

describe('endEewOnExpiry', () => {
  it('正: 表示中の報と受け付けの記憶があれば、最後の報と第 1 報の時刻で記憶を作る', () => {
    const ended = endEewOnExpiry({ ended: undefined, shown: report(5), acceptance: acceptEewReport(undefined, report(5)), nowMs: T0, firstIssueTime: 'x' })
    expect(ended?.cancelled).toBe(false)
    expect(ended?.lastReport?.id).toBe('ev1-5')
    expect(ended?.firstIssueTime).toBe('x')
  })

  it('対照: 取消を表示中の報（cancelledAt）は自動解除の記憶を作らない', () => {
    const ended = endEewOnExpiry({ ended: undefined, shown: { ...report(5), cancelledAt: new Date(T0) }, acceptance: acceptEewReport(undefined, report(5)), nowMs: T0, firstIssueTime: null })
    expect(ended).toBeNull()
  })

  it('対照: 取消で終えた地震は自動解除の記憶を作らない', () => {
    const ended = endEewOnExpiry({ ended: undefined, shown: { ...report(5), cancelled: true }, acceptance: acceptEewReport(undefined, report(5)), nowMs: T0, firstIssueTime: null })
    expect(ended).toBeNull()
  })
})

describe('stepEewAnnounce', () => {
  it('正: 初めての報は新規、予報から警報へは区分の格上げ', () => {
    const first = stepEewAnnounce(report(1), false, { level: undefined, baseline: undefined })
    expect(first.isNew).toBe(true)
    const second = stepEewAnnounce(report(2, { severity: 'Warning', forecastMaxScale: 45 }), false, first.memory)
    expect(second.isNew).toBe(false)
    expect(second.levelUpgraded).toBe(true)
    expect(second.severityUpgraded).toBe(true)
  })

  it('正: 通知に出した予想より上がったら出し直す。基準は上げるだけ', () => {
    const first = stepEewAnnounce(report(1, { forecastMaxScale: 30 }), false, { level: undefined, baseline: undefined })
    const up = stepEewAnnounce(report(2, { forecastMaxScale: 40 }), false, first.memory)
    expect(up.forecastRaised).toBe(true)
    const down = stepEewAnnounce(report(3, { forecastMaxScale: 30 }), false, up.memory)
    expect(down.forecastRaised).toBe(false)
    expect(down.memory.baseline.scale.scale).toBe(40)
    const back = stepEewAnnounce(report(4, { forecastMaxScale: 40 }), false, down.memory)
    expect(back.forecastRaised).toBe(false)
  })

  it('対照: 別の経路から受けた同じ報は、予想が上がっていても出し直さない', () => {
    const first = stepEewAnnounce(report(1, { forecastMaxScale: 30 }), false, { level: undefined, baseline: undefined })
    const same = stepEewAnnounce(report(2, { forecastMaxScale: 40 }), true, first.memory)
    expect(same.forecastRaised).toBe(false)
  })

  it('安全弁: 区分が下がった続報でも、記憶の区分は下げない', () => {
    const warn = stepEewAnnounce(report(1, { severity: 'Warning', forecastMaxScale: 45 }), false, { level: undefined, baseline: undefined })
    const fc = stepEewAnnounce(report(2, { severity: 'Forecast', forecastMaxScale: 45 }), false, warn.memory)
    expect(fc.memory.level).toBe(1)
    expect(fc.levelUpgraded).toBe(false)
  })
})

describe('通知の文面', () => {
  it('発表は区分で見出しを決め、tag は地震の鍵から作る', () => {
    const warn = report(1, { severity: 'Warning', forecastMaxScale: 45 })
    const step = stepEewAnnounce(warn, false, { level: undefined, baseline: undefined })
    expect(eewAnnounceNotice('ev1', warn, step.forecast)).toEqual({
      title: '緊急地震速報 警報', body: '石川県能登地方 最大震度5弱予想', tag: 'eew-ev1',
    })
    const fc = report(1)
    expect(eewAnnounceNotice('ev1', fc, stepEewAnnounce(fc, false, { level: undefined, baseline: undefined }).forecast).title).toBe('地震動予報')
  })

  it('特別警報だった地震は、続報で下がっても見出しを特別警報のまま出す', () => {
    const e = report(2, { severity: 'Warning', forecastMaxScale: 45, everSpecialWarning: true })
    expect(eewAnnounceNotice('ev1', e, stepEewAnnounce(e, false, { level: undefined, baseline: undefined }).forecast).title).toBe('緊急地震速報 特別警報')
  })

  it('取消は取消の tag で出す', () => {
    expect(eewCancelNotice('ev1', '石川県能登地方').tag).toBe('eew-cancel-ev1')
  })
})
