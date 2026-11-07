import { describe, expect, it } from 'vitest'
import type { IntensityScale, IssueType, JMAEstimatedIntensity, JMAQuake, JMATsunami } from '../types/earthquake'
import { mergeQuakeInto } from './quakeMerge'
import {
  quakeHistoryEntries, quakeHistoryView, recordTsunamiFactStep, TSUNAMI_FACT_STEPS_MAX,
  type QuakeHistoryInputs,
} from './quakeReportHistory'

const EVENT_ID = '20260728162718'

function telegram(o: {
  type: IssueType
  time: string
  serial?: number
  mag?: number
  maxScale?: IntensityScale
  points?: JMAQuake['points']
  key: string
}): JMAQuake {
  const hasHypo = o.type !== '震度速報'
  return {
    kind: 'quake',
    id: `dmdata-quake-${EVENT_ID}-${o.key}`,
    telegramKey: o.key,
    ...(o.serial !== undefined && { reportSerial: o.serial }),
    time: o.time,
    issue: { source: 'dmdata', time: o.time, type: o.type, correct: 'なし' },
    earthquake: {
      time: '2026-07-28T16:27:00+09:00',
      hypocenter: hasHypo
        ? { name: '熊本県熊本地方', latitude: 32.7, longitude: 130.7, depth: 10, magnitude: o.mag ?? 6.0 }
        : { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: Number.NaN },
      maxScale: o.maxScale ?? 45,
      domesticTsunami: 'なし',
    },
    points: o.points ?? [{ pref: '熊本県', addr: '熊本県熊本', isArea: true, scale: o.maxScale ?? 45 }],
  }
}

/** 電文を届いた順に統合したカード（ライブと同じ当て方）。 */
function cardOf(telegrams: JMAQuake[]): JMAQuake {
  let card: JMAQuake | undefined
  for (const t of telegrams) card = mergeQuakeInto(card, t, { quiet: true })
  return card as JMAQuake
}

function inputsOf(card: JMAQuake, over: Partial<QuakeHistoryInputs> = {}): QuakeHistoryInputs {
  return {
    card, lpgm: undefined, internationalTsunamis: [], estimatedIntensity: null,
    tsunamiSteps: [], tsunamis: [], quakes: [card], areaPrefIndex: null, ...over,
  }
}

const sokuho = telegram({ type: '震度速報', time: '2026-07-28T16:29:00+09:00', key: 'a', maxScale: 45 })
const full1 = telegram({ type: '震源・震度情報', time: '2026-07-28T16:32:00+09:00', key: 'b', serial: 1, mag: 6.0, maxScale: 45 })
const full2 = telegram({ type: '震源・震度情報', time: '2026-07-28T16:40:00+09:00', key: 'c', serial: 2, mag: 6.2, maxScale: 45 })

describe('quakeHistoryEntries', () => {
  // 正: 受けた報が発表の古い順に、一覧と同じ名前で並ぶ。
  it('受けた報を発表の古い順に並べる', () => {
    const card = cardOf([sokuho, full1, full2])
    const entries = quakeHistoryEntries(inputsOf(card))
    expect(entries.map(e => e.label)).toEqual(['震度速報', '震源・震度情報 #1', '震源・震度情報 #2'])
    expect(entries.every(e => e.heldBack === undefined)).toBe(true)
  })

  // 正: 完全版の後に届いた速報段階は、捨てた報として理由つきで並ぶ。
  it('カードが採らなかった報に理由を付ける', () => {
    const late = telegram({ type: '震度速報', time: '2026-07-28T16:35:00+09:00', key: 'd', maxScale: 50 })
    const card = cardOf([full1, late])
    const entries = quakeHistoryEntries(inputsOf(card))
    expect(entries.map(e => e.heldBack)).toEqual([undefined, 'superseded'])
  })
})

describe('quakeHistoryView', () => {
  // 正: 前の報を押すと、その報までで組んだカードになる。
  it('前の報を押すとその報までのカードになる', () => {
    const card = cardOf([sokuho, full1, full2])
    const entries = quakeHistoryEntries(inputsOf(card))
    const view = quakeHistoryView(inputsOf(card), entries[1].id)
    expect(view?.quake.earthquake.hypocenter.magnitude).toBe(6.0)
    expect(card.earthquake.hypocenter.magnitude).toBe(6.2)
  })

  // 正: 印は直前の報と比べて付く（規模が動いた報に規模の印）。
  // 対照: 動いていない欄（最大震度）には付かない。
  it('その報で動いた欄にだけ印が付く', () => {
    const card = cardOf([sokuho, full1, full2])
    const entries = quakeHistoryEntries(inputsOf(card))
    const marks = quakeHistoryView(inputsOf(card), entries[2].id)?.marks
    expect(marks?.facts.has('magnitude')).toBe(true)
    expect(marks?.facts.has('maxScale')).toBe(false)
  })

  // 安全弁: 最初の報には比べる相手が無いので、印は付かない（ライブの初報と同じ）。
  it('最初の報には印を付けない', () => {
    const card = cardOf([sokuho, full1, full2])
    const entries = quakeHistoryEntries(inputsOf(card))
    expect(quakeHistoryView(inputsOf(card), entries[0].id)?.marks).toBeUndefined()
  })

  // 正: 捨てた報を押すと「採っていたら」のカードになり、実際のカードと比べた印が付く。
  // 安全弁: 画面のカード（ライブの統合）は捨てた報の値を採らないまま。
  it('捨てた報は採っていたらの姿を出し、実際のカードは変えない', () => {
    const late = telegram({ type: '震度速報', time: '2026-07-28T16:35:00+09:00', key: 'd', maxScale: 50 })
    const card = cardOf([full1, late])
    expect(card.earthquake.maxScale).toBe(45)
    const entries = quakeHistoryEntries(inputsOf(card))
    const view = quakeHistoryView(inputsOf(card), entries[1].id)
    expect(view?.heldBack).toBe('superseded')
    expect(view?.quake.earthquake.maxScale).toBe(50)
    expect(view?.marks?.facts.has('maxScale')).toBe(true)
  })

  // 対照: 捨てた報の後の報は、捨てた報を採らずに組む（捨てた報は実際のカードを変えていない）。
  it('捨てた報の後の報は、捨てた報の値を含まない', () => {
    const late = telegram({ type: '震度速報', time: '2026-07-28T16:35:00+09:00', key: 'd', maxScale: 50 })
    const card = cardOf([full1, late, full2])
    const entries = quakeHistoryEntries(inputsOf(card))
    expect(entries.map(e => e.label)).toEqual(['震源・震度情報 #1', '震度速報', '震源・震度情報 #2'])
    const view = quakeHistoryView(inputsOf(card), entries[2].id)
    expect(view?.quake.earthquake.maxScale).toBe(45)
    // 直前の実際のカード（#1）と比べるので、捨てた報の震度 5強 は印に混ざらない
    expect(view?.marks?.facts.has('maxScale')).toBe(false)
  })

  // 正: 推計震度分布図の前の報を押すと、その時点の版が出る。
  // 対照: 後の版の行では後の版が出る。
  it('推計震度分布図は押した行の時点の版を出す', () => {
    const card = cardOf([full1])
    const eiBase = { arrivalTime: '2026-07-28T03:00:00+09:00', hypocenter: { lat: 0, lon: 0 } }
    const first = { ...eiBase, id: 'ei-1', time: '2026-07-28T16:45:00+09:00' } as unknown as JMAEstimatedIntensity
    const second = { ...eiBase, id: 'ei-2', time: '2026-07-28T16:55:00+09:00', previousTimes: [first.time], previousVersions: [first] } as unknown as JMAEstimatedIntensity
    const inputs = inputsOf(card, { estimatedIntensity: second })
    const entries = quakeHistoryEntries(inputs)
    expect(entries.map(e => e.label)).toEqual(['震源・震度情報', '推計震度分布図', '推計震度分布図'])
    expect(quakeHistoryView(inputs, entries[1].id)?.estimatedIntensity?.id).toBe('ei-1')
    expect(quakeHistoryView(inputs, entries[2].id)?.estimatedIntensity?.id).toBe('ei-2')
    // 安全弁: 推計より前の報の時点では、推計はまだ無い
    expect(quakeHistoryView(inputs, entries[0].id)?.estimatedIntensity).toBeNull()
  })
})

describe('recordTsunamiFactStep', () => {
  const tsunami = { kind: 'tsunami', id: 't1', eventId: EVENT_ID, time: '2026-07-28T16:30:00+09:00', infoName: '津波警報・津波注意報・津波予報' } as unknown as JMATsunami
  const card = cardOf([full1])

  // 対照: 地震カードが変わらなかった報は積まない（値の変わらない続報で一覧を埋めない）。
  it('地震カードが変わらなければ積まない', () => {
    const cards = [card]
    expect(recordTsunamiFactStep([], tsunami, [tsunami], cards, cards)).toEqual([])
  })

  // 正: 地震カードが変わった報を、当て込みが見た一覧ごと積む。
  it('地震カードが変わった報を積む', () => {
    const steps = recordTsunamiFactStep([], tsunami, [tsunami], [card], [{ ...card }])
    expect(steps).toEqual([{ id: tsunami.id, time: tsunami.time, label: tsunami.infoName, tsunamis: [tsunami] }])
  })

  // 安全弁: どの地震カードとも結べない記録は捨て、件数は上限で頭打ちにする。
  it('結べない記録を捨て、上限で頭打ちにする', () => {
    const other = { ...tsunami, eventId: '20990101000000' } as JMATsunami
    const stale = { time: other.time, label: 'x', tsunamis: [other] }
    expect(recordTsunamiFactStep([stale], tsunami, [tsunami], [card], [{ ...card }])).toHaveLength(1)
    const many = Array.from({ length: TSUNAMI_FACT_STEPS_MAX }, () => ({ time: tsunami.time, label: 'y', tsunamis: [tsunami] }))
    const capped = recordTsunamiFactStep(many, tsunami, [tsunami], [card], [{ ...card }])
    expect(capped).toHaveLength(TSUNAMI_FACT_STEPS_MAX)
    expect(capped[capped.length - 1].label).toBe(tsunami.infoName)
  })
})

describe('一部取消の帯と行の鍵', () => {
  // 正: 取消より前の時点では帯を出さない。対照: 取消の後の行では出す。
  it('一部取消の帯は取消電文より後の行でだけ出す', () => {
    const card = {
      ...cardOf([sokuho, full1, full2]),
      retractedReports: [{ issueType: '震度速報' as const, reportTime: sokuho.time, cancelTime: '2026-07-28T16:35:00+09:00' }],
    }
    const entries = quakeHistoryEntries(inputsOf(card))
    expect(quakeHistoryView(inputsOf(card), entries[1].id)?.quake.retractedReports).toBeUndefined()
    expect(quakeHistoryView(inputsOf(card), entries[2].id)?.quake.retractedReports).toHaveLength(1)
  })

  // 安全弁: 同じ電文の鍵が 2 通あっても、行の鍵は重ならない（押した行と別の行を取り違えない）。
  it('同じ鍵の電文が 2 通あっても行の鍵は一意', () => {
    const dup = { ...full2, time: '2026-07-28T16:41:00+09:00', issue: { ...full2.issue, time: '2026-07-28T16:41:00+09:00' } }
    const card = { ...cardOf([full1, full2]), sourceTelegrams: [full1, full2, dup] }
    const ids = quakeHistoryEntries(inputsOf(card)).map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
