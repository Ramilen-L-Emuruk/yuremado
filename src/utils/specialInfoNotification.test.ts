import { describe, it, expect } from 'vitest'
import {
  nankaiNotification, kohatsuNotification, nankaiCommentaryNotification, lpgmNotification,
  estimatedIntensityNotification, earthquakeCountNotification, quakeNoticeNotification,
} from './specialInfoNotification'
import type {
  JMANankai, JMAKohatsu, JMANankaiCommentary, JMALpgm, JMAEstimatedIntensity, JMAEarthquakeCount, JMAQuakeNotice,
} from '../types/earthquake'

// 文面は 2026-10-24 ユーザー選択「この案でよい (Recommended)」。ここで固定する。

const nankai = (over: Partial<JMANankai>): JMANankai => ({
  id: 'n', time: '2026-10-24T10:00:00+09:00', eventId: 'e', kindCode: '130', kindName: '巨大地震注意',
  headline: '南海トラフ地震臨時情報（巨大地震注意）', body: '本文', cancelled: false,
  reportDateTime: '2026-10-24T10:00:00+09:00', summary: '要約の文。', ...over,
})

describe('nankaiNotification', () => {
  it('正: 見出しは段階名を括弧で、本文は要約', () => {
    expect(nankaiNotification(nankai({}))).toEqual({
      title: '南海トラフ地震臨時情報（巨大地震注意）', body: '要約の文。', tag: 'nankai', open: null,
    })
  })
  it('正: 調査終了も段階名で出す（取消と混ぜない）', () => {
    expect(nankaiNotification(nankai({ kindName: '調査終了', cancelled: true })).title).toBe('南海トラフ地震臨時情報（調査終了）')
  })
  it('正: 取消は「取消」の見出しと「取り消されました」の本文で、発表と同じ札', () => {
    expect(nankaiNotification(nankai({ cancelled: true, retracted: true, kindName: '', kindCode: '', body: '' }))).toEqual({
      title: '南海トラフ地震臨時情報 取消', body: '南海トラフ地震臨時情報は取り消されました', tag: 'nankai', open: null,
    })
  })
  it('対照: 要約の無い報は本文なし', () => {
    expect(nankaiNotification(nankai({ summary: undefined })).body).toBe('')
  })
})

// 2026-11-09 ユーザー選択「帯を取消に切り替え＋通知に理由 (Recommended)」（説明「ブラウザ通知・プッシュ通知の本文を理由の文に（空なら今の定型文）」）
describe('取消の通知の本文は電文の理由', () => {
  const reason = 'システムの障害により誤った情報を配信しました。'
  it('正: 臨時情報・後発・関連解説・地震回数・お知らせの取消は、理由があれば本文をその文にする', () => {
    expect(nankaiNotification(nankai({ cancelled: true, retracted: true, body: reason })).body).toBe(reason)
    expect(kohatsuNotification({ id: 'k', time: '', eventId: 'k', headline: '', body: reason, cancelled: true, retracted: true, reportDateTime: '', expireAt: '' } as JMAKohatsu).body).toBe(reason)
    expect(nankaiCommentaryNotification({ id: 'c', time: '', eventId: 'c', serialCode: '', serialName: '', headline: '', body: reason, cancelled: true, reportDateTime: '', expireAt: '' } as JMANankaiCommentary).body).toBe(reason)
    expect(earthquakeCountNotification({ id: 'ec', eventId: 'ec', time: '', cancelled: true, items: [], cancelText: reason } as unknown as JMAEarthquakeCount, '').body).toBe(reason)
    expect(quakeNoticeNotification({ id: 'q', eventId: 'q', time: '', headline: '', body: reason, cancelled: true, reportDateTime: '' } as unknown as JMAQuakeNotice).body).toBe(reason)
  })
  it('対照: 理由が空白だけなら今の定型文', () => {
    expect(nankaiNotification(nankai({ cancelled: true, retracted: true, body: ' 　\n' })).body).toBe('南海トラフ地震臨時情報は取り消されました')
  })
  it('安全弁: 臨時情報の調査終了（取消ではない）は本文を理由に替えない', () => {
    expect(nankaiNotification(nankai({ kindName: '調査終了', cancelled: true, body: reason })).body).toBe('要約の文。')
  })
})

describe('kohatsuNotification', () => {
  const kohatsu = (over: Partial<JMAKohatsu>): JMAKohatsu => ({
    id: 'k', time: '', eventId: 'k', headline: '北海道・三陸沖後発地震注意情報', body: '', cancelled: false,
    reportDateTime: '', expireAt: '', summary: '要約。', ...over,
  })
  it('正: 情報名と要約', () => {
    expect(kohatsuNotification(kohatsu({}))).toEqual({ title: '北海道・三陸沖後発地震注意情報', body: '要約。', tag: 'kohatsu', open: null })
  })
  it('正: 取消', () => {
    expect(kohatsuNotification(kohatsu({ cancelled: true, retracted: true }))).toEqual({
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
    expect(nankaiCommentaryNotification(c({})).title).toBe('南海トラフ地震関連解説情報（第１号）')
  })
  it('安全弁: 情報名が空なら種別名', () => {
    expect(nankaiCommentaryNotification(c({ headline: '' })).title).toBe('南海トラフ地震関連解説情報')
  })
  it('正: 取消', () => {
    expect(nankaiCommentaryNotification(c({ cancelled: true })).title).toBe('南海トラフ地震関連解説情報 取消')
  })
})

describe('lpgmNotification', () => {
  const lpgm = (over: Partial<JMALpgm>): JMALpgm => ({
    id: 'l', eventId: '20260101161000', time: '', originTime: '', maxClass: 3, cancelled: false,
    hypocenter: { name: '石川県能登地方' }, ...over,
  } as JMALpgm)
  it('正: 震央地名と最大長周期地震動階級', () => {
    expect(lpgmNotification(lpgm({}), '')).toEqual({
      title: '長周期地震動に関する観測情報', body: '石川県能登地方 最大長周期地震動階級3', tag: 'lpgm-20260101161000',
      open: { tab: 'earthquake', lpgm: '20260101161000' },
    })
  })
  it('対照: 地名が無ければ階級だけ', () => {
    expect(lpgmNotification(lpgm({ hypocenter: undefined }), '').body).toBe('最大長周期地震動階級3')
  })
  it('正: 取消は覚えた地名で言い、同じ札で置き換える', () => {
    expect(lpgmNotification(lpgm({ cancelled: true, hypocenter: undefined }), '石川県能登地方')).toEqual({
      title: '長周期地震動に関する観測情報 取消',
      body: '石川県能登地方の長周期地震動に関する観測情報は取り消されました',
      tag: 'lpgm-20260101161000',
      // 取り消された報には開く表示が無いので、開き先を持たない
      open: null,
    })
  })
  it('対照: 地名を覚えていない取消は地名なし', () => {
    expect(lpgmNotification(lpgm({ cancelled: true }), '').body).toBe('長周期地震動に関する観測情報は取り消されました')
  })
})

describe('estimatedIntensityNotification', () => {
  const ei = { arrivalTime: '2026-10-24T10:05:00+09:00' } as JMAEstimatedIntensity
  it('正: 地震発現時刻で地震を言い、受信を伝える', () => {
    expect(estimatedIntensityNotification(ei, true).body).toBe('10時05分頃発生した地震の推計震度分布図を受信しました')
  })
  it('対照: 続報は「更新されました」', () => {
    expect(estimatedIntensityNotification(ei, false).body).toBe('10時05分頃発生した地震の推計震度分布図が更新されました')
  })
  it('安全弁: 時刻が読めなければ時刻の句ごと落とす', () => {
    expect(estimatedIntensityNotification({ arrivalTime: '' } as JMAEstimatedIntensity, true).body).toBe('推計震度分布図を受信しました')
  })
})

describe('earthquakeCountNotification', () => {
  const count = (over: Partial<JMAEarthquakeCount>) => ({ cancelled: false, ...over }) as JMAEarthquakeCount
  it('正: 本文は帯の見出し', () => {
    expect(earthquakeCountNotification(count({}), '10/24 09時から 1,704回（うち有感 25回）')).toEqual({
      title: '地震回数に関する情報', body: '10/24 09時から 1,704回（うち有感 25回）', tag: 'earthquake-count', open: null,
    })
  })
  it('対照: 見出しが種別名だけなら本文なし', () => {
    expect(earthquakeCountNotification(count({}), '地震回数に関する情報').body).toBe('')
  })
  it('正: 取消', () => {
    expect(earthquakeCountNotification(count({ cancelled: true }), '').title).toBe('地震回数に関する情報 取消')
  })
})
