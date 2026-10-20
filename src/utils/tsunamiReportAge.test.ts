import { describe, it, expect } from 'vitest'
import { foldTsunamiReports, isCancelForCurrentTsunami, latestValidDateTime } from './tsunami'
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
