// 地震カードの一部の取消（震源情報まで進んだカードに震度速報だけの取消）の読み上げ。
// 文面は 2026-10-15 ユーザー承認「情報名で言う（推奨）」。
import { describe, it, expect } from 'vitest'
import { earthquakeCancelToText, earthquakeReportCancelToText } from './ttsText'

describe('earthquakeReportCancelToText', () => {
  it('正: 取り消された情報の名前と、その報の発表時刻で言う', () => {
    expect(earthquakeReportCancelToText('震度速報', '2024-01-01T23:05:00+09:00'))
      .toBe('23時5分に発表された震度速報は取り消されました。')
  })

  it('正: 理由が宣言だけ（「先ほどの、震度速報を取り消します。」）なら読まない（全体の取消と同じ扱い）', () => {
    expect(earthquakeReportCancelToText('震度速報', '2024-01-01T23:05:00+09:00', '先ほどの、震度速報を取り消します。'))
      .toBe('23時5分に発表された震度速報は取り消されました。')
  })

  it('安全弁: 理由に中身があれば全体の取消と同じく読む', () => {
    const reason = '先ほどの、観測データの誤りのため震度速報を取り消します。'
    const whole = earthquakeCancelToText('2024-01-01T23:05:00+09:00', reason)
    const part = earthquakeReportCancelToText('震度速報', '2024-01-01T23:05:00+09:00', reason)
    // 頭の文だけが違い、理由の文は同じ
    expect(part.slice(part.indexOf('。') + 1)).toBe(whole.slice(whole.indexOf('。') + 1))
    expect(part.slice(part.indexOf('。') + 1)).not.toBe('')
  })

  it('対照: 時刻が読めなければ時刻を言わない', () => {
    expect(earthquakeReportCancelToText('震度速報', null)).toBe('震度速報は取り消されました。')
  })
})
