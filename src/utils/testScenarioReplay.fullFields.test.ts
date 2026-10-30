// 収録シナリオの時刻シフト（`instantiateScenario`）が、電文の時刻を 1 つも取りこぼさないことを確かめる。
//
// **欄を 1 つずつ書き並べたテストでは、新しく足した欄の漏れを捕まえられない。** シフトの実装も
// 欄を 1 つずつ書き並べる形なので、欄を足したときに両方へ書き忘れると、テストも通ったまま
// その時刻だけが収録当時の絶対値で画面に出る（`observationDateTime`・`cancelledAreas` が実際にそうだった）。
//
// そこで見本を **全部の欄を埋めた形**（`DeepRequired`）で書く。型の欄が増えれば見本が型エラーに
// なって埋めることを強いられ、埋めた時刻がシフトされなければ下の照合で落ちる。
import { describe, it, expect } from 'vitest'
import { instantiateScenario } from './testScenarioReplay'
import type { TestScenarioFile } from '../types/testScenario'
import type { ReplayPayload } from '../types/replay'
import { wepa60Id } from '../services/wepa60Parser'
import type {
  AppEvent, EEWAlert, JMAEarthquakeCount, JMAEstimatedIntensity, JMAInternationalTsunami, JMAKohatsu, JMALpgm, JMANankai,
  JMANankaiCommentary, JMAQuake, JMAQuakeNotice, JMATsunami,
} from '../types/earthquake'

/**
 * 省略できる欄・`null` を取る欄を、すべて値ありの欄にした型。
 * 型付き配列と `Date` は中を辿らない（時刻の文字列を持たない）。
 */
type DeepRequired<T> =
  T extends Date | Float32Array | Uint8Array ? T
    : T extends readonly (infer U)[] ? DeepRequired<U>[]
      : T extends object ? { [K in keyof T]-?: DeepRequired<NonNullable<T[K]>> }
        : T

/**
 * **電文には現れず、受信処理・カードの統合が後から付ける欄**は見本から外す。収録シナリオは
 * 電文をパーサーへ通した結果を記録したもので、これらは持たない（`capture-test-scenario.ts`）。
 * ここへ足すときは、電文から読む欄でないことを確かめてから足すこと。
 */
type QuakeSample = DeepRequired<Omit<JMAQuake,
  | 'cancelledAt' // 取消を当てたときに受信処理が付ける（Date）
  | 'eventKey' | 'reports' | 'sourceTelegrams' | 'retractedReports' // カードの統合が積む
  | 'intensityFromCache' // 震度の控えから補ったときの印
  | 'hypocenterSource' | 'domesticTsunamiSource' // 津波電文から借りたときの印
>>
type TsunamiSample = DeepRequired<Omit<JMATsunami,
  | 'cancelledAt' // 解除を当てたときに受信処理が付ける（Date）
  | 'foldedReports' // 報を畳んだときに統合が積む
  | 'previousSourceEarthquakes' // 別の地震の津波で置き換えたときに統合が積む（時刻は積む前の報で既にずれている）
  | 'failsafeExpiry' // 標準版の安全弁の予約にだけ付く印（電文には無い）
>>
type EewSample = DeepRequired<Omit<EEWAlert, 'cancelledAt'>>

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

/** 見本の時刻。**欄ごとに別の値**にして、どの欄が残ったかを照合の失敗から辿れるようにする。 */
let isoSeq = 0
function iso(): string {
  isoSeq++
  return new Date(Date.parse('2024-01-01T07:00:00Z') + isoSeq * 1000).toISOString()
}

const EVENT_ID = '20240101070900'

const hypocenterDetail = () => ({
  code: '390', detailedCode: '3900', latitude: 37.5, longitude: 137.2, depth: 10, depthAtLeast: true,
  nameFromMark: '輪島の東北東３０ｋｍ付近', markCode: '201', direction: '東北東', distanceKm: 30,
})

function quakeSample(): QuakeSample {
  const t = iso()
  return {
    kind: 'quake',
    id: `dmdata-quake-${EVENT_ID}-1`,
    eventId: EVENT_ID,
    time: t,
    reportsRevise: true,
    cancelled: false,
    cancelText: '取消',
    issue: { source: '気象庁', editorialOffice: '気象庁本庁', publishingOffice: '気象庁', time: iso(), type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: iso(),
      hypocenter: {
        name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10, depthAtLeast: true, magnitude: 7.6,
        magnitudeCondition: 'Ｍ不明', magnitudeType: 'Mj', code: '390', detailedCode: '3900',
        nameFromMark: '輪島の東北東３０ｋｍ付近', markCode: '201', direction: '東北東', distanceKm: 30, source: '気象庁',
      },
      maxScale: 70,
      domesticTsunami: '警報等',
      domesticTsunamiCode: '0211',
    },
    operationStatus: '訓練',
    points: [{
      pref: '石川県', addr: '輪島市門前町走出', isArea: false, scale: 70, unreceived: true, revise: '追加',
      nonJma: true, code: '1720000', city: '輪島市', area: '石川県能登',
    }],
    cities: [{
      name: '輪島市', area: '石川県能登', pref: '石川県', scale: 70, unreceived: true, hasUnreceived: true,
      code: '1720400', revise: '追加',
    }],
    forecastText: '津波警報等を発表中です。',
    varCommentText: '＊印は気象庁以外の震度観測点についての情報です。',
    varCommentCodes: ['0262'],
    freeText: '自由付加文',
    foreignTsunamiText: '日本以外の津波',
    headline: '見出し',
    telegramKey: '震源・震度に関する情報|key',
    createdAtMs: Date.parse('2024-01-01T07:00:00Z'),
    reportSerial: 1,
  }
}

function tsunamiArea(): TsunamiSample['areas'][number] {
  return {
    grade: 'MajorWarning', kindName: '大津波警報', lastKindName: '津波警報', lastGrade: 'Warning', immediate: true, name: '能登', code: '191',
    firstHeight: { arrivalTime: iso(), condition: 'ただちに津波来襲と予測', revise: '追加' },
    maxHeight: { description: '５ｍ', value: 5, revise: '更新' },
    forecastHeightImportant: true,
    stations: [{
      name: '輪島港', code: '19101', highTideDateTime: iso(), arrivalTime: iso(),
      arrivalCondition: '第１波の到達を確認', revise: '追加',
    }],
  }
}

function tsunamiSample(): TsunamiSample {
  return {
    kind: 'tsunami',
    id: `dmdata-tsunami-VTSE41-${EVENT_ID}-1`,
    eventId: EVENT_ID,
    time: iso(),
    createdAtMs: Date.parse('2024-01-01T07:00:00Z'),
    headType: 'VTSE41',
    operationStatus: '訓練',
    cancelled: false,
    cancelReason: 'lifted',
    cancelText: '取消',
    liftText: '解除',
    headline: '見出し',
    warningComments: [{ key: '0111', text: '津波警報を発表しました。' }],
    carriesForecastStations: true,
    bodyText: '本文',
    freeText: '自由付加文',
    sourceEarthquakes: [{
      ...hypocenterDetail(),
      hypocenterName: '石川県能登地方', magnitude: 7.6, magnitudeType: 'Mj', magnitudeCondition: 'Ｍ不明',
      originTime: iso(), arrivalTime: iso(), source: '気象庁',
    }],
    validDateTime: iso(),
    issue: { source: '気象庁', editorialOffice: '気象庁本庁', publishingOffice: '気象庁', time: iso(), type: 'Focus' },
    infoName: '津波警報・注意報・予報',
    areas: [tsunamiArea()],
    cancelledAreas: [tsunamiArea()],
    observations: [{
      name: '輪島港', height: { value: 1.2, description: '１．２ｍ', over: true },
      condition: { firstWaveUnidentifiable: true, firstHeightMissing: true, maxHeightMissing: true, weak: true, observing: true, important: true, rising: true },
      arrivalTime: iso(), initial: '押し波', offshore: true, code: '19101', sensor: '検潮所',
      maxHeightRevise: '更新', firstHeightRevise: '追加', maxHeightDateTime: iso(),
      districtCode: '191', districtName: '能登',
    }],
    observationDateTime: iso(),
    estimations: [{
      name: '能登', code: '191', arrivalTime: iso(), arrivalCondition: '早いところでは既に津波到達と推定',
      maxHeight: { description: '３ｍ', value: 3 },
      condition: { estimating: true, important: true },
      maxHeightDateTime: iso(), firstHeightRevise: '追加', maxHeightRevise: '更新',
    }],
  }
}

function eewRegion(): EewSample['areas'][number] {
  return {
    pref: '石川県', name: '石川県能登', scaleFrom: 60, scaleTo: 70, scaleToOrAbove: true, kindCode: '11',
    arrivalTime: iso(), arrived: true, lgIntTo: 4, lgIntToOver: true, lgIntBelowClass1: true,
  }
}

function eewSample(): EewSample {
  return {
    headline: '見出し',
    warningRegions: ['北陸', '甲信'],
    addedWarningRegions: ['甲信'],
    infoName: '緊急地震速報（警報）',
    cancelText: '取消',
    strongShakingOnly: true,
    strongShakingText: '強い揺れ',
    kind: 'eew',
    origin: 'dmdata',
    id: `dmdata-eew-${EVENT_ID}-1`,
    time: iso(),
    test: false,
    earthquake: {
      originTime: iso(),
      arrivalTime: iso(),
      condition: '仮定震源要素',
      hypocenter: {
        name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10, depthAtLeast: true, magnitude: 7.6,
        magnitudeCondition: 'Ｍ不明', magnitudeType: 'Mj', code: '390', detailedCode: '3900',
        nameFromMark: '輪島の東北東３０ｋｍ付近', markCode: '201', direction: '東北東', distanceKm: 30, source: '気象庁',
      },
    },
    severity: 'Warning',
    cancelled: false,
    expired: false,
    isFinal: true,
    everSpecialWarning: true,
    firstIssueTime: iso(),
    issue: { eventId: EVENT_ID, serial: '1', time: iso() },
    areas: [eewRegion()],
    regions: [eewRegion()],
    forecastMaxScale: 70,
    forecastMaxScaleOrAbove: true,
    maxScaleFromForecast: true,
    forecastMaxLpgmClass: 4,
    forecastMaxLpgmClassOver: true,
    forecastMaxScaleBelow1: true,
    forecastMaxLpgmBelowClass1: true,
    warningComment: '強い揺れに警戒',
    operationStatus: '訓練',
    accuracy: { epicenterRank: 1, epicenterRank2: 1, depthRank: 1, magnitudeRank: 1, magnitudePoints: 1 },
    landOrSea: '内陸',
    reduceName: '石川県能登地方',
    reduceCode: '390',
    forecastChange: { maxInt: 1, maxLgInt: 1, reason: 1 },
  }
}

function lpgmSample(): DeepRequired<JMALpgm> {
  return {
    id: `dmdata-lpgm-${EVENT_ID}-1`,
    eventId: EVENT_ID,
    time: iso(),
    createdAtMs: Date.parse('2024-01-01T07:00:00Z'),
    reportsRevise: true,
    operationStatus: '訓練',
    infoName: '長周期地震動に関する観測情報',
    originTime: iso(),
    maxClass: 4,
    cancelled: false,
    cancelText: '取消',
    points: [{
      code: '1720000', name: '輪島市門前町走出', pref: '石川県', area: '石川県能登', lgInt: 4, int: 70, sva: 100,
      periods: [{ band: 1, lgInt: 4, sva: 100 }], nonJma: true,
    }],
    regions: [{ code: '390', name: '石川県能登', maxLgInt: 4, pref: '石川県', maxInt: 70, revise: '追加' }],
    prefs: [{ code: '17', name: '石川県', maxLgInt: 4, maxInt: 70, revise: '追加' }],
    maxInt: 70,
    magnitude: 7.6,
    magnitudeCondition: 'Ｍ不明',
    magnitudeType: 'Mj',
    arrivalTime: iso(),
    hypocenter: { ...hypocenterDetail(), name: '石川県能登地方', source: '気象庁' },
    forecastText: '津波',
    forecastCodes: ['0215'],
    varCommentText: '＊印',
    varCommentCodes: ['0263'],
    freeFormText: '自由付加文',
    uri: 'https://www.data.jma.go.jp/',
    headline: '見出し',
    category: 1,
  }
}

const infoMeta = () => ({
  summary: '要約', nextAdvisory: '次回', appendix: '参考', earthquakeInfoKind: '種類', earthquakeInfoType: '型',
})

function nankaiSample(): DeepRequired<JMANankai> {
  return {
    ...infoMeta(),
    id: `nankai-${EVENT_ID}`, time: iso(), eventId: EVENT_ID, operationStatus: '訓練',
    kindCode: '120', kindName: '巨大地震注意', headline: '見出し', body: '本文',
    cancelled: false, retracted: true, reportDateTime: iso(),
  }
}

function commentarySample(): DeepRequired<JMANankaiCommentary> {
  return {
    ...infoMeta(),
    id: `commentary-${EVENT_ID}`, time: iso(), eventId: EVENT_ID, operationStatus: '訓練',
    serialCode: '1', serialName: '臨時解説', headline: '見出し', body: '本文',
    cancelled: false, reportDateTime: iso(), expireAt: iso(),
  }
}

function kohatsuSample(): DeepRequired<JMAKohatsu> {
  return {
    ...infoMeta(),
    id: `kohatsu-${EVENT_ID}`, time: iso(), eventId: EVENT_ID, operationStatus: '訓練',
    headline: '見出し', body: '本文', cancelled: false, retracted: true, reportDateTime: iso(), expireAt: iso(),
  }
}

function noticeSample(): DeepRequired<JMAQuakeNotice> {
  return {
    id: `notice-${EVENT_ID}`, time: iso(), eventId: EVENT_ID, operationStatus: '訓練',
    headline: '見出し', body: '本文', freeText: '自由付加文', cancelled: false, reportDateTime: iso(), expireAt: iso(),
  }
}

function countSample(): DeepRequired<JMAEarthquakeCount> {
  return {
    id: `count-${EVENT_ID}`, time: iso(), eventId: EVENT_ID, operationStatus: '訓練',
    headline: '見出し',
    items: [{ type: '1時間', startTime: iso(), endTime: iso(), number: 3, feltNumber: 1 }],
    body: '本文', nextAdvisory: '次回', freeText: '自由付加文',
    cancelled: false, cancelText: '取消', reportDateTime: iso(), expireAt: iso(),
  }
}

function estimatedSample(): DeepRequired<JMAEstimatedIntensity> {
  return {
    id: 'estimated-1', time: iso(), arrivalTime: iso(),
    hypocenter: { lat: 37.5, lon: 137.2, depthKm: 10 },
    magnitude: 7.6, magnitudeCondition: 'Ｍ不明', areaCode: 390, telegramKind: 1,
    mark: { pointCode: 201, directionDeg: 67.5, distanceKm: 30 },
    grades: [{ scale: 5, modifier: 'weak', lower: 4.5, upper: 5.0 }],
    count: 1,
    lat: new Float32Array([37.5]), lon: new Float32Array([137.2]), si: new Uint8Array([1]),
    cellLatDeg: 0.01, cellLonDeg: 0.01,
    bounds: { south: 37, north: 38, west: 137, east: 138 },
  }
}

function internationalTsunamiSample(): DeepRequired<JMAInternationalTsunami> {
  const time = iso()
  return {
    id: wepa60Id(time, 'TSUNAMI BULLETIN NUMBER 001', 'WEPA60 RJTD 250003'), title: 'TSUNAMI BULLETIN NUMBER 001',
    time, originTime: iso(), isCommunicationsTest: false, text: 'WEPA60 RJTD 250003',
  }
}

/**
 * 見本の一覧。**種別ごとの表にしておき、種別が増えたら型エラーで見本を足させる**
 * （`satisfies` が `ReplayPayload['kind']` と `AppEvent['kind']` の全種別を要求する）。
 */
function allPayloads(): ReplayPayload[] {
  const events = {
    quake: quakeSample(),
    tsunami: tsunamiSample(),
    eew: eewSample(),
  } satisfies Record<AppEvent['kind'], unknown>
  const payloads = {
    event: Object.values(events).map((event): ReplayPayload => ({ kind: 'event', event: event as AppEvent })),
    lpgm: [{ kind: 'lpgm', data: lpgmSample() }],
    nankai: [{ kind: 'nankai', data: nankaiSample() }],
    nankaiCommentary: [{ kind: 'nankaiCommentary', data: commentarySample() }],
    kohatsu: [{ kind: 'kohatsu', data: kohatsuSample() }],
    quakeNotice: [{ kind: 'quakeNotice', data: noticeSample() }],
    earthquakeCount: [{ kind: 'earthquakeCount', data: countSample() }],
    estimatedIntensity: [{ kind: 'estimatedIntensity', data: estimatedSample() }],
    internationalTsunami: [{ kind: 'internationalTsunami', data: internationalTsunamiSample() }],
  } satisfies Record<ReplayPayload['kind'], ReplayPayload[]>
  return Object.values(payloads).flat()
}

/** 値の中の文字列を、どこにあったか（パス）付きで全部拾う。 */
function collectStrings(value: unknown, path: string, out: { path: string; value: string }[]): void {
  if (typeof value === 'string') { out.push({ path, value }); return }
  if (Array.isArray(value)) { value.forEach((v, i) => collectStrings(v, `${path}[${i}]`, out)); return }
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) collectStrings(v, `${path}.${k}`, out)
  }
}

describe('instantiateScenario は電文の時刻を 1 つも取りこぼさない', () => {
  const NOW = new Date('2026-10-21T00:00:00Z')

  it('全部の欄を埋めた見本を通すと、元の時刻は 1 つも残らない', () => {
    const payloads = allPayloads()
    const scenario: TestScenarioFile = {
      id: 'full', label: '全部の欄', description: '', category: 'quake', durationMs: 0,
      baseTime: '2024-01-01T07:00:00Z',
      entries: payloads.map(payload => ({ offsetMs: 0, payload })),
    }

    const originals: { path: string; value: string }[] = []
    payloads.forEach((p, i) => collectStrings(p, `entries[${i}]`, originals))
    const originalTimes = new Set(originals.filter(s => ISO_RE.test(s.value)).map(s => s.value))
    // 見本が時刻を持っていること自体を確かめる（拾えていなければ照合が空振りする）。
    // 下限だけを見る（書いた時点で 47 個。欄が増えれば増える）
    expect(originalTimes.size).toBeGreaterThanOrEqual(40)

    const shifted: { path: string; value: string }[] = []
    instantiateScenario(scenario, NOW).forEach((e, i) => collectStrings(e.payload, `entries[${i}]`, shifted))

    const left = shifted.filter(s => originalTimes.has(s.value)).map(s => s.path)
    expect(left).toEqual([])
  })

  it('作成時刻（createdAtMs）もずらす', () => {
    const payloads = allPayloads()
    const scenario: TestScenarioFile = {
      id: 'full', label: '全部の欄', description: '', category: 'quake', durationMs: 0,
      baseTime: '2024-01-01T07:00:00Z',
      entries: payloads.map(payload => ({ offsetMs: 0, payload })),
    }
    const delta = NOW.getTime() - Date.parse(scenario.baseTime)
    const createdOf = (p: ReplayPayload): number | undefined =>
      p.kind === 'event' ? (p.event.kind === 'eew' ? undefined : p.event.createdAtMs)
        : p.kind === 'lpgm' ? p.data.createdAtMs : undefined
    const result = instantiateScenario(scenario, NOW)
    let checked = 0
    payloads.forEach((p, i) => {
      const before = createdOf(p)
      if (before === undefined) return
      expect(createdOf(result[i].payload)).toBe(before + delta)
      checked++
    })
    expect(checked).toBe(3) // 地震情報・津波・長周期
  })
})
