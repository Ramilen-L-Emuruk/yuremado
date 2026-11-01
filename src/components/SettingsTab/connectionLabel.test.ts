import { describe, it, expect, vi } from 'vitest'
import { forecastConnectionLabel, keyForecastConnectionLabel, telegramConnectionLabel } from './connectionLabel'
import { log } from '../../utils/logger'

vi.mock('../../utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// 接続状態の文言。**利用者がすべきことが違うなら文言も分ける**という規約を固定する。
//
// 画面の分岐をここへ切り出したのは、三項演算子の連鎖だと `ConnectionStatus` へ値を足した
// ときの書き忘れが型検査に掛からず、「画面にだけ出ない」形で漏れるため。
describe('keyForecastConnectionLabel', () => {
  const KEY_OK = { apiKeySet: true, apiKeyInvalid: false }

  // 正: 同時接続の上限は専用の文言にする。**利用者がすべきことを書く** ——
  // 実際にできるのは別のタブを閉じることだけで、枠が空けば自動で繋がる
  it('同時接続の上限は「切断」と別の文言で、閉じれば繋がることを伝える', () => {
    const label = keyForecastConnectionLabel('crowded', KEY_OK)

    expect(label.text).toContain('同時接続')
    expect(label.text).toContain('自動で繋がります')
    expect(label.text).not.toContain('切断')
    // 「異常」の赤ではなく注意の色。こちら側の不具合ではないため
    expect(label.className).toContain('amber')
  })

  // 正: 配信元が閉じて止めた 2 つは、理由と利用者がすべきことを分けて出す（2026-10-19 ユーザー承認の文面）。
  // 「切断」のままだと、自動で繋ぎ直す切断と見分けが付かず、待っていれば戻ると読まれる
  it('解約・終了の操作で止めたときは、理由ごとの文言を出す', () => {
    expect(keyForecastConnectionLabel('contract-ended', KEY_OK).text)
      .toBe('接続を停止（受信できる区分がなくなりました。契約を確かめてから再読み込みしてください）')
    expect(keyForecastConnectionLabel('closed-by-user', KEY_OK).text)
      .toBe('接続を停止（DMDATA.JP 側で接続が終了されました。再読み込みで繋ぎ直します）')
  })

  // 対照: 本当の切断は従来どおり「切断」。crowded の文言に寄せると、
  // キーや回線の問題を「タブを閉じれば直る」と誤って案内する
  it('切断は「切断」のまま', () => {
    expect(keyForecastConnectionLabel('disconnected', KEY_OK).text).toBe('切断')
  })

  // 対照: キーが未設定・不正なときは接続を試みていないので、通信の失敗と区別する
  it('キーの問題は通信の失敗と区別する', () => {
    expect(keyForecastConnectionLabel('disconnected', { apiKeySet: false, apiKeyInvalid: false }).text).toBe('APIキー未設定')
    expect(keyForecastConnectionLabel('disconnected', { apiKeySet: true, apiKeyInvalid: true }).text).toBe('APIキーが無効')
    // 鍵が使えないときは接続を作らない（null）
    expect(keyForecastConnectionLabel(null, { apiKeySet: false, apiKeyInvalid: false }).text).toBe('APIキー未設定')
    expect(keyForecastConnectionLabel(null, { apiKeySet: true, apiKeyInvalid: true }).text).toBe('APIキーが無効')
  })

  // 対照: 既存の 3 状態を巻き込んでいないこと
  it('接続中・接続試行中・再生中は従来の文言', () => {
    expect(keyForecastConnectionLabel('connected', KEY_OK).text).toBe('接続中')
    expect(keyForecastConnectionLabel('connecting', KEY_OK).text).toBe('接続試行中…')
    expect(keyForecastConnectionLabel('replay', KEY_OK).text).toContain('再生中')
  })

  // 安全弁: **どの状態でも空文字を返さない**。空を返すと接続状態の行が消え、
  // 「状態が分からない」ことに画面からも気づけない
  it('どの状態でも文言が空にならない', () => {
    for (const s of ['connected', 'connecting', 'disconnected', 'replay', 'crowded', 'contract-ended', 'closed-by-user', null] as const) {
      const label = keyForecastConnectionLabel(s, KEY_OK)
      expect(label.text.length).toBeGreaterThan(0)
      expect(label.className.length).toBeGreaterThan(0)
    }
  })

  // 安全弁: キーの状態は `disconnected` / 未設定のときだけ見る。
  // 繋がっているのに「APIキーが無効」と出たら、利用者は正しいキーを疑って消しにかかる
  it('接続できている状態ではキーの不正を文言に出さない', () => {
    const invalid = { apiKeySet: true, apiKeyInvalid: true }
    expect(keyForecastConnectionLabel('connected', invalid).text).toBe('接続中')
    expect(keyForecastConnectionLabel('crowded', invalid).text).toContain('同時接続')
  })

  // 安全弁: 型検査を通らない経路で未知の値が来たとき、**画面に出すだけでなく記録も残す**。
  // 画面の文言だけでは、どこから来た値なのか追えない
  it('未知の状態は記録を残し、既存の文言へ混ぜない', () => {
    vi.mocked(log.warn).mockClear()

    // 型の上では到達しない分岐。型を無視して渡す経路（型と呼び出し側の同期が崩れた場合）を再現する
    const label = keyForecastConnectionLabel('throttled' as never, KEY_OK)

    expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(log.warn).mock.calls[0][0])).toContain('未知の接続状態')
    // **「切断」へ落とさない** —— 落とすと新しい状態が既存の文言に混ざり、画面からも気づけない
    expect(label.text).not.toBe('切断')
  })
})

// 「電文」の行（中継の接続）。中継と繋がっていても、中継が DMDATA.JP と切れていれば電文は届かない
describe('telegramConnectionLabel', () => {
  const at = (iso: string) => Date.parse(`${iso}+09:00`)

  // 正: 中継が DMDATA.JP と切れている間は「切断」と言い、切れた時刻を添える（2026-10-31 ユーザー選択の文面）
  it('中継が DMDATA.JP と切れていれば、繋がっていても切断と言い、時刻を添える', () => {
    const label = telegramConnectionLabel('connected', { connected: false, disconnectedAtMs: at('2026-10-31T15:42:10') })
    expect(label.text).toBe('切断（配信サーバーが DMDATA.JP と切断中・15:42 から）')
    expect(label.className).toContain('red')
  })

  // 正: 中継が時刻を知らなければ時刻だけ落とす（推測で埋めない）
  it('切れた時刻が分からなければ時刻を添えない', () => {
    expect(telegramConnectionLabel('connected', { connected: false, disconnectedAtMs: null }).text)
      .toBe('切断（配信サーバーが DMDATA.JP と切断中）')
  })

  // 対照: 中継が DMDATA.JP と繋がっている、またはまだ知らせが無いなら「接続中」
  it('中継が繋がっている・知らせがまだ無いなら接続中', () => {
    expect(telegramConnectionLabel('connected', { connected: true, disconnectedAtMs: null }).text).toBe('接続中')
    expect(telegramConnectionLabel('connected', null).text).toBe('接続中')
  })

  // 安全弁: 鍵の状態を見ない（中継は鍵が無くても繋がる）。中継自体が切れていれば素の「切断」
  it('中継自体が切れていれば「切断」で、鍵の文言は出さない', () => {
    expect(telegramConnectionLabel('disconnected', null).text).toBe('切断')
    expect(telegramConnectionLabel('disconnected', { connected: false, disconnectedAtMs: null }).text).toBe('切断')
  })

  // 安全弁: 再生中は中継の上流の状態で上書きしない（ライブ受信を止めているので）
  it('再生中は上流が切れていても再生中と出す', () => {
    expect(telegramConnectionLabel('replay', { connected: false, disconnectedAtMs: null }).text).toContain('再生中')
  })
})

describe('forecastConnectionLabel（「予報」の行）', () => {
  const base = { relayForecastLive: false, keyStatus: null, relayStatus: 'connected' as const, relayUpstream: null, relayForecastAvailable: false }
  const KEY = { apiKeySet: true, apiKeyInvalid: false }
  const NO_KEY = { apiKeySet: false, apiKeyInvalid: false }

  it('正: 中継から予報を受けていれば経路を「配信サーバー経由」と添える（鍵の接続より先に見る）', () => {
    expect(forecastConnectionLabel({ ...base, relayForecastLive: true, keyStatus: 'connected' }, KEY).text).toBe('接続中（配信サーバー経由）')
  })

  it('正: 鍵の接続で受けていれば「APIキー」と添える', () => {
    expect(forecastConnectionLabel({ ...base, keyStatus: 'connected' }, KEY).text).toBe('接続中（APIキー）')
  })

  it('対照: どちらも無ければ「APIキー未設定」', () => {
    expect(forecastConnectionLabel(base, NO_KEY).text).toBe('APIキー未設定')
  })

  it('安全弁: ほかの状態の文は今のまま（鍵の試行中・予報キーだけで中継が切れている）', () => {
    expect(forecastConnectionLabel({ ...base, keyStatus: 'connecting' }, KEY).text).toBe('接続試行中…')
    expect(forecastConnectionLabel({ ...base, relayStatus: 'disconnected', relayForecastAvailable: true }, NO_KEY).text).toBe('切断')
  })
})
