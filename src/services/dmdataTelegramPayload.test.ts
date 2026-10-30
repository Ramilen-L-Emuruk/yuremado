// @vitest-environment jsdom
// 電文の読み取りが XML に一本化されたため、DOMParser を使う jsdom 環境で動かす（既定は node）。
// アプリが受け取る電文の入口（購読分類・EEW 種別）を固定するテスト。
//
// 守りたいのは「緊急地震速報は VXSE45 か VXSE43 の**どちらか 1 つ**だけを取り込む」こと。
// 予報（VXSE45）を受けている人が VXSE43（警報）も取り込むと、遅れて届く複製が新しい VXSE45 を
// 上書きし、地図の区域塗りが削られる（根拠と実害は docs/spec/data-sources-spec.md §2
// 「EEW は VXSE45 だけを受ける」）。予報が無く警報だけの人は、VXSE43 が唯一の緊急地震速報になる。
// この判定はライブ（services/dmdata.ts）とリプレイ（dmdataReplay.ts / dmdataReplayLive.ts）が
// 共有する。かつて二重定義でライブ側だけ VXSE43 を含み、ライブでのみ塗りが削られていた。
import { describe, it, expect, vi } from 'vitest'
import {
  isHandledType, buildXmlPayload,
  buildBinaryPayload, isFilteredBinaryTelegram, historyExtraKey,
  TELEGRAM_KIND_OF_HEAD_TYPE, telegramKindOfHeadType, telegramKindOfPayload,
  NON_EEW_HANDLED_TYPES, EEW_HEAD_TYPES, DISPATCHED_WITHOUT_PARSER, resetUnreadableNankaiWarnForTest,
  QUAKE_TYPES, TSUNAMI_TYPES, LPGM_TYPES, NANKAI_TYPES, COMMENTARY_TYPES, KOHATSU_TYPES,
  NOTICE_TYPES, QUAKE_COUNT_TYPES, ESTIMATED_INTENSITY_TYPES, INTERNATIONAL_TSUNAMI_TYPES,
} from './dmdataTelegramPayload'
import { KIND_OPTIONS } from '../components/TelegramTab/labels'
import { log } from '../utils/logger'
import { PREFERRED_CLASSIFICATIONS, eewHeadTypeFor } from './dmdataClassifications'
import { buildSampleTelegram } from '../test-utils/bufrBuild'
import type { ReplayPayload } from '../types/replay'
// テストボタンと同じ電文（→ `utils/testTelegramScripts.ts`）。**トップレベルで読む** ——
// テスト本体の中で初めて読むと、電文の読み込みが 1 件目の所要時間に乗って時間切れになる。
import {
  first, telegramNankais, telegramCommentaries, telegramKohatsus, telegramNotices, telegramCounts,
} from '../test-utils/testTelegramFixtures'

const nankai = first(await telegramNankais('NANKAI_CHECKING'), '南海トラフ臨時情報')
const nankaiCommentary = first(await telegramCommentaries('NANKAI_COMMENTARY_AD_HOC'), '南海トラフ関連解説情報')
const kohatsu = first(await telegramKohatsus('KOHATSU'), '後発地震注意情報')
const quakeNotice = first(await telegramNotices('QUAKE_NOTICE'), '地震・津波に関するお知らせ')
const earthquakeCount = first(await telegramCounts('EARTHQUAKE_COUNT'), '地震回数に関する情報')

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
<Pref><Name>石川</Name><Code>9170</Code><Area>
<Name>石川県能登</Name><Code>390</Code>
<Category><Kind><Name>緊急地震速報（警報）</Name><Code>11</Code></Kind></Category>
<ForecastInt><From>6+</From><To>7</To></ForecastInt>
</Area></Pref>
</Forecast></Intensity>
</Body>
</Report>`

describe('EEW として扱う電文種別', () => {
  it('予報を受けていれば VXSE45 を取り込む', () => {
    expect(isHandledType('VXSE45', 'VXSE45')).toBe(true)
  })

  // 対照: この判定の本体。予報を受けている人が VXSE43 も取り込むと、古い複製で上書きされる。
  it('予報を受けていれば VXSE43（警報）は取り込まない', () => {
    expect(isHandledType('VXSE43', 'VXSE45')).toBe(false)
    expect(buildXmlPayload('VXSE43', EEW_XML, 'VXSE45')).toBeNull()
  })

  // 正: 予報が無く警報だけを受けている人には、VXSE43 が唯一の緊急地震速報。
  it('警報だけを受けていれば VXSE43 を取り込み、VXSE45 は取り込まない', () => {
    expect(isHandledType('VXSE43', 'VXSE43')).toBe(true)
    expect(isHandledType('VXSE45', 'VXSE43')).toBe(false)
    const payload = buildXmlPayload('VXSE43', EEW_XML, 'VXSE43')
    expect(payload?.kind === 'event' ? payload.event.kind : null).toBe('eew')
  })

  // 安全弁: 緊急地震速報を受けていなければ、どちらも取り込まない（地震・津波は従来どおり）。
  it('緊急地震速報を受けていなければ EEW は取り込まず、地震情報は取り込む', () => {
    expect(isHandledType('VXSE45', null)).toBe(false)
    expect(isHandledType('VXSE43', null)).toBe(false)
    expect(isHandledType('VXSE53', null)).toBe(true)
    expect(buildXmlPayload('VXSE45', EEW_XML, null)).toBeNull()
  })

  // VXSE44（予報）は廃止予定で、同時刻の VXSE45 より区域が少ない（能登本震で 45 対 77）。
  it('VXSE44（予報・廃止予定）はどの区分でも取り込まない', () => {
    expect(isHandledType('VXSE44', 'VXSE45')).toBe(false)
    expect(isHandledType('VXSE44', 'VXSE43')).toBe(false)
    expect(buildXmlPayload('VXSE44', EEW_XML, 'VXSE45')).toBeNull()
  })

  it('VXSE45 はペイロードを作る（区域も落とさない）', () => {
    const payload = buildXmlPayload('VXSE45', EEW_XML, 'VXSE45')
    expect(payload?.kind).toBe('event')
    const event = payload?.kind === 'event' ? payload.event : null
    expect(event?.kind).toBe('eew')
    // 警報級の判定は VXSE43 を取らなくても、区域の Kind 名から立つ。
    expect(event?.kind === 'eew' ? event.severity : null).toBe('Warning')
    expect(event?.kind === 'eew' ? event.areas?.length : null).toBe(1)
  })
})

// 最初に申し込む区分は「そもそもどの電文が届くか」を決める最上流。ここが変わると型検査も
// パーサのテストも素通りしたまま挙動だけが変わるため、集合そのものを固定する。
describe('最初に申し込む区分', () => {
  // 対照: 戻すと能登本震で起きた区域塗りの後退（76→40）が再発する。
  it('eew.warning（VXSE43 だけを含む区分）を最初からは申し込まない', () => {
    expect(PREFERRED_CLASSIFICATIONS).not.toContain('eew.warning')
  })

  it('EEW（eew.forecast）と地震・津波（telegram.earthquake）を申し込む', () => {
    expect(PREFERRED_CLASSIFICATIONS).toContain('eew.forecast')
    expect(PREFERRED_CLASSIFICATIONS).toContain('telegram.earthquake')
  })

  // 安全弁: 区分と種別は別の層で、片方だけ直しても穴が残る。両方が要る。
  it('既定の区分なら、取り込む EEW 種別は VXSE45', () => {
    expect(eewHeadTypeFor(PREFERRED_CLASSIFICATIONS)).toBe('VXSE45')
  })
})

// 非 XML 電文（推計震度分布図 IXAC41）の試験・訓練配信の抑制。
//
// **XML 側の抑制（`head.test` を見るもの）は、この電文に対して原理的に発火しない。**
// 配信元が 2 つのことを別々に明記しているため:
//   - `socket.start`: 「XML電文以外のテスト配信は no 時も配信されます」→ **届く**
//   - `telegram.list` / `websocket`: 「XML電文以外のテスト配信は常に false になります」
//     → **見分けられない**
// だから本文の電文の種類（BUFR の `0-01-242`）で判定する。
describe('非 XML 電文の試験・訓練配信の抑制', () => {
  const payloadFor = (kind: number) => {
    const p = buildBinaryPayload('IXAC41', buildSampleTelegram({ kind }), 'id-1', '2026-09-16T00:00:00Z')
    if (!p) throw new Error('テスト用の BUFR を読めませんでした（テスト側の組み立てを確かめること）')
    return p
  }

  // 正: 訓練等（0 以外）は、設定が無効なら流さない。
  it('電文の種類が通常（0）以外なら、試験報の受信が無効のとき流さない', () => {
    expect(isFilteredBinaryTelegram(payloadFor(1), false)).toBe(true)
  })

  // 対照: 通常の配信を止めてはいけない。これが無いと「常に true」でもテストが通る。
  it('電文の種類が通常（0）なら流す', () => {
    expect(isFilteredBinaryTelegram(payloadFor(0), false)).toBe(false)
  })

  // 安全弁: 検証用の設定を無視してはいけない。XML 側と同じ扱いにする。
  it('試験報の受信が有効なら、通常（0）以外でも流す', () => {
    expect(isFilteredBinaryTelegram(payloadFor(1), true)).toBe(false)
  })

  // 安全弁: XML 電文のペイロードは**型で**渡せない。
  //
  // かつては実行時に `kind` を見て `false`（流す）へ倒していたが、それは
  // 「XML 電文を巻き込まない」と同時に「**将来増える二進電文も素通しする**」形だった
  // （非 XML 電文は `test` フラグで見分けられないので、素通しは試験報が画面へ出ることを意味する）。
  // いまは引数を `BinaryReplayPayload` に絞ってあり、**型検査が渡す側を止める**。
  //
  // `@ts-expect-error` は「エラーが出なければテストが落ちる」ので、
  // **絞りが外れたらここで気づける**（実行はしないので中身の期待値は書かない）。
  it('XML 電文のペイロードは型で渡せない', () => {
    const xml = buildXmlPayload('VXSE45', EEW_XML, 'VXSE45')
    expect(xml).not.toBeNull()
    // @ts-expect-error 二進電文以外は渡せない（引数は `BinaryReplayPayload`）
    const reject = () => isFilteredBinaryTelegram(xml!, false)
    expect(typeof reject).toBe('function')
  })
})

// 履歴の補完で「同じ電文か」を見分ける鍵。推計震度分布図は**中身から作る**。
// 分割された電文の id は「結合を終えた断片の id」で、当日経路は断片を並列で取るので揺れる。
describe('推計震度分布図の historyExtraKey', () => {
  const payloadWithId = (id: string, time = '2026-09-16T00:00:00Z') => {
    const p = buildBinaryPayload('IXAC41', buildSampleTelegram(), id, time)
    if (!p) throw new Error('テスト用の BUFR を読めませんでした（テスト側の組み立てを確かめること）')
    return p
  }

  // 正: 同じ電文なら、どの断片の id で結合を終えても鍵は同じ。
  it('同じ電文なら id が違っても鍵は同じ', () => {
    expect(historyExtraKey(payloadWithId('frag-1'))).toBe(historyExtraKey(payloadWithId('frag-2')))
  })

  // 対照: 発表時刻が違う（続報）なら別の鍵（畳まない）。
  it('発表時刻が違えば別の鍵', () => {
    expect(historyExtraKey(payloadWithId('a', '2026-09-16T00:00:00Z')))
      .not.toBe(historyExtraKey(payloadWithId('a', '2026-09-16T00:06:00Z')))
  })
})

// 帯（南海トラフ・解説情報・後発地震・お知らせ・地震回数）の鍵は**電文ごと**。種別ごとに 1 通へ畳むと、
// 最新の 1 通が取消のとき取り消す相手の発表が落ち、帯の取消が当てる先を失う。
describe('帯の historyExtraKey', () => {
  // 帯の 5 種別を実際の型で作る（`as never` で型を潰すと、項目名が型から消えても鍵が
  // `kind:undefined|undefined|issue` に化けたまま通ってしまう）。
  type BandPayload = Extract<ReplayPayload, { kind: 'nankai' | 'nankaiCommentary' | 'kohatsu' | 'quakeNotice' | 'earthquakeCount' }>
  const bands: BandPayload[] = [
    { kind: 'nankai', data: nankai },
    { kind: 'nankaiCommentary', data: nankaiCommentary },
    { kind: 'kohatsu', data: kohatsu },
    { kind: 'quakeNotice', data: quakeNotice },
    { kind: 'earthquakeCount', data: earthquakeCount },
  ]
  const withData = (p: BandPayload, patch: { id?: string; reportDateTime?: string; cancelled?: boolean }): BandPayload =>
    ({ ...p, data: { ...p.data, ...patch } } as BandPayload)

  for (const band of bands) {
    describe(band.kind, () => {
      // 正: 同じ識別情報の発表と取消は別の鍵（両方を流す）
      it('発表と取消は別の鍵', () => {
        expect(historyExtraKey(band)).not.toBe(historyExtraKey(withData(band, { cancelled: true })))
      })

      // 正: 同じ種別でも電文が違えば別の鍵（最新 1 通へ畳まない）
      it('別の電文は別の鍵', () => {
        expect(historyExtraKey(band)).not.toBe(historyExtraKey(withData(band, { id: 'other', reportDateTime: '2026-07-18T02:00:00+09:00' })))
      })

      // 対照: 同じ電文（id・発表時刻・取消かどうかが同じ）は同じ鍵（24 時間側と履歴側で二重に積まない）
      it('同じ電文は同じ鍵', () => {
        expect(historyExtraKey(band)).toBe(historyExtraKey({ ...band }))
      })

      it('鍵に undefined が入らない', () => {
        expect(historyExtraKey(band)).not.toContain('undefined')
      })
    })
  }

  // 安全弁: 長周期は従来どおり地震ごと（受け手が時刻で最新を選ぶ）
  it('長周期は地震ごとの鍵のまま', () => {
    const lpgm = (id: string) => ({ kind: 'lpgm' as const, data: { id, eventId: 'e1' } as never })
    expect(historyExtraKey(lpgm('x'))).toBe(historyExtraKey(lpgm('y')))
  })
})

// 電文種別 → 何の電文か の表は、受信の振り分け（`buildXmlPayload`・ライブ）と電文ログが引く唯一の表。
describe('TELEGRAM_KIND_OF_HEAD_TYPE', () => {
  // 正: 扱う種別がすべて載り、扱わない種別は載らない（表と集合が食い違わない）
  it('扱う電文種別とちょうど一致する', () => {
    const handled = new Set([...NON_EEW_HANDLED_TYPES, ...EEW_HEAD_TYPES, ...DISPATCHED_WITHOUT_PARSER])
    expect([...TELEGRAM_KIND_OF_HEAD_TYPE.keys()].sort()).toEqual([...handled].sort())
  })

  // 安全弁: 同じ電文種別が 2 つの集合に載って別々の種別へ割り当てられていない
  // （表は後勝ちで上書きするので、重なると黙ってどちらかに倒れる）
  it('同じ電文種別を別の種別へ二重に割り当てていない', () => {
    // 表を作る個々の集合をそのまま並べる（緊急地震速報の 2 つは同じ種別なので重なってよい）
    const groups: Array<[ReadonlySet<string>, string]> = [
      [EEW_HEAD_TYPES, 'eew'], [DISPATCHED_WITHOUT_PARSER, 'eew'],
      [QUAKE_TYPES, 'quake'], [TSUNAMI_TYPES, 'tsunami'], [LPGM_TYPES, 'lpgm'],
      [NANKAI_TYPES, 'nankai'], [COMMENTARY_TYPES, 'nankaiCommentary'], [KOHATSU_TYPES, 'kohatsu'],
      [NOTICE_TYPES, 'quakeNotice'], [QUAKE_COUNT_TYPES, 'earthquakeCount'],
      [ESTIMATED_INTENSITY_TYPES, 'estimatedIntensity'], [INTERNATIONAL_TSUNAMI_TYPES, 'internationalTsunami'],
    ]
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const [set, kind] of groups) {
      for (const code of set) {
        const before = seen.get(code)
        if (before !== undefined && before !== kind) clashes.push(`${code}: ${before} と ${kind}`)
        seen.set(code, kind)
      }
    }
    expect(clashes).toEqual([])
    // 対照: 並べた集合が表と同じものを作る（集合を足して上の並びへ書き忘れたら落ちる）
    expect([...seen].sort()).toEqual([...TELEGRAM_KIND_OF_HEAD_TYPE].sort())
  })

  // 正: 電文ログの種別のすべてに、少なくとも 1 つの電文種別が対応する（絞り込みに空の選択肢を作らない）
  it('電文ログの全種別に電文種別がある', () => {
    const kinds = new Set(TELEGRAM_KIND_OF_HEAD_TYPE.values())
    expect(KIND_OPTIONS.filter(k => !kinds.has(k))).toEqual([])
  })

  // 安全弁: 読み取った結果の種別は表の種別と同じ（読めた行と読めなかった行が別の絞り込みに入らない）
  it('読み取り結果の種別は表の種別と一致する', () => {
    const payload = buildXmlPayload('VXSE45', EEW_XML, 'VXSE45')
    expect(payload && telegramKindOfPayload(payload)).toBe(telegramKindOfHeadType('VXSE45'))
  })

  // 正: 南海トラフ臨時情報の段階が読めないことは、ライブに限らずどの経路でも記録する
  it('VYSE50 の段階が読めなければ記録する（経路によらない）', () => {
    // 間引きの枠はモジュールに残るので、先に白紙へ戻す（他のテストが同じ種別を読んでいても落ちない）
    resetUnreadableNankaiWarnForTest()
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      expect(buildXmlPayload('VYSE50', '<Report/>', 'VXSE45')).toBeNull()
      expect(warn.mock.calls.some(c => String(c[0]).includes('[dmdata] 南海トラフ臨時情報 (VYSE50) の段階を解析できませんでした'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })
})
