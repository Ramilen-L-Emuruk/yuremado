// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { dmdataKeyEndpoint, DMDATA_API_BASE, DMDATA_DATA_BASE, type DmdataEndpoint } from './dmdataEndpoint'
import { DmdataApiKeyError } from '../utils/dmdataApiKey'
import { fetchDmdataGdEarthquakes, fetchDmdataEewEventList, fetchLatestEewReport } from './dmdata'
import { fetchDmdataReplayEvents } from './dmdataReplay'
import { fetchLiveReplayEntries } from './dmdataReplayLive'
import { PREFERRED_CLASSIFICATIONS } from './dmdataClassifications'
import { fetchTelegramText, setBodyGateIntervalForTest, resetTelegramBodyStatsForTest } from './telegramBody'
import { resetDataApiGateForTest } from './dmdataRequestGates'

/** 偽の繋ぎ先。宛先も見出しも DMDATA と違う値にして、呼び出し側がこの値だけを見ていることを確かめる */
const FAKE: DmdataEndpoint = {
  apiBase: 'https://relay.example.test/v2',
  dataBase: 'https://data.example.test/v1/',
  problem: () => null,
  apiHeaders: () => ({ 'X-Relay-Token': 'api-tag' }),
  dataHeaders: () => ({ 'X-Relay-Token': 'data-tag' }),
}

describe('dmdataKeyEndpoint', () => {
  it('DMDATA の宛先と、鍵の Basic 認証を返す', () => {
    const ep = dmdataKeyEndpoint('abc')
    expect(ep.apiBase).toBe(DMDATA_API_BASE)
    expect(ep.dataBase).toBe(DMDATA_DATA_BASE)
    expect(ep.problem()).toBeNull()
    expect(ep.apiHeaders()).toEqual({ Authorization: 'Basic ' + btoa('abc:') })
    expect(ep.dataHeaders()).toEqual({ Authorization: 'Basic ' + btoa('abc:') })
  })

  it('鍵が空なら作る時点では投げず、見出しを求めた時点で投げる', () => {
    const ep = dmdataKeyEndpoint('')
    expect(ep.problem()).not.toBeNull()
    expect(() => ep.apiHeaders()).toThrow(DmdataApiKeyError)
    expect(() => ep.dataHeaders()).toThrow(DmdataApiKeyError)
  })
})

describe('呼び出し側は渡された繋ぎ先だけを使う', () => {
  let calls: { url: string; headers: Record<string, string> }[]

  beforeEach(() => {
    calls = []
    setBodyGateIntervalForTest(0)
    resetDataApiGateForTest()
    resetTelegramBodyStatsForTest()
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } })
      if (String(url).startsWith(FAKE.dataBase)) return new Response('<Report/>', { status: 200 })
      return new Response(JSON.stringify({ status: 'ok', items: [] }), { status: 200 })
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('一覧（/gd/earthquake）は apiBase と apiHeaders で投げる', async () => {
    await fetchDmdataGdEarthquakes(FAKE, 1)
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(c.url.startsWith(`${FAKE.apiBase}/gd/earthquake`)).toBe(true)
      expect(c.headers).toEqual({ 'X-Relay-Token': 'api-tag' })
    }
  })

  it('緊急地震速報の一覧（/gd/eew）も apiBase と apiHeaders で投げる', async () => {
    await fetchDmdataEewEventList(FAKE, Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2))
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(c.url.startsWith(`${FAKE.apiBase}/gd/eew`)).toBe(true)
      expect(c.headers).toEqual({ 'X-Relay-Token': 'api-tag' })
    }
  })

  it('電文本体は dataHeaders で投げる（apiHeaders は付けない）', async () => {
    await fetchTelegramText(FAKE, `${FAKE.dataBase}endpoint-test-id-0001`)
    expect(calls).toEqual([
      { url: `${FAKE.dataBase}endpoint-test-id-0001`, headers: { 'X-Relay-Token': 'data-tag' } },
    ])
  })

  it('緊急地震速報の詳細は apiBase、そこから辿る電文本体は dataBase で投げる', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } })
      if (String(url).startsWith(FAKE.dataBase)) return new Response('<Report/>', { status: 200 })
      return new Response(JSON.stringify({
        status: 'ok',
        items: [{ serial: 1, telegrams: [{ head: { type: 'VXSE45' }, id: 'endpoint-eew-body-0001' }] }],
      }), { status: 200 })
    }))
    await fetchLatestEewReport(FAKE, 'ev-0001', 'VXSE45', false, false)
    expect(calls).toEqual([
      { url: `${FAKE.apiBase}/gd/eew/ev-0001`, headers: { 'X-Relay-Token': 'api-tag' } },
      { url: `${FAKE.dataBase}endpoint-eew-body-0001`, headers: { 'X-Relay-Token': 'data-tag' } },
    ])
  })

  it('リプレイのアーカイブ目録も apiBase と apiHeaders で投げる', async () => {
    await fetchDmdataReplayEvents(
      FAKE, new Date('2024-01-01T07:00:00Z'), new Date('2024-01-01T08:00:00Z'), false, PREFERRED_CLASSIFICATIONS, null,
    )
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(c.url.startsWith(`${FAKE.apiBase}/`)).toBe(true)
      expect(c.headers).toEqual({ 'X-Relay-Token': 'api-tag' })
    }
  })

  it('当日経路の一覧（/telegram・/gd/eew）も apiBase と apiHeaders で投げる', async () => {
    const day = '2024-01-01'
    await fetchLiveReplayEntries(
      FAKE, new Date('2024-01-01T07:00:00Z'), new Date('2024-01-01T08:00:00Z'), [day], false, PREFERRED_CLASSIFICATIONS, null,
    )
    const paths = calls.map(c => c.url.slice(FAKE.apiBase.length).split('?')[0])
    expect(paths).toEqual(expect.arrayContaining(['/telegram', '/gd/eew']))
    for (const c of calls) {
      expect(c.url.startsWith(`${FAKE.apiBase}/`)).toBe(true)
      expect(c.headers).toEqual({ 'X-Relay-Token': 'api-tag' })
    }
  })

  it('繋げない値なら一覧を 1 件も投げない', async () => {
    const blocked: DmdataEndpoint = { ...FAKE, problem: () => 'missing' }
    await fetchDmdataEewEventList(blocked, Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2))
    expect(calls).toEqual([])
  })
})
