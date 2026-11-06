import { describe, expect, it } from 'vitest'
import type { JMAInternationalTsunami } from '../types/earthquake'
import { EVALUATION_SPEECH, internationalTsunamiBody, internationalTsunamiToText } from './internationalTsunamiSpeech'

// 値は 2020-12-25 ミンドロ島付近の報（全期間の控えの実電文）に倣った
function bulletin(over: Partial<JMAInternationalTsunami> = {}): JMAInternationalTsunami {
  return {
    id: 'WEPA60:2020-12-25T00:03:00.000Z:TSUNAMI BULLETIN NUMBER 001:00000000',
    title: 'TSUNAMI BULLETIN NUMBER 001',
    time: '2020-12-25T00:03:00.000Z',
    originTime: '2020-12-24T23:43:00.000Z',
    isCommunicationsTest: false,
    text: '',
    epicenter: { latitude: 13.9, longitude: 120.5 },
    regionName: 'MINDORO, PHILIPPINES',
    magnitude: 6.5,
    bulletinNumber: 1,
    evaluation: 'verySmall',
    ...over,
  }
}

describe('internationalTsunamiToText', () => {
  it('結べた地震カードの震源名で読み、評価を訳して結ぶ（時刻は日本時間）', () => {
    expect(internationalTsunamiToText(bulletin(), 'フィリピン諸島、ミンドロ島付近')).toBe(
      '国際津波関連情報。25日8時43分頃、フィリピン諸島、ミンドロ島付近で発生したマグニチュード6.5の地震について、'
      + '被害をもたらす津波の可能性は非常に小さいと発表されました。',
    )
  })

  it('結べる地震カードが無ければ電文の座標で震源を言う（英語の地名は読まない）', () => {
    expect(internationalTsunamiToText(bulletin())).toBe(
      '国際津波関連情報。25日8時43分頃、北緯13.9度、東経120.5度で発生したマグニチュード6.5の地震について、'
      + '被害をもたらす津波の可能性は非常に小さいと発表されました。',
    )
  })

  it('南緯・西経は電文どおり言い分ける', () => {
    expect(internationalTsunamiBody(bulletin({ epicenter: { latitude: -36.1, longitude: -72.9 } })))
      .toContain('南緯36.1度、西経72.9度で発生した')
  })

  it('深さは電文にあるときだけ規模の前に入れる', () => {
    expect(internationalTsunamiBody(bulletin({ depthKm: 139 }), 'インドネシア付近'))
      .toBe('25日8時43分頃、インドネシア付近で発生した深さ139キロメートル、マグニチュード6.5の地震について、被害をもたらす津波の可能性は非常に小さいと発表されました。')
  })

  it('続報（番号が 2 以上）は「更新されました」で始める', () => {
    expect(internationalTsunamiToText(bulletin({ bulletinNumber: 2 }), 'X')).toMatch(/^国際津波関連情報が更新されました。25日/)
  })

  it('通信試験は試験だと言うだけ', () => {
    const test = bulletin({ isCommunicationsTest: true, title: 'NWPTA COMMUNICATIONS TEST', originTime: undefined, bulletinNumber: undefined, evaluation: undefined })
    expect(internationalTsunamiToText(test)).toBe('国際津波関連情報の通信試験です。')
    expect(internationalTsunamiBody(test)).toBe('通信試験です。')
  })

  it('評価が 5 種のどれとしても読めない報は、評価の句を落とし、情報が発表されたことだけを言う（原文は画面に出ている）', () => {
    expect(internationalTsunamiBody(bulletin({ evaluation: undefined }), 'X')).toBe('25日8時43分頃、Xで発生したマグニチュード6.5の地震について、国際津波関連情報が発表されました。')
  })

  it('評価の 5 種はどれも訳を持つ', () => {
    expect(Object.keys(EVALUATION_SPEECH).sort()).toEqual(['localNearEpicenter', 'none', 'oceanWide', 'regional', 'verySmall'])
    expect(internationalTsunamiBody(bulletin({ evaluation: 'none' }), 'X')).toMatch(/について、津波の可能性はないと発表されました。$/)
  })
})
