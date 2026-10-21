// @vitest-environment jsdom
// 電文の読み取りに DOMParser を使うため jsdom 環境で動かす（既定は node）。
//
// 起動時の復元（`fetchDmdataActiveEews`）が、誤報取消の読み上げのために第 1 報の発表時刻を載せることを、
// 一覧 → 詳細 → 電文本体まで通して確かめる。拾い方そのものは `dmdata.test.ts` の `firstEewReportTime`。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { PREFERRED_CLASSIFICATIONS } from './dmdataClassifications'
import { fetchDmdataActiveEews } from './dmdata'
import { log } from '../utils/logger'
import { serverNow } from '../utils/clock'
import { setBodyGateIntervalForTest, resetTelegramBodyStatsForTest } from './telegramBody'
import { setApiGateIntervalForTest, resetApiGateForTest } from './dmdataRequestGates'

vi.mock('../utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogThrottle: () => (emit: () => void) => emit(),
}))

// 門の間隔は 0 にして経路だけを見る（理由は `dmdata.test.ts` の同じ前準備）。
beforeEach(() => {
  setBodyGateIntervalForTest(0)
  resetTelegramBodyStatsForTest()
  setApiGateIntervalForTest(0)
  resetApiGateForTest()
})

describe('fetchDmdataActiveEews の第 1 報の時刻', () => {
  const KEY = 'valid-key'
  const warnings = () => vi.mocked(log.warn).mock.calls.map(c => c.join(' '))
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

  /** 時刻を ISO（+09:00）で書く。発表中と判定される窓の中に収めるため、いまからの相対で作る */
  const jst = (ms: number) => {
    const d = new Date(ms + 9 * 3600_000)
    return `${d.toISOString().slice(0, 19)}+09:00`
  }
  const eewXml = (eventId: string, serial: number, reportTime: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx="http://xml.kishou.go.jp/jmaxml1/">
<Control><Title>緊急地震速報（地震動予報）</Title><Status>通常</Status><EditorialOffice>気象庁</EditorialOffice></Control>
<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
<Title>緊急地震速報（地震動予報）</Title><ReportDateTime>${reportTime}</ReportDateTime>
<EventID>${eventId}</EventID><InfoType>発表</InfoType><Serial>${serial}</Serial></Head>
<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
<Earthquake><OriginTime>${reportTime}</OriginTime><ArrivalTime>${reportTime}</ArrivalTime>
<Hypocenter><Area><Name>茨城県南部</Name><jmx_eb:Coordinate>+36.0+140.1-80000/</jmx_eb:Coordinate></Area></Hypocenter>
<jmx_eb:Magnitude type="Mj">6.4</jmx_eb:Magnitude></Earthquake>
<Intensity><Forecast><ForecastInt><From>5+</From><To>5+</To></ForecastInt></Forecast></Intensity>
</Body></Report>`

  function stub(eventId: string, items: unknown[], body: string): void {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('data.api.dmdata.jp')) return { ok: true, text: async () => body } as unknown as Response
      if (url.includes('/gd/eew/')) return { ok: true, json: async () => ({ items }) } as unknown as Response
      return { ok: true, json: async () => ({ items: [{ eventId, dateTime: new Date(serverNow()).toISOString() }] }) } as unknown as Response
    }))
  }

  // 正: 最新報（第 3 報）を復元しても、第 1 報の時刻を載せる。載せないと取消が第 3 報の時刻を読む
  it('復元する速報に、詳細の第 1 報の時刻を載せる', async () => {
    const now = serverNow()
    const t1 = jst(now - 30_000)
    const t3 = jst(now - 10_000)
    const id = '20261016124000'
    stub(id, [
      { serial: 1, dateTime: t1, isCanceled: false, telegrams: [{ id: 'xml-1', head: { type: 'VXSE45', test: false } }] },
      { serial: 2, dateTime: jst(now - 20_000), isCanceled: false, telegrams: [{ id: 'xml-2', head: { type: 'VXSE45', test: false } }] },
      { serial: 3, dateTime: t3, isCanceled: false, telegrams: [{ id: 'xml-3', head: { type: 'VXSE45', test: false } }] },
    ], eewXml(id, 3, t3))

    const got = await fetchDmdataActiveEews(KEY, PREFERRED_CLASSIFICATIONS)

    expect(got).toHaveLength(1)
    expect(got[0].issue?.serial).toBe('3')
    expect(got[0].firstIssueTime).toBe(t1)
  })

  // 安全弁: 拾えなければ null を載せ、記録を残す。最新報の時刻で代えない
  it('第 1 報の時刻を拾えなければ null を載せて記録する', async () => {
    const now = serverNow()
    const t2 = jst(now - 10_000)
    const id = '20261016124001'
    stub(id, [
      { serial: 2, telegrams: [{ id: 'xml-2', head: { type: 'VXSE45', test: false } }] },
    ], eewXml(id, 2, t2))

    const got = await fetchDmdataActiveEews(KEY, PREFERRED_CLASSIFICATIONS)

    expect(got).toHaveLength(1)
    expect(got[0].firstIssueTime).toBeNull()
    expect(warnings().some(w => w.includes('第 1 報の発表時刻を拾えませんでした'))).toBe(true)
  })

  // 解除済みかは、取り始めた時刻ではなく取り終えた時刻で判定する。一覧と詳細を順に取る間に解除の時刻を過ぎた
  // 最終報を「発表中」として返すと、受け手が終わった速報を戻す
  describe('解除済みかは取り終えた時刻で判定する', () => {
    afterEach(() => { vi.restoreAllMocks() })

    /** 最終報。発生は 10 分前（規模による解除はとうに過ぎている）、発表は `reportAgoMs` 前 —— 解除は発表の 60 秒後 */
    const finalXml = (eventId: string, reportAgoMs: number) => {
      const now = serverNow()
      return eewXml(eventId, 5, jst(now - reportAgoMs))
        .replace(/<OriginTime>[^<]*<\/OriginTime>/, `<OriginTime>${jst(now - 10 * 60_000)}</OriginTime>`)
        .replace('</Body>', '<NextAdvisory>この情報をもって、緊急地震速報：最終報とします。</NextAdvisory></Body>')
    }

    /** 本体を返すときに時計を `advanceMs` 進める（詳細を取る間に時間が経った形） */
    function stubAdvancing(eventId: string, body: string, advanceMs: number): void {
      const realNow = Date.now.bind(Date)
      let shift = 0
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() + shift)
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.includes('data.api.dmdata.jp')) {
          shift += advanceMs
          return { ok: true, text: async () => body } as unknown as Response
        }
        if (url.includes('/gd/eew/')) {
          return { ok: true, json: async () => ({ items: [{ serial: 5, telegrams: [{ id: 'xml-5', head: { type: 'VXSE45', test: false } }] }] }) } as unknown as Response
        }
        return { ok: true, json: async () => ({ items: [{ eventId, dateTime: new Date(serverNow()).toISOString() }] }) } as unknown as Response
      }))
    }

    // 正: 取っている間に解除の時刻を過ぎた最終報は返さない
    it('取っている間に解除の時刻を過ぎた最終報は返さない', async () => {
      const id = '20261021120000'
      stubAdvancing(id, finalXml(id, 58_000), 5_000)
      expect(await fetchDmdataActiveEews(KEY, PREFERRED_CLASSIFICATIONS)).toHaveLength(0)
    })

    // 対照: 取り終えた時点でもまだ解除の時刻前なら返す
    it('取り終えた時点でまだ解除の時刻前なら返す', async () => {
      const id = '20261021120001'
      stubAdvancing(id, finalXml(id, 30_000), 5_000)
      expect(await fetchDmdataActiveEews(KEY, PREFERRED_CLASSIFICATIONS)).toHaveLength(1)
    })
  })
})

