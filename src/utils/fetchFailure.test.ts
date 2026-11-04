import { describe, expect, it } from 'vitest'
import { FETCH_NETWORK_FAILURE_TEXT, fetchFailureReason, isFetchNetworkFailure } from './fetchFailure'

describe('fetchFailureReason', () => {
  // 正: ブラウザ 3 種の通信の失敗は、英語の文を出さず日本語の文にする
  it.each(['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.'])('通信の失敗「%s」は日本語の文にする', (message) => {
    expect(isFetchNetworkFailure(new TypeError(message))).toBe(true)
    expect(fetchFailureReason(new TypeError(message))).toBe(FETCH_NETWORK_FAILURE_TEXT)
  })

  // 対照: こちらで組んだ文（状態番号・時間切れ）はそのまま出す
  it('通信の失敗でない失敗の文はそのまま', () => {
    expect(fetchFailureReason(new Error('DMDATA の電文一覧 を取得できなかった: 500'))).toBe('DMDATA の電文一覧 を取得できなかった: 500')
  })

  // 安全弁: 同じ TypeError でもプログラムの誤りは通信の失敗にしない（ありもしない通信の失敗を伝えない）。Error でない値は従来の文
  it('通信と関係の無い TypeError と、Error でない値', () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'x')")
    expect(isFetchNetworkFailure(bug)).toBe(false)
    expect(fetchFailureReason(bug)).toBe(bug.message)
    expect(fetchFailureReason('x')).toBe('取得失敗')
    // TypeError でなければ、文面が同じでも通信の失敗にしない
    expect(isFetchNetworkFailure(new Error('Failed to fetch'))).toBe(false)
  })
})
