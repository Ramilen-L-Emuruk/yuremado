import { describe, it, expect } from 'vitest'
import {
  nankaiNotification, kohatsuNotification, nankaiCommentaryNotification, lpgmNotification,
  estimatedIntensityNotification, earthquakeCountNotification, quakeNoticeNotification, internationalTsunamiNotification,
} from './specialInfoNotification'
import { internationalTsunamiBody } from './internationalTsunamiSpeech'
import { ja } from '../i18n/messages/ja'
import { en } from '../i18n/messages/en'
import { JA_PLACE_NAMES } from '../i18n/placeNames'
import type {
  JMANankai, JMAKohatsu, JMANankaiCommentary, JMALpgm, JMAEstimatedIntensity, JMAEarthquakeCount, JMAQuakeNotice,
  JMAInternationalTsunami,
} from '../types/earthquake'

// 文面は 2026-10-24 ユーザー選択「この案でよい (Recommended)」。ここで固定する。

const nankai = (over: Partial<JMANankai>): JMANankai => ({
  id: 'n', time: '2026-10-24T10:00:00+09:00', eventId: 'e', kindCode: '130', kindName: '巨大地震注意',
  headline: '南海トラフ地震臨時情報（巨大地震注意）', body: '本文', cancelled: false,
  reportDateTime: '2026-10-24T10:00:00+09:00', summary: '要約の文。', ...over,
})

describe('nankaiNotification', () => {
  it('正: 見出しは段階名を括弧で、本文は要約', () => {
    expect(nankaiNotification(nankai({}), ja)).toEqual({
      title: '南海トラフ地震臨時情報（巨大地震注意）', body: '要約の文。', tag: 'nankai', open: null,
    })
  })
  it('正: 調査終了も段階名で出す（取消と混ぜない）', () => {
    expect(nankaiNotification(nankai({ kindName: '調査終了', cancelled: true }), ja).title).toBe('南海トラフ地震臨時情報（調査終了）')
  })
  it('正: 取消は「取消」の見出しと「取り消されました」の本文で、発表と同じ札', () => {
    expect(nankaiNotification(nankai({ cancelled: true, retracted: true, kindName: '', kindCode: '', body: '' }), ja)).toEqual({
      title: '南海トラフ地震臨時情報 取消', body: '南海トラフ地震臨時情報は取り消されました', tag: 'nankai', open: null,
    })
  })
  it('対照: 要約の無い報は本文なし', () => {
    expect(nankaiNotification(nankai({ summary: undefined }), ja).body).toBe('')
  })
})

// 2026-11-09 ユーザー選択「帯を取消に切り替え＋通知に理由 (Recommended)」（説明「ブラウザ通知・プッシュ通知の本文を理由の文に（空なら今の定型文）」）
describe('取消の通知の本文は電文の理由', () => {
  const reason = 'システムの障害により誤った情報を配信しました。'
  it('正: 臨時情報・後発・関連解説・地震回数・お知らせの取消は、理由があれば本文をその文にする', () => {
    expect(nankaiNotification(nankai({ cancelled: true, retracted: true, body: reason }), ja).body).toBe(reason)
    expect(kohatsuNotification({ id: 'k', time: '', eventId: 'k', headline: '', body: reason, cancelled: true, retracted: true, reportDateTime: '', expireAt: '' } as JMAKohatsu, ja).body).toBe(reason)
    expect(nankaiCommentaryNotification({ id: 'c', time: '', eventId: 'c', serialCode: '', serialName: '', headline: '', body: reason, cancelled: true, reportDateTime: '', expireAt: '' } as JMANankaiCommentary, ja).body).toBe(reason)
    expect(earthquakeCountNotification({ id: 'ec', eventId: 'ec', time: '', cancelled: true, items: [], cancelText: reason } as unknown as JMAEarthquakeCount, '', ja).body).toBe(reason)
    expect(quakeNoticeNotification({ id: 'q', eventId: 'q', time: '', headline: '', body: reason, cancelled: true, reportDateTime: '' } as unknown as JMAQuakeNotice, ja).body).toBe(reason)
  })
  it('対照: 理由が空白だけなら今の定型文', () => {
    expect(nankaiNotification(nankai({ cancelled: true, retracted: true, body: ' 　\n' }), ja).body).toBe('南海トラフ地震臨時情報は取り消されました')
  })
  it('安全弁: 臨時情報の調査終了（取消ではない）は本文を理由に替えない', () => {
    expect(nankaiNotification(nankai({ kindName: '調査終了', cancelled: true, body: reason }), ja).body).toBe('要約の文。')
  })
})

describe('kohatsuNotification', () => {
  const kohatsu = (over: Partial<JMAKohatsu>): JMAKohatsu => ({
    id: 'k', time: '', eventId: 'k', headline: '北海道・三陸沖後発地震注意情報', body: '', cancelled: false,
    reportDateTime: '', expireAt: '', summary: '要約。', ...over,
  })
  it('正: 情報名と要約', () => {
    expect(kohatsuNotification(kohatsu({}), ja)).toEqual({ title: '北海道・三陸沖後発地震注意情報', body: '要約。', tag: 'kohatsu', open: null })
  })
  it('正: 取消', () => {
    expect(kohatsuNotification(kohatsu({ cancelled: true, retracted: true }), ja)).toEqual({
      title: '北海道・三陸沖後発地震注意情報 取消', body: '北海道・三陸沖後発地震注意情報は取り消されました', tag: 'kohatsu', open: null,
    })
  })
})

describe('nankaiCommentaryNotification', () => {
  const c = (over: Partial<JMANankaiCommentary>): JMANankaiCommentary => ({
    id: 'c', time: '', eventId: 'c', serialCode: '210', serialName: '臨時解説',
    headline: '南海トラフ地震関連解説情報（第１号）', body: '', cancelled: false, reportDateTime: '', expireAt: '',
    summary: '要約。', ...over,
  })
  it('正: 見出しは電文の情報名（号数を含む）', () => {
    expect(nankaiCommentaryNotification(c({}), ja).title).toBe('南海トラフ地震関連解説情報（第１号）')
  })
  it('安全弁: 情報名が空なら種別名', () => {
    expect(nankaiCommentaryNotification(c({ headline: '' }), ja).title).toBe('南海トラフ地震関連解説情報')
  })
  it('正: 取消', () => {
    expect(nankaiCommentaryNotification(c({ cancelled: true }), ja).title).toBe('南海トラフ地震関連解説情報 取消')
  })
})

const lpgm = (over: Partial<JMALpgm>): JMALpgm => ({
  id: 'l', eventId: '20260101161000', time: '', originTime: '', maxClass: 3, cancelled: false,
  hypocenter: { name: '石川県能登地方' }, ...over,
} as JMALpgm)

describe('lpgmNotification', () => {
  it('正: 震央地名と最大長周期地震動階級', () => {
    expect(lpgmNotification(lpgm({}), '', ja, JA_PLACE_NAMES)).toEqual({
      title: '長周期地震動に関する観測情報', body: '石川県能登地方 最大長周期地震動階級3', tag: 'lpgm-20260101161000',
      open: { tab: 'earthquake', lpgm: '20260101161000' },
    })
  })
  it('対照: 地名が無ければ階級だけ', () => {
    expect(lpgmNotification(lpgm({ hypocenter: undefined }), '', ja, JA_PLACE_NAMES).body).toBe('最大長周期地震動階級3')
  })
  it('正: 取消は覚えた地名で言い、同じ札で置き換える', () => {
    expect(lpgmNotification(lpgm({ cancelled: true, hypocenter: undefined }), '石川県能登地方', ja, JA_PLACE_NAMES)).toEqual({
      title: '長周期地震動に関する観測情報 取消',
      body: '石川県能登地方の長周期地震動に関する観測情報は取り消されました',
      tag: 'lpgm-20260101161000',
      // 取り消された報には開く表示が無いので、開き先を持たない
      open: null,
    })
  })
  it('対照: 地名を覚えていない取消は地名なし', () => {
    expect(lpgmNotification(lpgm({ cancelled: true }), '', ja, JA_PLACE_NAMES).body).toBe('長周期地震動に関する観測情報は取り消されました')
  })
})

const ei = { arrivalTime: '2026-10-24T10:05:00+09:00' } as JMAEstimatedIntensity

describe('estimatedIntensityNotification', () => {
  it('正: 地震発現時刻で地震を言い、受信を伝える', () => {
    expect(estimatedIntensityNotification(ei, true, ja).body).toBe('10時05分頃発生した地震の推計震度分布図を受信しました')
  })
  it('対照: 続報は「更新されました」', () => {
    expect(estimatedIntensityNotification(ei, false, ja).body).toBe('10時05分頃発生した地震の推計震度分布図が更新されました')
  })
  it('安全弁: 時刻が読めなければ時刻の句ごと落とす', () => {
    expect(estimatedIntensityNotification({ arrivalTime: '' } as JMAEstimatedIntensity, true, ja).body).toBe('推計震度分布図を受信しました')
  })
})

describe('earthquakeCountNotification', () => {
  const count = (over: Partial<JMAEarthquakeCount>) => ({ cancelled: false, ...over }) as JMAEarthquakeCount
  it('正: 本文は帯の見出し', () => {
    expect(earthquakeCountNotification(count({}), '10/24 09時から 1,704回（うち有感 25回）', ja)).toEqual({
      title: '地震回数に関する情報', body: '10/24 09時から 1,704回（うち有感 25回）', tag: 'earthquake-count', open: null,
    })
  })
  it('対照: 見出しが種別名だけなら本文なし', () => {
    expect(earthquakeCountNotification(count({}), '地震回数に関する情報', ja).body).toBe('')
  })
  it('正: 取消', () => {
    expect(earthquakeCountNotification(count({ cancelled: true }), '', ja).title).toBe('地震回数に関する情報 取消')
  })
})

const wepa = (over: Partial<JMAInternationalTsunami>): JMAInternationalTsunami => ({
  kind: 'internationalTsunami', id: 'w', time: '2026-11-24T23:50:00Z', isCommunicationsTest: false,
  originTime: '2026-11-24T23:43:00Z', epicenter: { latitude: 13.9, longitude: 120.5 }, depthKm: 139, magnitude: 7,
  evaluation: 'localNearEpicenter', ...over,
} as JMAInternationalTsunami)

// 通知の本文は、日本語では読み上げの文から名乗りを除いたものと 1 文字も変わらない（2026-11-06 ユーザー選択「通知もそろえる (Recommended)」）
describe('internationalTsunamiNotification', () => {
  it('正: 日本語の本文は読み上げの本文と同じ（震源名・座標・評価なし・深さなし・通信試験）', () => {
    const cases: [JMAInternationalTsunami, string | undefined][] = [
      [wepa({}), undefined],
      [wepa({}), 'フィリピン諸島'],
      [wepa({ evaluation: undefined }), undefined],
      [wepa({ depthKm: undefined, epicenter: { latitude: -13.9, longitude: -120.5 } }), undefined],
      [wepa({ originTime: undefined, epicenter: undefined, magnitude: undefined }), undefined],
      [wepa({ isCommunicationsTest: true }), undefined],
    ]
    for (const [x, name] of cases) {
      expect(internationalTsunamiNotification(x, name, ja, JA_PLACE_NAMES).body).toBe(internationalTsunamiBody(x, name))
    }
    expect(internationalTsunamiNotification(wepa({}), undefined, ja, JA_PLACE_NAMES).body)
      .toBe('25日8時43分頃、北緯13.9度、東経120.5度で発生した深さ139キロメートル、マグニチュード7.0の地震について、震源付近に被害をもたらす津波の可能性があると発表されました。')
    expect(internationalTsunamiNotification(wepa({}), undefined, ja, JA_PLACE_NAMES).title).toBe('国際津波関連情報')
  })
})

// 英語の辞書を渡すと、見出し・本文が英語になる（電文の要約・見出し文・震源名は電文のまま）
describe('英語の通知の文', () => {
  it('臨時情報: 情報名と段階名を訳し、取消は帯と同じ語', () => {
    expect(nankaiNotification(nankai({}), en).title).toBe(`Nankai Trough Earthquake Extra Information (${en.specialInfo.nankaiKind['巨大地震注意']})`)
    expect(nankaiNotification(nankai({ cancelled: true, retracted: true, body: '' }), en)).toMatchObject({
      title: 'Nankai Trough Earthquake Extra Information retracted', body: 'Nankai Trough Earthquake Extra Information has been retracted',
    })
  })
  it('後発・関連解説・お知らせ・地震回数の見出し', () => {
    expect(kohatsuNotification({ id: 'k', time: '', eventId: 'k', headline: '', body: '', cancelled: false, reportDateTime: '', expireAt: '' } as JMAKohatsu, en).title)
      .toBe('Hokkaido and Sanriku-oki Subsequent Earthquake Advisory')
    expect(nankaiCommentaryNotification({ id: 'c', time: '', eventId: 'c', serialCode: '', serialName: '', headline: '', body: '', cancelled: false, reportDateTime: '', expireAt: '' } as JMANankaiCommentary, en).title)
      .toBe('Nankai Trough Earthquake Commentary')
    expect(earthquakeCountNotification({ cancelled: false } as JMAEarthquakeCount, 'Earthquake Count Information', en))
      .toMatchObject({ title: 'Information on the Number of Earthquakes', body: '' })
  })
  it('長周期: 階級の文と取消の件名', () => {
    expect(lpgmNotification(lpgm({}), '', en, JA_PLACE_NAMES)).toMatchObject({
      title: 'Long-Period Ground Motion Observation Information', body: '石川県能登地方 · Max long-period ground motion class 3',
    })
    expect(lpgmNotification(lpgm({ cancelled: true, hypocenter: undefined }), '石川県能登地方', en, JA_PLACE_NAMES).body)
      .toBe('Long-Period Ground Motion Observation Information for 石川県能登地方 has been retracted')
  })
  it('推計震度分布図: 受信と更新', () => {
    expect(estimatedIntensityNotification(ei, true, en)).toMatchObject({
      title: 'Estimated seismic intensity map', body: 'Estimated seismic intensity map received for the earthquake at about 10:05 JST',
    })
    expect(estimatedIntensityNotification(ei, false, en).body).toBe('Estimated seismic intensity map updated for the earthquake at about 10:05 JST')
  })
  it('国際津波関連情報: 日時は言語の書き方（日本時間）、震源名が無ければ座標、評価の訳', () => {
    expect(internationalTsunamiNotification(wepa({}), undefined, en, JA_PLACE_NAMES)).toMatchObject({
      title: 'International tsunami information',
      body: 'Earthquake at about Nov 25, 08:43 JST, 13.9°N 120.5°E, depth 139 km, M7.0: A tsunami that could cause damage near the epicenter is possible.',
    })
    expect(internationalTsunamiNotification(wepa({ evaluation: undefined, depthKm: undefined }), 'フィリピン諸島', en, JA_PLACE_NAMES).body)
      .toBe('Earthquake at about Nov 25, 08:43 JST, フィリピン諸島, M7.0: International tsunami information issued.')
    expect(internationalTsunamiNotification(wepa({ isCommunicationsTest: true }), undefined, en, JA_PLACE_NAMES).body).toBe('Communications test.')
  })
})
