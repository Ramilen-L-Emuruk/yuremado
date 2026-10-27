import { describe, expect, it } from 'vitest'

import {
  boardActionAvailability,
  boardActionConfirm,
  boardActionFailureLine,
  boardActionSentLine,
  hostRestartAcceptedLine,
  hostRestartFailureLine,
  parseBoardControl,
  parseRedetectState,
  REDETECT_INTERRUPTED_LINE,
  redetectLine,
  redetectPollFailureLine,
  redetectStartFailureLine,
  redetectStationsFailureLine,
} from './adminOperations'
import { ApiError } from './api'

const KEY = 'mac:020000000001'
// 2026-10-27 12:34 JST
const T = Date.UTC(2026, 9, 27, 3, 34)

describe('boardActionAvailability', () => {
  it('正: トークンがあり住所が分かれば押せる', () => {
    expect(boardActionAvailability({ tokenConfigured: true, reachable: [KEY] }, null, KEY)).toEqual({ enabled: true, reason: null })
  })
  it('対照: トークンが無ければ押せず、理由に環境変数の名前を出す', () => {
    expect(boardActionAvailability({ tokenConfigured: false, reachable: [KEY] }, null, KEY).reason).toBe(
      'ホストに基板のトークンが無い（SEISMO_BOARD_ADMIN_TOKEN）',
    )
  })
  it('対照: 住所の分からない基板は押せない', () => {
    expect(boardActionAvailability({ tokenConfigured: true, reachable: [] }, null, KEY).reason).toBe(
      '基板の住所が分からない（まだパケットが届いていない）',
    )
  })
  it('安全弁: 材料が取れていなければ押せず、取れなかった理由を出す', () => {
    expect(boardActionAvailability(null, '通信できない: x', KEY)).toEqual({ enabled: false, reason: '通信できない: x' })
  })
})

describe('parseBoardControl', () => {
  it('形が違えば null', () => {
    expect(parseBoardControl({ tokenConfigured: true, reachable: [KEY] })).toEqual({ tokenConfigured: true, reachable: [KEY] })
    expect(parseBoardControl({ tokenConfigured: 'yes', reachable: [] })).toBeNull()
    expect(parseBoardControl({ tokenConfigured: true, reachable: [1] })).toBeNull()
  })
})

describe('基板の操作の文言', () => {
  it('確認の窓は承認した文面', () => {
    expect(boardActionConfirm('restart', '台所')).toEqual({
      title: '基板「台所」を再起動しますか？',
      body: '再起動の間は、この基板の波形が途切れます。',
      confirmLabel: '再起動する',
    })
    expect(boardActionConfirm('wifi-reconnect', '台所')).toEqual({
      title: '基板「台所」の Wi-Fi を繋ぎ直しますか？',
      body: '繋ぎ直す間は、この基板の波形が途切れます。再起動はしません。',
      confirmLabel: '繋ぎ直す',
    })
  })
  it('頼めたら操作ごとの一言', () => {
    expect(boardActionSentLine('restart')).toEqual({ text: '再起動を頼んだ', error: false })
    expect(boardActionSentLine('wifi-reconnect')).toEqual({ text: '繋ぎ直しを頼んだ', error: false })
  })
  it('基板の断り方を本文の error で読み分ける', () => {
    const line = (error: string, extra: Record<string, unknown> = {}) =>
      boardActionFailureLine(new ApiError(502, { error, ...extra } as { error: string })).text
    expect(line('board-closed')).toBe('この基板は操作を受け付けない（ADMIN_TOKEN を入れずに焼いた）')
    expect(line('board-bad-token')).toBe('基板のトークンが違う')
    expect(line('board-old-firmware')).toBe('この基板のファームは古い（焼き直しが要る）')
    expect(line('board-no-reply')).toBe('基板から返事が無い')
    expect(line('board-no-reply', { cause: 'timeout', reason: 'TimeoutError' })).toBe('基板から返事が無い（時間切れ）')
    expect(line('board-no-reply', { cause: 'refused', reason: 'fetch failed: connect ECONNREFUSED' })).toBe(
      '基板から返事が無い（繋ぎを断られた）',
    )
    // それ以外の種類は添えず、英語の原文は画面に出さない
    expect(line('board-no-reply', { cause: 'other', reason: 'fetch failed: getaddrinfo ENOTFOUND' })).toBe('基板から返事が無い')
    expect(line('board-unexpected', { boardStatus: 500 })).toBe('基板が予期しない返事をした（HTTP 500）')
  })
  it('対照: 認証の失敗はほかのタブと同じ言い方', () => {
    expect(boardActionFailureLine(new ApiError(401, { error: 'invalid-token' })).text).toBe('管理トークンが違う')
  })
})

describe('parseRedetectState・redetectLine', () => {
  it('正: 走っている間は始めた時刻を添える', () => {
    const s = parseRedetectState({ kind: 'running', startedAtMs: T, request: {} })
    expect(s).toEqual({ kind: 'running', startedAtMs: T })
    expect(redetectLine(s!, T + 60_000)).toEqual({ text: '流し直している（12:34 から）', error: false })
  })
  it('正: 終わったら書いた件数と既にあった件数', () => {
    const s = parseRedetectState({ kind: 'done', startedAtMs: T, finishedAtMs: T + 1, ok: true, written: 3, existing: 7, reason: null, warnings: [] })
    expect(redetectLine(s!, T)).toEqual({ text: '流し直した: 書いた 3 件・既にあった 7 件', error: false })
  })
  it('対照: うまくいかなければ理由をそのまま添えて赤', () => {
    const s = parseRedetectState({
      kind: 'done',
      startedAtMs: T,
      finishedAtMs: T + 1,
      ok: false,
      written: null,
      existing: null,
      reason: '[redetect] 地震情報を取れなかった: HTTP 503',
      warnings: [],
    })
    expect(redetectLine(s!, T)).toEqual({ text: '流し直しがうまくいかなかった: [redetect] 地震情報を取れなかった: HTTP 503', error: true })
  })
  it('安全弁: 何もしていなければ行を出さない・形が違えば null', () => {
    expect(redetectLine({ kind: 'idle' }, T)).toBeNull()
    expect(parseRedetectState({ kind: 'running' })).toBeNull()
    expect(parseRedetectState({ kind: 'done', startedAtMs: T, finishedAtMs: T, ok: true, written: '3', existing: 0, reason: null, warnings: [] })).toBeNull()
    // warnings が無い・文字列でないものが混じるなら読めない
    expect(parseRedetectState({ kind: 'done', startedAtMs: T, finishedAtMs: T, ok: true, written: 0, existing: 0, reason: null })).toBeNull()
    expect(parseRedetectState({ kind: 'done', startedAtMs: T, finishedAtMs: T, ok: true, written: 0, existing: 0, reason: null, warnings: [1] })).toBeNull()
  })
  it('始められなかったときも同じ形', () => {
    expect(redetectStartFailureLine(new Error('通信できない: x')).text).toBe('流し直しがうまくいかなかった: 通信できない: x')
  })
  it('正: 成功でも読めなかった所があれば、件数に添えて赤', () => {
    const s = parseRedetectState({
      kind: 'done',
      startedAtMs: T,
      finishedAtMs: T + 1,
      ok: true,
      written: 1,
      existing: 2,
      reason: null,
      warnings: ['W1', 'W2'],
    })
    expect(redetectLine(s!, T)).toEqual({
      text: '流し直した: 書いた 1 件・既にあった 2 件。ただし読めなかった所がある: W1／W2',
      error: true,
    })
  })
  it('ホストが断った範囲の理由を承認した言葉へ写す', () => {
    const reject = (error: string) => redetectStartFailureLine(new ApiError(400, { error })).text
    expect(reject('range-in-future')).toBe('流し直しがうまくいかなかった: 期間の始まりが未来になっている')
    expect(reject('bad-range')).toBe('流し直しがうまくいかなかった: 期間の指定が正しくない')
    expect(reject('bad-station')).toBe('流し直しがうまくいかなかった: 観測点の指定が正しくない')
  })
  it('途中で止まった・進み具合を訊けない・観測点の一覧を取れないの 3 行', () => {
    expect(REDETECT_INTERRUPTED_LINE).toEqual({ text: '流し直しが途中で止まった（ホストが起動し直したため）', error: true })
    expect(redetectPollFailureLine(new Error('通信できない: x'))).toEqual({
      text: '流し直しの進み具合を訊けない: 通信できない: x',
      error: true,
    })
    expect(redetectStationsFailureLine(new Error('通信できない: x'))).toEqual({
      text: '観測点の一覧を取れなかった（すべての観測点だけ選べる）: 通信できない: x',
      error: true,
    })
  })
})

describe('基板の二度押し', () => {
  it('ホストが 409 board-busy で断ったら「適用中」', () => {
    expect(boardActionFailureLine(new ApiError(409, { error: 'board-busy' }))).toEqual({ text: 'この基板はいま適用中', error: true })
  })
})

describe('ホストの再起動の文言', () => {
  it('正: 受けたら承認した一言', () => {
    expect(hostRestartAcceptedLine('restarting')).toEqual({ text: '再起動を頼んだ。起動し直すまで繋がらない', error: false })
  })
  it('対照: もう締めくくりの途中なら頼めなかったと赤で', () => {
    expect(hostRestartAcceptedLine('already-closing')).toEqual({ text: 'もう締めくくりの途中で、再起動は頼めなかった', error: true })
  })
  it('起動の途中（503）なら待ってから押し直す', () => {
    expect(hostRestartFailureLine(new ApiError(503, { error: 'not-ready' })).text).toBe(
      '起動の途中なので、まだ頼めない。少し待ってから押し直す',
    )
  })
})
