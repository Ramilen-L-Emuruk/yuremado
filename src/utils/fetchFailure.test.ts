import { describe, expect, it } from 'vitest'
import { FETCH_NETWORK_FAILURE_TEXT, fetchFailureReason, isFetchNetworkFailure } from './fetchFailure'
import { FetchTimeoutError } from './fetchWithTimeout'
import { DmdataApiKeyError } from './dmdataApiKey'
import { RelayTokenError } from '../services/relayEndpoint'
import { LocalizedError, errorText } from './localizedError'
import { ja } from '../i18n/messages/ja'
import { en } from '../i18n/messages/en'

const J = ja.errorText
const E = en.errorText

describe('fetchFailureReason', () => {
  // 正: ブラウザ 3 種の通信の失敗は、英語の文を出さず日本語の文にする
  it.each(['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.'])('通信の失敗「%s」は日本語の文にする', (message) => {
    expect(isFetchNetworkFailure(new TypeError(message))).toBe(true)
    expect(fetchFailureReason(new TypeError(message), J)).toBe(FETCH_NETWORK_FAILURE_TEXT)
    expect(FETCH_NETWORK_FAILURE_TEXT).toBe('通信できませんでした')
  })

  // 対照: こちらで組んだ文（状態番号・時間切れ）はそのまま出す
  it('通信の失敗でない失敗の文はそのまま', () => {
    expect(fetchFailureReason(new Error('DMDATA の電文一覧 を取得できなかった: 500'), J)).toBe('DMDATA の電文一覧 を取得できなかった: 500')
  })

  // 安全弁: 同じ TypeError でもプログラムの誤りは通信の失敗にしない（ありもしない通信の失敗を伝えない）。Error でない値は従来の文
  it('通信と関係の無い TypeError と、Error でない値', () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'x')")
    expect(isFetchNetworkFailure(bug)).toBe(false)
    expect(fetchFailureReason(bug, J)).toBe(bug.message)
    expect(fetchFailureReason('x', J)).toBe('取得失敗')
    // TypeError でなければ、文面が同じでも通信の失敗にしない
    expect(isFetchNetworkFailure(new Error('Failed to fetch'))).toBe(false)
  })
})

// 再生の帯・地震タブの履歴の帯に届く失敗は、鍵と引数を持ち、画面の言語の辞書で組む。`message`（ログと記録）は日本語のまま
describe('画面に届く失敗の文', () => {
  it('中継の札: message は前と同じ日本語、画面は言語の辞書', () => {
    const e = new RelayTokenError(errorText('relayTokenHttp', 429), 429)
    expect(e.message).toBe('中継の札を受け取れませんでした（HTTP 429）')
    expect(fetchFailureReason(e, J)).toBe('中継の札を受け取れませんでした（HTTP 429）')
    expect(fetchFailureReason(e, E)).toBe('Could not get a relay token (HTTP 429)')
    expect(fetchFailureReason(new RelayTokenError(errorText('relayTokenNotReady'), null), E))
      .toBe('Internal error: tried to build the request header before the relay token was ready')
  })

  it('時間切れ', () => {
    const e = new FetchTimeoutError('https://example.invalid/a', 15_000)
    expect(e.message).toBe('取得が 15 秒以内に終わりませんでした: https://example.invalid/a')
    expect(fetchFailureReason(e, E)).toBe('Loading did not finish within 15 s: https://example.invalid/a')
  })

  it('アーカイブの一覧の失敗', () => {
    const http = new LocalizedError(errorText('archiveListHttp', 401))
    expect(http.message).toBe('アーカイブの一覧を取得できなかった: 401')
    expect(fetchFailureReason(http, E)).toBe('Could not get the archive list: 401')
    const cut = new LocalizedError(errorText('archiveListCutOff', 20, '2026-11-01', '2026-11-02', 2000))
    expect(cut.message).toBe('アーカイブの一覧が途中で切れた: ページ上限（20）に達した 範囲=2026-11-01~2026-11-02 件数=2000')
    expect(fetchFailureReason(cut, E)).toBe('The archive list was cut off: reached the page limit (20) range=2026-11-01~2026-11-02 count=2000')
    expect(fetchFailureReason(new LocalizedError(errorText('archiveAllFailed', 3)), E)).toBe('Could not get the archive: none of the 3 sources could be read')
  })

  it('API キーと通信の失敗', () => {
    expect(fetchFailureReason(new DmdataApiKeyError('missing'), E)).toBe('No API key is set. Enter your DM-D.S.S API key.')
    expect(new DmdataApiKeyError('invalid').message).toBe(J.apiKeyInvalid())
    expect(new DmdataApiKeyError('missing').message).toBe(J.apiKeyMissing())
    expect(fetchFailureReason(new TypeError('Failed to fetch'), E)).toBe('Could not connect')
    expect(fetchFailureReason('x', E)).toBe('Load failed')
  })
})
