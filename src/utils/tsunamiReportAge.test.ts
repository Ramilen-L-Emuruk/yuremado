import { describe, it, expect } from 'vitest'
import { foldTsunamiReports, isCancelForCurrentTsunami, latestValidDateTime, mergeTsunamiReports, stepTsunamiState } from './tsunami'
import type { JMATsunami, TsunamiArea } from '../types/earthquake'

// 津波の報の新旧を作成時刻（Control/DateTime。秒まで）で比べる（→ docs/spec/tsunami-spec.md §3「報の新旧は作成時刻で比べる」）。
// 実電文では同じ津波の津波警報等（VTSE41）と津波情報（VTSE51）が同じ分に出て（手元の控え 651 通で 36 組）、
// どの組も VTSE41 の作成時刻が先だった。発表時刻（分まで）では前後を決められない。

const A = '20240101161000'
const MINUTE = '2024-01-01T16:22:00+09:00'
const at = (sec: number) => Date.parse(`2024-01-01T16:22:${String(sec).padStart(2, '0')}+09:00`)

function area(over: Partial<TsunamiArea> = {}): TsunamiArea {
  return { code: '100', name: '岩手県', grade: 'Watch', immediate: false, ...over }
}

function report(over: Partial<JMATsunami> = {}): JMATsunami {
  return {
    kind: 'tsunami',
    id: `t-${over.headType ?? 'VTSE41'}-${over.createdAtMs ?? 'x'}`,
    eventId: A,
    headType: 'VTSE41',
    time: MINUTE,
    cancelled: false,
    issue: { source: '気象庁', time: MINUTE, type: 'Focus' },
    areas: [area()],
    ...over,
  }
}

describe('foldTsunamiReports（同じ分の報を作成時刻で並べる）', () => {
  // 正: 届いた順が逆でも、作成時刻の古い順に重ねる
  it('同じ分の津波警報等と津波情報を作成時刻の順に重ねる', () => {
    const warning = report({ headType: 'VTSE41', createdAtMs: at(10) })
    const info = report({ headType: 'VTSE51', createdAtMs: at(40) })
    const folded = foldTsunamiReports([info, warning])!
    expect(folded.foldedReports?.map(r => r.headType)).toEqual(['VTSE41', 'VTSE51'])
  })

  // 対照: 作成時刻を持たない報どうし（P2PQuake・テストボタン）は従来どおり届いた順を保つ
  it('どちらも作成時刻を持たなければ届いた順のまま', () => {
    const info = report({ headType: 'VTSE51' })
    const warning = report({ headType: 'VTSE41' })
    const folded = foldTsunamiReports([info, warning])!
    expect(folded.foldedReports?.map(r => r.headType)).toEqual(['VTSE51', 'VTSE41'])
  })
})

describe('latestValidDateTime（同じ分の報の期限）', () => {
  // 正: 同じ分なら作成時刻の新しい報の期限を採る（届いた順によらない）
  it('同じ分の報は作成時刻の新しいほうの期限を返す', () => {
    const older = report({ createdAtMs: at(10), validDateTime: '2024-01-02T09:00:00+09:00' })
    const newer = report({ headType: 'VTSE51', createdAtMs: at(40), validDateTime: '2024-01-02T12:00:00+09:00' })
    expect(latestValidDateTime([newer, older])).toBe('2024-01-02T12:00:00+09:00')
    expect(latestValidDateTime([older, newer])).toBe('2024-01-02T12:00:00+09:00')
  })

  // 安全弁: 片方しか作成時刻を持たない同じ分の組は前後を決めず、後ろの報を採る（従来どおり）
  it('片方だけ作成時刻を持つ同じ分の組は後ろの報を採る', () => {
    const withMs = report({ createdAtMs: at(10), validDateTime: '2024-01-02T09:00:00+09:00' })
    const withoutMs = report({ headType: 'VTSE51', validDateTime: '2024-01-02T12:00:00+09:00' })
    expect(latestValidDateTime([withMs, withoutMs])).toBe('2024-01-02T12:00:00+09:00')
    expect(latestValidDateTime([withoutMs, withMs])).toBe('2024-01-02T09:00:00+09:00')
  })
})

describe('isCancelForCurrentTsunami（同じ分の取消・解除の足切り）', () => {
  // 正: 番号を持たない解除が、表示中より同じ分の中で先に作られていたら別の津波の遅れた解除とみなす
  it('番号の無い解除が同じ分の中で表示中より先に作られていれば当てない', () => {
    const current = report({ eventId: undefined, createdAtMs: at(40) })
    const lift = report({ eventId: undefined, cancelled: true, createdAtMs: at(10) })
    expect(isCancelForCurrentTsunami(lift, current)).toBe(false)
  })

  // 対照: 後に作られた解除は当てる
  it('番号の無い解除が表示中より後に作られていれば当てる', () => {
    const current = report({ eventId: undefined, createdAtMs: at(10) })
    const lift = report({ eventId: undefined, cancelled: true, createdAtMs: at(40) })
    expect(isCancelForCurrentTsunami(lift, current)).toBe(true)
  })

  // 安全弁: 比べる相手は解除と同じ種類の報。同じ分に後から作られた津波情報があっても、その津波の解除は落とさない
  it('番号の無い解除は、同じ分の津波情報ではなく同じ種類の最後の報と比べる', () => {
    const current = foldTsunamiReports([
      report({ eventId: undefined, headType: 'VTSE41', createdAtMs: at(5) }),
      report({ eventId: undefined, headType: 'VTSE51', createdAtMs: at(40) }),
    ])!
    const lift = report({ eventId: undefined, headType: 'VTSE41', cancelled: true, createdAtMs: at(10) })
    expect(isCancelForCurrentTsunami(lift, current)).toBe(true)
  })

  // 対照: 同じ種類の最後の報より先に作られた解除は、別の種類の報があっても当てない（別の津波の遅れた解除）
  it('番号の無い解除が同じ種類の最後の報より先に作られていれば当てない', () => {
    const current = foldTsunamiReports([
      report({ eventId: undefined, headType: 'VTSE41', createdAtMs: at(20) }),
      report({ eventId: undefined, headType: 'VTSE51', createdAtMs: at(40) }),
    ])!
    const lift = report({ eventId: undefined, headType: 'VTSE41', cancelled: true, createdAtMs: at(10) })
    expect(isCancelForCurrentTsunami(lift, current)).toBe(false)
  })

  // 安全弁: 片方しか作成時刻を持たず同じ分なら前後を決められないので、解除を落とさない
  it('同じ分で片方だけ作成時刻を持つなら当てる', () => {
    const current = report({ eventId: undefined, createdAtMs: at(40) })
    const lift = report({ eventId: undefined, cancelled: true })
    expect(isCancelForCurrentTsunami(lift, current)).toBe(true)
  })

  // 正: 津波警報等の取消は、取り消す報より同じ分の中で先に作られていれば当てない（届き直した古い取消）
  it('同じ分の中で表示中の津波警報等より先に作られた取消は当てない', () => {
    const current = foldTsunamiReports([report({ createdAtMs: at(40) })])!
    const retraction = report({ cancelled: true, cancelReason: 'retracted', createdAtMs: at(10) })
    expect(isCancelForCurrentTsunami(retraction, current)).toBe(false)
  })

  // 対照: 後に作られた取消は当てる
  it('表示中の津波警報等より後に作られた取消は当てる', () => {
    const current = foldTsunamiReports([report({ createdAtMs: at(10) })])!
    const retraction = report({ cancelled: true, cancelReason: 'retracted', createdAtMs: at(40) })
    expect(isCancelForCurrentTsunami(retraction, current)).toBe(true)
  })
})

describe('mergeTsunamiReports（古い報が後から届いたとき）', () => {
  // 正: 後から届いた古い津波警報等は、新しい報の期限・本文・区域を上書きしない（作成時刻の順に重ね直す）
  it('古い津波警報等が後から届いても、新しい報の期限・本文・等級が残る', () => {
    const older = report({ createdAtMs: at(10), validDateTime: '2024-01-01T20:00:00+09:00', bodyText: '古い本文', areas: [area({ grade: 'Warning' })] })
    const newer = report({ createdAtMs: at(40), validDateTime: '2024-01-01T22:00:00+09:00', bodyText: '新しい本文', areas: [area({ grade: 'Watch' })] })
    const merged = mergeTsunamiReports(newer, older)
    expect(merged.validDateTime).toBe('2024-01-01T22:00:00+09:00')
    expect(merged.bodyText).toBe('新しい本文')
    expect(merged.areas[0].grade).toBe('Watch')
    expect(merged.foldedReports?.map(r => r.createdAtMs)).toEqual([at(10), at(40)])
  })

  // 対照: 順番どおりに届いた報は、従来どおり新しい報が正
  it('順番どおりに届いた報は、届いた報の期限・本文を採る', () => {
    const older = report({ createdAtMs: at(10), validDateTime: '2024-01-01T20:00:00+09:00', bodyText: '古い本文' })
    const newer = report({ createdAtMs: at(40), validDateTime: '2024-01-01T22:00:00+09:00', bodyText: '新しい本文' })
    const merged = mergeTsunamiReports(older, newer)
    expect(merged.validDateTime).toBe('2024-01-01T22:00:00+09:00')
    expect(merged.bodyText).toBe('新しい本文')
  })

  // 安全弁: 前後を決められない組（同じ分で片方だけ作成時刻を持つ）は並べ直さず、届いた順に重ねる
  it('前後を決められない組は届いた順に重ねる', () => {
    const first = report({ createdAtMs: at(40), bodyText: '先に届いた本文' })
    const second = report({ bodyText: '後から届いた本文' })
    expect(mergeTsunamiReports(first, second).bodyText).toBe('後から届いた本文')
  })

  // 安全弁: 組み立て済みの古い報がもう一度届いても（張り直しの取り戻し）、新しい報の本文が残る
  it('組み立て済みの古い報がもう一度届いても新しい報の本文が残る', () => {
    const older = report({ createdAtMs: at(10), bodyText: '古い本文' })
    const newer = report({ createdAtMs: at(40), bodyText: '新しい本文' })
    const again = mergeTsunamiReports(mergeTsunamiReports(older, newer), older)
    expect(again.bodyText).toBe('新しい本文')
  })
})

describe('stepTsunamiState（時計を渡したとき）', () => {
  const NOW = new Date('2024-01-01T17:00:00+09:00')

  // 正: 表示中の津波が無いところへ届いた期限切れの報は、何も始めない
  it('表示中の津波が無いときの期限切れの報は何も変えない', () => {
    const expired = report({ validDateTime: '2024-01-01T16:30:00+09:00' })
    expect(stepTsunamiState(undefined, expired, NOW)).toEqual({ kind: 'ignored' })
  })

  // 正: 生きている別の津波へ、期限の過ぎた古い報が届いても外さない（届いた報 1 通の期限では判定しない）
  it('生きている別の津波は、期限の過ぎた古い報で外さない', () => {
    const live = report({ eventId: '20240101170000', createdAtMs: at(40), validDateTime: '2024-01-01T20:00:00+09:00' })
    const stale = report({ createdAtMs: at(10), validDateTime: '2024-01-01T16:30:00+09:00' })
    expect(stepTsunamiState(live, stale, NOW)).toEqual({ kind: 'ignored' })
  })

  // 正: 同じ津波の古い報が後から届いても、新しい報の期限が生きていれば残る
  it('同じ津波の古い期限切れの報は、新しい報の期限で判定する', () => {
    const newer = report({ createdAtMs: at(40), validDateTime: '2024-01-01T20:00:00+09:00' })
    const stale = report({ createdAtMs: at(10), validDateTime: '2024-01-01T16:30:00+09:00' })
    const step = stepTsunamiState(newer, stale, NOW)
    expect(step.kind).toBe('live')
    if (step.kind === 'live') expect(step.tsunami.validDateTime).toBe('2024-01-01T20:00:00+09:00')
  })

  // 対照: 当てた結果の期限が過ぎていれば、津波は終わる
  it('当てた結果の期限が過ぎていれば終わりとして扱う', () => {
    const older = report({ createdAtMs: at(10), validDateTime: '2024-01-01T18:00:00+09:00' })
    const newer = report({ createdAtMs: at(40), validDateTime: '2024-01-01T16:30:00+09:00' })
    expect(stepTsunamiState(older, newer, NOW)).toEqual({ kind: 'ended', reason: 'outdated' })
  })

  // 対照: 時計を渡さない（復元の経路）なら期限は見ない
  it('時計を渡さなければ期限で落とさない', () => {
    const expired = report({ validDateTime: '2024-01-01T16:30:00+09:00' })
    expect(stepTsunamiState(undefined, expired, null).kind).toBe('live')
  })
})
