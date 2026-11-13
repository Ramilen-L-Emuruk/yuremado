import { describe, it, expect } from 'vitest'
import { quakeReportTimeline, formatTimelineTime } from './quakeReportTimeline'
import { mergeQuakeInto } from './quakeMerge'
import { ja } from '../i18n/messages/ja'
import type { IssueType, JMAQuake } from '../types/earthquake'

const t = (h: number, m: number) => new Date(2024, 0, 1, h, m).toISOString()

/** 一覧が読む欄（種別・発表時刻・報番号・鍵）だけを持つ電文。 */
function telegram(type: IssueType, time: string, key: string, reportSerial?: number): JMAQuake {
  return {
    kind: 'quake',
    id: `dmdata-quake-20240101161006-${key}`,
    telegramKey: key,
    ...(reportSerial !== undefined && { reportSerial }),
    time,
    issue: { source: 'dmdata', time, type, correct: 'なし' },
    earthquake: {
      time: '2024-01-01T07:10:00Z',
      hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.3, depth: 10, magnitude: 7.6 },
      maxScale: 70,
      domesticTsunami: 'なし',
    },
    points: [{ pref: '石川県', addr: '志賀町', isArea: false, scale: 70 }],
  }
}

/** 電文を届いた順に統合へ通したカード。 */
function card(...telegrams: JMAQuake[]): JMAQuake {
  return telegrams.reduce<JMAQuake | undefined>((acc, x) => mergeQuakeInto(acc, x), undefined)!
}

describe('quakeReportTimeline', () => {
  // 正: 見出しは震源・震度情報が震度速報を呑み込むが、一覧には受け取った報をすべて並べる
  it('震度速報・震源情報も、震源・震度情報が届いた後に一覧から消えない', () => {
    const q = card(
      telegram('震度速報', t(16, 12), 'a'),
      telegram('震源情報', t(16, 13), 'b'),
      telegram('震源・震度情報', t(16, 15), 'c', 1),
    )
    expect(q.reports?.map(r => r.type)).toEqual(['震源・震度情報'])
    expect(quakeReportTimeline(q).map(e => e.label)).toEqual(['震度速報', '震源情報', '震源・震度情報'])
  })

  it('種別をまたいで発表時刻の順に並べ、複数ある種別には報番号を付ける', () => {
    const q = card(
      telegram('震度速報', t(16, 12), 'a'),
      telegram('震源・震度情報', t(16, 15), 'b', 1),
      telegram('震源・震度情報', t(16, 32), 'c', 2),
    )
    const out = quakeReportTimeline(q, [{ label: '長周期地震動に関する観測情報', time: t(16, 23) }])
    expect(out.map(e => e.label)).toEqual([
      '震度速報', '震源・震度情報 #1', '長周期地震動に関する観測情報', '震源・震度情報 #2',
    ])
    expect(out[0].ms).toBe(new Date(2024, 0, 1, 16, 12).getTime())
  })

  it('途中から受信した端末でも、最後の報の番号は電文が名乗った番号になる', () => {
    const q = card(telegram('震源・震度情報', t(16, 30), 'x', 4), telegram('震源・震度情報', t(16, 40), 'y', 5))
    expect(quakeReportTimeline(q).map(e => e.label)).toEqual(['震源・震度情報 #4', '震源・震度情報 #5'])
  })

  // 対照: 番号を名乗らない種別（震度速報は Head/Serial が空）は受け取った数で振る
  it('番号を名乗らない種別は受け取った数で振る', () => {
    const q = card(telegram('震度速報', t(16, 12), 'a'), telegram('震度速報', t(16, 18), 'b'))
    expect(quakeReportTimeline(q).map(e => e.label)).toEqual(['震度速報 #1', '震度速報 #2'])
  })

  // 安全弁: 統合を通っていない（控えを持たない）カードは、カード自身を 1 報として並べる
  it('控えを持たないカードは自身の種別と発表時刻で 1 行になる', () => {
    const q = telegram('各地の震度情報', t(16, 20), 'z')
    expect(quakeReportTimeline(q)).toEqual([{ label: '各地の震度情報', ms: new Date(2024, 0, 1, 16, 20).getTime() }])
  })

  it('時刻が読めない報は末尾へ回す', () => {
    const q = telegram('震度速報', '', 'a')
    const out = quakeReportTimeline(q, [{ label: '国際津波関連情報', time: t(16, 0) }])
    expect(out.map(e => e.label)).toEqual(['国際津波関連情報', '震度速報'])
    expect(out[1].ms).toBeNull()
  })

  it('時刻は「日 時:分」で書く', () => {
    expect(formatTimelineTime(new Date(2024, 0, 1, 16, 5).getTime(), ja.formats)).toBe('1日 16:05')
  })
})
