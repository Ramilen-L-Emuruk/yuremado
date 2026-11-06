import { describe, expect, test } from 'vitest'
import {
  CATALOG_MAX_DISTANCE_KM,
  catalogYearsFor,
  earliestOriginMs,
  findCatalogOriginMs,
  jstWallClockToIso,
  parseJstTimeMs,
  resolveOriginSeconds,
  telegramOriginMinuteMs,
  usableEewOrigin,
  withinOriginMinute,
  withinQuakeMinute,
  type CatalogColumns,
} from './quakeOriginSeconds'

/**
 * 2026-10-25 小笠原諸島西方沖 M7.0（深さ約 500 km）。実電文と震源リストの値。
 * カードの時刻（地震発現）は 11:10、電文の地震発生時刻は 11:09、本当の発生は 11:09:21（緊急地震速報の最終報）・
 * 11:09:22.00（震源リスト）。発現の分の幅（11:09:30〜）からは外れる。
 */
const OGASAWARA = {
  arrivalMs: Date.parse('2026-10-25T11:10:00+09:00'),
  originMinuteMs: Date.parse('2026-10-25T11:09:00+09:00'),
  eewMs: Date.parse('2026-10-25T11:09:21+09:00'),
  catalogMs: Date.parse('2026-10-25T11:09:22.00+09:00'),
  latitude: 28.0,
  longitude: 139.9,
  magnitude: 7.0,
} as const

describe('発生時刻の分で探す（深い地震・遠い地震）', () => {
  // 正: 発現の分からは外れる発生時刻を、電文の発生時刻の分で拾う
  test('緊急地震速報の発生時刻を、電文の発生時刻の分で使う', () => {
    expect(withinQuakeMinute(OGASAWARA.arrivalMs, OGASAWARA.eewMs)).toBe(false)
    expect(usableEewOrigin(OGASAWARA.arrivalMs, OGASAWARA.originMinuteMs, { originMs: OGASAWARA.eewMs, assumed: false })).toBe(OGASAWARA.eewMs)
  })

  test('震源リストの発生時刻を、電文の発生時刻の分で引く', () => {
    const y = catalog([{ t: OGASAWARA.catalogMs, lat: 27.778, lng: 139.928, m: 6.8 }])
    const q = { timeMs: OGASAWARA.arrivalMs, originMinuteMs: OGASAWARA.originMinuteMs, latitude: OGASAWARA.latitude, longitude: OGASAWARA.longitude, magnitude: OGASAWARA.magnitude }
    expect(findCatalogOriginMs(q, [y], OGASAWARA.arrivalMs + 86400_000)).toBe(OGASAWARA.catalogMs)
    // 対照: 電文の発生時刻が無ければ（震度速報の形）発現の分でしか探せず、引けない
    expect(findCatalogOriginMs({ ...q, originMinuteMs: null }, [y], OGASAWARA.arrivalMs + 86400_000)).toBeNull()
  })

  // 境界: 分の頭の 5 秒前〜1 分 5 秒後（両端を含む）
  test('電文の発生時刻の分の幅は、分の頭の 5 秒前〜1 分 5 秒後', () => {
    const m = OGASAWARA.originMinuteMs
    expect(withinOriginMinute(m, m - 5_000)).toBe(true)
    expect(withinOriginMinute(m, m + 65_000)).toBe(true)
    expect(withinOriginMinute(m, m - 5_001)).toBe(false)
    expect(withinOriginMinute(m, m + 65_001)).toBe(false)
    expect(withinOriginMinute(null, m)).toBe(false)
  })

  // 安全弁: 発生時刻の分で決まらなければ、今までの発現の分の幅で引く（今まで決まっていた地震を手放さない）
  test('発生時刻の分で 2 つ以上合っても、発現の分の幅で 1 つに決まればそれを採る', () => {
    const arrival = Date.parse('2026-10-03T13:27:00+09:00')
    const originMinute = Date.parse('2026-10-03T13:26:00+09:00')
    // 13:26:05 は発生時刻の分の幅にだけ入り、13:26:40 は両方の幅に入る
    const y = catalog([
      { t: Date.parse('2026-10-03T13:26:05+09:00'), lat: 32.5, lng: 130.5, m: 3.5 },
      { t: Date.parse('2026-10-03T13:26:40+09:00'), lat: 32.5, lng: 130.5, m: 3.5 },
    ])
    const q = { timeMs: arrival, originMinuteMs: originMinute, latitude: 32.5, longitude: 130.5, magnitude: 3.5 }
    expect(findCatalogOriginMs(q, [y], arrival + 86400_000)).toBe(Date.parse('2026-10-03T13:26:40+09:00'))
  })

  test('発生時刻の分の幅に 1 つ・発現の分の幅に 2 つなら、発生時刻の分の 1 つを採る', () => {
    const arrival = Date.parse('2026-10-03T13:27:00+09:00')
    const originMinute = Date.parse('2026-10-03T13:26:00+09:00')
    const y = catalog([
      { t: Date.parse('2026-10-03T13:26:50+09:00'), lat: 32.5, lng: 130.5, m: 3.5 },
      { t: Date.parse('2026-10-03T13:27:30+09:00'), lat: 32.5, lng: 130.5, m: 3.5 },
    ])
    const q = { timeMs: arrival, originMinuteMs: originMinute, latitude: 32.5, longitude: 130.5, magnitude: 3.5 }
    expect(findCatalogOriginMs(q, [y], arrival + 86400_000)).toBe(Date.parse('2026-10-03T13:26:50+09:00'))
  })

  test('本当の発生が入りうる最も早い時刻は、2 つの幅の始まりの早いほう', () => {
    expect(earliestOriginMs(OGASAWARA.arrivalMs, OGASAWARA.originMinuteMs)).toBe(OGASAWARA.originMinuteMs - 5_000)
    expect(earliestOriginMs(OGASAWARA.arrivalMs, null)).toBe(OGASAWARA.arrivalMs - 30_000)
    // 同じ分なら発現の分の 30 秒前のほうが早い
    expect(earliestOriginMs(OGASAWARA.originMinuteMs, OGASAWARA.originMinuteMs)).toBe(OGASAWARA.originMinuteMs - 30_000)
    expect(earliestOriginMs(Number.NaN, null)).toBeNaN()
  })

  test('年の境目は、電文の発生時刻の分の幅の年も数える', () => {
    // 発現は 1/1 00:01、発生時刻は 12/31 23:59（発現の分の幅は 00:00:30〜で 2026 年だけ）
    expect(catalogYearsFor(Date.parse('2026-01-01T00:01:00+09:00'), Date.parse('2025-12-31T23:59:00+09:00'))).toEqual([2025, 2026])
  })

  test('カードの電文の地震発生時刻を読む（持たなければ null）', () => {
    expect(telegramOriginMinuteMs({ earthquake: { originTime: '2026-10-25T11:09:00+09:00' } } as never)).toBe(OGASAWARA.originMinuteMs)
    expect(telegramOriginMinuteMs({ earthquake: {} } as never)).toBeNull()
    expect(telegramOriginMinuteMs({ earthquake: { originTime: 'こわれた時刻' } } as never)).toBeNull()
  })
})

/** 地震情報の発生時刻（分まで）。 */
const QUAKE_MS = Date.parse('2026-10-03T13:26:00+09:00')
const EEW_MS = Date.parse('2026-10-03T13:26:01+09:00')
const CATALOG_MS = Date.parse('2026-10-03T13:26:00.85+09:00')

describe('withinQuakeMinute', () => {
  // 正・対照・安全弁: 分の頭の 30 秒前〜65 秒後だけを同じ地震の発生時刻として認める。
  // 前を 30 秒取るのは、カードの時刻が発生ではなく地震発現（最初に揺れを捉えた時刻）の分だから。
  test('分の頭の 30 秒前〜65 秒後なら入る（両端を含む）', () => {
    expect(withinQuakeMinute(QUAKE_MS, QUAKE_MS - 30_000)).toBe(true)
    expect(withinQuakeMinute(QUAKE_MS, QUAKE_MS + 65_000)).toBe(true)
  })

  test('その外は入らない', () => {
    expect(withinQuakeMinute(QUAKE_MS, QUAKE_MS - 30_001)).toBe(false)
    expect(withinQuakeMinute(QUAKE_MS, QUAKE_MS + 65_001)).toBe(false)
  })

  test('地震情報の時刻に秒が残っていても分の頭で測る', () => {
    expect(withinQuakeMinute(QUAKE_MS + 30_000, QUAKE_MS - 4_000)).toBe(true)
  })

  test('有限でない値は入らない', () => {
    expect(withinQuakeMinute(Number.NaN, EEW_MS)).toBe(false)
    expect(withinQuakeMinute(QUAKE_MS, Number.NaN)).toBe(false)
  })
})

describe('usableEewOrigin', () => {
  test('震源の決まった報・見分けられない報の発生時刻は使う', () => {
    expect(usableEewOrigin(QUAKE_MS, null, { originMs: EEW_MS, assumed: false })).toBe(EEW_MS)
    expect(usableEewOrigin(QUAKE_MS, null, { originMs: EEW_MS, assumed: null })).toBe(EEW_MS)
  })

  // 2026-10-15 ユーザー承認「仮定震源の報は使わない」。
  test('仮定震源要素の報の発生時刻は使わない', () => {
    expect(usableEewOrigin(QUAKE_MS, null, { originMs: EEW_MS, assumed: true })).toBeNull()
  })

  // 電文解説資料の出現例４: 同じ地震 ID の中身が別の地震で食い違うことがある。
  test('地震情報の分に入らない緊急地震速報は結ばない', () => {
    expect(usableEewOrigin(QUAKE_MS, null, { originMs: QUAKE_MS + 120_000, assumed: false })).toBeNull()
  })

  test('記録が無ければ null', () => {
    expect(usableEewOrigin(QUAKE_MS, null, undefined)).toBeNull()
  })
})

describe('resolveOriginSeconds', () => {
  test('緊急地震速報の発生時刻があればそれを採る（カタログより先）', () => {
    expect(resolveOriginSeconds({
      quakeTimeMs: QUAKE_MS, originMinuteMs: null, eew: { originMs: EEW_MS, assumed: false }, catalogOriginMs: CATALOG_MS,
    })).toEqual({ originMs: EEW_MS, source: 'eew' })
  })

  test('使えない緊急地震速報ならカタログを採る', () => {
    expect(resolveOriginSeconds({
      quakeTimeMs: QUAKE_MS, originMinuteMs: null, eew: { originMs: EEW_MS, assumed: true }, catalogOriginMs: CATALOG_MS,
    })).toEqual({ originMs: CATALOG_MS, source: 'catalog' })
  })

  // 2026-10-15 ユーザー承認「カタログが届くまで線を引かない」。地震 ID の時刻へは落とさない。
  test('どちらも無ければ秒は無い', () => {
    expect(resolveOriginSeconds({ quakeTimeMs: QUAKE_MS, originMinuteMs: null, eew: undefined, catalogOriginMs: null })).toBeNull()
    expect(resolveOriginSeconds({
      quakeTimeMs: QUAKE_MS, originMinuteMs: null, eew: { originMs: EEW_MS, assumed: true }, catalogOriginMs: null,
    })).toBeNull()
  })

  test('有限でないカタログの値は採らない', () => {
    expect(resolveOriginSeconds({ quakeTimeMs: QUAKE_MS, originMinuteMs: null, eew: undefined, catalogOriginMs: Number.NaN })).toBeNull()
  })
})

/** カタログの 1 年ぶんを組む（時刻の昇順で渡す）。 */
function catalog(rows: readonly { t: number; lat: number; lng: number; m: number; ext?: boolean }[]): CatalogColumns {
  return {
    timeMs: rows.map((r) => r.t),
    lat: rows.map((r) => r.lat),
    lng: rows.map((r) => r.lng),
    magnitude: rows.map((r) => r.m),
    external: rows.map((r) => (r.ext ? 1 : 0)),
  }
}

describe('findCatalogOriginMs', () => {
  // 熊本県天草・芦北地方あたりの震央。
  const quake = { timeMs: QUAKE_MS, originMinuteMs: null, latitude: 32.5, longitude: 130.5, magnitude: 3.5 }
  const covered = QUAKE_MS + 10 * 24 * 3600_000

  test('分・震央・規模が合う地震がちょうど 1 つならその発生時刻', () => {
    const y = catalog([
      { t: QUAKE_MS - 600_000, lat: 32.5, lng: 130.5, m: 3.5 },
      { t: CATALOG_MS, lat: 32.52, lng: 130.48, m: 3.6 },
    ])
    expect(findCatalogOriginMs(quake, [y], covered)).toBe(CATALOG_MS)
  })

  // 群発の最中は同じ分・同じ場所で複数の地震が起きる。取り違えるより線を引かない。
  test('2 つ以上合えば採らない', () => {
    const y = catalog([
      { t: CATALOG_MS, lat: 32.5, lng: 130.5, m: 3.5 },
      { t: CATALOG_MS + 20_000, lat: 32.51, lng: 130.5, m: 3.4 },
    ])
    expect(findCatalogOriginMs(quake, [y], covered)).toBeNull()
  })

  // 気象庁以外の機関の震源は同じ地震の別決定。候補に数えると、気象庁の行と 2 つになって引けなくなる
  test('気象庁以外の機関の震源は候補に数えない', () => {
    const y = catalog([
      { t: CATALOG_MS, lat: 32.52, lng: 130.48, m: 3.6 },
      { t: CATALOG_MS + 1_500, lat: 32.5, lng: 130.5, m: 3.5, ext: true },
    ])
    expect(findCatalogOriginMs(quake, [y], covered)).toBe(CATALOG_MS)
  })

  test('気象庁以外の機関の震源しか合わなければ採らない', () => {
    const y = catalog([{ t: CATALOG_MS, lat: 32.5, lng: 130.5, m: 3.5, ext: true }])
    expect(findCatalogOriginMs(quake, [y], covered)).toBeNull()
  })

  test('震央が離れている・規模が違う地震は数えない', () => {
    const far = 32.5 + (CATALOG_MAX_DISTANCE_KM + 5) / 111
    const y = catalog([
      { t: CATALOG_MS, lat: 32.5, lng: 130.5, m: 3.5 },
      { t: CATALOG_MS + 1_000, lat: far, lng: 130.5, m: 3.5 },
      { t: CATALOG_MS + 2_000, lat: 32.5, lng: 130.5, m: 2.9 },
    ])
    expect(findCatalogOriginMs(quake, [y], covered)).toBe(CATALOG_MS)
  })

  // 安全弁: 規模は Float32 で持つので、ちょうど 0.3 違う地震が丸めで外れない。
  test('規模の差がちょうど 0.3 なら数える（Float32 の丸めで外さない）', () => {
    const y = catalog([{ t: CATALOG_MS, lat: 32.5, lng: 130.5, m: Math.fround(3.8) }])
    expect(findCatalogOriginMs(quake, [y], covered)).toBe(CATALOG_MS)
  })

  test('分の外の地震は数えない', () => {
    const y = catalog([{ t: QUAKE_MS + 70_000, lat: 32.5, lng: 130.5, m: 3.5 }])
    expect(findCatalogOriginMs(quake, [y], covered)).toBeNull()
  })

  // 安全弁: まだ載っていない期間で「1 つに決まった」と言わない。
  test('分の幅がカタログの終端を越えるなら引かない', () => {
    const y = catalog([{ t: CATALOG_MS, lat: 32.5, lng: 130.5, m: 3.5 }])
    expect(findCatalogOriginMs(quake, [y], QUAKE_MS + 30_000)).toBeNull()
  })

  test('震央か規模が判らない地震では引かない', () => {
    const y = catalog([{ t: CATALOG_MS, lat: 32.5, lng: 130.5, m: 3.5 }])
    expect(findCatalogOriginMs({ ...quake, latitude: -200, longitude: -200 }, [y], covered)).toBeNull()
    expect(findCatalogOriginMs({ ...quake, magnitude: Number.NaN }, [y], covered)).toBeNull()
  })

  test('年をまたぐ地震は両方の年から探す', () => {
    const newYear = Date.parse('2026-01-01T00:00:00+09:00')
    const q = { ...quake, timeMs: Date.parse('2025-12-31T23:59:00+09:00') }
    const y2025 = catalog([])
    const y2026 = catalog([{ t: newYear + 3_000, lat: 32.5, lng: 130.5, m: 3.5 }])
    expect(findCatalogOriginMs(q, [y2025, y2026], newYear + 86400_000)).toBe(newYear + 3_000)
  })
})

describe('catalogYearsFor', () => {
  test('日本時間の暦年で数える（UTC では前年）', () => {
    expect(catalogYearsFor(Date.parse('2026-01-01T03:00:00+09:00'), null)).toEqual([2026])
  })

  test('分の幅が年をまたぐなら両方', () => {
    expect(catalogYearsFor(Date.parse('2025-12-31T23:59:00+09:00'), null)).toEqual([2025, 2026])
    expect(catalogYearsFor(Date.parse('2026-01-01T00:00:00+09:00'), null)).toEqual([2025, 2026])
  })
})

describe('parseJstTimeMs', () => {
  // **端末の時間帯に依らないことを固定する。** テストは日本時間で走るので `new Date()` と比べても
  // 違いは出ない。時間帯つきの絶対時刻と突き合わせる。
  test('時間帯を持たない時計表記を日本時間として読む', () => {
    expect(parseJstTimeMs('2026/10/03 13:26:00')).toBe(Date.parse('2026-10-03T13:26:00+09:00'))
  })

  test('小数秒つき・秒なしも読む', () => {
    expect(parseJstTimeMs('2026/10/03 13:26:05.500')).toBe(Date.parse('2026-10-03T13:26:05+09:00'))
    expect(parseJstTimeMs('2026/10/03 13:26')).toBe(Date.parse('2026-10-03T13:26:00+09:00'))
  })

  test('時間帯を持つ表記（DMDATA の ISO 形式）はそのまま読む', () => {
    expect(parseJstTimeMs('2026-10-03T04:26:00Z')).toBe(Date.parse('2026-10-03T13:26:00+09:00'))
    expect(parseJstTimeMs('2026-10-03T13:26:00+09:00')).toBe(Date.parse('2026-10-03T13:26:00+09:00'))
  })

  test('存在しない日時・読めない文字列は NaN', () => {
    expect(parseJstTimeMs('2026/02/30 12:00:00')).toBeNaN()
    // 秒・分の範囲の外も繰り上げずに弾く（`jstWallClockToIso` と同じ照合を通る）
    expect(parseJstTimeMs('2026/10/24 01:09:75')).toBeNaN()
    expect(parseJstTimeMs('2026/10/24 01:60:00')).toBeNaN()
    expect(parseJstTimeMs('こわれた時刻')).toBeNaN()
  })
})

describe('jstWallClockToIso', () => {
  // 正: 小数の秒つき（桁数が揃っていない）の時計表記を日本時間の ISO の形へ直す。
  // **Safari はこの形のままだと読めない**（WebKit 26.5 で `NaN` を実測）
  test('小数の秒つきの時計表記を、ミリ秒 3 桁の ISO の形へ直す', () => {
    expect(jstWallClockToIso('2026/10/24 01:09:42.83')).toBe('2026-10-24T01:09:42.830+09:00')
    expect(jstWallClockToIso('2026/10/24 01:12:15.236')).toBe('2026-10-24T01:12:15.236+09:00')
    expect(jstWallClockToIso('2026/10/24 01:12:15.2369')).toBe('2026-10-24T01:12:15.236+09:00')
  })

  test('小数の秒なし・秒なし・1 桁の月日時も直す', () => {
    expect(jstWallClockToIso('2026/10/24 01:07:00')).toBe('2026-10-24T01:07:00.000+09:00')
    expect(jstWallClockToIso('2026/1/2 3:04')).toBe('2026-01-02T03:04:00.000+09:00')
  })

  // 直した値が、元の表記を日本時間として読んだ時刻と同じ瞬間を指すこと
  test('直した値は parseJstTimeMs と同じ瞬間を指す', () => {
    for (const s of ['2026/10/24 01:09:42.83', '2026/12/31 23:59:59', '2027/01/01 00:00:00']) {
      expect(Math.floor(Date.parse(jstWallClockToIso(s)!) / 1000)).toBe(parseJstTimeMs(s) / 1000)
    }
  })

  // 対照: 時間帯を持つ表記（DMDATA の ISO の形）は時計表記ではないので触らない
  test('時間帯を持つ表記は null（呼び出し側が元の文字列のまま扱う）', () => {
    expect(jstWallClockToIso('2026-10-24T01:09:42.830+09:00')).toBeNull()
    expect(jstWallClockToIso('2026-10-23T16:09:42Z')).toBeNull()
  })

  // 安全弁: 暦に無い日時・読めない文字列を、ずらした正しそうな日時へ化けさせない
  // `Date.UTC` は範囲の外を黙って繰り上げる。分・秒の照合を省くと、繰り上がった別の日時が通る
  test('暦に無い日時・読めない文字列は null', () => {
    expect(jstWallClockToIso('2026/02/30 12:00:00')).toBeNull()
    expect(jstWallClockToIso('2026/10/24 25:00:00')).toBeNull()
    expect(jstWallClockToIso('2026/10/24 24:00:00')).toBeNull()
    expect(jstWallClockToIso('2026/10/24 01:60:00')).toBeNull()
    expect(jstWallClockToIso('2026/10/24 01:09:60')).toBeNull()
    expect(jstWallClockToIso('2026/10/24 01:09:75')).toBeNull()
    expect(jstWallClockToIso('こわれた時刻')).toBeNull()
    expect(jstWallClockToIso('')).toBeNull()
  })
})
