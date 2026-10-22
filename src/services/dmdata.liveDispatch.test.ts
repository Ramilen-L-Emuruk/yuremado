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
  const logs: TelegramLogEntry[] = []
  ws.onEvent = ev => { events.push(ev) }
  ws.onRawMessage = entry => { logs.push(entry) }
  const send = (headType: string, body: string, test = false) =>
    (ws as unknown as { handleMessage(m: Record<string, unknown>): Promise<void> }).handleMessage({
      type: 'data', id: `id-${headType}`, head: { type: headType, test }, body, encoding: 'utf-8', format: 'xml',
    })
  return { events, logs, send }
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

  // 安全弁: VXSE42（配信テスト）は何もしない（疎通の確認だけ）
  it('VXSE42 は通知も電文ログも出さない', async () => {
    const { events, logs, send } = setup()
    await send('VXSE42', '<Report/>')
    expect(events).toEqual([])
    expect(logs).toEqual([])
  })
})
