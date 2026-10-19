import { describe, it, expect } from 'vitest'
import type { JMATsunami, TsunamiArea, TsunamiGrade } from '../types/earthquake'
import { tsunamiLiftedAreas } from './tsunami'
import { joinAreaNamesForNotification, tsunamiIssueNotification, tsunamiLiftNotification, TSUNAMI_NOTIFY_MAX_AREAS } from './tsunamiNotification'
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
