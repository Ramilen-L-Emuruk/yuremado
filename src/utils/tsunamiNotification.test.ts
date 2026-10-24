import { describe, it, expect } from 'vitest'
import type { JMATsunami, TsunamiArea, TsunamiGrade, TsunamiObservation } from '../types/earthquake'
import { tsunamiLiftedAreas } from './tsunami'
import { joinAreaNamesForNotification, tsunamiIssueNotification, tsunamiLiftNotification, tsunamiObservationNotification, tsunamiEndNotification, TSUNAMI_NOTIFY_MAX_AREAS, TSUNAMI_OBS_NOTIFY_MAX_POINTS } from './tsunamiNotification'
import { TSUNAMI_ALL_LIFTED_SENTENCE } from './ttsText'

const area = (name: string, code: string, grade: TsunamiGrade, lastGrade?: TsunamiGrade): TsunamiArea =>
  ({ name, code, grade, ...(lastGrade && { lastGrade }), immediate: false } as TsunamiArea)

function report(areas: TsunamiArea[], cancelledAreas: TsunamiArea[] = []): JMATsunami {
  return {
    kind: 'tsunami', id: 't-1', eventId: '20240101161010', time: '2024-01-01T16:22:00+09:00',
    cancelled: false, issue: { source: '気象庁', time: '2024-01-01T16:22:00+09:00', type: 'Focus' },
    areas, ...(cancelledAreas.length > 0 && { cancelledAreas }),
  }
}

// 区域コードは実在のもの（津波予報区）。並びは同じ等級の中では電文順のまま
const SEVEN_WATCH = [
  area('石川県能登', '360', 'Watch'), area('新潟県上中下越', '340', 'Watch'), area('富山県', '350', 'Watch'),
  area('石川県加賀', '361', 'Watch'), area('福井県', '380', 'Watch'), area('京都府', '400', 'Watch'),
  area('兵庫県北部', '440', 'Watch'),
]

describe('区域名の並べ方', () => {
  // 2026-10-14 ユーザー選択「「ほか N 区域」を足す（推奨）」・2026-10-19「空白を入れる (Recommended)」
  it('正: 上限を超えた分は「ほか N 区域」にまとめる', () => {
    expect(joinAreaNamesForNotification(SEVEN_WATCH))
      .toBe('石川県能登、新潟県上中下越、富山県、石川県加賀、福井県 ほか 2 区域')
  })

  it('対照: 上限ちょうどなら件数を添えない', () => {
    expect(joinAreaNamesForNotification(SEVEN_WATCH.slice(0, TSUNAMI_NOTIFY_MAX_AREAS)))
      .toBe('石川県能登、新潟県上中下越、富山県、石川県加賀、福井県')
  })
})

describe('発表中の報の通知', () => {
  // 受信処理の材料（`tsunamiCardOrderBasis`）と同じ作り方: 前報を持たない報では、その報の区域と解除の組
  const issue = (r: JMATsunami) => tsunamiIssueNotification(r, { areas: r.areas, observations: [], liftedAreas: tsunamiLiftedAreas(r, []) })

  // 2026-10-14 ユーザー選択「解除区域を別の行で出す」・2026-10-19「「解除：」を頭に付ける (Recommended)」
  it('正: この報で解除された区域を「解除：」の行に出す', () => {
    const n = issue(report(
      [area('石川県能登', '360', 'Watch', 'Watch'), area('富山県', '350', 'Watch', 'Watch')],
      [area('青森県日本海沿岸', '200', 'Unknown', 'Watch'), area('秋田県', '230', 'Unknown', 'Watch')],
    ))
    expect(n.title).toBe('津波注意報')
    expect(n.body).toBe('石川県能登、富山県\n解除：青森県日本海沿岸、秋田県')
  })

  it('対照: 解除された区域が無い報は 1 行だけ', () => {
    expect(issue(report(SEVEN_WATCH)).body).not.toContain('\n')
  })

  it('安全弁: 解除された区域を 1 行目（発表中の区域）へ混ぜない', () => {
    const n = issue(report([area('石川県能登', '360', 'Watch', 'Watch')], [area('秋田県', '230', 'Unknown', 'Watch')]))
    expect(n.body.split('\n')[0]).toBe('石川県能登')
  })

  // 2026-10-14 ユーザー選択「注意報以上を残す（推奨）」
  it.each([
    ['MajorWarning', true], ['Warning', true], ['Watch', true], ['Forecast', false],
  ] as const)('閉じるまで残すか: %s → %s', (grade, expected) => {
    expect(issue(report([area('石川県能登', '360', grade)])).requireInteraction).toBe(expected)
  })
})

describe('全区域解除の報の通知', () => {
  const LIFT_TEXT = '現在、大津波警報・津波警報・津波注意報を発表している沿岸はありません。'

  // 2026-10-19 ユーザー選択「送る (Recommended)」
  it('正: 気象庁が書いた文を本文にし、閉じるまでは残さない', () => {
    const n = tsunamiLiftNotification({ warningComments: [{ key: 'VTSE41', text: LIFT_TEXT }] })
    expect(n).toEqual({ title: '津波警報等の解除', body: LIFT_TEXT, requireInteraction: false })
  })

  // 2026-10-19 ユーザー選択「読み上げと同じ文 (Recommended)」
  it('対照: 文を持たない報は読み上げと同じ文にする', () => {
    expect(tsunamiLiftNotification({}).body).toBe(TSUNAMI_ALL_LIFTED_SENTENCE)
  })
})

// 観測情報だけの報の通知（2026-10-24 ユーザー選択「別の通知にする (Recommended)」）
describe('tsunamiObservationNotification', () => {
  const o = (name: string, extra: Partial<TsunamiObservation> = {}): TsunamiObservation => ({ name, ...extra } as TsunamiObservation)

  it('正: 観測点ごとに波高・到達確認・欠測を並べ、見出しは電文の情報名', () => {
    const n = tsunamiObservationNotification({ infoName: '沖合の津波観測に関する情報' }, [
      o('輪島港', { height: { value: 1.2, description: '1.2m' } }),
      o('珠洲市長橋'),
      o('富山', { condition: { maxHeightMissing: true } }),
    ])
    expect(n).toEqual({ title: '沖合の津波観測に関する情報', body: '輪島港 1.2m、珠洲市長橋 到達確認、富山 欠測', requireInteraction: false })
  })

  it('正: 上限を超えた分は「ほか N 地点」にまとめる', () => {
    const many = Array.from({ length: TSUNAMI_OBS_NOTIFY_MAX_POINTS + 2 }, (_, i) => o(`地点${i}`))
    expect(tsunamiObservationNotification({}, many).body).toMatch(/ ほか 2 地点$/)
  })

  // 安全弁: 値を観測できていた欠測は値も残す（片方へ丸めない）
  it('安全弁: 波高を持つ欠測は値と欠測の両方を出す', () => {
    const n = tsunamiObservationNotification({}, [o('富山', { height: { value: 0.3, description: '0.3m' }, condition: { maxHeightMissing: true } })])
    expect(n.title).toBe('津波観測に関する情報')
    expect(n.body).toBe('富山 0.3m 欠測')
  })
})

// 取消と失効の通知（2026-10-24 ユーザー選択「この文面で (Recommended)」）
describe('tsunamiEndNotification', () => {
  it('正: 取消は理由を本文に、無ければ定型の文', () => {
    expect(tsunamiEndNotification({ cancelReason: 'retracted', cancelText: '取り消します。' }))
      .toEqual({ title: '津波警報等の取消', body: '取り消します。', requireInteraction: false })
    expect(tsunamiEndNotification({ cancelReason: 'retracted' })?.body).toBe('津波警報等は誤って発表されたため取り消されました。')
  })

  it('正: 失効は「津波予報の失効」', () => {
    expect(tsunamiEndNotification({ cancelReason: 'expired' }))
      .toEqual({ title: '津波予報の失効', body: '津波予報は失効しました。', requireInteraction: false })
  })

  it('対照: 解除はこの関数では作らない（解除の通知は別の関数）', () => {
    expect(tsunamiEndNotification({ cancelReason: 'lifted' })).toBeNull()
  })
})
