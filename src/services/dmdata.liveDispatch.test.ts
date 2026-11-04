// @vitest-environment jsdom
//
// ライブ受信（`DmdataWebSocket` の `handleMessage`）が電文を振り分ける形を固定する。
//
// **読み取りは一覧・リプレイ・取り戻しと同じ `buildXmlPayload` を通し、種別も同じ表
// （`TELEGRAM_KIND_OF_HEAD_TYPE`）から引く。** かつてライブだけが独自の分岐を持ち、電文ログの種別も
// 別の表から引いていた —— 片方を付け替えても食い違いを捕まえる検査が無かった。
// ライブだけの扱い（VXSE42・購読していない EEW・VXSE44・試験報の EEW）はその手前で済ませる。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TelegramLogEntry } from '../types/earthquake'
import type { ReplayPayload } from '../types/replay'

vi.mock('../utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogThrottle: () => (emit: () => void) => emit(),
}))

// 読み取りだけを差し替えられるようにする（既定は本物のまま）
const buildXmlPayloadMock = vi.hoisted(() => ({
  impl: null as null | ((h: string, x: string, e: unknown) => unknown),
  // 種別の表を引く関数の差し替え。表への載せ忘れを作るのに使う（既定は本物）
  kindOf: null as null | ((h: string) => unknown),
}))
vi.mock('./dmdataTelegramPayload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dmdataTelegramPayload')>()
  return {
    ...actual,
    buildXmlPayload: vi.fn((headType: string, xml: string, eewHeadType: Parameters<typeof actual.buildXmlPayload>[2]) =>
      buildXmlPayloadMock.impl ? buildXmlPayloadMock.impl(headType, xml, eewHeadType) : actual.buildXmlPayload(headType, xml, eewHeadType)),
    telegramKindOfHeadType: vi.fn((headType: string) =>
      buildXmlPayloadMock.kindOf ? buildXmlPayloadMock.kindOf(headType) : actual.telegramKindOfHeadType(headType)),
  }
})

import { DmdataWebSocket, type DmdataEvent } from './dmdata'
import { buildXmlPayload, TELEGRAM_KIND_OF_HEAD_TYPE, isBinaryTelegramType } from './dmdataTelegramPayload'
import { log } from '../utils/logger'
import { buildSampleTelegram } from '../test-utils/bufrBuild'

// 2024-01-01 能登半島地震の緊急地震速報（地震動予報・警報級）を最小化したもの。
const EEW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx="http://xml.kishou.go.jp/jmaxml1/">
<Control><Title>緊急地震速報（地震動予報）</Title><Status>通常</Status><EditorialOffice>気象庁本庁</EditorialOffice><PublishingOffice>気象庁</PublishingOffice></Control>
<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
<Title>緊急地震速報（地震動予報）</Title>
<ReportDateTime>2024-01-01T16:11:07+09:00</ReportDateTime>
<EventID>20240101161010</EventID>
<InfoType>発表</InfoType>
<Serial>30</Serial>
</Head>
<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
<Earthquake>
<OriginTime>2024-01-01T16:10:10+09:00</OriginTime>
<ArrivalTime>2024-01-01T16:10:10+09:00</ArrivalTime>
<Hypocenter><Area><Name>石川県能登地方</Name><jmx_eb:Coordinate>+37.5+137.2-10000/</jmx_eb:Coordinate></Area></Hypocenter>
<jmx_eb:Magnitude type="Mj">7.6</jmx_eb:Magnitude>
</Earthquake>
<Intensity><Forecast>
<ForecastInt><From>7</From><To>7</To></ForecastInt>
</Forecast></Intensity>
</Body>
</Report>`

function setup(includeTest = false, eewHeadType: 'VXSE45' | 'VXSE43' | null = 'VXSE45') {
  const ws = new DmdataWebSocket('valid-key', includeTest)
  // 受けている区分で決まる値（接続時に `eewHeadTypeFor` が決める）。ここでは直に置く
  ;(ws as unknown as { eewHeadType: 'VXSE45' | 'VXSE43' | null }).eewHeadType = eewHeadType
  const events: DmdataEvent[] = []
  const telegramIds: string[] = []
  const logs: TelegramLogEntry[] = []
  ws.onEvent = (ev, telegramId) => { events.push(ev); telegramIds.push(telegramId) }
  ws.onRawMessage = entry => { logs.push(entry) }
  const send = (headType: string, body: string, test = false) =>
    (ws as unknown as {
      handleMessage(m: Record<string, unknown>, emit: (ev: DmdataEvent, telegramId: string) => void): Promise<void>
    }).handleMessage({
      type: 'data', id: `id-${headType}`, head: { type: headType, test }, body, encoding: 'utf-8', format: 'xml',
    }, (ev, telegramId) => ws.onEvent?.(ev, telegramId))
  return { events, telegramIds, logs, send }
}

const warnings = () => vi.mocked(log.warn).mock.calls.map(c => String(c[0]))

beforeEach(() => {
  buildXmlPayloadMock.impl = null
  buildXmlPayloadMock.kindOf = null
  vi.mocked(log.warn).mockClear()
  vi.mocked(buildXmlPayload).mockClear()
})

describe('ライブ受信の振り分け', () => {
  // 正: XML で届く種別ごとに、読み取り結果の種別で通知し、電文ログにも同じ種別を付ける。
  // 種別の表に載る全種別を回すので、表に足した種別がライブで黙って落ちる形も捕まる。
  const xmlKinds = [...TELEGRAM_KIND_OF_HEAD_TYPE].filter(([headType]) => !isBinaryTelegramType(headType))
  const firstHeadOfKind = new Map<string, string>()
  for (const [headType, kind] of xmlKinds) {
    if (kind === 'eew') continue  // 緊急地震速報は区分で取り込む種別が決まるので下で別に見る
    if (!firstHeadOfKind.has(kind)) firstHeadOfKind.set(kind, headType)
  }
  for (const [kind, headType] of firstHeadOfKind) {
    it(`${headType}（${kind}）は読み取り結果の種別で通知し、電文ログにも同じ種別を付ける`, async () => {
      const data = { marker: headType }
      buildXmlPayloadMock.impl = () => (kind === 'quake' || kind === 'tsunami'
        ? { kind: 'event', event: { kind, ...data } }
        : { kind, data }) as unknown as ReplayPayload
      const { events, logs, send } = setup()
      await send(headType, '<Report/>')
      expect(vi.mocked(buildXmlPayload)).toHaveBeenCalledWith(headType, '<Report/>', 'VXSE45')
      expect(events.map(e => e.kind)).toEqual([kind])
      expect(logs.map(l => [l.status, l.kind])).toEqual([['parsed', kind]])
    })
  }

  // 正: 本物の電文を読む（差し替えなし）。試験報は設定が入っているときだけ通り、`test: false` で画面へ流す
  it('取り込む側の EEW を読み、試験報は test を外して通知する', async () => {
    const { events, logs, send } = setup(true)
    await send('VXSE45', EEW_XML, true)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('eew')
    expect(events[0].kind === 'eew' && events[0].data.test).toBe(false)
    expect(logs.map(l => [l.status, l.kind, l.isTest])).toEqual([['parsed', 'eew', true]])
  })

  // 正: 通知に電文の id（DMDATA が付けた `id`）を添える。中継と鍵の接続で同じ電文を見分けるのに使う
  it('通知に電文の id を添える', async () => {
    const { events, telegramIds, send } = setup()
    await send('VXSE45', EEW_XML)
    expect(events).toHaveLength(1)
    expect(telegramIds).toEqual(['id-VXSE45'])
  })

  // 対照: 読めなかった電文は通知せず、電文ログには読めなかった行として残す
  it('読めなかった電文は通知せず filtered で残す', async () => {
    buildXmlPayloadMock.impl = () => null
    const { events, logs, send } = setup()
    await send('VXSE53', '<Report/>')
    expect(events).toEqual([])
    expect(logs.map(l => [l.status, l.kind])).toEqual([['filtered', undefined]])
  })

  // 安全弁: 予報を受けている人に届いた VXSE43 は、読まずに警告して電文ログへ残す
  it('購読していない VXSE43 は読まずに警告する', async () => {
    const { events, logs, send } = setup()
    await send('VXSE43', EEW_XML)
    expect(vi.mocked(buildXmlPayload)).not.toHaveBeenCalled()
    expect(events).toEqual([])
    expect(logs.map(l => l.status)).toEqual(['filtered'])
    expect(warnings().some(w => w.includes('購読していない VXSE43'))).toBe(true)
  })

  // 正: 予報が無く警報だけを受けている人には、VXSE43 が取り込む側の EEW
  it('警報だけを受けている人は VXSE43 を読み、VXSE45 は警告して読まない', async () => {
    const { events, logs, send } = setup(false, 'VXSE43')
    await send('VXSE43', EEW_XML)
    expect(events.map(e => e.kind)).toEqual(['eew'])
    await send('VXSE45', EEW_XML)
    expect(events).toHaveLength(1)
    expect(logs.map(l => l.status)).toEqual(['parsed', 'filtered'])
    expect(warnings().some(w => w.includes('購読していない VXSE45'))).toBe(true)
  })

  // 安全弁: 緊急地震速報を受けていない人は、どちらの EEW も読まない（地震情報などは読む）
  it('緊急地震速報を受けていない人はどちらの EEW も読まない', async () => {
    const { events, logs, send } = setup(false, null)
    await send('VXSE45', EEW_XML)
    await send('VXSE43', EEW_XML)
    expect(events).toEqual([])
    expect(logs.map(l => l.status)).toEqual(['filtered', 'filtered'])
    expect(vi.mocked(buildXmlPayload)).not.toHaveBeenCalled()
  })

  // 安全弁: VXSE44 は想定内なので警告せず、電文ログにだけ残す
  it('VXSE44 は警告せず電文ログにだけ残す', async () => {
    const { events, logs, send } = setup()
    await send('VXSE44', EEW_XML)
    expect(events).toEqual([])
    expect(logs.map(l => l.status)).toEqual(['filtered'])
    expect(warnings()).toEqual([])
  })

  // 正: 本文を復号する種別なのに種別の表に無い（載せ忘れ）なら、debug に依らず警告し電文ログへ残す
  it('種別の表に無い電文は警告して filtered で残す', async () => {
    buildXmlPayloadMock.kindOf = () => undefined
    const { events, logs, send } = setup()
    await send('VXSE53', '<Report/>')
    expect(vi.mocked(buildXmlPayload)).not.toHaveBeenCalled()
    expect(events).toEqual([])
    expect(logs.map(l => [l.status, l.kind])).toEqual([['filtered', undefined]])
    expect(warnings().some(w => w.includes('VXSE53 は種別の表に無いため読みません'))).toBe(true)
  })

  // 安全弁: VXSE42（配信テスト）は通知しない（疎通の確認だけ）。届いたことと本文は電文ログに残す
  // （以前は電文ログにも出さなかった。2026-11-04 ユーザー選択「行を出し本文も読める形に (Recommended)」
  // 「ライブと同じに積む (Recommended)」で、試験報を受ける設定でも行を残す形に覆した）
  it('VXSE42 は通知せず、本文ごと電文ログにだけ積む', async () => {
    const { events, logs, send } = setup(true)
    await send('VXSE42', '<Report/>', true)
    expect(events).toEqual([])
    expect(logs.map(l => [l.status, l.rawBody])).toEqual([['filtered', '<Report/>']])
  })

  // 正: 読まない種類（VXSE56）も、復号した本文ごと「スキップ」の行で積む。画面へは流さない
  it('読まない種類は通知せず、復号した本文ごと電文ログに積む', async () => {
    const { events, logs, send } = setup()
    await send('VXSE56', '<Report><Control><Title>地震の活動状況等に関する情報</Title></Control></Report>')
    expect(vi.mocked(buildXmlPayload)).not.toHaveBeenCalled()
    expect(events).toEqual([])
    expect(logs.map(l => [l.status, l.headType, typeof l.rawBody === 'string' && l.rawBody.includes('地震の活動状況等')]))
      .toEqual([['filtered', 'VXSE56', true]])
  })

  // 安全弁: 読まない種類の試験報も、base64 のままではなく復号した本文で積む
  it('読まない種類の試験報も復号した本文で積む', async () => {
    const { logs, send } = setup()
    await send('VXSE56', '<Report><Control><Title>x</Title><Status>試験</Status></Control></Report>', true)
    expect(logs.map(l => [l.status, l.operationStatus, typeof l.rawBody === 'string' && l.rawBody.startsWith('<Report>')]))
      .toEqual([['filtered', '試験', true]])
  })
})

// 試験報を受け付けない設定のとき、試験報は通知せず電文ログへだけ積む。訓練と試験の印は本文の
// `Control/Status` から読む（配信元の `head.test` はどちらも同じ真）。
describe('受け付けない試験報の電文ログ', () => {
  const withStatus = (status: string) =>
    `<Report><Control><Title>x</Title><Status>${status}</Status></Control><Head><Title>x</Title></Head></Report>`

  // 正: 本文を復号して訓練・試験を読み分ける
  it('本文の名乗りで訓練と試験を分けて積む', async () => {
    const { events, logs, send } = setup(false)
    await send('VXSE53', withStatus('試験'), true)
    await send('VXSE53', withStatus('訓練'), true)
    expect(events).toEqual([])
    expect(logs.map(l => [l.status, l.isTest, l.operationStatus])).toEqual([
      ['filtered', true, '試験'],
      ['filtered', true, '訓練'],
    ])
    expect(vi.mocked(buildXmlPayload)).not.toHaveBeenCalled()
  })

  // 対照: 本文を使わない種別は、通常の経路と同じく復号せずに積む（名乗りは読めない）
  it('本文を使わない種別は復号せず、印は付けない', async () => {
    const { logs, send } = setup(false)
    // 実配信の本文は base64 ＋ gzip。復号しないので、届いたままの文字列が行に残る
    await send('XXXX99', 'H4sIAAAAAAAA', true)
    expect(logs.map(l => [l.status, l.isTest, l.operationStatus, l.rawBody])).toEqual([['filtered', true, undefined, 'H4sIAAAAAAAA']])
  })
})

// 推計震度分布図（IXAC41）の行が、結合した元の二進を持つこと（2026-11-04 ユーザー選択「残して落とせる (Recommended)」）。
// `makeLogEntry` は位置で渡す引数が多く、二進の渡し忘れが型でもほかのテストでも捕まらないので、ここで固定する
describe('推計震度分布図の電文ログ', () => {
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  const sendBinary = (ws: DmdataWebSocket, bytes: Uint8Array, designation: string | null) =>
    (ws as unknown as {
      handleMessage(m: Record<string, unknown>, emit: (ev: DmdataEvent, telegramId: string) => void): Promise<void>
    }).handleMessage({
      type: 'data', id: `id-${designation ?? 'first'}`,
      head: { type: 'IXAC41', test: false, author: 'RJTD', time: '2026-08-10T03:06:00Z', designation },
      body: b64(bytes), encoding: 'base64', format: 'binary',
    }, (ev, telegramId) => ws.onEvent?.(ev, telegramId))

  // 正: 結合して読めた行は元の二進をそのまま持つ。対照: 結合待ちの断片の行は持たない（1 断片が最大 512KB あるため）
  it('結合して読めた行は元の二進を持ち、結合待ちの断片の行は持たない', async () => {
    const bin = buildSampleTelegram()
    const ws = new DmdataWebSocket('valid-key', false)
    const got: TelegramLogEntry[] = []
    ws.onRawMessage = e => { got.push(e) }
    await sendBinary(ws, bin.slice(0, 32), null)
    await sendBinary(ws, bin.slice(32), 'RRA')
    expect(got.map(l => l.status)).toEqual(['filtered', 'parsed'])
    expect('rawBytes' in got[0]).toBe(false)
    expect([...(got[1].rawBytes ?? [])]).toEqual([...bin])
  })

  // 安全弁: 読めなかった二進も、元の電文を落とせるよう二進を持つ
  it('読めなかった二進の行も元の二進を持つ', async () => {
    const junk = buildSampleTelegram({ section4LengthOverride: 0xffffff })
    const ws = new DmdataWebSocket('valid-key', false)
    const got: TelegramLogEntry[] = []
    ws.onRawMessage = e => { got.push(e) }
    await sendBinary(ws, junk, null)
    expect(got.map(l => [l.status, l.errorMessage])).toEqual([['error', 'bufr decode failed']])
    expect([...(got[0].rawBytes ?? [])]).toEqual([...junk])
  })
})
