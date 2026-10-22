import { describe, it, expect, vi } from 'vitest'
import {
  advanceQuakeMarks, changedQuakeFacts, diffQuakeRows, lpgmMarkKey, lpgmRowSnapshot, lpgmTelegramRevise,
  pruneQuakeMarks, quakeFactSnapshot, quakeRowSnapshot, quakeTelegramRevise, rowMarkKey, rowMarkOf,
  markIssuedAt, trimQuakeMarkMemory, MARK_MEMORY_MAX_ROWS,
  type QuakeMarkMemory,
  type QuakeMarkSnapshot,
  type MarkReportType,
  type RowSnapshot,
} from './quakeUpdateMark'
import { UPDATE_MARK_TTL_MS } from './updateMark'
import type { EarthquakePoint, IntensityScale, JMALpgm, JMAQuake, JMAQuakeCity } from '../types/earthquake'
import { log } from './logger'

function makeQuake(over: {
  name?: string
  lat?: number
  lng?: number
  depth?: number
  magnitude?: number
  magnitudeCondition?: string
  magnitudeType?: string
  nameFromMark?: string
  domesticTsunami?: JMAQuake['earthquake']['domesticTsunami']
  maxScale?: IntensityScale
} = {}): JMAQuake {
  return {
    kind: 'quake',
    id: 'test-1',
    time: '2024-01-01T16:10:00+09:00',
    issue: { source: 'テスト', time: '2024-01-01T16:10:00+09:00', type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: '2024-01-01T16:10:00+09:00',
      hypocenter: {
        name: over.name ?? '能登半島沖',
        latitude: over.lat ?? 37.5,
        longitude: over.lng ?? 137.2,
        depth: over.depth ?? 10,
        magnitude: over.magnitude ?? 7.6,
        ...(over.magnitudeCondition ? { magnitudeCondition: over.magnitudeCondition } : {}),
        ...(over.magnitudeType ? { magnitudeType: over.magnitudeType } : {}),
        ...(over.nameFromMark ? { nameFromMark: over.nameFromMark } : {}),
      },
      maxScale: over.maxScale ?? 70,
      domesticTsunami: over.domesticTsunami ?? '警報等',
    },
    points: [],
  } as JMAQuake
}

const station = (addr: string, scale: IntensityScale, over: Partial<EarthquakePoint> = {}): EarthquakePoint =>
  ({ pref: '石川県', addr, isArea: false, scale, ...over }) as EarthquakePoint
const area = (addr: string, scale: IntensityScale): EarthquakePoint =>
  ({ pref: '', addr, isArea: true, scale }) as EarthquakePoint
const city = (name: string, areaName: string, scale: IntensityScale, over: Partial<JMAQuakeCity> = {}): JMAQuakeCity =>
  ({ name, area: areaName, pref: '石川県', scale, ...over }) as JMAQuakeCity

const snapRows = (points: EarthquakePoint[], cities: JMAQuakeCity[] = []) =>
  quakeRowSnapshot(points, cities, null)

/**
 * 同じ情報種別の続報として差分を取る（このファイルの多くのテストが見たい形）。
 * 値の変化は直前の報と、初出は同じ種別で前に見た報と比べるので、同じ種別なら両方とも同じ写し。
 */
const diffSameType = (cur: ReturnType<typeof snapRows>, prev: ReturnType<typeof snapRows> | undefined) =>
  diffQuakeRows(cur, prev, prev)

/**
 * 都道府県ロールアップ点（電文の `Pref/MaxInt` 由来）。**`isArea` が真で `pref` を持つ。**
 * 行にはならず、県の最大にしか効かない（→ `buildIntensityRows`）。
 */
const prefRollup = (pref: string, scale: IntensityScale): EarthquakePoint =>
  ({ pref, addr: pref, isArea: true, scale }) as EarthquakePoint

describe('地震カードの更新の印', () => {
  describe('震源要素・最大震度', () => {
    // 正: 値が上がったら「上がった」の印。
    it('規模が上がったら上がったの印が出る', () => {
      const before = quakeFactSnapshot(makeQuake({ magnitude: 7.4 }))
      const after = quakeFactSnapshot(makeQuake({ magnitude: 7.6 }))
      expect(changedQuakeFacts(after, before, false).get('magnitude')).toBe('raised')
    })

    // 正: **数値が同じまま種別だけ変わっても印が出る。** 画面は種別を前置きの記号に出すので
    // （`M6.8` → `Mj6.8`）、表示は動いている。鍵から種別を外すと、この変化だけ印が付かない。
    it('規模の種別だけが変わっても印が出る', () => {
      const before = quakeFactSnapshot(makeQuake({ magnitude: 6.8, magnitudeType: 'M' }))
      const after = quakeFactSnapshot(makeQuake({ magnitude: 6.8, magnitudeType: 'Mj' }))
      // 数値は動いていないので、向きの無い「変わった」。
      expect(changedQuakeFacts(after, before, false).get('magnitude')).toBe('changed')
    })

    // 安全弁: **規模が無い報は、種別だけ持っていても「値なし」として扱う。** 鍵へ項目を足すと
    // 区切りの数が変わるので、「値が無い」を鍵の文字列で見ていると黙って外れる（実際に外れた）。
    // 種別が変わった報で欄が一斉に光るのを防ぐ守りが、これに依っている。
    it('規模が無ければ種別を持っていても値なしとして扱う', () => {
      const prompt = quakeFactSnapshot(makeQuake({ name: '', lat: -200, lng: -200, depth: -1, magnitude: -1, magnitudeType: 'Mj' }))
      const settled = quakeFactSnapshot(makeQuake({ magnitudeType: 'Mj' }))
      expect(changedQuakeFacts(settled, prompt, false).size).toBe(0)
    })

    // 対照: 種別も数値も同じなら印は出ない（上の鍵が過敏になっていないこと）。
    it('種別も数値も同じなら印は出ない', () => {
      const before = quakeFactSnapshot(makeQuake({ magnitude: 6.8, magnitudeType: 'Mj' }))
      const after = quakeFactSnapshot(makeQuake({ magnitude: 6.8, magnitudeType: 'Mj' }))
      expect(changedQuakeFacts(after, before, false).get('magnitude')).toBeUndefined()
    })

    // 対照: 下がったら別の印。**同じ「動いた」で畳まない。**
    it('規模が下がったら下がったの印が出る', () => {
      const before = quakeFactSnapshot(makeQuake({ magnitude: 7.6 }))
      const after = quakeFactSnapshot(makeQuake({ magnitude: 7.4 }))
      expect(changedQuakeFacts(after, before, false).get('magnitude')).toBe('lowered')
    })

    // 正: **浅くなったら「上がった」**（浅いほど危険なので、赤が「より深刻」を指す約束を守る）。
    it('震源が浅くなったら上がったの印が出る', () => {
      const before = quakeFactSnapshot(makeQuake({ depth: 30 }))
      const after = quakeFactSnapshot(makeQuake({ depth: 10 }))
      expect(changedQuakeFacts(after, before, false).get('depth')).toBe('raised')
    })

    // 正: 大小の無い欄は向きを言わない。
    it('震央地名が変わったら向きの無い印が出る', () => {
      const before = quakeFactSnapshot(makeQuake({ name: '能登半島沖' }))
      const after = quakeFactSnapshot(makeQuake({ name: '石川県能登地方' }))
      expect(changedQuakeFacts(after, before, false).get('hypocenterName')).toBe('changed')
    })

    // 正: 震央補助表現の文が別の文へ変わったら向きの無い印（比べるのは電文の原文）。
    it('震央補助表現の文が変わったら向きの無い印が出る', () => {
      const before = quakeFactSnapshot(makeQuake({ nameFromMark: '輪島の東北東３０ｋｍ付近' }))
      const after = quakeFactSnapshot(makeQuake({ nameFromMark: '輪島の東北東４０ｋｍ付近' }))
      expect(changedQuakeFacts(after, before, false).get('nameFromMark')).toBe('changed')
    })

    // 対照: 文が無かった報のあとに文が現れても、**種別が変わった報なら**印を付けない（値が無い欄に値が付いたのと同じ）。
    it('震央補助表現が現れても、種別が変わった報では印を付けない', () => {
      const before = quakeFactSnapshot(makeQuake({}))
      const after = quakeFactSnapshot(makeQuake({ nameFromMark: '輪島の東北東３０ｋｍ付近' }))
      expect(changedQuakeFacts(after, before, false).has('nameFromMark')).toBe(false)
    })

    // 安全弁: 座標だけ動いて文がそのままなら、印は座標の行にだけ出る（全期間の控えで 87 組あった形）。
    it('座標だけ動いて震央補助表現が同じなら、震央補助表現には印を付けない', () => {
      const before = quakeFactSnapshot(makeQuake({ lat: 37.5, lng: 137.2, nameFromMark: '輪島の東北東３０ｋｍ付近' }))
      const after = quakeFactSnapshot(makeQuake({ lat: 37.495, lng: 137.27, nameFromMark: '輪島の東北東３０ｋｍ付近' }))
      const changed = changedQuakeFacts(after, before, false)
      expect(changed.has('nameFromMark')).toBe(false)
      expect(changed.get('coordinate')).toBe('changed')
    })

    // 文が消えた報（全期間の控えで 14 組あった形）。記憶の上では「向きの無い変化」になるが、カードは文が無いと
    // 行ごと出さないので、印を描く場所が無い（→ EarthquakeCard の震央補助表現の行）。
    it('震央補助表現が消えた報では向きの無い変化として残る（描く行は無い）', () => {
      const before = quakeFactSnapshot(makeQuake({ nameFromMark: '輪島の東北東３０ｋｍ付近' }))
      const after = quakeFactSnapshot(makeQuake({}))
      expect(changedQuakeFacts(after, before, false).get('nameFromMark')).toBe('changed')
    })

    // 対照: 津波区分の「調査中」「不明」は値ではなく「まだ決まっていない」なので、
    // **種別が変わった報で確定しても印を付けない**（震源が未確定から確定した報と同じ扱い）。
    it('津波区分は調査中から確定しても、種別が変わった報では印を出さない', () => {
      const before = quakeFactSnapshot(makeQuake({ domesticTsunami: '調査中' }))
      const after = quakeFactSnapshot(makeQuake({ domesticTsunami: 'なし' }))
      expect(changedQuakeFacts(after, before, false).size).toBe(0)
    })

    // 正: **逆向きは印を付ける。** 確定していた区分が調査中へ戻るのは気象庁が取り下げた事実。
    it('津波区分が確定から調査中へ戻ったら印を出す', () => {
      const before = quakeFactSnapshot(makeQuake({ domesticTsunami: 'なし' }))
      const after = quakeFactSnapshot(makeQuake({ domesticTsunami: '調査中' }))
      expect(changedQuakeFacts(after, before, false).get('domesticTsunami')).toBe('changed')
    })

    // 対照: 重さの決まっている値どうしなら向きが出る。
    it('津波区分が警報等から注意報へ下がったら下がったの印が出る', () => {
      const before = quakeFactSnapshot(makeQuake({ domesticTsunami: '警報等' }))
      const after = quakeFactSnapshot(makeQuake({ domesticTsunami: '注意報' }))
      expect(changedQuakeFacts(after, before, false).get('domesticTsunami')).toBe('lowered')
    })

    // 対照: **種別が変わった報で値が付いただけなら印を付けない。** 震度速報 → 震源情報 の遷移が
    // これで、付けると震源が確定した報で欄が一斉に光る。種別が変われば載せる欄の顔ぶれも変わる。
    it('種別が変わった報で震源が未確定から確定しても印を出さない', () => {
      const prompt = quakeFactSnapshot(makeQuake({ name: '', lat: -200, lng: -200, depth: -1, magnitude: -1 }))
      const settled = quakeFactSnapshot(makeQuake())
      expect(changedQuakeFacts(settled, prompt, false).size).toBe(0)
    })

    // 正: 値が消えたのは向きの無い変化。**「下がった」ではない** —— 小さくなったのではなく
    // 気象庁が取り下げたので、大小の話にしない。
    it('値が取り下げられたら向きの無い印が出る', () => {
      const before = quakeFactSnapshot(makeQuake({ magnitude: 7.6 }))
      const after = quakeFactSnapshot(makeQuake({ magnitude: -1 }))
      expect(changedQuakeFacts(after, before, false).get('magnitude')).toBe('changed')
    })

    // 対照: 前report が無ければ何も出ない（全欄が初出になって画面を埋める）。
    it('そのカードで最初に見た報では印を出さない', () => {
      expect(changedQuakeFacts(quakeFactSnapshot(makeQuake()), undefined, false).size).toBe(0)
    })

    // 対照: 同じ値なら出ない。
    it('値が動いていなければ印を出さない', () => {
      const snap = quakeFactSnapshot(makeQuake())
      expect(changedQuakeFacts(snap, snap, false).size).toBe(0)
    })

    // 正: **直前の電文と種別が同じなら、値の無かった欄に値が付いたら初出（緑）にする**
    // （2026-10-21 ユーザー承認「自明でない組だけ緑 (Recommended)」。全期間の控えで震央補助表現 3 件・遠地地震の津波区分 22 件）。
    it('同じ種別の続報で値の無かった欄に値が付いたら初出の印が出る', () => {
      const before = quakeFactSnapshot(makeQuake({ domesticTsunami: '調査中' }))
      const after = quakeFactSnapshot(makeQuake({ domesticTsunami: 'なし', nameFromMark: '輪島の東北東３０ｋｍ付近' }))
      const changed = changedQuakeFacts(after, before, true)
      expect(changed.get('domesticTsunami')).toBe('new')
      expect(changed.get('nameFromMark')).toBe('new')
    })

    // 安全弁: 同じ種別でも、値が無いまま（番兵どうし）なら印を付けない。
    it('同じ種別の続報でも値が無いままなら印を出さない', () => {
      const snap = quakeFactSnapshot(makeQuake({ domesticTsunami: '調査中' }))
      expect(changedQuakeFacts(snap, snap, true).size).toBe(0)
    })

    // 安全弁: 規模は**数値と説明の両方**を鍵に含める。「Ｍ８を超える巨大地震」は本文が NaN で
    // `description` だけが値を持つので、数値だけで比べるとその変化が消える。
    it('数値が読めないまま説明だけが変わっても印が出る', () => {
      const before = quakeFactSnapshot(makeQuake({ magnitude: NaN, magnitudeCondition: '不明' }))
      const after = quakeFactSnapshot(makeQuake({ magnitude: NaN, magnitudeCondition: 'Ｍ８を超える巨大地震' }))
      // 数値が無いので大小は言えない。向きの無い変化として出す。
      expect(changedQuakeFacts(after, before, false).get('magnitude')).toBe('changed')
    })

    // 安全弁: 位置不明のセンチネル（-200）を座標として扱わない。
    it('位置不明のセンチネルは座標として扱わない', () => {
      const snap = quakeFactSnapshot(makeQuake({ lat: -200, lng: -200 }))
      expect(snap.get('coordinate')?.key).toBe('')
    })
  })

  describe('震度一覧の行', () => {
    // 正: 既にあった行の値が動いたら「更新」。
    it('観測点の震度が上がったら上がったの印が出る', () => {
      const before = snapRows([station('輪島', 50), station('珠洲', 40)])
      const after = snapRows([station('輪島', 60), station('珠洲', 40)])
      const marks = diffSameType(after, before)
      expect(marks.get(rowMarkKey.station('輪島'))).toBe('raised')
      expect(marks.has(rowMarkKey.station('珠洲'))).toBe(false)
    })

    // 対照: 下がった行は別の印。
    it('観測点の震度が下がったら下がったの印が出る', () => {
      const before = snapRows([station('輪島', 60)])
      const after = snapRows([station('輪島', 50)])
      expect(diffSameType(after, before).get(rowMarkKey.station('輪島'))).toBe('lowered')
    })

    // 正: その段が既に出ている報で新しい行が増えたら「初出」。
    it('観測点が増えたら初出の印が出る', () => {
      const before = snapRows([station('輪島', 50)])
      const after = snapRows([station('輪島', 50), station('珠洲', 40)])
      expect(diffSameType(after, before).get(rowMarkKey.station('珠洲'))).toBe('new')
    })

    // 対照: **その段が初めて現れた報では印を付けない。**
    // 「震度速報 → 各地の震度」では観測点の行がいっぺんに全部現れる（実測で最大 2,825 行）。
    it('観測点の段が初めて現れた報では印を付けない', () => {
      const prompt = snapRows([area('能登', 70)])
      const detail = snapRows([area('能登', 70), station('輪島', 70), station('珠洲', 60)])
      const marks = diffSameType(detail, prompt)
      expect(marks.has(rowMarkKey.station('輪島'))).toBe(false)
      expect(marks.has(rowMarkKey.station('珠洲'))).toBe(false)
    })

    // 安全弁: **都道府県ロールアップ点を観測点として数えない。**
    //
    // 電文の `Pref/MaxInt` は `isArea` が真で `pref` を持つ点として届く。これを観測点の側へ
    // 振り分けると、震度速報の段階で `st:` の記憶ができ、**次の「各地の震度」で観測点が
    // 数千行いっぺんに光る**（上の抑止が効かなくなる）。
    it('都道府県ロールアップ点は観測点の段として数えない', () => {
      const prompt = snapRows([prefRollup('石川県', 70), area('能登', 70)])
      expect([...prompt.keys()].some(k => k.startsWith('st:'))).toBe(false)
      // その結果、次の報で初めて現れる観測点は抑止される。
      const detail = snapRows([prefRollup('石川県', 70), area('能登', 70), station('輪島', 70)])
      expect(diffSameType(detail, prompt).has(rowMarkKey.station('輪島'))).toBe(false)
    })

    // 対照: ロールアップ点は県の最大としては効く（落としているのではなく、行にしないだけ）。
    it('都道府県ロールアップ点は県の最大には効く', () => {
      expect(snapRows([prefRollup('石川県', 70)]).get(rowMarkKey.pref('石川県'))?.key).toBe('70')
    })

    // 正: 標準版（P2PQuake）は区域の点にも県名を積む。`pref` の有無で見分けると区域の記憶が
    // 1 つもできず、震度速報の区域の行に印が付かない。
    it('県名を持つ区域の点（標準版）も区域の行として覚える', () => {
      const p2pArea: EarthquakePoint = { pref: '石川県', addr: '石川県能登', isArea: true, scale: 70 as IntensityScale }
      const snap = snapRows([p2pArea])
      expect(snap.get(rowMarkKey.area('石川県能登'))?.key).toBe('70')
      expect(snap.get(rowMarkKey.pref('石川県'))?.key).toBe('70')
      expect([...snap.keys()].some(k => k.startsWith('st:'))).toBe(false)
    })

    // 対照: 区域の段は既に出ているので、同じ報で区域が増えれば印は付く（段ごとに見ている）。
    it('既に出ている段の行は、同じ報でも印が付く', () => {
      const prompt = snapRows([area('能登', 70)])
      const detail = snapRows([area('能登', 70), area('加賀', 50), station('輪島', 70)])
      const marks = diffSameType(detail, prompt)
      expect(marks.get(rowMarkKey.area('加賀'))).toBe('new')
      expect(marks.has(rowMarkKey.station('輪島'))).toBe(false)
    })

    // 対照: 前が無ければ何も出ない。
    it('そのカードで最初に見た報では行の印を出さない', () => {
      expect(diffSameType(snapRows([station('輪島', 50)]), undefined).size).toBe(0)
    })

    // 安全弁: 未入電は下限の 45 が入るので、階級だけで比べると観測値が届いた瞬間を取りこぼす。
    it('未入電から観測値へ変わったら印が出る（階級が同じでも）', () => {
      const before = snapRows([station('輪島', 45, { unreceived: true })])
      const after = snapRows([station('輪島', 45)])
      // 階級は動いていないので**向きは言わない**。未入電が解けたのは大小の話ではない。
      expect(diffSameType(after, before).get(rowMarkKey.station('輪島'))).toBe('changed')
    })

    // 安全弁: 市町村は区域との組で鍵にする（名前だけでは一意にならない）。
    it('同名の市町村を区域で見分ける', () => {
      const before = snapRows([], [city('府中市', '東京都多摩北部', 30), city('府中市', '広島県南西部', 20)])
      const after = snapRows([], [city('府中市', '東京都多摩北部', 40), city('府中市', '広島県南西部', 20)])
      const marks = diffSameType(after, before)
      expect(marks.get(rowMarkKey.city('東京都多摩北部', '府中市'))).toBe('raised')
      expect(marks.has(rowMarkKey.city('広島県南西部', '府中市'))).toBe(false)
    })

    // 安全弁: 県の行は配下の最大。点の順序で上書きされない。
    it('県の行は配下の最大を採る（点の並び順に依らない）', () => {
      const ascending = snapRows([station('a', 30), station('b', 60)])
      const descending = snapRows([station('b', 60), station('a', 30)])
      expect(ascending.get(rowMarkKey.pref('石川県'))?.key).toBe('60')
      expect(descending.get(rowMarkKey.pref('石川県'))?.key).toBe('60')
    })

    // 正: 県の行の鍵にも未入電の印を含める（観測点・区域の行と同じ）。県の値が未入電の下限 45 から
    // 観測値の 45 へ変わったとき、階級だけで比べると印が出ない。
    it('県の値が未入電から観測値へ変わったら、県の行にも印が出る', () => {
      // 配下がすべて未入電の県は `MaxInt` を持たず、未入電の点として届く（→ パーサーの `onlyUnreceivedCities`）
      const before = snapRows([{ ...prefRollup('石川県', 45), unreceived: true }, station('輪島', 45, { unreceived: true })])
      const after = snapRows([prefRollup('石川県', 45), station('輪島', 45)])
      expect(before.get(rowMarkKey.pref('石川県'))?.key).toBe('45!')
      expect(after.get(rowMarkKey.pref('石川県'))?.key).toBe('45')
      expect(diffSameType(after, before).get(rowMarkKey.pref('石川県'))).toBe('changed')
    })

    // 安全弁: 同じ震度なら観測値を採る（画面の県の行と同じ規則。並び順で鍵が変わらない）。
    it('県の行の鍵は、同じ震度なら観測値を採る（並び順に依らない）', () => {
      const a = snapRows([station('a', 45, { unreceived: true }), station('b', 45)])
      const b = snapRows([station('b', 45), station('a', 45, { unreceived: true })])
      expect(a.get(rowMarkKey.pref('石川県'))?.key).toBe('45')
      expect(b.get(rowMarkKey.pref('石川県'))?.key).toBe('45')
    })
  })

  describe('比べる相手を、値の変化と初出で分ける', () => {
    // 正: **その種別を初めて見た報では初出を出さない。**
    // 震度速報は震度3以上の区域しか載せず、震源・震度情報は震度1以上を全部載せる。
    // 能登本震の実電文では 33 県 75 区域 → 44 県 118 区域で、11 県・43 区域が光っていた。
    it('種別を初めて見た報では、区域が一斉に増えても初出の印を付けない', () => {
      const prompt = snapRows([area('能登', 70), area('加賀', 50)])
      const detail = snapRows([area('能登', 70), area('加賀', 50), area('広島県南東部', 20), area('高知県東部', 20)])
      // 直前の報は震度速報（prompt）。その種別の写しはまだ無い。
      const marks = diffQuakeRows(detail, prompt, undefined)
      expect(marks.has(rowMarkKey.area('広島県南東部'))).toBe(false)
      expect(marks.has(rowMarkKey.area('高知県東部'))).toBe(false)
    })

    // 対照: **同じ種別の続報なら初出の印は出る。** 増えた区域はその報が伝えた新しい事実。
    it('同じ種別の続報なら初出の印が出る', () => {
      const first = snapRows([area('能登', 70)])
      const second = snapRows([area('能登', 70), area('鹿児島県薩摩', 20)])
      expect(diffSameType(second, first).get(rowMarkKey.area('鹿児島県薩摩'))).toBe('new')
    })

    // 正: **種別が前後しても、同じ種別どうしなら初出は出る。**
    // 気象庁は 2024-01-01 16:06 の前震で 震度速報(16:07) → 震源情報 → 震度速報(16:08) の順に
    // 発表した。「直前の報と種別が違うか」で判定すると、この 16:08 の続報で本当に増えた区域
    // （新潟県佐渡）の印まで消える。
    it('種別が前後しても、同じ種別で前に見た報と比べる', () => {
      const sokuho1 = snapRows([area('石川県能登', 55), area('新潟県上越', 40)])
      // あいだに震源情報が挟まる（震度は前報から引き継がれるので行は同じ）。
      const hypocenter = sokuho1
      const sokuho2 = snapRows([area('石川県能登', 55), area('新潟県上越', 40), area('新潟県佐渡', 30)])
      const marks = diffQuakeRows(sokuho2, hypocenter, sokuho1)
      expect(marks.get(rowMarkKey.area('新潟県佐渡'))).toBe('new')
    })

    // 安全弁: **値が動いた行の印は種別をまたいでも出す。** 気象庁が震度を引き上げた事実は
    // 報の粒度の違いでは説明できない。
    it('種別を初めて見た報でも、値が上がった行には印を付ける', () => {
      const prompt = snapRows([area('能登', 60)])
      const detail = snapRows([area('能登', 70), area('加賀', 30)])
      const marks = diffQuakeRows(detail, prompt, undefined)
      expect(marks.get(rowMarkKey.area('能登'))).toBe('raised')
      expect(marks.has(rowMarkKey.area('加賀'))).toBe(false)
    })
  })

  describe('親の行への持ち上げ', () => {
    // 正: 配下が動いていれば親にも印が出る（一覧は既定で畳んである）。
    it('配下が動いたら親の行にも印が出る', () => {
      const marks = new Map([[rowMarkKey.station('輪島'), 'raised' as const]])
      expect(rowMarkOf(rowMarkKey.area('能登'), [rowMarkKey.station('輪島')], marks)).toBe('raised')
    })

    // 正: 配下の向きが混ざったら**いちばん重いものを採る**（畳んだ親は 1 つしか言えない）。
    it('配下の向きが混ざったら上がった側を採る', () => {
      const marks = new Map<string, 'raised' | 'lowered'>([
        [rowMarkKey.station('輪島'), 'lowered'],
        [rowMarkKey.station('珠洲'), 'raised'],
      ])
      const keys = [rowMarkKey.station('輪島'), rowMarkKey.station('珠洲')]
      expect(rowMarkOf(rowMarkKey.area('能登'), keys, marks)).toBe('raised')
    })

    // 対照: 配下も自分も動いていなければ印は出ない。
    it('配下が動いていなければ印は出ない', () => {
      expect(rowMarkOf(rowMarkKey.area('能登'), [rowMarkKey.station('輪島')], new Map())).toBeUndefined()
    })

    // 安全弁: 自分自身が初出なら、配下より自分の印を優先する。
    it('自分自身の印を配下より優先する', () => {
      const marks = new Map([
        [rowMarkKey.area('能登'), 'new' as const],
        [rowMarkKey.station('輪島'), 'raised' as const],
      ])
      expect(rowMarkOf(rowMarkKey.area('能登'), [rowMarkKey.station('輪島')], marks)).toBe('new')
    })
  })

  describe('記憶の持ち回り', () => {
    // 種別は既定を持たせる（このブロックの主題ではないため）。種別をまたぐ挙動は
    // 「種別が変わった報」の describe で明示的に渡して確かめる。
    const memoryOf = (
      q: JMAQuake,
      points: EarthquakePoint[],
      reportType: MarkReportType = '震源・震度情報',
    ): QuakeMarkSnapshot => ({
      facts: quakeFactSnapshot(q), rows: snapRows(points), reportType,
      issuedAt: markIssuedAt(q.issue.time),
      telegramType: reportType, revise: null,
    })

    // 正: 続報で動いた分が印になり、記憶は進む。
    it('続報で動いた分を印にして記憶を進める', () => {
      const first = advanceQuakeMarks({
        prev: { memory: new Map(), marks: new Map() },
        key: 'q1',
        snapshot: memoryOf(makeQuake({ magnitude: 7.4 }), [station('輪島', 50)]),
        liveKeys: new Set(['q1']),
        now: 1000,
      })
      expect(first.marks.size).toBe(0)
      const second = advanceQuakeMarks({
        prev: { memory: first.memory, marks: first.marks },
        key: 'q1',
        snapshot: memoryOf(makeQuake({ magnitude: 7.6 }), [station('輪島', 60)]),
        liveKeys: new Set(['q1']),
        now: 2000,
      })
      expect(second.marks.get('q1')?.facts.get('magnitude')).toBe('raised')
      expect(second.marks.get('q1')?.rows.get(rowMarkKey.station('輪島'))).toBe('raised')
    })

    // 安全弁: **震源要素更新（VXSE61）は必ず種別が変わる報。** 行の初出を止める判定を
    // 欄（`facts`）まで広げると、座標・深さが動いた印がこの種別でだけ出なくなる。
    it('震源要素更新でも欄の印は出る（種別が変わっても止めない）', () => {
      const first = advanceQuakeMarks({
        prev: { memory: new Map(), marks: new Map() },
        key: 'q1',
        snapshot: memoryOf(makeQuake({ lng: 137.2, depth: 0 }), [station('輪島', 70)]),
        liveKeys: new Set(['q1']),
        now: 1000,
      })
      const amended = advanceQuakeMarks({
        prev: { memory: first.memory, marks: first.marks },
        key: 'q1',
        // 2024-01-01 21:30 の実電文と同じ動き（経度 137.2 → 137.3・深さ 0 → 20km）。
        snapshot: memoryOf(
          makeQuake({ lng: 137.3, depth: 20 }),
          [station('輪島', 70)],
          '顕著な地震の震源要素更新のお知らせ',
        ),
        liveKeys: new Set(['q1']),
        now: 2000,
      })
      expect(amended.marks.get('q1')?.facts.get('coordinate')).toBe('changed')
      expect(amended.marks.get('q1')?.facts.get('depth')).toBe('lowered')
    })

    // 正: **種別が前後しても、同じ種別で前に見た報と比べる。**
    // 2024-01-01 16:06 の前震は 震度速報(16:07) → 震源情報 → 震度速報(16:08) の順に届いた。
    // 「直前の報の種別」で判定すると、16:08 の続報で本当に増えた区域の印まで消える。
    it('種別が前後しても、同じ種別どうしの続報で初出の印が出る', () => {
      const run = (
        prev: ReturnType<typeof advanceQuakeMarks>,
        points: EarthquakePoint[],
        type: MarkReportType,
        now: number,
      ) => advanceQuakeMarks({
        prev: { memory: prev.memory, marks: prev.marks },
        key: 'q1',
        snapshot: memoryOf(makeQuake(), points, type),
        liveKeys: new Set(['q1']),
        now,
      })
      const empty = { memory: new Map(), marks: new Map() } as ReturnType<typeof advanceQuakeMarks>

      const sokuho1 = run(empty, [area('石川県能登', 55), area('新潟県上越', 40)], '震度速報', 1000)
      // 震源情報は震度を持たないが、カードは前報の震度を引き継ぐので行は同じ顔ぶれ。
      const hypocenter = run(sokuho1, [area('石川県能登', 55), area('新潟県上越', 40)], '震源情報', 2000)
      const sokuho2 = run(
        hypocenter,
        [area('石川県能登', 55), area('新潟県上越', 40), area('新潟県佐渡', 30)],
        '震度速報', 3000,
      )
      expect(sokuho2.marks.get('q1')?.rows.get(rowMarkKey.area('新潟県佐渡'))).toBe('new')
    })

    // 対照: **その種別を初めて見た報では、行が一斉に増えても初出を出さない。**
    // 震度速報（震度3以上の区域まで）→ 震源・震度情報（震度1以上の全区域）の遷移がこれで、
    // 直前の報とだけ比べる形にすると能登本震で 11 県・43 区域が光る。
    it('種別を初めて見た報では、行が一斉に増えても初出を出さない', () => {
      const run = (
        prev: ReturnType<typeof advanceQuakeMarks>,
        points: EarthquakePoint[],
        type: MarkReportType,
        now: number,
      ) => advanceQuakeMarks({
        prev: { memory: prev.memory, marks: prev.marks },
        key: 'q1',
        snapshot: memoryOf(makeQuake(), points, type),
        liveKeys: new Set(['q1']),
        now,
      })
      const empty = { memory: new Map(), marks: new Map() } as ReturnType<typeof advanceQuakeMarks>

      const sokuho = run(empty, [area('石川県能登', 55)], '震度速報', 1000)
      const detail = run(
        sokuho,
        [area('石川県能登', 55), area('石川県加賀', 30), area('富山県東部', 30)],
        '震源・震度情報', 2000,
      )
      expect(detail.marks.get('q1')?.rows.get(rowMarkKey.area('石川県加賀'))).toBeUndefined()
      expect(detail.marks.get('q1')?.rows.get(rowMarkKey.area('富山県東部'))).toBeUndefined()
    })

    // 安全弁: **種別ごとの写しを捨てない。** 鍵の値域は有限なので溜まりようがなく、
    // 上限で古いものから落とすと「ありふれた遷移で最初の種別が追い出される」形になる。
    // ここが壊れると、下の「一巡して戻ってきた種別」の初出が出なくなる。
    //
    // **落ちることを確かめてある。** 種別数の上限を再導入すると、上限 5 ではこの 1 件が、
    // 上限 3 では下の 1 件も落ちる。**3 はこの変更に入るまで実際に置いていた値**で、
    // そこで初出の印が消えていた。
    it('種別ごとの写しは、種別が増えても捨てない', () => {
      const types: MarkReportType[] = [
        '震度速報', '震源情報', '震源・震度情報', '各地の震度情報',
        '顕著な地震の震源要素更新のお知らせ', '遠地地震', 'その他',
      ]
      let state = { memory: new Map(), marks: new Map() } as ReturnType<typeof advanceQuakeMarks>
      types.forEach((type, i) => {
        state = advanceQuakeMarks({
          prev: { memory: state.memory, marks: state.marks },
          key: 'q1',
          snapshot: memoryOf(makeQuake(), [area('能登', 55)], type),
          liveKeys: new Set(['q1']),
          now: 1000 * (i + 1),
        })
      })
      expect([...(state.memory.get('q1')?.rowsByType.keys() ?? [])]).toEqual(types)
    })

    // 正: **一巡して戻ってきた種別でも、同じ種別どうしで比べる。** 上限で写しを落として
    // いた頃は、4 種別を経ただけで最初の種別が追い出され、その種別が再び届いたとき
    // 「初めて見る種別」として初出が出なかった（M5 程度以上でありふれた遷移）。
    it('多くの種別を経たあとでも、最初の種別の続報で初出が出る', () => {
      const path: MarkReportType[] = [
        '震度速報', '震源情報', '震源・震度情報', '各地の震度情報',
        '顕著な地震の震源要素更新のお知らせ',
      ]
      let state = { memory: new Map(), marks: new Map() } as ReturnType<typeof advanceQuakeMarks>
      path.forEach((type, i) => {
        state = advanceQuakeMarks({
          prev: { memory: state.memory, marks: state.marks },
          key: 'q1',
          snapshot: memoryOf(makeQuake(), [area('能登', 55)], type),
          liveKeys: new Set(['q1']),
          now: 1000 * (i + 1),
        })
      })
      // 最初の種別（震度速報）が区域を 1 つ増やして戻ってくる。
      const back = advanceQuakeMarks({
        prev: { memory: state.memory, marks: state.marks },
        key: 'q1',
        snapshot: memoryOf(makeQuake(), [area('能登', 55), area('佐渡', 30)], '震度速報'),
        liveKeys: new Set(['q1']),
        now: 9000,
      })
      expect(back.marks.get('q1')?.rows.get(rowMarkKey.area('佐渡'))).toBe('new')
    })

    // 対照: 動いたものが無ければ印を置かない（TTL の掃除が空の鍵を抱えないように）。
    it('何も動かなければ印を置かない', () => {
      const snapshot = memoryOf(makeQuake(), [station('輪島', 50)])
      const first = advanceQuakeMarks({
        prev: { memory: new Map(), marks: new Map() }, key: 'q1', snapshot, liveKeys: new Set(['q1']), now: 1000,
      })
      const second = advanceQuakeMarks({
        prev: { memory: first.memory, marks: first.marks }, key: 'q1', snapshot, liveKeys: new Set(['q1']), now: 2000,
      })
      expect(second.marks.has('q1')).toBe(false)
    })

    // 正: **報が来たら、その報の差分で付け直す。** 続報が届いた時点で表示は新しくなって
    // いるので、前の報の印が残っていると「いまの報で動いた」と読めてしまう。
    it('動いたものが無い報では前の印を引き継がない', () => {
      const first = advanceQuakeMarks({
        prev: { memory: new Map(), marks: new Map() },
        key: 'q1',
        snapshot: memoryOf(makeQuake({ magnitude: 7.4 }), [station('輪島', 50)]),
        liveKeys: new Set(['q1']), now: 1000,
      })
      const second = advanceQuakeMarks({
        prev: { memory: first.memory, marks: first.marks },
        key: 'q1',
        snapshot: memoryOf(makeQuake({ magnitude: 7.6 }), [station('輪島', 50)]),
        liveKeys: new Set(['q1']), now: 2000,
      })
      expect(second.marks.get('q1')?.facts.get('magnitude')).toBe('raised')
      // 同じ中身のまま、もう 1 通処理される（種別の記録だけが動いた報）。
      const third = advanceQuakeMarks({
        prev: { memory: second.memory, marks: second.marks },
        key: 'q1',
        snapshot: memoryOf(makeQuake({ magnitude: 7.6 }), [station('輪島', 50)]),
        liveKeys: new Set(['q1']), now: 3000,
      })
      expect(third.marks.has('q1')).toBe(false)
    })

    // 安全弁: 一覧から消えたカードの記憶と印は捨てる（群発で観測点の写しが積み上がる）。
    it('一覧に残っていないカードの記憶と印を捨てる', () => {
      const first = advanceQuakeMarks({
        prev: { memory: new Map(), marks: new Map() },
        key: 'gone',
        snapshot: memoryOf(makeQuake(), [station('輪島', 50)]),
        liveKeys: new Set(['gone']),
        now: 1000,
      })
      const second = advanceQuakeMarks({
        prev: { memory: first.memory, marks: first.marks },
        key: 'q2',
        snapshot: memoryOf(makeQuake(), [station('珠洲', 40)]),
        liveKeys: new Set(['q2']),
        now: 2000,
      })
      expect(second.memory.has('gone')).toBe(false)
      expect(second.marks.has('gone')).toBe(false)
    })

    // 安全弁: 長周期の鍵は地震の鍵と混ざらない（行の鍵は同じ名前空間を使うため）。
    it('長周期の印は地震の印と別の鍵に入る', () => {
      const withQuake = advanceQuakeMarks({
        prev: { memory: new Map(), marks: new Map() },
        key: 'q1',
        snapshot: memoryOf(makeQuake(), [station('輪島', 50)]),
        liveKeys: new Set(['q1']),
        now: 1000,
      })
      const withLpgm = advanceQuakeMarks({
        prev: { memory: withQuake.memory, marks: withQuake.marks },
        key: lpgmMarkKey('20240101161000'),
        snapshot: {
          facts: new Map(), rows: lpgmRowSnapshot([{ name: '能登', maxLgInt: 4 }], [], []),
          reportType: 'lpgm' as const, issuedAt: 0, telegramType: 'lpgm' as const, revise: null,
        },
        liveKeys: new Set(['q1', lpgmMarkKey('20240101161000')]),
        now: 2000,
      })
      expect(withLpgm.memory.has('q1')).toBe(true)
      expect(withLpgm.memory.has(lpgmMarkKey('20240101161000'))).toBe(true)
    })

    // 安全弁: 寿命を過ぎた印は落ちる。落とすものが無ければ同じ参照を返す。
    it('寿命を過ぎた印を落とす', () => {
      const marks = new Map([['q1', { facts: new Map(), rows: new Map(), markedAt: 1000 }]])
      expect(pruneQuakeMarks(marks, 1000 + UPDATE_MARK_TTL_MS).size).toBe(0)
      expect(pruneQuakeMarks(marks, 1000 + UPDATE_MARK_TTL_MS - 1)).toBe(marks)
    })
  })

  describe('長周期地震動の行', () => {
    // 正: 階級が動いたら印が出る。
    it('階級が上がったら上がったの印が出る', () => {
      const before = lpgmRowSnapshot([{ name: '能登', maxLgInt: 3 }], [], [])
      const after = lpgmRowSnapshot([{ name: '能登', maxLgInt: 4 }], [], [])
      expect(diffSameType(after, before).get(rowMarkKey.area('能登'))).toBe('raised')
    })

    // 安全弁: 階級が据え置きでも震度だけが動いたら印が出る（カードは 2 つを並べて出す）。
    it('階級が同じでも震度が動いたら印が出る', () => {
      const before = lpgmRowSnapshot([{ name: '能登', maxLgInt: 4, maxInt: 50 }], [], [])
      const after = lpgmRowSnapshot([{ name: '能登', maxLgInt: 4, maxInt: 60 }], [], [])
      expect(diffSameType(after, before).get(rowMarkKey.area('能登'))).toBe('raised')
    })

    // 安全弁: 順序は**階級を主、震度を従**にする。階級が下がったなら、震度が上がっていても
    // 「下がった」と言う（カードが階級を先に出しているのと揃える）。
    it('階級が下がれば、震度が上がっていても下がったの印が出る', () => {
      const before = lpgmRowSnapshot([{ name: '能登', maxLgInt: 4, maxInt: 10 }], [], [])
      const after = lpgmRowSnapshot([{ name: '能登', maxLgInt: 3, maxInt: 70 }], [], [])
      expect(diffSameType(after, before).get(rowMarkKey.area('能登'))).toBe('lowered')
    })
  })

  describe('記憶の刈り込み', () => {
    /** 行 n 件ぶんの写し。刈り込みは行の中身を見ないので、鍵と値は素朴に作る。 */
    const rowsOfSize = (n: number, prefix: string): RowSnapshot =>
      new Map(Array.from({ length: n }, (_, i) => [`${prefix}:${i}`, { key: String(i) }]))

    /**
     * 鍵・行数・発表時刻・最大震度の組から記憶を作る。**渡した順に挿入する**
     * （挿入順に頼っていないことを見るため）。発表時刻を省いたら 0、最大震度を省いたら
     * 「震度の分からない記憶」（落とす順では最後）になる。
     *
     * **`rows` と `rowsByType` へ同じ写しを入れる。** 実装（`advanceQuakeMarks`・
     * `rememberQuakeCard`）がそうしているので、片方だけにすると重さの数え方
     * （`rowCountOf` は `rowsByType` だけを数える）が実物と食い違う。
     */
    const memoryOf = (
      entries: ReadonlyArray<readonly [string, number, number?, number?]>,
    ): Map<string, QuakeMarkMemory> =>
      new Map(entries.map(([key, rows, issuedAt, maxScale]) => {
        const snap = rowsOfSize(rows, key)
        return [key, {
          facts: maxScale === undefined
            ? new Map()
            : new Map([['maxScale', { key: String(maxScale), rank: maxScale }]] as const),
          rows: snap, rowsByType: new Map([['震源・震度情報', snap]]),
          issuedAt: issuedAt ?? 0, telegramType: '震源・震度情報',
        }]
      }))

    /**
     * 刈り込みだけを `advanceQuakeMarks` 経由で走らせる（刈り込み本体は非公開で、
     * `trimQuakeMarkMemory` は「いま届いた報」を持たないため守りの検証には使えない）。
     *
     * **`key` の記憶は渡したものと同じ行数で入れ直す** —— あちらは写しで上書きするので、
     * 元の記憶の `rows` をそのまま写しとして渡す。
     */
    const capViaAdvance = (memory: Map<string, QuakeMarkMemory>, key: string): void => {
      const target = memory.get(key)
      if (!target) throw new Error(`テストの前提が壊れています: ${key} の記憶がありません`)
      const next = advanceQuakeMarks({
        prev: { memory, marks: new Map() },
        key,
        snapshot: {
          facts: target.facts, rows: target.rows,
          reportType: '震源・震度情報', issuedAt: target.issuedAt,
          telegramType: '震源・震度情報', revise: null,
        },
        liveKeys: new Set(memory.keys()),
        now: 0,
      })
      memory.clear()
      for (const [k, v] of next.memory) memory.set(k, v)
    }

    // 正: 群発でも、一覧に出ているカードの記憶は残る。
    //
    // **2024-01-01 能登を模した件数。** 本震の最後の通常報（16:24:31）から顕著な地震の
    // 震源要素更新（21:30:20）までの 5 時間に、本震以外の地震が 67 件発表されていた
    // （控えの実電文 262 通から数えた値）。本震の記憶が落ちると、その震源要素更新で
    // 比べる相手が無くなり印が出ない —— これがこのテストが守る症状。
    //
    // 行数も実測値。本震は観測点 2993・市町村 1343 で、写しは約 4336 行になる。
    it('群発でも、一覧に出ているカードの記憶を落とさない', () => {
      const memory = memoryOf([
        ['main', 4336],
        ...Array.from({ length: 67 }, (_, i) => [`after-${i}`, 12] as const),
      ])
      trimQuakeMarkMemory(memory, new Set(memory.keys()))
      expect(memory.has('main')).toBe(true)
    })

    // 正: 「もっと見る」で古い地震を積んでも、いま画面で見ている地震の記憶は残る。
    //
    // あちらは `prev.quakeMarkMemory` を土台に**古い地震を後から積む**。挿入順を
    // 「最後に触った順」の代理にしていると、取り込んだ古い分が新しい側へ回り、
    // 画面に出ているカードのぶんが先に落ちる。
    it('もっと見るで古い地震を積んでも、新しい地震の記憶を落とさない', () => {
      const memory = memoryOf([
        ['live-new', 12],
        ...Array.from({ length: 40 }, (_, i) => [`older-${i}`, 12] as const),
      ])
      trimQuakeMarkMemory(memory, new Set(memory.keys()))
      expect(memory.has('live-new')).toBe(true)
    })

    // 対照: 行の総数が上限を超えたら落とす。**落ちるのは発表時刻の古い側。**
    //
    // 上限の半分より大きい記憶を 2 件置けば超える。**枚数ではなく重さで切っている**ので、
    // わずか 2 件でも落ちる（前の項は 68 件でも落ちない）。
    it('行の総数が上限を超えたら、発表時刻の古い側から落ちる', () => {
      const half = Math.floor(MARK_MEMORY_MAX_ROWS / 2) + 1
      const memory = memoryOf([
        ['older', half, 1_000],
        ['newer', half, 2_000],
      ])
      trimQuakeMarkMemory(memory, new Set(memory.keys()))
      expect(memory.has('newer')).toBe(true)
      expect(memory.has('older')).toBe(false)
    })

    // 安全弁: 落とす順は**挿入順に依らない**。古い側を後から挿しても、落ちるのは古い側。
    //
    // 「もっと見る」がこの形（既存の記憶へ古い地震を後から積む）。挿入順を代理にしていた
    // 頃は、ここで新しい側が落ちていた。
    it('古い地震を後から挿しても、落ちるのは古い側', () => {
      const half = Math.floor(MARK_MEMORY_MAX_ROWS / 2) + 1
      const memory = memoryOf([
        ['newer', half, 2_000],
        ['older', half, 1_000],
      ])
      trimQuakeMarkMemory(memory, new Set(memory.keys()))
      expect(memory.has('newer')).toBe(true)
      expect(memory.has('older')).toBe(false)
    })

    // 正: 上限を超えていても、**いま届いた報の記憶**は落とさない。
    //
    // 落とすと、次の続報が比べる相手を失って印が出なくなる —— 記憶を作った意味がその場で
    // 消える。**発表時刻が読めない報でとくに要る**（`markIssuedAt` が 0 へ倒すので、
    // 並びのいちばん前＝最初に落とす側に来る）。
    it('いま届いた報の記憶は、上限を超えても落とさない', () => {
      const half = Math.floor(MARK_MEMORY_MAX_ROWS / 2) + 1
      const memory = memoryOf([
        ['old-big', half, 9_000],
        // 発表時刻が読めなかった報（`markIssuedAt` の 0 フォールバック）。
        ['just-arrived', half, 0],
      ])
      capViaAdvance(memory, 'just-arrived')
      expect(memory.has('just-arrived')).toBe(true)
      expect(memory.has('old-big')).toBe(false)
    })

    // 安全弁: 守った 1 件だけで上限を超えても、その記憶は残る（落とせる相手が無くなっても
    // 守りを解かない）。本震級 1 件が上限を単独で超える規模に育った場合がこれ。
    it('守った 1 件だけで上限を超えても、その記憶は残る', () => {
      const memory = memoryOf([['huge', MARK_MEMORY_MAX_ROWS + 1, 0]])
      capViaAdvance(memory, 'huge')
      expect(memory.has('huge')).toBe(true)
    })

    // 正: 群発の静穏期でも、**本震の記憶は余震に押されて落ちない**。
    //
    // 能登本震は最後の通常報（16:24）から**5 時間沈黙したあと**に震源要素更新（21:30）が
    // 届いた。その 5 時間に余震が 67 件発表されるので、**発表時刻で落とす順を決めると本震が
    // いちばん古くなり真っ先に落ちる** —— この機能が直そうとした症状そのものが、別の経路で
    // 戻ることになる。最大震度で並べれば本震は最後まで残る。
    it('静穏期の本震の記憶は、あとから来た余震に押されても落ちない', () => {
      const half = Math.floor(MARK_MEMORY_MAX_ROWS / 2) + 1
      const memory = memoryOf([
        // 本震（震度7）。発表時刻はいちばん古い。
        ['main', half, 1_000, 70],
        // あとから届いた余震（震度2）。発表時刻は新しい。
        ['after', half, 9_000, 20],
      ])
      // 刈り込みを起こすのは別の地震の受信（本震は `keep` で守られない）。
      memory.set('trigger', { facts: new Map(), rows: new Map(), rowsByType: new Map(), issuedAt: 9_500, telegramType: null })
      capViaAdvance(memory, 'trigger')
      expect(memory.has('main')).toBe(true)
      expect(memory.has('after')).toBe(false)
    })

    // 対照: 最大震度が同じなら、発表時刻の古い側から落ちる（第 2 キーが効いている）。
    it('最大震度が同じなら、発表時刻の古い側から落ちる', () => {
      const half = Math.floor(MARK_MEMORY_MAX_ROWS / 2) + 1
      const memory = memoryOf([
        ['older', half, 1_000, 40],
        ['newer', half, 2_000, 40],
      ])
      trimQuakeMarkMemory(memory, new Set(memory.keys()))
      expect(memory.has('newer')).toBe(true)
      expect(memory.has('older')).toBe(false)
    })

    // 安全弁: **震度の分からない記憶は最後に落とす。** 長周期地震動の記憶がこれ（別の鍵で
    // 持つので地震側の震度を引けない）。先に落とす側へ倒すと、行が少なくて空く余地も小さい
    // ものから落ちることになり、刈り込みが何度も走るだけになる。
    it('震度の分からない記憶は、震度を持つ記憶より後に落ちる', () => {
      const half = Math.floor(MARK_MEMORY_MAX_ROWS / 2) + 1
      const memory = memoryOf([
        // 長周期の記憶を模したもの（`facts` が空）。
        ['lpgm:X', half, 1_000],
        // 震度2 の余震。発表時刻はこちらが新しい。
        ['weak', half, 9_000, 20],
      ])
      trimQuakeMarkMemory(memory, new Set(memory.keys()))
      expect(memory.has('lpgm:X')).toBe(true)
      expect(memory.has('weak')).toBe(false)
    })

    // 安全弁: **震度の分からない記憶が 2 件以上並んでも、並べ方が壊れない。**
    //
    // 震度が分からない記憶は落とす順を `Infinity` へ倒すので、引き算で比べると
    // `Infinity - Infinity` が `NaN` になり、**並べ方そのものが未定義へ落ちる**
    // （第 2 キーの発表時刻へも進まない）。長周期の記憶が 2 件あれば起きる。
    it('震度の分からない記憶が並んでも、発表時刻の古い側から落ちる', () => {
      const half = Math.floor(MARK_MEMORY_MAX_ROWS / 2) + 1
      const memory = memoryOf([
        ['lpgm:newer', half, 2_000],
        ['lpgm:older', half, 1_000],
      ])
      trimQuakeMarkMemory(memory, new Set(memory.keys()))
      expect(memory.has('lpgm:newer')).toBe(true)
      expect(memory.has('lpgm:older')).toBe(false)
    })

    // 安全弁: 一覧から消えたカードの記憶は、上限に余裕があっても落とす。
    it('一覧に無いカードの記憶は落とす', () => {
      const memory = memoryOf([['gone', 12], ['alive', 12]])
      trimQuakeMarkMemory(memory, new Set(['alive']))
      expect(memory.has('gone')).toBe(false)
      expect(memory.has('alive')).toBe(true)
    })
  })
})

describe('電文の Revise で行の印を付ける', () => {
  /** DMDATA の電文の観測点（県名を持たない。県名を持つのは県の点だけ）。 */
  const dmStation = (addr: string, scale: IntensityScale, over: Partial<EarthquakePoint> = {}): EarthquakePoint =>
    station(addr, scale, { pref: '', ...over })

  /** DMDATA の震源・震度情報の続報（`reportsRevise` が真）。 */
  const reviseQuake = (points: EarthquakePoint[], cities: JMAQuakeCity[] = []): JMAQuake =>
    ({ ...makeQuake(), points, cities, reportsRevise: true }) as JMAQuake

  /** 同じ地震へ 2 通当てる。1 通目の電文の種別と 2 通目の写し・`Revise` を渡す。 */
  const marksOf = (
    prevPoints: EarthquakePoint[],
    curPoints: EarthquakePoint[],
    opts: {
      prevTelegramType: MarkReportType | null
      telegram: JMAQuake
      cities?: { prev?: JMAQuakeCity[]; cur?: JMAQuakeCity[] }
    },
  ) => {
    const q = makeQuake()
    const first = advanceQuakeMarks({
      prev: { memory: new Map(), marks: new Map() },
      key: 'q1',
      snapshot: {
        facts: quakeFactSnapshot(q), rows: snapRows(prevPoints, opts.cities?.prev ?? []),
        reportType: '震源・震度情報', issuedAt: 0, telegramType: opts.prevTelegramType, revise: null,
      },
      liveKeys: new Set(['q1']),
      now: 0,
    })
    return advanceQuakeMarks({
      prev: first,
      key: 'q1',
      snapshot: {
        facts: quakeFactSnapshot(q), rows: snapRows(curPoints, opts.cities?.cur ?? []),
        reportType: '震源・震度情報', issuedAt: 1, telegramType: opts.telegram.issue.type,
        revise: quakeTelegramRevise(opts.telegram),
      },
      liveKeys: new Set(['q1']),
      now: 1,
    }).marks.get('q1')?.rows ?? new Map()
  }

  // 正: 同じ種別の続報では、`Revise` の付いた行に電文どおりの印が付く（追加＝初出・上方修正＝上がった）。
  it('同じ種別の続報では Revise の付いた行に電文どおりの印を付ける', () => {
    const cur = [
      dmStation('輪島市鳳至町', 60, { revise: '上方修正' }),
      dmStation('珠洲市正院町', 50, { revise: '追加' }),
      { pref: '', addr: '石川県能登', isArea: true, scale: 60, revise: '上方修正' } as EarthquakePoint,
    ]
    const telegram = reviseQuake(cur, [city('輪島市', '石川県能登', 60, { revise: '追加' })])
    const rows = marksOf(
      [dmStation('輪島市鳳至町', 50), area('石川県能登', 50)],
      cur,
      { prevTelegramType: '震源・震度情報', telegram, cities: { cur: [city('輪島市', '石川県能登', 60)] } },
    )
    expect(rows.get(rowMarkKey.station('輪島市鳳至町'))).toBe('raised')
    expect(rows.get(rowMarkKey.station('珠洲市正院町'))).toBe('new')
    expect(rows.get(rowMarkKey.area('石川県能登'))).toBe('raised')
    expect(rows.get(rowMarkKey.city('石川県能登', '輪島市'))).toBe('new')
  })

  // 正: `Revise` が受け持つ段では、**`Revise` の無い行に差分の印を付けない**（電文は「動いていない」と言っている）。
  // **差分と食い違ったことは記録に残す**（全期間の控えでは起きていない形。崩れたとき画面からは見分けが付かない）。
  it('Revise の無い行は値が違って見えても印を付けず、食い違いを記録に残す', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const cur = [dmStation('輪島市鳳至町', 60)]
      const rows = marksOf([dmStation('輪島市鳳至町', 50)], cur, {
        prevTelegramType: '震源・震度情報', telegram: reviseQuake(cur),
      })
      expect(rows.size).toBe(0)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toMatch(/^\[quake\] .*Revise の無い行がある/)
    } finally {
      warn.mockRestore()
    }
  })

  // 正: 一部の行にだけ `Revise` が欠けた形も記録に残す（ほかの行に `Revise` があっても黙らない）。
  it('一部の行にだけ Revise が欠けても記録に残す', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const cur = [
        dmStation('輪島市鳳至町', 60, { revise: '上方修正' }),
        dmStation('珠洲市正院町', 60),
      ]
      const rows = marksOf([dmStation('輪島市鳳至町', 50), dmStation('珠洲市正院町', 50)], cur, {
        prevTelegramType: '震源・震度情報', telegram: reviseQuake(cur),
      })
      expect(rows.get(rowMarkKey.station('輪島市鳳至町'))).toBe('raised')
      expect(rows.has(rowMarkKey.station('珠洲市正院町'))).toBe(false)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][1]).toMatchObject({ rows: 1 })
    } finally {
      warn.mockRestore()
    }
  })

  // 対照: `Revise` が 0 件でも、差分でも何も動いていなければ記録しない（全期間の控えの 4 通はこの形）。
  it('Revise が 0 件で差分も動いていなければ記録しない', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const cur = [dmStation('輪島市鳳至町', 50)]
      const rows = marksOf([dmStation('輪島市鳳至町', 50)], cur, {
        prevTelegramType: '震源・震度情報', telegram: reviseQuake(cur),
      })
      expect(rows.size).toBe(0)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  // 対照: 直前の電文と種別が違えば `Revise` は使わず、今の差分で付ける（2026-10-21 ユーザー承認「おすすめで」）。
  it('直前の電文と種別が違えば今の差分で付ける', () => {
    const cur = [dmStation('輪島市鳳至町', 60, { revise: '追加' })]
    const rows = marksOf([dmStation('輪島市鳳至町', 50)], cur, {
      prevTelegramType: '震度速報', telegram: reviseQuake(cur),
    })
    expect(rows.get(rowMarkKey.station('輪島市鳳至町'))).toBe('raised')
  })

  // 安全弁: 直前の記憶が電文の報でない（取消を当て直した姿）なら、`Revise` は使わない。
  it('直前の記憶が電文の報でなければ Revise を使わない', () => {
    const cur = [dmStation('輪島市鳳至町', 60)]
    const rows = marksOf([dmStation('輪島市鳳至町', 50)], cur, {
      prevTelegramType: null, telegram: reviseQuake(cur),
    })
    expect(rows.get(rowMarkKey.station('輪島市鳳至町'))).toBe('raised')
  })

  // 安全弁: カードの一覧に無い行の `Revise` は印にしない（指す先が無い）。
  // 捨てた数は記録に残す（鍵の作り方がカード側とずれると、ずれた行だけ印が永久に出なくなる）。
  it('カードに無い行の Revise は印にせず、捨てた数を記録に残す', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const telegram = reviseQuake([dmStation('幻の観測点', 30, { revise: '追加' })])
      const rows = marksOf([dmStation('輪島市鳳至町', 50)], [dmStation('輪島市鳳至町', 50)], {
        prevTelegramType: '震源・震度情報', telegram,
      })
      expect(rows.size).toBe(0)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][1]).toMatchObject({ dropped: 1 })
    } finally {
      warn.mockRestore()
    }
  })

  // 安全弁: `reportsRevise` を持たない電文（P2PQuake・震度速報）は `Revise` を作らない。
  it('Revise で変化を伝えない電文では作らない', () => {
    expect(quakeTelegramRevise(makeQuake())).toBeNull()
  })

  // 安全弁: 知らない語は電文の印にせず、記録に残す（黙って捨てると「動いていない」と見分けが付かない）。
  it('知らない Revise の語は印にせず記録に残す', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const revise = quakeTelegramRevise(reviseQuake([dmStation('輪島市鳳至町', 60, { revise: '新語' })]))
      expect(revise?.marks.size).toBe(0)
      expect(revise?.unreadable).toEqual(new Set([rowMarkKey.station('輪島市鳳至町')]))
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  // 安全弁: 知らない語の行は差分の印を残す（電文が何か言っているのに読めないので「動いていない」とは扱えない）。
  // 対照として、同じ電文の `Revise` の無い行は差分が動いていても印を付けない。
  it('知らない Revise の語の行だけは差分の印を残す', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const cur = [
        dmStation('輪島市鳳至町', 60, { revise: '新語' }),
        dmStation('珠洲市正院町', 60),
      ]
      const rows = marksOf([dmStation('輪島市鳳至町', 50), dmStation('珠洲市正院町', 50)], cur, {
        prevTelegramType: '震源・震度情報', telegram: reviseQuake(cur),
      })
      expect(rows.get(rowMarkKey.station('輪島市鳳至町'))).toBe('raised')
      expect(rows.has(rowMarkKey.station('珠洲市正院町'))).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  /** 長周期の同じ地震へ 2 通当てる（1 通目は印の記憶を作るだけ）。 */
  const lpgmMarksOf = (prevLg: number, cur: { pref: number; area: number; station: number }, lpgm: JMALpgm) => {
    const first = advanceQuakeMarks({
      prev: { memory: new Map(), marks: new Map() },
      key: lpgmMarkKey('e'),
      snapshot: {
        facts: new Map(),
        rows: lpgmRowSnapshot([{ name: '石川県能登', maxLgInt: prevLg }], [{ name: '輪島', lgInt: prevLg }], [{ name: '石川県', maxLgInt: prevLg }]),
        reportType: 'lpgm', issuedAt: 0, telegramType: 'lpgm', revise: null,
      },
      liveKeys: new Set([lpgmMarkKey('e')]),
      now: 0,
    })
    return advanceQuakeMarks({
      prev: first,
      key: lpgmMarkKey('e'),
      snapshot: {
        facts: new Map(),
        rows: lpgmRowSnapshot([{ name: '石川県能登', maxLgInt: cur.area }], [{ name: '輪島', lgInt: cur.station }], [{ name: '石川県', maxLgInt: cur.pref }]),
        reportType: 'lpgm', issuedAt: 1, telegramType: 'lpgm', revise: lpgmTelegramRevise(lpgm),
      },
      liveKeys: new Set([lpgmMarkKey('e')]),
      now: 1,
    }).marks.get(lpgmMarkKey('e'))?.rows
  }

  // 正・安全弁: 長周期は県・区域だけを `Revise` で付け、`Revise` を持たない観測点は差分のまま。
  it('長周期は県と区域を Revise で付け、観測点は差分で付ける', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const lpgm = {
        id: 'L1',
        reportsRevise: true,
        prefs: [{ code: '17', name: '石川県', maxLgInt: 3, revise: '上方修正' }],
        regions: [{ code: '390', name: '石川県能登', maxLgInt: 3 }],
        points: [],
      } as unknown as JMALpgm
      expect(lpgmTelegramRevise(lpgm)?.kinds).toEqual(['pref:', 'area:'])
      const rows = lpgmMarksOf(2, { pref: 3, area: 3, station: 3 }, lpgm)
      expect(rows?.get(rowMarkKey.pref('石川県'))).toBe('raised')
      // 区域は Revise が無いので「動いていない」（差分では上がって見えても付けない）
      expect(rows?.has(rowMarkKey.area('石川県能登'))).toBe(false)
      // 観測点は電文が Revise を持たないので差分のまま
      expect(rows?.get(rowMarkKey.station('輪島'))).toBe('raised')
      // 区域は差分では動いたのに Revise が無い —— 前提が崩れた形として長周期の印で記録に残す
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toMatch(/^\[lpgm\] /)
    } finally {
      warn.mockRestore()
    }
  })

  // 対照: 長周期で観測点だけが動いた報は記録しない（観測点の段は `Revise` の受け持ちではない）。
  it('長周期で観測点だけが動いた報は Revise が 0 件でも記録しない', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const lpgm = {
        id: 'L1',
        reportsRevise: true,
        prefs: [{ code: '17', name: '石川県', maxLgInt: 2 }],
        regions: [{ code: '390', name: '石川県能登', maxLgInt: 2 }],
        points: [],
      } as unknown as JMALpgm
      const rows = lpgmMarksOf(2, { pref: 2, area: 2, station: 3 }, lpgm)
      expect(rows?.get(rowMarkKey.station('輪島'))).toBe('raised')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
