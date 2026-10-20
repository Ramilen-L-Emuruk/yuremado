import { describe, it, expect } from 'vitest'
import {
  tsunamiEventIds,
  isSameTsunamiEvent,
  isRetractedTsunamiInfoUnit,
  stepTsunamiState,
  isTsunamiContinuation,
  isTsunamiNewFire,
  isCancelForCurrentTsunami,
  isPartialTsunamiRetraction,
  mergeTsunamiReports,
  foldTsunamiReports,
  refoldTsunamiWithout,
  withInheritedTsunamiFacts,
  sameTsunamiEventReports,
} from './tsunami'
import type { JMATsunami, TsunamiArea, TsunamiObservation } from '../types/earthquake'

// 番号が足される切替え（電文解説資料 Ⅰ.別02-7 出現例６）と、種類ごとの取消（同 Ⅰ.別03-1 例１①）。
// 実電文の標本は手元に無いので、資料の例の形をそのまま組む。

const A = '20100714184000'
const B = '20100714185000'

function area(over: Partial<TsunamiArea> = {}): TsunamiArea {
  return { code: '100', name: '岩手県', grade: 'Watch', immediate: false, ...over }
}

function obs(name: string): TsunamiObservation {
  return { name, condition: undefined, maxHeight: undefined } as unknown as TsunamiObservation
}

function report(over: Partial<JMATsunami> = {}): JMATsunami {
  return {
    kind: 'tsunami',
    id: `t-${over.time ?? 'x'}-${over.headType ?? ''}`,
    eventId: A,
    headType: 'VTSE41',
    time: '2010-07-14T18:44:00+09:00',
    cancelled: false,
    issue: { source: '気象庁', time: '2010-07-14T18:44:00+09:00', type: 'Focus' },
    areas: [area()],
    ...over,
  }
}

describe('tsunamiEventIds', () => {
  it('半角スペースで並んだ番号を割る', () => {
    expect(tsunamiEventIds({ eventId: `${A} ${B}` })).toEqual([A, B])
  })

  it('組み立てに使った報の番号も含める', () => {
    expect(tsunamiEventIds({ eventId: B, foldedReports: [report({ eventId: A }), report({ eventId: B })] }).sort()).toEqual([A, B])
  })

  it('番号が無ければ空', () => {
    expect(tsunamiEventIds({ eventId: undefined })).toEqual([])
    expect(tsunamiEventIds({ eventId: '' })).toEqual([])
  })
})

describe('isSameTsunamiEvent（番号の重なりと運用種別）', () => {
  // 正: 「A」→「A B」の切替えは同じ津波
  it('番号が 1 つでも重なれば同じ津波', () => {
    expect(isSameTsunamiEvent(report({ eventId: A }), report({ eventId: `${A} ${B}` }))).toBe(true)
  })

  // 対照: 重ならなければ別の津波（今と同じく置き換える。2026-10-14 ユーザー承認「置き換える（推奨）」）
  it('番号が重ならなければ別の津波', () => {
    expect(isSameTsunamiEvent(report({ eventId: A }), report({ eventId: B }))).toBe(false)
  })

  // 安全弁: 訓練の報を通常の津波へ混ぜない（独立した情報単位は運用種別を含む）
  it('運用種別が違えば同じ番号でも別の津波', () => {
    expect(isSameTsunamiEvent(report({ eventId: A }), report({ eventId: A, operationStatus: '訓練' }))).toBe(false)
  })

  it('どちらかが番号を持たなければ偽', () => {
    expect(isSameTsunamiEvent(report({ eventId: undefined }), report())).toBe(false)
  })
})

describe('切替えの報を同じ津波として扱う（続報・新しい発表・解除の照合）', () => {
  const current = report({ eventId: A })
  const switched = report({ eventId: `${A} ${B}`, time: '2010-07-14T18:50:00+09:00' })

  it('続報として引き継ぐ', () => {
    expect(isTsunamiContinuation(current, switched)).toBe(true)
  })

  it('新しい発表として鳴らさない', () => {
    expect(isTsunamiNewFire(switched, current)).toBe(false)
  })

  it('A B の解除で A の津波が消える', () => {
    const lift = report({ eventId: `${A} ${B}`, cancelled: true, cancelReason: 'lifted', areas: [] })
    expect(isCancelForCurrentTsunami(lift, current)).toBe(true)
  })

  // 対照: 別の地震の津波の解除では消えない
  it('重ならない番号の解除では消えない', () => {
    const lift = report({ eventId: B, cancelled: true, cancelReason: 'lifted', areas: [] })
    expect(isCancelForCurrentTsunami(lift, current)).toBe(false)
  })

  // 番号が入れ替わっていく形（A → A B → B）でも、組み立てた報の番号を見るので続く
  it('統合した津波は前の番号も覚えている', () => {
    const merged = mergeTsunamiReports(current, switched)
    const onlyA = report({ eventId: A, time: '2010-07-14T18:55:00+09:00', headType: 'VTSE51' })
    expect(isTsunamiContinuation(merged, onlyA)).toBe(true)
  })
})

describe('期限と本文は津波警報等（VTSE41）が決める（F7）', () => {
  const forecast = report({
    time: '2010-07-14T18:44:00+09:00',
    areas: [area({ grade: 'Forecast' })],
    validDateTime: '2010-07-15T00:00:00+09:00',
    bodyText: '予報の本文',
  })

  // 正: 予報 → 注意報へ引き上げた VTSE41 は期限を持たない。前の期限を残さない
  it('VTSE41 が期限なしで届いたら期限を消す', () => {
    const watch = report({ time: '2010-07-14T18:50:00+09:00', areas: [area({ grade: 'Watch' })] })
    const merged = mergeTsunamiReports(forecast, watch)
    expect(merged.validDateTime).toBeUndefined()
    expect(merged.bodyText).toBeUndefined()
  })

  // 対照: 津波情報（VTSE51）は期限を載せないので、届いても消さない（能登・日向灘の最後の VTSE51）
  it('VTSE51 が届いても期限と本文を残す', () => {
    const info = report({ headType: 'VTSE51', time: '2010-07-14T18:47:00+09:00', areas: [] })
    const merged = mergeTsunamiReports(forecast, info)
    expect(merged.validDateTime).toBe('2010-07-15T00:00:00+09:00')
    expect(merged.bodyText).toBe('予報の本文')
  })

  // 安全弁: 種類を持たない報（P2PQuake・古いテストデータ）は従来どおり引き継ぐ
  it('種類を持たない報は従来どおり期限を引き継ぐ', () => {
    const plain = report({ headType: undefined, time: '2010-07-14T18:50:00+09:00' })
    expect(mergeTsunamiReports(forecast, plain).validDateTime).toBe('2010-07-15T00:00:00+09:00')
  })

  it('履歴からの復元も同じ規則で決める', () => {
    const watch = report({ time: '2010-07-14T18:50:00+09:00', areas: [area({ grade: 'Watch' })] })
    const info = report({ headType: 'VTSE51', time: '2010-07-14T18:55:00+09:00', areas: [] })
    expect(withInheritedTsunamiFacts(info, [info, watch, forecast]).validDateTime).toBeUndefined()
  })
})

describe('津波情報・沖合の観測だけの取消（F5）', () => {
  const warning = report({ time: '2010-07-14T18:44:00+09:00' })
  const info = report({ headType: 'VTSE51', time: '2010-07-14T18:50:00+09:00', areas: [], observations: [obs('宮古')] })
  const offshore = report({ headType: 'VTSE52', time: '2010-07-14T18:52:00+09:00', areas: [], observations: [obs('岩手釜石沖')] })
  const merged = [info, offshore].reduce(mergeTsunamiReports, warning)

  it('VTSE51・VTSE52 の取消だけが部分の取消', () => {
    expect(isPartialTsunamiRetraction(report({ headType: 'VTSE51', cancelled: true, cancelReason: 'retracted' }))).toBe(true)
    expect(isPartialTsunamiRetraction(report({ headType: 'VTSE52', cancelled: true, cancelReason: 'retracted' }))).toBe(true)
    // 対照: 警報等の取消は津波全体
    expect(isPartialTsunamiRetraction(report({ headType: 'VTSE41', cancelled: true, cancelReason: 'retracted' }))).toBe(false)
    // 安全弁: 解除は取消ではない
    expect(isPartialTsunamiRetraction(report({ headType: 'VTSE51', cancelled: true, cancelReason: 'lifted' }))).toBe(false)
    expect(isPartialTsunamiRetraction(report({ headType: undefined, cancelled: true, cancelReason: 'retracted' }))).toBe(false)
  })

  // 正: 沖合の観測の取消で、沖合の観測点だけが落ち、警報と沿岸の観測は残る
  it('その種類の報が運んだ値だけを抜く', () => {
    const refolded = refoldTsunamiWithout(merged, report({ headType: 'VTSE52', cancelled: true, cancelReason: 'retracted' }))
    expect(refolded?.areas).toEqual(warning.areas)
    expect(refolded?.observations?.map(o => o.name)).toEqual(['宮古'])
  })

  // 安全弁: 抜くと何も残らなければ null（呼び出し側が消す）
  it('組み立てた報がその種類だけなら null', () => {
    expect(refoldTsunamiWithout(info, report({ headType: 'VTSE51', cancelled: true, cancelReason: 'retracted' }))).toBeNull()
  })

  // 正: 番号が「A」→「A B」と伸びた津波で、「B」だけの津波情報の取消は「A」の津波情報を残す
  // （取消は情報の単位ごと。種類だけで抜くと、生きている単位の観測点まで消える）。
  it('取消と番号が重ならない同じ種類の報は残す', () => {
    const infoA = report({ eventId: A, headType: 'VTSE51', time: '2010-07-14T18:50:00+09:00', areas: [], observations: [obs('宮古')] })
    const infoB = report({ eventId: B, headType: 'VTSE51', time: '2010-07-14T18:51:00+09:00', areas: [], observations: [obs('八戸港')] })
    const folded = [infoA, infoB].reduce(mergeTsunamiReports, report({ eventId: `${A} ${B}`, time: '2010-07-14T18:44:00+09:00' }))
    const refolded = refoldTsunamiWithout(folded, report({ eventId: B, headType: 'VTSE51', cancelled: true, cancelReason: 'retracted' }))
    expect(refolded?.observations?.map(o => o.name)).toEqual(['宮古'])
  })

  // 対照: 取消が番号を持たなければ、同じ種類の報をすべて抜く（番号で照合できない経路）。
  it('取消が番号を持たなければ種類だけで抜く', () => {
    const refolded = refoldTsunamiWithout(merged, report({ eventId: undefined, headType: 'VTSE52', cancelled: true, cancelReason: 'retracted' }))
    expect(refolded?.observations?.map(o => o.name)).toEqual(['宮古'])
  })

  it('履歴の最新が部分の取消でも、津波は消さずに組み直す', () => {
    const retract = report({ headType: 'VTSE52', time: '2010-07-14T18:58:00+09:00', cancelled: true, cancelReason: 'retracted', areas: [] })
    const restored = withInheritedTsunamiFacts(retract, [retract, offshore, info, warning])
    expect(restored.cancelled).toBe(false)
    expect(restored.observations?.map(o => o.name)).toEqual(['宮古'])
  })

  it('畳み込みでも取消より前の同じ種類の報だけを抜く', () => {
    const retract = report({ headType: 'VTSE51', time: '2010-07-14T18:53:00+09:00', cancelled: true, cancelReason: 'retracted', areas: [] })
    const reissued = report({ headType: 'VTSE51', time: '2010-07-14T18:59:00+09:00', areas: [], observations: [obs('久慈港')] })
    const folded = foldTsunamiReports([warning, info, offshore, retract, reissued])
    expect(folded?.observations?.map(o => o.name).sort()).toEqual(['久慈港', '岩手釜石沖'].sort())
  })
})

describe('isRetractedTsunamiInfoUnit（取消が取り消す情報の単位）', () => {
  // 正: 報の番号の組が取消の組に含まれれば取り消される（並びは問わない。切替え前の「A」も「A B」の取消で消える。Ⅰ.別02-8 例２）
  it('番号の組が取消の組に含まれれば取り消される', () => {
    expect(isRetractedTsunamiInfoUnit(report({ eventId: `${A} ${B}` }), report({ eventId: `${B} ${A}` }))).toBe(true)
    expect(isRetractedTsunamiInfoUnit(report({ eventId: A }), report({ eventId: `${A} ${B}` }))).toBe(true)
  })

  // 対照: 番号が重なっていても、取消の組に含まれない番号を持つ報は取り消さない（「A」の取消は「A B」を消さない）
  it('取消の組より番号の多い報は取り消さない', () => {
    expect(isRetractedTsunamiInfoUnit(report({ eventId: `${A} ${B}` }), report({ eventId: A }))).toBe(false)
  })

  // 安全弁: 運用種別も単位に含む。番号が無ければ照合しない
  it('運用種別が違う・番号が無いなら偽', () => {
    expect(isRetractedTsunamiInfoUnit(report({ eventId: A }), report({ eventId: A, operationStatus: '訓練' }))).toBe(false)
    expect(isRetractedTsunamiInfoUnit(report({ eventId: undefined }), report({ eventId: A }))).toBe(false)
    expect(isRetractedTsunamiInfoUnit(report({ eventId: A }), report({ eventId: undefined }))).toBe(false)
  })

  it('組み立てに使った報の番号は足さない', () => {
    const folded = report({ eventId: `${A} ${B}`, foldedReports: [report({ eventId: A }), report({ eventId: `${A} ${B}` })] })
    expect(isRetractedTsunamiInfoUnit(folded, report({ eventId: A }))).toBe(false)
  })
})

describe('番号が伸びた津波の取消は、取消の組に含まれる単位だけに効く（Ⅰ.別02-8 例２）', () => {
  const warnA = report({ eventId: A, time: '2010-07-14T18:44:00+09:00' })
  const warnAB = report({ eventId: `${A} ${B}`, time: '2010-07-14T18:50:00+09:00' })
  const current = mergeTsunamiReports(warnA, warnAB)
  const retract = (eventId: string, headType: JMATsunami['headType'] = 'VTSE41') =>
    report({ eventId, headType, time: '2010-07-14T19:00:00+09:00', cancelled: true, cancelReason: 'retracted', areas: [] })

  // 正: 切り替え済みの「A」だけの取消では津波は終わらない
  it('古い単位「A」の津波警報等の取消は表示中の「A B」に当たらない', () => {
    expect(isCancelForCurrentTsunami(retract(A), current)).toBe(false)
    expect(stepTsunamiState(current, retract(A), null)).toEqual({ kind: 'ignored' })
  })

  // 対照: いまの単位の組を含む取消なら終わる
  it('「A B」の取消なら津波を終える', () => {
    expect(stepTsunamiState(current, retract(`${A} ${B}`), null)).toEqual({ kind: 'ended', reason: 'cancelled' })
  })

  // 正: 表示中より大きい組の取消でも、いまの単位を含むので終える
  it('「A B C」の取消でも「A B」の津波を終える', () => {
    expect(stepTsunamiState(current, retract(`${A} ${B} 20100714190000`), null)).toEqual({ kind: 'ended', reason: 'cancelled' })
  })

  // 安全弁: 発表し直した津波へ、前の津波を終えた取消が届き直しても終えない（取消は取り消す報より後に出る）
  it('発表し直した「A」の津波は、それより前の「A B」の取消で終えない', () => {
    const reissued = report({ eventId: A, time: '2010-07-14T19:30:00+09:00' })
    expect(stepTsunamiState(reissued, retract(`${A} ${B}`), null)).toEqual({ kind: 'ignored' })
  })

  // 安全弁: 番号を持たない一部取消でも、運用種別の違う報は抜かない
  it('番号を持たない訓練の津波情報の取消は通常の津波情報を抜かない', () => {
    const infoA = report({ eventId: A, headType: 'VTSE51', time: '2010-07-14T18:46:00+09:00', areas: [], observations: [obs('宮古')] })
    const folded = mergeTsunamiReports(warnA, infoA)
    const drill = report({ eventId: undefined, headType: 'VTSE51', operationStatus: '訓練', time: '2010-07-14T19:00:00+09:00', cancelled: true, cancelReason: 'retracted', areas: [] })
    expect(stepTsunamiState(folded, drill, null)).toEqual({ kind: 'ignored' })
  })

  // 安全弁: 解除は従来どおり番号の重なりで当てる（解除の照合は狭めていない）
  it('解除は番号が重なれば当たる', () => {
    const lift = report({ eventId: A, time: '2010-07-14T19:00:00+09:00', cancelled: true, cancelReason: 'lifted', areas: [] })
    expect(stepTsunamiState(current, lift, null)).toEqual({ kind: 'ended', reason: 'cancelled' })
  })

  // 安全弁: 比べる相手は同じ種類の最後の報。種類の違う報（津波情報）が別の組を名乗っても、警報等の取消は当たる
  it('津波情報が「A」を名乗った後でも「A B」の津波警報等の取消で終える', () => {
    const infoA = report({ eventId: A, headType: 'VTSE51', time: '2010-07-14T18:55:00+09:00', areas: [], observations: [obs('宮古')] })
    const withInfo = mergeTsunamiReports(current, infoA)
    expect(withInfo.eventId).toBe(A)
    expect(stepTsunamiState(withInfo, retract(`${A} ${B}`), null)).toEqual({ kind: 'ended', reason: 'cancelled' })
  })

  // 対照: 番号は重なるが取消の組に含まれる津波情報が無い一部取消は、取り消すものが無いので何もしない（読み上げも走らせない）
  it('取消の組に含まれる報の無い津波情報の取消は ignored', () => {
    const infoAB = report({ eventId: `${A} ${B}`, headType: 'VTSE51', time: '2010-07-14T18:52:00+09:00', areas: [], observations: [obs('八戸港')] })
    expect(stepTsunamiState(mergeTsunamiReports(current, infoAB), retract(A, 'VTSE51'), null)).toEqual({ kind: 'ignored' })
  })

  // 正: 津波情報の取消は「A」の単位の報だけを抜き、「A B」の単位の観測点を残す
  it('津波情報の「A」の取消は「A B」の津波情報を残す', () => {
    const infoA = report({ eventId: A, headType: 'VTSE51', time: '2010-07-14T18:46:00+09:00', areas: [], observations: [obs('宮古')] })
    const infoAB = report({ eventId: `${A} ${B}`, headType: 'VTSE51', time: '2010-07-14T18:52:00+09:00', areas: [], observations: [obs('八戸港')] })
    const folded = [warnAB, infoAB].reduce(mergeTsunamiReports, [infoA].reduce(mergeTsunamiReports, warnA))
    const step = stepTsunamiState(folded, retract(A, 'VTSE51'), null)
    expect(step.kind).toBe('live')
    if (step.kind !== 'live') return
    expect(step.tsunami.observations?.map(o => o.name)).toEqual(['八戸港'])
  })

  // 正: 「A B」の津波情報の取消は、切替え前の「A」の津波情報もまとめて抜く（警報は残る）
  it('津波情報の「A B」の取消は「A」と「A B」の津波情報を両方抜く', () => {
    const infoA = report({ eventId: A, headType: 'VTSE51', time: '2010-07-14T18:46:00+09:00', areas: [], observations: [obs('宮古')] })
    const infoAB = report({ eventId: `${A} ${B}`, headType: 'VTSE51', time: '2010-07-14T18:52:00+09:00', areas: [], observations: [obs('八戸港')] })
    const folded = [warnAB, infoAB].reduce(mergeTsunamiReports, [infoA].reduce(mergeTsunamiReports, warnA))
    const step = stepTsunamiState(folded, retract(`${A} ${B}`, 'VTSE51'), null)
    expect(step.kind).toBe('live')
    if (step.kind !== 'live') return
    expect(step.tsunami.observations ?? []).toEqual([])
    expect(step.tsunami.areas).toEqual(warnAB.areas)
  })
})

describe('sameTsunamiEventReports（番号の重なりを辿る）', () => {
  it('A → A B → B と入れ替わっても同じ津波の報として集める', () => {
    const r1 = report({ eventId: A, time: '2010-07-14T18:44:00+09:00' })
    const r2 = report({ eventId: `${A} ${B}`, time: '2010-07-14T18:50:00+09:00' })
    const r3 = report({ eventId: B, time: '2010-07-14T19:00:00+09:00' })
    const other = report({ eventId: '20100714190000', time: '2010-07-14T19:01:00+09:00' })
    expect(sameTsunamiEventReports(r3, [r1, r2, r3, other])).toEqual([r1, r2])
  })
})
