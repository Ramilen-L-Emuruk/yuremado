// @vitest-environment jsdom
//
// テストボタンの台本（`testTelegramScripts.ts`）を、置いてある電文 XML から実際に組んで確かめる。
// パーサーが DOMParser を使うので jsdom で動かす。
//
// **確かめるのは「確かめたい形が実電文（と書き換え）から本当に出ているか」。** 手で内部型を
// 組んでいた頃の検査（`testData.test.ts`）のうち、地震情報のボタンに当たるものをここへ移した。
// 標準版を P2PQuake の形へ寄せる検査は移していない —— P2PQuake は廃止する予定で、テストボタンは
// 両版とも同じ XML の読み取り結果を流す（2026-10-22 ユーザー原文「XMLにしましょう。近いうちに2つは
// 統合するので。」「統合すると言うかP2PQuakeは廃止する」）。
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EEWAlert, JMALpgm, JMAQuake, JMATsunami } from '../types/earthquake'
import type { ReplayPayload } from '../types/replay'
import { buildTestTelegramEntries, clearTestTelegramCacheForTest, type BuiltTestTelegram, type TestTelegramScript } from './testTelegrams'
import * as scripts from './testTelegramScripts'
import { mergeQuakeInto, mergeQuakeHistory, extractQuakeEventId } from './quakeMerge'
import { eewAreas, eewMaxScale, computeSingleEEWLevel, isProvisionalHypocenter } from './eew'
import { earthquakeToSegments, createQuakeSpokenState, applySpokenRefs } from './ttsText'
import { joinSegments } from './ttsFollow'
import { reportsText } from '../test-utils/quakeReports'

const NOW = new Date('2026-10-22T03:00:00.000Z')

// **`new URL(\`…${file}\`, import.meta.url)` の形で書かないこと。** Vite はこの形を静的な資材の参照へ
// 書き換え、`public` 配下は対象外なので `undefined` を返す（全件が「ファイルが無い」で落ちる）。
const TELEGRAM_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../public/data/test-telegrams')
const fetcher = async (file: string): Promise<string> => readFileSync(join(TELEGRAM_DIR, file), 'utf8')
const binaryFetcher = async (file: string): Promise<Uint8Array> => new Uint8Array(readFileSync(join(TELEGRAM_DIR, file)))

async function build(script: TestTelegramScript, isDmdss = true): Promise<BuiltTestTelegram[]> {
  return buildTestTelegramEntries(script, { isDmdss, now: NOW, fetcher, binaryFetcher })
}

const payloads = (built: BuiltTestTelegram[]): ReplayPayload[] => built.map(b => b.entry.payload)

function quakesOf(built: BuiltTestTelegram[]): JMAQuake[] {
  return payloads(built).flatMap(p => (p.kind === 'event' && p.event.kind === 'quake' ? [p.event] : []))
}

function lpgmsOf(built: BuiltTestTelegram[]): JMALpgm[] {
  return payloads(built).flatMap(p => (p.kind === 'lpgm' ? [p.data] : []))
}

beforeEach(() => clearTestTelegramCacheForTest())

describe('台本はどれも置いてある電文から組める', () => {
  for (const [name, script] of Object.entries(scripts.ALL_TEST_TELEGRAM_SCRIPTS)) {
    it.each([true, false])(`${name}（DMDSS 版 = %s）`, async (isDmdss) => {
      const built = await build(script, isDmdss)
      expect(built.length).toBeGreaterThan(0)
      // 流す時刻は押した時刻から、台本の順に並ぶ
      const times = built.map(b => b.entry.replayTime.getTime())
      expect(times[0]).toBe(NOW.getTime())
      expect(times).toEqual([...times].sort((a, b) => a - b))
      // **届く時刻より先の発表時刻を持たない。** 先だと、画面に出る時刻が未来になるうえ、
      // 報の新旧を作成時刻で比べる経路（→ quake-spec.md §6.3）が実配信と違う並びを見る。
      // **押すたびに進む台本は対象外** —— 届く時刻は押した人が決めるので、電文どうしの間隔より
      // 速く押せばその分だけ発表時刻が先になる。
      // **`pacedByApp` の台本も対象外** —— 届く時刻はアプリが決める（取消は自動解除の後）
      if (!script.stepByPress && !script.pacedByApp) {
        for (const b of built) {
          const p = b.entry.payload
          const issued = Date.parse(p.kind === 'event' ? p.event.time : p.data.time)
          // **取消の報は時刻を持たない**（実配信どおり。→ eew-spec.md §8）。比べる相手が無い
          if (!Number.isFinite(issued)) continue
          expect(`${b.step.file} ${new Date(issued).toISOString()}`)
            .toBe(`${b.step.file} ${new Date(Math.min(issued, b.entry.replayTime.getTime())).toISOString()}`)
        }
      }
      // **観測状況を確定した時刻は、発表時刻より後にならない。** その時刻までの観測をまとめた
      // のが観測情報なので、後にあると**まだ来ていない波を観測した**ことになる
      // （→ docs/spec/tsunami-spec.md §4「観測状況を確定した時刻」）。
      for (const b of built) {
        const p = b.entry.payload
        if (p.kind !== 'event' || p.event.kind !== 'tsunami') continue
        const observed = p.event.observationDateTime
        if (!observed) continue
        expect(`${b.step.file} ${observed}`)
          .toBe(`${b.step.file} ${new Date(Math.min(Date.parse(observed), Date.parse(p.event.time))).toISOString()}`)
      }
    })
  }

  // 安全弁: 基準にした報の時刻が「いま」になり、ほかの報はそれより前（未来の発表時刻は実配信に無い）
  it('地震情報の台本は、最後の報の発表時刻が「いま」で、どの報もそれより前', async () => {
    for (const script of [scripts.QUAKE_REPORT_SEQUENCE, scripts.QUAKE_AMENDMENT, scripts.QUAKE_CANCEL, scripts.QUAKE_PARTIAL_CANCEL]) {
      const quakes = quakesOf(await build(script))
      const times = quakes.map(q => Date.parse(q.time))
      expect(Math.max(...times)).toBe(Date.parse(quakes[script.anchor].time))
      for (const t of times) expect(t).toBeLessThanOrEqual(NOW.getTime())
    }
  })

  // 安全弁: **二進電文（推計震度分布図）も同じ時間軸に乗る。** 発表時刻を本文に持たないので
  // 外から渡しており、実時刻を入れると寄せが二重に効いて何年も先の報になる（実測 2029 年）。
  it('二進電文の発表時刻が、台本の時間軸に乗る', async () => {
    const built = await build(scripts.ESTIMATED_INTENSITY)
    const binary = built.filter(b => b.entry.payload.kind === 'estimatedIntensity')
    expect(binary).toHaveLength(2)
    for (const b of binary) {
      const issued = Date.parse(b.entry.payload.kind === 'estimatedIntensity' ? b.entry.payload.data.time : '')
      expect(issued).toBe(b.entry.replayTime.getTime())
    }
  })

  // 安全弁: 押すたびに進む台本は、段の添字を押下の回数に使う。バリアントで段が落ちるとずれる
  it('押すたびに進む台本は、バリアントで段を分けられない', async () => {
    const broken: TestTelegramScript = {
      ...scripts.EEW_FORECAST,
      steps: scripts.EEW_FORECAST.steps.map((s, i) => (i === 1 ? { ...s, onlyIn: 'dmdss' as const } : s)),
    }
    await expect(build(broken, false)).rejects.toThrow('バリアントで段を分けられません')
    // 対照: 分けていなければ通る
    await expect(build(scripts.EEW_FORECAST, false)).resolves.toBeDefined()
  })
})

describe('地震テスト', () => {
  it('能登本震の報番号 2 を、DMDATA 経路の形で流す', async () => {
    const [quake] = quakesOf(await build(scripts.EARTHQUAKE))
    expect(quake.issue.type).toBe('震源・震度情報')
    expect(quake.earthquake.hypocenter.magnitude).toBe(7.6)
    expect(quake.earthquake.maxScale).toBe(70)
    // 観測点・区域は pref 空、都道府県は別のロールアップ点として立つ（→ quake-spec.md §4）
    expect(quake.points.filter(p => !p.isArea).every(p => p.pref === '')).toBe(true)
    expect(quake.points.some(p => p.isArea && p.pref !== '' && p.pref === p.addr)).toBe(true)
    // 観測点が市町村に紐付く（4 段目が出る）
    expect(quake.points.some(p => !p.isArea && p.city)).toBe(true)
  })

  it('実電文が持つ項目がそのまま入る（震央補助表現・気象庁以外の印・付加文 2 種）', async () => {
    const [quake] = quakesOf(await build(scripts.EARTHQUAKE))
    expect(quake.earthquake.hypocenter.nameFromMark).toBe('輪島の東北東３０ｋｍ付近')
    expect(quake.points.some(p => p.nonJma)).toBe(true)
    expect(quake.varCommentText).toContain('震源要素を訂正します。')
    expect(quake.varCommentText).toContain('＊印は気象庁以外の震度観測点')
    expect(quake.forecastText).toContain('緊急地震速報を発表しています')
    // 0256 を持っていても訂正報ではない（気象庁は発表報に付けている）
    expect(quake.issue.correct).toBe('なし')
  })

  // 正・対照: 長周期地震動は DMDSS 版だけ（電文そのものが標準版の受信元から届かない）
  it('長周期地震動は DMDSS 版だけで流し、地震と同じ識別子に紐付く', async () => {
    const dmdss = payloads(await build(scripts.EARTHQUAKE, true))
    const lpgm = dmdss.find(p => p.kind === 'lpgm')
    expect(lpgm).toBeDefined()
    const quake = quakesOf(await build(scripts.EARTHQUAKE, true))[0]
    expect(lpgm!.kind === 'lpgm' && lpgm!.data.eventId).toBe(extractQuakeEventId(quake))
    expect(payloads(await build(scripts.EARTHQUAKE, false)).some(p => p.kind === 'lpgm')).toBe(false)
  })

  // 正: 長周期地震動にも、気象庁以外が運用する観測点の印が 1 点だけ立つ。**元の電文には 1 件も無い**
  // ので、ここで立てないと表示の経路を実機で一度も通せない（→ `markFirstLgStation`）。
  it('長周期地震動の先頭 1 点に、気象庁以外の観測点の印が立つ', async () => {
    const lpgm = lpgmsOf(await build(scripts.EARTHQUAKE, true))[0]!
    const marked = (lpgm.points ?? []).filter(pt => pt.nonJma)
    expect(marked.length).toBe(1)
    // 印は名前から外れている（引き当てのため。→ quake-spec.md §8）
    expect(marked[0]!.name.endsWith('＊')).toBe(false)
  })

  // 安全弁: 押すたびに別の地震になる（同じ識別子のまま 2 回押すと、続報として 1 枚に畳まれる）
  it('押すたびに識別子が付け替わる', async () => {
    const first = quakesOf(await build(scripts.EARTHQUAKE))[0]
    const second = quakesOf(await buildTestTelegramEntries(scripts.EARTHQUAKE, { isDmdss: true, now: new Date(NOW.getTime() + 1000), fetcher, binaryFetcher }))[0]
    expect(first.eventId).toMatch(/^\d{14}$/)
    expect(second.eventId).not.toBe(first.eventId)
  })
})

describe('訓練報テスト', () => {
  it('運用種別だけが「訓練」になる（中身は地震テストと同じ）', async () => {
    const [training] = quakesOf(await build(scripts.TRAINING_QUAKE))
    const [normal] = quakesOf(await build(scripts.EARTHQUAKE))
    expect(training.operationStatus).toBe('訓練')
    expect(normal.operationStatus).toBeUndefined()
    expect(training.points.length).toBe(normal.points.length)
  })
})

describe('種別遷移テスト', () => {
  it('震度速報 → 震源情報 → 震度速報 → 震源・震度情報 → その続報 → 完全版後の震度速報 → 震度が動いた続報 の 7 通', async () => {
    const quakes = quakesOf(await build(scripts.QUAKE_REPORT_SEQUENCE))
    expect(quakes.map(q => q.issue.type))
      .toEqual(['震度速報', '震源情報', '震度速報', '震源・震度情報', '震源・震度情報', '震度速報', '震源・震度情報'])
    expect(quakes.map(q => q.reportSerial)).toEqual([undefined, undefined, undefined, 1, 2, undefined, 3])
  })

  it('統合すると見出しが「震度速報#2/震源情報」を経て「震源・震度情報」になる', async () => {
    const quakes = quakesOf(await build(scripts.QUAKE_REPORT_SEQUENCE))
    const headlineAfter = (count: number): string => {
      let card: JMAQuake | undefined
      for (const q of quakes.slice(0, count)) card = mergeQuakeInto(card, q)
      return reportsText(card!.reports, card!.issue.type)
    }
    expect(headlineAfter(1)).toBe('震度速報')
    expect(headlineAfter(2)).toBe('震度速報/震源情報')
    expect(headlineAfter(3)).toBe('震度速報#2/震源情報')
    expect(headlineAfter(4)).toBe('震源・震度情報')
  })

  // 安全弁: 鍵が報ごとに違う（同じ電文を 2 回流す報も、発表時刻を動かしてある）
  it('一意鍵は報ごとに違い、7 通とも同じ地震を指す', async () => {
    const quakes = quakesOf(await build(scripts.QUAKE_REPORT_SEQUENCE))
    expect(new Set(quakes.map(q => q.telegramKey)).size).toBe(7)
    expect(new Set(quakes.map(q => extractQuakeEventId(q))).size).toBe(1)
  })

  it('5 通目は観測点・市町村だけが増え、区域の最大震度は動かない', async () => {
    const [, , , detail, followUp] = quakesOf(await build(scripts.QUAKE_REPORT_SEQUENCE))
    expect(followUp.points.filter(p => !p.isArea).length).toBeGreaterThan(detail.points.filter(p => !p.isArea).length)
    expect((followUp.cities ?? []).length).toBeGreaterThan((detail.cities ?? []).length)
    const areasOf = (q: JMAQuake) => q.points.filter(p => p.isArea).map(p => `${p.addr}=${p.scale}`).sort()
    expect(areasOf(followUp)).toEqual(areasOf(detail))
    expect(followUp.earthquake.maxScale).toBe(detail.earthquake.maxScale)
  })

  // 正: 読み上げが実際に「観測地点が追加されましたが」と読む（このデータの目的そのもの）
  it('5 通目は「観測地点が追加されましたが」と読まれる', async () => {
    const quakes = quakesOf(await build(scripts.QUAKE_REPORT_SEQUENCE))
    const opts = { intensityLevels: 2, maxRegions: 0, alwaysReadScale: -1, regionTolerance: 0 }
    const state = createQuakeSpokenState()
    quakes.slice(0, 4).forEach((report, i) => {
      const authoritative = report.issue.type === '震源・震度情報'
      const segs = earthquakeToSegments(report, opts, i === 0, state, authoritative)
      applySpokenRefs(state, segs.flatMap(s => s.refs))
    })
    expect(joinSegments(earthquakeToSegments(quakes[4], opts, false, state)))
      .toBe('地震情報が更新されました。観測地点が追加されましたが、地域ごとの最大震度は変わっていません。')
  })

  // 正: 6 通目（完全版のあとの震度速報）は据え置かれる
  it('6 通目を流してもカードの中身が動かない', async () => {
    const quakes = quakesOf(await build(scripts.QUAKE_REPORT_SEQUENCE))
    let card: JMAQuake | undefined
    for (const q of quakes.slice(0, 5)) card = mergeQuakeInto(card, q)
    const after = mergeQuakeInto(card, quakes[5])
    expect(after.points.length).toBe(card!.points.length)
    expect(after.cities?.length).toBe(card!.cities?.length)
    expect(after.issue.type).toBe(card!.issue.type)
  })

  // 対照: 6 通目は据え置きが無ければ中身を痩せさせる形（区域だけ・発表時刻は新しい）
  it('6 通目は完全版より内容が乏しく、発表時刻は新しい', async () => {
    const quakes = quakesOf(await build(scripts.QUAKE_REPORT_SEQUENCE))
    expect(quakes[5].points.every(p => p.isArea)).toBe(true)
    expect(quakes[5].points.length).toBeLessThan(quakes[4].points.length)
    expect(Date.parse(quakes[5].time)).toBeGreaterThan(Date.parse(quakes[4].time))
  })

  it('7 通目は一部の観測点の震度が上がり、一部が下がる（顔ぶれは変わらない）', async () => {
    const quakes = quakesOf(await build(scripts.QUAKE_REPORT_SEQUENCE))
    const scaleByAddr = (q: JMAQuake) => new Map(q.points.filter(p => !p.isArea).map(p => [p.addr, p.scale]))
    const before = scaleByAddr(quakes[4])
    const after = scaleByAddr(quakes[6])
    const risen = [...after].filter(([a, s]) => (before.get(a) ?? -1) < s)
    const fallen = [...after].filter(([a, s]) => (before.get(a) ?? -1) > s)
    expect(risen.length).toBeGreaterThan(0)
    expect(fallen.length).toBeGreaterThan(0)
    expect(risen.length + fallen.length).toBeLessThan(before.size)
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    // 安全弁: 地震全体の最大震度は下がらない（市町村でいちばん強い観測点は下げない）。
    // 下がると、確かめたい行の印ではなく最大震度の下方修正になる（実機で一度そうなった）
    expect(quakes[6].earthquake.maxScale).toBe(quakes[4].earthquake.maxScale)
  })

  it('受信経路を通すと 1 枚のカードへ合流する', async () => {
    const { cards } = mergeQuakeHistory(quakesOf(await build(scripts.QUAKE_REPORT_SEQUENCE)), [], [], null)
    expect(cards).toHaveLength(1)
    expect(reportsText(cards[0].reports, cards[0].issue.type)).toBe('震源・震度情報#3')
  })

  // 正: **動いた行は電文の印（`Revise`）を持つ。** 同じ種別の続報では、アプリは電文の印だけを
  // 採り、差分からは付けない（→ `utils/quakeUpdateMark.ts`）。付いていないと行が 1 つも光らない。
  it('5 通目は増えた行へ「追加」、7 通目は動いた行へ「上方修正」「下方修正」が付く', async () => {
    const quakes = quakesOf(await build(scripts.QUAKE_REPORT_SEQUENCE))
    const revises = (q: JMAQuake): string[] =>
      (q.points ?? []).flatMap(p => (p.revise ? [p.revise] : []))
    // 4 通目（抜いた形）は印を持たない —— 初報に印は出さない
    expect(revises(quakes[3])).toEqual([])
    // 5 通目: 抜いた分が戻り、その行に「追加」が付く
    expect(new Set(revises(quakes[4]))).toEqual(new Set(['追加']))
    expect(revises(quakes[4]).length).toBeGreaterThan(0)
    // 7 通目: 上がった行と下がった行で印が分かれる
    expect(new Set(revises(quakes[6]))).toEqual(new Set(['上方修正', '下方修正']))
  })

  // 正: **1 通目は震度が出そろっていない。** 3 通目で上がるので、カードの最大震度の更新と
  // ブラウザ通知の「最大震度更新」を実機で通せる（→ `lowerAreaInts`）。
  it('速報の 1 通目は区域の最大震度が 1 段低く、3 通目で上がる', async () => {
    const quakes = quakesOf(await build(scripts.QUAKE_REPORT_SEQUENCE))
    expect(quakes[0].earthquake.maxScale).toBe(45)
    expect(quakes[2].earthquake.maxScale).toBe(50)
  })
})

describe('訂正報テスト', () => {
  it('初報は M7.4・訂正なし、訂正報は M7.6・「震源を訂正」の印を持つ', async () => {
    const [initial, amended] = quakesOf(await build(scripts.QUAKE_AMENDMENT))
    expect(initial.earthquake.hypocenter.magnitude).toBe(7.4)
    expect(initial.issue.correct).toBe('なし')
    expect(amended.earthquake.hypocenter.magnitude).toBe(7.6)
    expect(amended.issue.correct).toBe('震源を訂正')
    expect(amended.varCommentText).toContain('震源要素を訂正します。')
  })

  it('2 通が同じ地震を指し、報番号と発表時刻は進む', async () => {
    const [initial, amended] = quakesOf(await build(scripts.QUAKE_AMENDMENT))
    expect(extractQuakeEventId(amended)).toBe(extractQuakeEventId(initial))
    expect(initial.reportSerial).toBe(1)
    expect(amended.reportSerial).toBe(2)
    expect(Date.parse(amended.time)).toBeGreaterThan(Date.parse(initial.time))
  })
})

describe('未入電テスト・5弱以上テスト', () => {
  it('未入電テストは市町村の未入電を 2 通りとも持ち、観測点の未入電もある', async () => {
    const [quake] = quakesOf(await build(scripts.UNRECEIVED_QUAKE))
    const cities = quake.cities ?? []
    expect(cities.some(c => c.hasUnreceived)).toBe(true)
    expect(cities.some(c => c.unreceived)).toBe(true)
    expect(quake.points.filter(p => p.unreceived).length).toBe(60)
  })

  // 対照: 地震テスト（能登本震）には市町村の未入電が無い
  it('地震テストには市町村の未入電が無い', async () => {
    const [quake] = quakesOf(await build(scripts.EARTHQUAKE))
    expect((quake.cities ?? []).some(c => c.hasUnreceived || c.unreceived)).toBe(false)
  })

  it('5弱以上テストは最大震度が5弱で、未入電を持つ', async () => {
    const [quake] = quakesOf(await build(scripts.MAX_SCALE_OR_ABOVE_QUAKE))
    expect(quake.earthquake.maxScale).toBe(45)
    expect(quake.points.some(p => p.unreceived)).toBe(true)
  })
})

describe('区域未入電テスト', () => {
  const area = scripts.AREA_UNRECEIVED_AREA

  // 安全弁: 元の電文では区域が観測値を持つ（書き換えが効かないと未入電テストと同じものになる）
  it('元の電文では区域が観測値を持つ', async () => {
    const [base] = quakesOf(await build(scripts.UNRECEIVED_QUAKE))
    expect(base.points.some(p => p.isArea && !p.pref && p.addr === area && !p.unreceived)).toBe(true)
  })

  it('区域・配下の市町村・観測点がすべて未入電（下限の5弱）になる', async () => {
    const [quake] = quakesOf(await build(scripts.AREA_UNRECEIVED_QUAKE))
    expect(quake.points.find(p => p.isArea && !p.pref && p.addr === area)).toMatchObject({ scale: 45, unreceived: true })
    const cities = (quake.cities ?? []).filter(c => c.area === area)
    expect(cities.length).toBe(7)
    for (const c of cities) expect(c).toMatchObject({ scale: 45, unreceived: true })
    const stations = quake.points.filter(p => !p.isArea && p.area === area)
    expect(stations.length).toBe(12)
    for (const st of stations) expect(st).toMatchObject({ scale: 45, unreceived: true })
  })

  // 対照: 他の区域は元のまま
  it('他の区域の市町村は元のまま', async () => {
    const [base] = quakesOf(await build(scripts.UNRECEIVED_QUAKE))
    const [quake] = quakesOf(await build(scripts.AREA_UNRECEIVED_QUAKE))
    const others = (q: JMAQuake) => (q.cities ?? []).filter(c => c.area !== area)
    expect(others(quake)).toEqual(others(base))
  })
})

describe('遠地地震テスト・巨大地震テスト', () => {
  it('遠地地震は深さ不明・付加文 2 種を実電文どおり持つ', async () => {
    const [quake] = quakesOf(await build(scripts.FOREIGN_QUAKE))
    expect(quake.issue.type).toBe('遠地地震')
    expect(quake.earthquake.hypocenter.name).toBe('メキシコ、チアパス州沿岸')
    expect(quake.earthquake.hypocenter.depth).toBe(-1)
    expect(quake.forecastText).toBe('震源の近傍で津波発生の可能性があります。この地震による日本への津波の影響はありません。')
    expect(quake.freeText).toContain('ＰＴＷＣ')
  })

  it('巨大地震は規模が数値にならず、「Ｍ８を超える巨大地震」と区別される', async () => {
    const [quake] = quakesOf(await build(scripts.FOREIGN_QUAKE_HUGE))
    expect(Number.isNaN(quake.earthquake.hypocenter.magnitude)).toBe(true)
    expect(quake.earthquake.hypocenter.magnitudeCondition).toBe('Ｍ８を超える巨大地震')
    expect(quake.earthquake.hypocenter.name).toBe('チリ中部沿岸')
  })
})

describe('取消テスト・一部取消テスト', () => {
  it('取消テストは震度速報と、その取消を流す', async () => {
    const [prompt, cancel] = quakesOf(await build(scripts.QUAKE_CANCEL))
    expect(prompt.issue.type).toBe('震度速報')
    expect(prompt.cancelled).toBeFalsy()
    expect(cancel.cancelled).toBe(true)
    expect(cancel.cancelText).toBe('先ほどの、震度速報を取り消します。')
    expect(extractQuakeEventId(cancel)).toBe(extractQuakeEventId(prompt))
  })

  it('一部取消テストは、取消を震源・震度情報より後の報として流す', async () => {
    const [prompt, detail, cancel] = quakesOf(await build(scripts.QUAKE_PARTIAL_CANCEL))
    expect([prompt.issue.type, detail.issue.type]).toEqual(['震度速報', '震源・震度情報'])
    expect(cancel.cancelled).toBe(true)
    expect(Date.parse(cancel.time)).toBeGreaterThan(Date.parse(detail.time))
  })
})

function tsunamisOf(built: BuiltTestTelegram[]): JMATsunami[] {
  return payloads(built).flatMap(p => (p.kind === 'event' && p.event.kind === 'tsunami' ? [p.event] : []))
}

describe('変化の小さい続報テスト', () => {
  // 正: 段の並び（発表 → 観測情報 → 沖合 → 観測情報 → 満潮時刻 → 全解除）と、津波が 1 つの事象で続く
  it('発表のあと 16 通の続報が同じ津波へ届き、最後に全解除で終わる', async () => {
    const tsunamis = tsunamisOf(await build(scripts.TSUNAMI_QUIET_REPORTS))
    expect(tsunamis).toHaveLength(18)
    // 沖合（VTSE52）は 2 通。**1 通目は次の段の前提**で、2 通目で初めて値が動く
    expect(tsunamis.map(t => t.headType)).toEqual([
      'VTSE41', 'VTSE51', 'VTSE51', 'VTSE51', 'VTSE51', 'VTSE52', 'VTSE52', 'VTSE51',
      'VTSE51', 'VTSE51', 'VTSE51', 'VTSE51', 'VTSE51', 'VTSE51', 'VTSE51', 'VTSE51', 'VTSE51', 'VTSE41',
    ])
    expect(new Set(tsunamis.map(t => t.eventId)).size).toBe(1)
    // 津波情報（VTSE51）の id は報番号から作るので、報ごとに違う（重なると再送として捨てられる）。
    // **津波警報（VTSE41）は実電文でも報番号が空**なので、発表と解除で id が重なる —— そちらは
    // 発表時刻で新旧を見る（→ docs/spec/quake-spec.md §6.3）
    const infoIds = tsunamis.filter(t => t.headType === 'VTSE51').map(t => t.id)
    expect(new Set(infoIds).size).toBe(infoIds.length)
    expect(tsunamis[17].cancelled).toBe(true)
  })

  const kamaishi = (t: JMATsunami) => t.observations?.find(o => o.name === '釜石')

  // 正: 段 2 は値が同じまま「以上」だけが付く。対照: 段 1 は付いていない
  it('段 2 は釜石の波高が据え置きのまま「以上」になる', async () => {
    const tsunamis = tsunamisOf(await build(scripts.TSUNAMI_QUIET_REPORTS))
    expect(kamaishi(tsunamis[1])?.height?.over).toBeFalsy()
    expect(kamaishi(tsunamis[2])?.height).toMatchObject({ value: 3.2, over: true })
  })

  // 正: 段 3 は最大波の観測時刻だけが動く（値・「以上」は据え置き）
  it('段 3 は最大波の観測時刻だけが動く', async () => {
    const tsunamis = tsunamisOf(await build(scripts.TSUNAMI_QUIET_REPORTS))
    const before = kamaishi(tsunamis[2])!
    const after = kamaishi(tsunamis[3])!
    expect(after.height).toEqual(before.height)
    expect(Date.parse(after.maxHeightDateTime!)).toBeGreaterThan(Date.parse(before.maxHeightDateTime!))
  })

  // 正: 段 7 は波高が下がり、「以上」も外れる
  it('段 8 は釜石の波高が下がり「以上」も外れる', async () => {
    const tsunamis = tsunamisOf(await build(scripts.TSUNAMI_QUIET_REPORTS))
    const lowered = kamaishi(tsunamis[8])!
    expect(lowered.height?.value).toBe(2.8)
    expect(lowered.height?.over).toBeFalsy()
    // 安全弁: 段 7 までは 3.2 のまま（下がるのは段 8 だけ）
    expect(kamaishi(tsunamis[7])?.height?.value).toBe(3.2)
  })

  // 正: 沖合の 2 通で、最大波の観測時刻が動く。**1 通目が無いと「動いた」にならない**
  // （前の値が状態に無いので、カードは新しく載った行として描き、更新の印を付けない）
  it('沖合の報は 2 通で、2 通目に最大波の観測時刻が動く', async () => {
    const tsunamis = tsunamisOf(await build(scripts.TSUNAMI_QUIET_REPORTS))
    const [first, second] = [tsunamis[5], tsunamis[6]]
    expect(first.headType).toBe('VTSE52')
    expect(second.headType).toBe('VTSE52')
    // 1 通目は「観測中」で波高を持たない点が並び、2 通目で値が入る（サンプルの実物どおり）
    const withHeight = (t: JMATsunami) => (t.observations ?? []).filter(o => o.offshore && o.height).length
    expect(withHeight(second)).toBeGreaterThan(withHeight(first))
  })

  // 正: **値を 1 つも持たない観測点へ、印だけが付く報。** カードの「到達時刻不明」「観測中」に
  // 印の色が当たる経路は、この形でしか通らない（→ tsunami-spec.md §9）。
  it('段 9 は、値を持たない観測点へ電文の印だけが付く', async () => {
    const tsunamis = tsunamisOf(await build(scripts.TSUNAMI_QUIET_REPORTS))
    const at = (t: JMATsunami) => (t.observations ?? []).find(o => o.name === '石巻市鮎川')
    const before = at(tsunamis[8])!
    const marked = at(tsunamis[9])!
    // 値はどちらの段でも持たない（到達時刻も波高も無い）
    for (const o of [before, marked]) {
      expect(o.height).toBeUndefined()
      expect(o.arrivalTime).toBeUndefined()
    }
    // 印が付くのは段 9 だけ
    expect(before.firstHeightRevise ?? before.maxHeightRevise).toBeUndefined()
    expect(marked.maxHeightRevise).toBe('追加')
  })

  // 正: 段 10 で釜石が欠測へ転じ（値は持ったまま）、段 11 で欠測のまま最大波の観測時刻だけが進む
  // （2026-10-21 ユーザー選択「印を付ける (Recommended)」「読む (Recommended)」の経路を実機で通す形）
  it('段 10 で釜石が欠測へ転じ、段 11 で欠測のまま最大波の観測時刻だけが更新される', async () => {
    const tsunamis = tsunamisOf(await build(scripts.TSUNAMI_QUIET_REPORTS))
    const [before, turned, timed] = [kamaishi(tsunamis[9])!, kamaishi(tsunamis[10])!, kamaishi(tsunamis[11])!]
    expect(before.condition?.maxHeightMissing).toBeFalsy()
    expect(turned.condition?.maxHeightMissing).toBe(true)
    expect(turned.height).toBeDefined()
    expect(timed.condition?.maxHeightMissing).toBe(true)
    expect(timed.height).toEqual(turned.height)
    expect(timed.maxHeightRevise).toBe('更新')
    expect(Date.parse(timed.maxHeightDateTime!)).toBeGreaterThan(Date.parse(turned.maxHeightDateTime!))
  })

  // 安全弁: どの段でも、最大波の観測時刻は観測状況を確定した時刻・発表時刻より後にならない（まだ来ていない波を観測した形にしない）
  it('最大波の観測時刻は、どの段でも観測状況を確定した時刻より後にならない', async () => {
    const tsunamis = tsunamisOf(await build(scripts.TSUNAMI_QUIET_REPORTS))
    for (const t of tsunamis) {
      const limit = Date.parse(t.observationDateTime ?? t.time)
      expect(limit).toBeLessThanOrEqual(Date.parse(t.time))
      for (const o of t.observations ?? []) {
        if (o.maxHeightDateTime) expect(Date.parse(o.maxHeightDateTime)).toBeLessThanOrEqual(limit)
      }
    }
  })

  // 正: 到達予想時刻だけが動く段がある（満潮時刻・到達状況は前の段のまま）
  it('段 15 は到達予想時刻だけを動かす', async () => {
    const tsunamis = tsunamisOf(await build(scripts.TSUNAMI_QUIET_REPORTS))
    const forecastOf = (t: JMATsunami) =>
      t.areas.flatMap(a => a.stations ?? []).map(st => st.arrivalTime ?? '').join('|')
    expect(forecastOf(tsunamis[15])).not.toBe(forecastOf(tsunamis[14]))
    // 対照: 段 16 では動かない（同じ値の再送）
    expect(forecastOf(tsunamis[16])).toBe(forecastOf(tsunamis[15]))
  })

  it('満潮時刻の続報は、満潮時刻の更新と到達状況の更新を別々の段で流す', async () => {
    const tsunamis = tsunamisOf(await build(scripts.TSUNAMI_QUIET_REPORTS))
    const tideOf = (t: JMATsunami) => t.areas.flatMap(a => a.stations ?? []).map(s => s.highTideDateTime).join('|')
    // 到達状況は区域の欄（`Forecast/Item/FirstHeight/Condition`）。観測点の側ではない
    const arrivalOf = (t: JMATsunami) => t.areas.map(a => a.firstHeight?.condition ?? '').join('|')
    const [, , , , , , , , , , , , t10, t11, t12] = tsunamis
    expect(tideOf(t11)).not.toBe(tideOf(t10))
    expect(arrivalOf(t11)).toBe(arrivalOf(t10))
    expect(arrivalOf(t12)).not.toBe(arrivalOf(t11))
  })
})

describe('津波のテスト', () => {
  // 正: 大津波警報テストは観測状態を一通り持つ（表示・読み上げの分岐を実機で一度ずつ通すため）
  it('大津波警報テストは、観測状態を一通り持つ', async () => {
    const tsunamis = tsunamisOf(await build(scripts.TSUNAMI_MAJOR_WARNING))
    expect(tsunamis[0].areas.some(a => a.grade === 'MajorWarning')).toBe(true)
    const observations = tsunamis.flatMap(t => t.observations ?? [])
    const has = (flag: string) => observations.some(o => (o.condition as Record<string, boolean> | undefined)?.[flag])
    for (const flag of ['observing', 'important', 'rising', 'weak', 'maxHeightMissing', 'firstHeightMissing', 'firstWaveUnidentifiable']) {
      expect(has(flag), flag).toBe(true)
    }
    expect(observations.some(o => o.offshore)).toBe(true)
    expect(observations.some(o => o.height?.over)).toBe(true)
    expect(tsunamis.some(t => (t.estimations ?? []).length > 0)).toBe(true)
    expect(tsunamis[tsunamis.length - 1].cancelled).toBe(true)
  })

  // 正: 片付けの報は全区域の解除として読まれる（発表中の区域を持たない）。読まれないとカードが残り続ける
  it.each([
    ['TSUNAMI_WARNING', scripts.TSUNAMI_WARNING],
    ['TSUNAMI_WATCH', scripts.TSUNAMI_WATCH],
    ['TSUNAMI_GRADE_CHANGE', scripts.TSUNAMI_GRADE_CHANGE],
    ['TSUNAMI_INFO_RETRACTION', scripts.TSUNAMI_INFO_RETRACTION],
  ] as const)('%s の最後の報は全区域の解除で、同じ津波を指す', async (_name, script) => {
    const tsunamis = tsunamisOf(await build(script))
    const first = tsunamis[0]
    const lift = tsunamis[tsunamis.length - 1]
    expect(first.areas.length).toBeGreaterThan(0)
    expect(lift.cancelled).toBe(true)
    expect(lift.areas).toEqual([])
    expect(lift.eventId).toBe(first.eventId)
  })

  // 正・対照: 予報テストの片付けは標準版だけ（DMDSS 版は失効時刻で消える）
  it('予報テストは失効時刻を持ち、片付けの報は標準版だけで流す', async () => {
    const dmdss = tsunamisOf(await build(scripts.TSUNAMI_FORECAST, true))
    expect(dmdss).toHaveLength(1)
    expect(dmdss[0].areas.every(a => a.grade === 'Forecast')).toBe(true)
    // **失効時刻は押した時刻から `TSUNAMI_DISMISS_MS` 後へ詰めてある。** 実電文は発表の
    // 約 3 時間後で、テストボタンでは待てない（ほかの津波テストの片付けと同じ長さに揃えた）。
    expect(Date.parse(dmdss[0].validDateTime!) - NOW.getTime()).toBe(scripts.TSUNAMI_DISMISS_MS)
    const standard = tsunamisOf(await build(scripts.TSUNAMI_FORECAST, false))
    expect(standard).toHaveLength(2)
    expect(standard[1].cancelled).toBe(true)
  })

  it('失効時刻テストは注意報のあと、予報だけ・失効時刻つきの報が届く', async () => {
    const [watch, expiry] = tsunamisOf(await build(scripts.TSUNAMI_EXPIRY))
    expect(watch.areas.some(a => a.grade === 'Watch')).toBe(true)
    expect(expiry.areas.every(a => a.grade === 'Forecast')).toBe(true)
    expect(Date.parse(expiry.validDateTime!)).toBeGreaterThan(Date.parse(expiry.time))
  })

  // 等級は同じまま期限だけを延ばした続報（2026-10-24 ユーザー選択「延長と言う (Recommended)」の文が通る形）
  it('失効時刻テストの最後の報は、等級も前回の等級も予報のまま、期限だけが後ろへ延びる', async () => {
    const [, expiry, extended] = tsunamisOf(await build(scripts.TSUNAMI_EXPIRY))
    expect(extended.areas.every(a => a.grade === 'Forecast' && a.lastGrade === 'Forecast')).toBe(true)
    expect(Date.parse(extended.validDateTime!) - Date.parse(expiry.validDateTime!)).toBe(scripts.TSUNAMI_EXPIRY_EXTEND_BY_MS)
    expect(Date.parse(extended.time)).toBeGreaterThan(Date.parse(expiry.time))
  })

  it('等級変化テストは引き上げと引き下げの両方を含む', async () => {
    const tsunamis = tsunamisOf(await build(scripts.TSUNAMI_GRADE_CHANGE))
    const notoGrade = (t: JMATsunami) => t.areas.find(a => a.name === '石川県能登')?.grade
    expect(tsunamis.map(notoGrade).slice(0, 4)).toEqual(['Warning', 'MajorWarning', 'MajorWarning', 'Warning'])
  })

  it('原因地震の追加テストは、識別子が「A」から「A B」へ伸び、原因地震が 2 件になる', async () => {
    const built = await build(scripts.TSUNAMI_SOURCE_ADDED)
    const tsunamis = tsunamisOf(built)
    const [quakeA, quakeB] = quakesOf(built)
    const [first, , last] = [tsunamis[0], tsunamis[1], tsunamis[tsunamis.length - 1]]
    expect(first.eventId).toBe(extractQuakeEventId(quakeA))
    expect(tsunamis[1].eventId).toBe(`${extractQuakeEventId(quakeA)} ${extractQuakeEventId(quakeB)}`)
    expect(tsunamis[1].sourceEarthquakes).toHaveLength(2)
    expect(last.cancelled).toBe(true)
  })

  it('誤報取消テストは、同じ津波を取り消す報を流す', async () => {
    const [issued, retraction] = tsunamisOf(await build(scripts.TSUNAMI_RETRACTION))
    expect(issued.cancelled).toBeFalsy()
    expect(retraction.cancelled).toBe(true)
    expect(retraction.eventId).toBe(issued.eventId)
    expect(retraction.cancelText).toBe('先ほどの、津波注意報を取り消します。')
    // 取消は発表より後の報
    expect(Date.parse(retraction.time)).toBeGreaterThan(Date.parse(issued.time))
  })

  it('津波情報の取消テストは、津波情報（VTSE51）だけを取り消す', async () => {
    const [, tide, retraction] = tsunamisOf(await build(scripts.TSUNAMI_INFO_RETRACTION))
    expect(retraction.cancelled).toBe(true)
    expect(retraction.headType).toBe('VTSE51')
    expect(retraction.eventId).toBe(tide.eventId)
  })
})

describe('南海トラフ・後発地震・お知らせ・地震回数・長周期のテスト', () => {
  const dataOf = <K extends ReplayPayload['kind']>(built: BuiltTestTelegram[], kind: K) =>
    payloads(built).flatMap(p => (p.kind === kind ? [(p as Extract<ReplayPayload, { kind: K }>)] : []))
      .map(p => ('data' in p ? p.data : null))

  it('臨時情報の 3 段階は、調査中・巨大地震注意・巨大地震警戒の名乗りを持つ', async () => {
    const kinds = await Promise.all([scripts.NANKAI_CHECKING, scripts.NANKAI_WATCH, scripts.NANKAI_WARNING]
      .map(async s => (dataOf(await build(s), 'nankai')[0] as { kindName: string }).kindName))
    expect(kinds).toEqual(['調査中', '巨大地震注意', '巨大地震警戒'])
  })

  it('臨時情報の取消は、対象と同じ識別子で届く', async () => {
    const [issued, retraction] = dataOf(await build(scripts.NANKAI_RETRACTION), 'nankai') as { eventId: string; cancelled: boolean; body: string }[]
    expect(retraction.cancelled).toBe(true)
    expect(retraction.eventId).toBe(issued.eventId)
    expect(retraction.body).toContain('８日１７時００分に発表した')
  })

  it('解説情報は臨時・定例を名乗り、次回発表予定は臨時解説だけが持つ', async () => {
    const [adHoc] = dataOf(await build(scripts.NANKAI_COMMENTARY_AD_HOC), 'nankaiCommentary') as { serialName: string; nextAdvisory?: string }[]
    const [routine] = dataOf(await build(scripts.NANKAI_COMMENTARY_ROUTINE), 'nankaiCommentary') as { serialName: string; nextAdvisory?: string }[]
    expect(adHoc.serialName).toBe('臨時解説')
    expect(routine.serialName).toBe('定例解説')
    expect(adHoc.nextAdvisory).toBeTruthy()
    expect(routine.nextAdvisory).toBeFalsy()
  })

  it('後発地震注意情報の取消は、取消の印と理由を持つ', async () => {
    const [issued, retraction] = dataOf(await build(scripts.KOHATSU_RETRACTION), 'kohatsu') as { eventId: string; cancelled: boolean; retracted?: boolean; body: string }[]
    expect(issued.cancelled).toBe(false)
    expect(retraction).toMatchObject({ cancelled: true, retracted: true, body: '先ほどの、北海道・三陸沖後発地震注意情報を取り消します。' })
    expect(retraction.eventId).toBe(issued.eventId)
  })

  it('お知らせは本文の後に自由付加文を持ち、問い合わせ先は持たない', async () => {
    const [notice] = dataOf(await build(scripts.QUAKE_NOTICE), 'quakeNotice') as { body: string; freeText?: string }[]
    expect(notice.body).toContain('沖縄県の震度データ入電停止のお知らせ')
    expect(notice.body).not.toContain('問い合わせ')
    expect(notice.freeText).toBe('保守点検の時刻が変更になりました。')
  })

  it('地震回数は回数が全区間「発表なし」で、有感回数は持つ', async () => {
    const [count] = dataOf(await build(scripts.EARTHQUAKE_COUNT), 'earthquakeCount') as { items: { number: number | null; feltNumber: number | null }[] }[]
    expect(count.items.length).toBe(5)
    expect(count.items.every(i => i.number === null)).toBe(true)
    expect(count.items.some(i => i.feltNumber === 1)).toBe(true)
  })

  it('地震回数の取消は、対象と同じ識別子で届く', async () => {
    const [issued, retraction] = dataOf(await build(scripts.EARTHQUAKE_COUNT_RETRACTION), 'earthquakeCount') as { eventId: string; cancelled: boolean }[]
    expect(retraction.cancelled).toBe(true)
    expect(retraction.eventId).toBe(issued.eventId)
  })

  it('長周期地震動の取消は、表示中の長周期と同じ地震を取り消す', async () => {
    const built = await build(scripts.LPGM_RETRACTION)
    const [issued, retraction] = dataOf(built, 'lpgm') as { eventId: string; cancelled?: boolean; cancelText?: string }[]
    expect(issued.cancelled).toBeFalsy()
    expect(retraction).toMatchObject({ cancelled: true, cancelText: '先ほどの、長周期地震動に関する観測情報を取り消します。' })
    expect(retraction.eventId).toBe(issued.eventId)
  })
})

describe('緊急地震速報のテスト', () => {
  const eewsOf = (built: BuiltTestTelegram[]): EEWAlert[] =>
    payloads(built).flatMap(p => (p.kind === 'event' && p.event.kind === 'eew' ? [p.event] : []))

  it('予報テストは予報のまま進み、最後が最終報', async () => {
    const eews = eewsOf(await build(scripts.EEW_FORECAST))
    expect(eews.every(e => e.severity === 'Forecast')).toBe(true)
    expect(eews.map(e => eewMaxScale(e))).toEqual([30, 30, 40, 40])
    expect(eews[eews.length - 1].isFinal).toBe(true)
    // 対照: 最終報より前は打ち切りの印を持たない
    expect(eews.slice(0, -1).every(e => !e.isFinal)).toBe(true)
  })

  it('警報テストは予報から警報へ上がり、特別警報にはならない', async () => {
    const eews = eewsOf(await build(scripts.EEW_WARNING))
    expect(eews.map(e => e.severity)).toEqual(['Forecast', 'Warning', 'Warning', 'Warning', 'Warning'])
    expect(eews.map(e => computeSingleEEWLevel(e))).toEqual([0, 1, 1, 1, 1])
  })

  it('特別警報テストは震度6弱まで上がり、特別警報相当になる', async () => {
    const eews = eewsOf(await build(scripts.EEW_SPECIAL_WARNING))
    expect(Math.max(...eews.map(e => eewMaxScale(e)))).toBe(55)
    expect(eews.some(e => computeSingleEEWLevel(e) === 2)).toBe(true)
    // 対照: 初報は予報（格上げが見える）
    expect(computeSingleEEWLevel(eews[0])).toBe(0)
  })

  it('誤報取消テストは実電文の取消で終わる', async () => {
    const eews = eewsOf(await build(scripts.EEW_RETRACTION))
    const cancel = eews[eews.length - 1]
    expect(cancel.cancelled).toBe(true)
    expect(cancel.cancelText).toBe('先ほどの、緊急地震速報（地震動予報）を取り消します。')
    // 取消は予想も震源も持たない（実電文の形）
    expect(eewAreas(cancel)).toEqual([])
    expect(cancel.earthquake.hypocenter.name).toBe('')
  })

  it('単独点処理テストは、仮定震源要素の初報から震源が決まった続報へ進む', async () => {
    const eews = eewsOf(await build(scripts.EEW_ASSUMED))
    expect(isProvisionalHypocenter(eews[0])).toBe(true)
    expect(eews[0].earthquake.condition).toBe('仮定震源要素')
    // 対照: 続報では震源が決まる
    expect(isProvisionalHypocenter(eews[1])).toBe(false)
    expect(eews[1].earthquake.hypocenter.magnitude).toBeGreaterThan(5)
  })

  // 正: 「非常に強い揺れを検知」は発生時刻の要素ごと無く、規模も数値でない
  // （**どちらか片方でも欠けるとパーサーがこの形と見なさない**。→ `dmdataParser.ts` の `notThisForm`）
  it('強い揺れ検知テストは、震源を決めないまま予想震度だけを持つ', async () => {
    const eews = eewsOf(await build(scripts.EEW_STRONG_SHAKING))
    expect(eews[0].strongShakingOnly).toBe(true)
    expect(eews[0].earthquake.originTime).toBe('')
    expect(Number.isNaN(eews[0].earthquake.hypocenter.magnitude)).toBe(true)
    expect(eewMaxScale(eews[0])).toBe(45)
    // **上限を定めない予想**（「５弱程度以上」）。閉じると「程度以上」の経路が実機で通らない
    expect(eews[0].forecastMaxScaleOrAbove).toBe(true)
    // 本文は実電文の形（日時・場所・最大震度）。定型の一文へ置き換えると、検知した時刻と場所が
    // 画面から消える（→ docs/spec/eew-spec.md §5）
    expect(eews[0].strongShakingText).toMatch(/^[０-９]{2}日[０-９]{2}時[０-９]{2}分[０-９]{2}秒頃\n.+付近　+最大震度５弱程度以上と推定$/)
    // **日時は押した時刻から作る**（電文の時刻は後で「いま」へ寄せるが、本文は寄せを受けない）
    expect(eews[0].strongShakingText).toContain(`${String(new Date(NOW.getTime() + 9 * 3600_000).getUTCDate()).padStart(2, '0').replace(/[0-9]/g, d => String.fromCharCode(d.charCodeAt(0) + 0xfee0))}日`)
    // 対照: 続報では震源が決まる
    expect(eews[1].strongShakingOnly).toBeFalsy()
  })

  it('予想震度なしテストは予想震度を持たないまま取り消される', async () => {
    const eews = eewsOf(await build(scripts.EEW_NO_FORECAST))
    expect(eews[0].forecastMaxScale).toBeUndefined()
    expect(eewAreas(eews[0])).toEqual([])
    expect(eews[eews.length - 1].cancelled).toBe(true)
  })

  it('予想震度0テストは震度1未満の予想から上がる', async () => {
    const eews = eewsOf(await build(scripts.EEW_FORECAST_ZERO))
    expect(eews[0].forecastMaxScaleBelow1).toBe(true)
    expect(eewMaxScale(eews[2])).toBe(40)
  })

  it('深発地震テストは深さ 450km で警報へ上がらない', async () => {
    const eews = eewsOf(await build(scripts.EEW_DEEP))
    expect(eews[0].earthquake.hypocenter.depth).toBe(450)
    expect(eews[0].earthquake.hypocenter.name).toBe('小笠原諸島西方沖')
    expect(eews.every(e => e.severity === 'Forecast')).toBe(true)
  })

  // 安全弁: どの台本も、押すたびに 1 通ずつ進む形になっている（`stepByPress` を持つ）
  it('緊急地震速報の台本はどれも押すたびに進む', () => {
    for (const name of ['EEW_FORECAST', 'EEW_WARNING', 'EEW_SPECIAL_WARNING', 'EEW_RETRACTION',
      'EEW_ASSUMED', 'EEW_DEEP', 'EEW_STRONG_SHAKING', 'EEW_NO_FORECAST', 'EEW_FORECAST_ZERO'] as const) {
      expect(scripts[name].stepByPress, name).toBeDefined()
    }
  })
})

describe('推計震度分布図のテスト', () => {
  it('地震情報 → 分布（初報・続報）→ 地震情報の続報 の順で、分布は同じ地震を指す', async () => {
    const built = await build(scripts.ESTIMATED_INTENSITY)
    expect(payloads(built).map(p => p.kind)).toEqual(['event', 'estimatedIntensity', 'estimatedIntensity', 'event'])
    const quakes = quakesOf(built)
    const distributions = payloads(built).flatMap(p => (p.kind === 'estimatedIntensity' ? [p.data] : []))
    // 引き当ては発現時刻（この電文は識別子を持たない）
    expect(distributions[0].arrivalTime).toBe(quakes[0].earthquake.time)
    expect(distributions[1].arrivalTime).toBe(distributions[0].arrivalTime)
    // 続報で分布が広がる
    expect(distributions[1].count).toBeGreaterThan(distributions[0].count)
    expect(distributions[0].count).toBeGreaterThan(0)
  })
})

describe('震源の借用テスト', () => {
  it('震度速報 → 津波警報 → 震度速報 → 津波警報 の順で、同じ地震を指す', async () => {
    const events = payloads(await build(scripts.HYPOCENTER_FROM_TSUNAMI)).map(p => (p.kind === 'event' ? p.event : null))
    expect(events.map(e => e?.kind)).toEqual(['quake', 'tsunami', 'quake', 'tsunami'])
    const [prompt1, tsunami1, , tsunami2] = events as [JMAQuake, JMATsunami, JMAQuake, JMATsunami]
    // 借りる条件は識別子の一致だけ（→ utils/borrowFromTsunami.ts）
    expect(tsunami1.eventId).toBe(extractQuakeEventId(prompt1))
    expect(prompt1.earthquake.hypocenter.name).toBe('')
    expect(tsunami1.sourceEarthquakes?.[0]?.magnitude).toBe(7.4)
    expect(tsunami2.sourceEarthquakes?.[0]?.magnitude).toBe(7.6)
  })
})
