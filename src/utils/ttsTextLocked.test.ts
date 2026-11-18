// 読み上げの文のうち、**ほかのどのテストも文面を照合していなかった関数と定数**を、日本語の文面のまま固める。
//
// 読み上げを言語ごとの語表から組む形へ移すとき、日本語は一字も変えない決まり。文面を照合する
// テストが無い関数は、移した拍子に一字ずれても誰も気づかない。そこで断片の切れ目（追従の位置が
// 断片ごとに決まる）と、断片に付く鍵（既読と追従の鍵）まで丸ごと照合する。
//
// 掃引の計測台（`ttsSentenceSweep.probe.test.ts`）は `*ToText` で繋いだ文しか書き出さず、
// 鍵も切れ目も見ないので、ここで補う。
import { describe, it, expect } from 'vitest'
import {
  tsunamiExpiryChangeSegments, tsunamiAreaGradeChangeToSegments, tsunamiArrivalToSegments,
  tsunamiMissingToSegments, tsunamiWarningLevelToSegments, tsunamiMissingMaxHeightTimeToSegments,
  tsunamiObservationLoweredSegments, EEW_UPGRADE_PHRASE, EEW_WARNING_REGIONS_CLOSING,
  EEW_LPGM_CLASS_ZERO_TEXT, domesticTsunamiFactValue, type TsunamiQuakeSpoken,
} from './ttsText'
import { TSUNAMI_GRADE_LIFTED, type TsunamiAreaGradeChange } from './tsunami'
import type { SpeechSegment, SpeechRef } from './ttsFollow'
import type { DomesticTsunami, JMATsunami, TsunamiArea, TsunamiObservation } from '../types/earthquake'

const texts = (segs: SpeechSegment[]) => segs.map(s => s.text)
const refs = (segs: SpeechSegment[]) => segs.flatMap(s => s.refs)
const A = (code: string, name: string): SpeechRef => ({ kind: 'area', code, name })
const St = (name: string): SpeechRef => ({ kind: 'station', name })

const area = (name: string, grade: TsunamiArea['grade'], code: string): TsunamiArea =>
  ({ name, code, grade, immediate: false }) as TsunamiArea
const tsunami = (over: Partial<JMATsunami>): JMATsunami => ({
  kind: 'tsunami', id: 't1', eventId: 'e1', time: '2024-01-01T16:30:00+09:00', cancelled: false,
  areas: [area('石川県能登', 'MajorWarning', '391')], observations: [],
  ...over,
}) as unknown as JMATsunami
const obs = (name: string, over: Partial<TsunamiObservation> = {}): TsunamiObservation =>
  ({ name, districtCode: '391', districtName: '石川県能登', ...over }) as TsunamiObservation

const timed = obs('輪島港', { arrivalTime: '2024-01-01T16:13:00+09:00', initial: '引き' })
const untimed = obs('珠洲市長橋')
const weak = obs('金沢', { districtCode: '392', districtName: '石川県加賀', condition: { weak: true } } as Partial<TsunamiObservation>)
const nanao = obs('七尾港')
const toyama = obs('富山', { districtCode: '390', districtName: '富山県' })

describe('失効時刻の変化（tsunamiExpiryChangeSegments）', () => {
  const areas = [area('北海道太平洋沿岸東部', 'Forecast', '100')]
  const forecast = tsunami({ areas })
  const applied = (validDateTime: string) => tsunami({ areas, validDateTime })
  const expiryRef = (value: string): SpeechRef => ({ kind: 'quakeFact', fact: 'tsunamiExpiry', value })

  it('延びたら「延長されました」', () => {
    const s = tsunamiExpiryChangeSegments(forecast, '2024-01-01T18:00:00+09:00', applied('2024-01-01T20:30:00+09:00'), undefined)
    expect(texts(s)).toEqual(['津波予報（若干の海面変動）の失効時刻が、', '20時30分', 'に延長されました。'])
    // 既読の鍵は言語に依らない形（読み上げる文とは別）
    expect(refs(s)).toEqual([expiryRef('20:30')])
  })

  it('早まったら「変更されました」', () => {
    const s = tsunamiExpiryChangeSegments(forecast, '2024-01-01T20:30:00+09:00', applied('2024-01-01T18:00:00+09:00'), undefined)
    expect(texts(s)).toEqual(['津波予報（若干の海面変動）の失効時刻が、', '18時0分', 'に変更されました。'])
    expect(refs(s)).toEqual([expiryRef('18:0')])
  })

  it('日をまたいだら日付を添える', () => {
    const s = tsunamiExpiryChangeSegments(forecast, '2024-01-01T18:00:00+09:00', applied('2024-01-02T14:00:00+09:00'), undefined)
    expect(texts(s)).toEqual(['津波予報（若干の海面変動）の失効時刻が、', '2日14時0分', 'に延長されました。'])
    expect(refs(s)).toEqual([expiryRef('2/14:0')])
  })

  it('同じ値を読んだあとなら黙る', () => {
    const spoken = { expiry: { facts: new Map([['tsunamiExpiry', '20:30']]) } } as unknown as TsunamiQuakeSpoken
    expect(tsunamiExpiryChangeSegments(forecast, '2024-01-01T18:00:00+09:00', applied('2024-01-01T20:30:00+09:00'), spoken)).toEqual([])
  })
})

describe('区域単位の等級変化（tsunamiAreaGradeChangeToSegments）', () => {
  it('引き上げ・切り替え・新たな発表・解除・前の等級が読めない解除を「また、」で繋ぐ', () => {
    const changes = [
      { from: 'Warning', to: 'MajorWarning', raised: true, areas: [area('石川県能登', 'MajorWarning', '391')] },
      { from: 'MajorWarning', to: 'Warning', raised: false, areas: [area('新潟県上中下越', 'Warning', '380'), area('富山県', 'Warning', '390')] },
      { from: 'Unknown', to: 'Watch', raised: true, areas: [area('福井県', 'Watch', '400')] },
      { from: 'Watch', to: TSUNAMI_GRADE_LIFTED, raised: false, areas: [area('山形県', 'Watch', '360')] },
      { from: undefined, to: TSUNAMI_GRADE_LIFTED, raised: false, areas: [area('秋田県', 'Watch', '350')] },
    ] as unknown as TsunamiAreaGradeChange[]
    const s = tsunamiAreaGradeChangeToSegments(changes)
    expect(texts(s)).toEqual([
      '石川県能登', 'の津波警報が大津波警報に引き上げられました。',
      'また、', '新潟県上中下越', '、', '富山県', 'の大津波警報が津波警報に切り替えられました。',
      'また、', '福井県', 'に津波注意報が発表されました。',
      'また、', '山形県', 'の津波注意報が解除されました。',
      'また、', '秋田県', 'の津波警報等が解除されました。',
    ])
    expect(refs(s)).toEqual([
      A('391', '石川県能登'), A('380', '新潟県上中下越'), A('390', '富山県'),
      A('400', '福井県'), A('360', '山形県'), A('350', '秋田県'),
    ])
  })
})

describe('到達の確認（tsunamiArrivalToSegments）', () => {
  it('第1波の時刻を読める地点があれば、見出しを置いて地点ごとに述語を持たせる', () => {
    const s = tsunamiArrivalToSegments([timed, untimed, weak])
    expect(texts(s)).toEqual([
      '次の地点で津波の到達を確認しました。', '石川県能登', '、', '輪島港', 'で16時13分に引き波を観測',
      '、', '珠洲市長橋', 'で到達を確認しました。最大波高は観測中です。',
      'また、', '石川県加賀', '、', '金沢', 'で到達を確認しました。最大波高は微弱です。',
    ])
    expect(refs(s)).toEqual([A('391', '石川県能登'), St('輪島港'), St('珠洲市長橋'), A('392', '石川県加賀'), St('金沢')])
  })

  it('時刻を読める地点が無ければ、見出しを置かない一文にする', () => {
    const s = tsunamiArrivalToSegments([untimed, weak])
    expect(texts(s)).toEqual([
      '石川県能登', '、', '珠洲市長橋', 'で到達を確認しました。最大波高は観測中です。',
      'また、', '石川県加賀', '、', '金沢', 'で到達を確認しました。最大波高は微弱です。',
    ])
    expect(refs(s)).toEqual([A('391', '石川県能登'), St('珠洲市長橋'), A('392', '石川県加賀'), St('金沢')])
  })

  it('上限で落とした地点は件数で言う', () => {
    const s = tsunamiArrivalToSegments([untimed, weak, nanao, toyama], 2)
    expect(texts(s)).toEqual([
      '石川県能登', '、', '珠洲市長橋', 'で到達を確認しました。最大波高は観測中です。',
      'また、', '石川県加賀', '、', '金沢', 'で到達を確認しました。最大波高は微弱です。',
      'ほか2地点でも到達を確認しています。',
    ])
  })

  it('第1波を読んだ地点は時刻を織り込まない', () => {
    const s = tsunamiArrivalToSegments([timed], undefined, new Map([['輪島港', 'x']]))
    expect(texts(s)).toEqual(['石川県能登', '、', '輪島港', 'で到達を確認しました。最大波高は観測中です。'])
    expect(refs(s)).toEqual([A('391', '石川県能登'), St('輪島港')])
  })
})

describe('欠測（tsunamiMissingToSegments）', () => {
  it('値を観測できていた群を先に、持たない群を「また、」で継ぐ', () => {
    const withHeight = obs('輪島港', { height: { value: 1.2, description: '1.2m' }, maxHeightDateTime: '2024-01-01T16:21:00+09:00' } as Partial<TsunamiObservation>)
    const s = tsunamiMissingToSegments([withHeight, weak, untimed])
    expect(texts(s)).toEqual([
      'これまでに', '石川県能登', '、', '輪島港', 'で1.2メートル', '、', '石川県加賀', '、', '金沢', 'で微弱な津波',
      'を観測したのち、欠測となっています。',
      'また、', '石川県能登', '、', '珠洲市長橋', 'は欠測となっています。',
    ])
    expect(refs(s)).toEqual([
      A('391', '石川県能登'), St('輪島港'), A('392', '石川県加賀'), St('金沢'), A('391', '石川県能登'), St('珠洲市長橋'),
    ])
  })

  it('落とした地点は「ほか N 地点も」と言う', () => {
    const s = tsunamiMissingToSegments([untimed, nanao, toyama], 2)
    expect(texts(s)).toEqual(['石川県能登', '、', '珠洲市長橋', '、', '七尾港', 'は欠測となっています。', 'ほか1地点も欠測となっています。'])
    expect(refs(s)).toEqual([A('391', '石川県能登'), St('珠洲市長橋'), St('七尾港')])
  })
})

describe('警報に相当する津波の観測（tsunamiWarningLevelToSegments）', () => {
  it('落とした地点は「ほか N 地点でも」と言う', () => {
    const s = tsunamiWarningLevelToSegments([untimed, nanao, toyama], 2)
    expect(texts(s)).toEqual([
      '石川県能登', '、', '珠洲市長橋', '、', '七尾港', 'では、津波警報に相当する津波を観測しています。',
      'ほか1地点でも津波警報に相当する津波を観測しています。',
    ])
    expect(refs(s)).toEqual([A('391', '石川県能登'), St('珠洲市長橋'), St('七尾港')])
  })
})

describe('欠測の観測点の最大波の時刻（tsunamiMissingMaxHeightTimeToSegments）', () => {
  it('欠測を先に言ってから時刻を言う', () => {
    const s = tsunamiMissingMaxHeightTimeToSegments([obs('輪島港', { maxHeightDateTime: '2024-01-01T23:26:00+09:00' }), untimed])
    expect(texts(s)).toEqual([
      '欠測となっている観測点で、最大波の観測時刻が更新されました。',
      '石川県能登', '、', '輪島港', 'で23時26分へ更新', '、', '珠洲市長橋', 'で更新されました。',
    ])
    expect(refs(s)).toEqual([A('391', '石川県能登'), St('輪島港'), St('珠洲市長橋')])
  })

  it('時刻を 1 つも読めなければ地点名を連ねる形にする', () => {
    const s = tsunamiMissingMaxHeightTimeToSegments([untimed])
    expect(texts(s)).toEqual(['欠測となっている', '石川県能登', '、', '珠洲市長橋', 'で、最大波の観測時刻が更新されました。'])
    expect(refs(s)).toEqual([A('391', '石川県能登'), St('珠洲市長橋')])
  })
})

describe('名乗るだけの文と定数', () => {
  it('読んだ波高より下がった報は名乗るだけ', () => {
    expect(tsunamiObservationLoweredSegments()).toEqual([{ text: '津波観測に関する情報が発表されました。', refs: [] }])
  })

  it('緊急地震速報の定数', () => {
    expect(EEW_UPGRADE_PHRASE).toBe('緊急地震速報に切り替わりました。')
    expect(EEW_WARNING_REGIONS_CLOSING).toBe('強い揺れに警戒してください')
    expect(EEW_LPGM_CLASS_ZERO_TEXT).toBe('予想最大階級0。')
  })

  // 既読の鍵に使う値（声にはしない）。言語によらず日本語のまま持つ。
  it('国内の津波の既読の鍵は電文の語のまま', () => {
    const values: DomesticTsunami[] = ['なし', '不明', '調査中', '海面変動の可能性', '若干の海面変動', '注意報', '警報等']
    expect(values.map(t => domesticTsunamiFactValue(t, undefined))).toEqual(values)
    expect(domesticTsunamiFactValue('若干の海面変動', '0212')).toBe('若干の海面変動:0212')
  })
})
