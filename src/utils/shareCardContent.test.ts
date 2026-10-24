import { describe, expect, it } from 'vitest'
import type { MapMode } from '../components/Map/mapTypes'
import type { EEWAlert, JMAQuake, JMATsunami } from '../types/earthquake'
import { ATTRIBUTION_SOURCES, EEW_NOTICE } from './shareCard'
import { buildShareCardContent, type ShareCardContent, type ShareCardContentInput } from './shareCardContent'
// テスト本体で初めて読むと、並列実行のときだけ解決と変換の待ちが 1 件目の時間に乗って 5 秒を超える。
// 先頭で読んでおけば待ちはファイル読み込み時へ移る（CLAUDE.md「テスト本体の中で対象モジュールを初めて読まないこと」）。
import { first, telegramEews } from '../test-utils/testTelegramFixtures'

function quake(over: { maxScale?: number; magnitude?: number; depth?: number; time?: string } = {}): JMAQuake {
  return {
    id: 'q1',
    time: '2026/08/24 12:35:00',
    issue: { source: '', time: '', type: '震源・震度情報' },
    earthquake: {
      time: over.time ?? '2026/08/24 12:34:00',
      hypocenter: {
        name: '日向灘',
        latitude: 32,
        longitude: 131.6,
        depth: over.depth ?? 30,
        magnitude: over.magnitude ?? 5.2,
      },
      maxScale: over.maxScale ?? 40,
      domesticTsunami: 'None',
    },
    points: [],
  } as unknown as JMAQuake
}

function eew(
  over: { severity?: string; scaleTo?: number; cancelled?: boolean; name?: string; condition?: string; originTime?: string; serial?: string; magnitude?: number; magnitudeCondition?: string } = {},
): EEWAlert {
  return {
    id: 'e1',
    earthquake: {
      originTime: over.originTime ?? '2026/08/24 12:34:00',
      condition: over.condition ?? '',
      hypocenter: {
        name: over.name ?? '日向灘', latitude: 32, longitude: 131.6, depth: 30, magnitude: over.magnitude ?? 6.5,
        ...(over.magnitudeCondition && { magnitudeCondition: over.magnitudeCondition }),
      },
    },
    ...(over.serial ? { issue: { serial: over.serial } } : {}),
    severity: over.severity ?? 'Forecast',
    cancelled: over.cancelled ?? false,
    areas: [{ pref: '宮崎県', name: '宮崎県南部平野部', scaleFrom: 40, scaleTo: over.scaleTo ?? 45 }],
  } as unknown as EEWAlert
}

/** 本文の末尾に入るアプリの URL。実際の値は `standardAppUrl` の担当（shareCard.test.ts）。 */
const APP_URL = 'https://example.test/yuremado/'

/** 見出しと出典を見るテストは URL を気にしないので、既定の URL で包んで呼ぶ。 */
function build(i: ShareCardContentInput): ShareCardContent {
  return buildShareCardContent(i, APP_URL)
}

function tsunami(over: { grade?: string; areaName?: string } = {}): JMATsunami {
  return {
    kind: 'tsunami',
    id: 't1',
    time: '2026/08/24 12:40:00',
    cancelled: false,
    issue: { source: '', time: '2026/08/24 12:40:00', type: 'Focus' },
    sourceEarthquakes: [{ hypocenterName: '日向灘', magnitude: 8.1 }],
    areas: [{ grade: over.grade ?? 'MajorWarning', immediate: false, name: over.areaName ?? '宮崎県' }],
  } as unknown as JMATsunami
}

/** 既定は「海底地形も活断層もプレート境界も表示している」＝アプリの既定設定に合わせる。 */
function input(over: Partial<ShareCardContentInput> & { mode: MapMode }): ShareCardContentInput {
  return {
    quake: null,
    tsunamis: [],
    eews: [],
    showBathymetry: true,
    showActiveFaults: true,
    showPlateBoundaries: true,
    showPublicStations: false,
    kyoshinDetection: null,
    ...over,
  }
}

describe('buildShareCardContent — 地震', () => {
  it('最大震度を見出しにし、震源・規模・深さを副見出しに並べる', () => {
    const c = build(input({ mode: 'quake', quake: quake() }))
    expect(c.header.title.startsWith('最大震度 ')).toBe(true)
    expect(c.header.subtitle).toContain('日向灘')
    expect(c.header.subtitle).toContain('M5.2')
    expect(c.header.subtitle).toContain('深さ 30km')
  })

  // 震度を伝えない電文（震源情報など）は maxScale がセンチネルで届く。「最大震度 不明」と
  // 書くくらいなら見出しを種別名に落とす。
  it('震度が階級表に無い値なら見出しを「地震情報」に落とす', () => {
    const c = build(input({ mode: 'quake', quake: quake({ maxScale: -1 }) }))
    expect(c.header.title).toBe('地震情報')
    expect(c.header.titleColor).toBeUndefined()
  })

  // 正（2026-10-23 ユーザー選択「「不明」も焼く」で覆した。語は 2026-10-24 ユーザー選択「この語で (Recommended)」）:
  // 規模・深さが不明でも「M不明」「深さ 不明」と焼く（落とすと「伝えていない」と「判らない」が見分けられない）
  it('規模・深さが不明なら「M不明」「深さ 不明」と焼く', () => {
    const c = build(input({ mode: 'quake', quake: quake({ magnitude: NaN, depth: -1 }) }))
    expect(c.header.subtitle).toBe('日向灘　M不明　深さ 不明')
  })

  // 安全弁: 震源そのものを伝えていない電文（震度速報。座標がセンチネル）では規模・深さを足さない
  it('安全弁: 震源を伝えていない電文では規模・深さを足さない', () => {
    const q = quake({ magnitude: NaN, depth: -1 })
    q.earthquake.hypocenter.latitude = -200
    q.earthquake.hypocenter.longitude = -200
    const c = build(input({ mode: 'quake', quake: q }))
    expect(c.header.subtitle).not.toContain('不明')
  })

  // 対照: 位置だけが判らない電文（震源要素不明）では、判っている規模を位置と一緒に伏せない（地震カードと同じ `hasHypocenterFacts`）
  it('位置が判らなくても規模が判っていれば規模を焼き、深さは「不明」と焼く', () => {
    const q = quake({ magnitude: 5.1, depth: -1 })
    q.earthquake.hypocenter.latitude = -200
    q.earthquake.hypocenter.longitude = -200
    const c = build(input({ mode: 'quake', quake: q }))
    expect(c.header.subtitle).toBe('日向灘　M5.1　深さ 不明')
  })

  it('地震が無くても見出しだけは作る', () => {
    const c = build(input({ mode: 'quake' }))
    expect(c.header.title).toBe('地震情報')
  })
})

// 時刻が日時として読めないときの meta 欄。
//
// **画像は訂正できない。** 素で埋めていた頃は `"null 発生"` という文字列が焼き付いた
// （`formatDateTime` が `null` を返してもテンプレートリテラルは型検査を通る）。
// 規模・深さの「不明」を落とすのと同じ考え方で、欄ごと落とす。
describe('buildShareCardContent — 読めない時刻', () => {
  it('地震発現時刻が読めなければ meta を出さない', () => {
    // 対照: 読める値では公式の名前つきで入る。秒は出さない（電文に秒が無い。2026-10-22 ユーザー承認
    // 「5-A 秒と発生を落とす」）。「ごろ」も付けない（2026-10-23 ユーザー選択「公式名を付ける (Recommended)」）。
    const ok = build(input({ mode: 'quake', quake: quake() })).header.meta
    expect(ok).toBe('地震発現時刻 2026/08/24 12:34')
    expect(ok).not.toContain('発生')
    const c = build(input({ mode: 'quake', quake: quake({ time: '壊れた値' }) }))
    expect(c.header.meta).toBeUndefined()
  })

  // 対照: 報番号と時刻が両方そろう既定の形。**組み立てを配列の join へ変えた**ので、
  // 区切り（全角スペース）と並びが従来どおりであることを固定する。
  // 安全弁: **緊急地震速報はこのままにする。** あちらが出すのは `originTime`（地震発生時刻）で、
  // 電文が秒まで持つ。地震情報の側の時刻（発現時刻・秒なし）とは別物なので、一緒に変えない。
  it('報番号と発生時刻が両方あれば従来どおり並べる（緊急地震速報）', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew({ serial: '3' })] }))
    expect(c.header.meta).toBe('第3報　2026/08/24 12:34:00 発生')
  })

  it('緊急地震速報は発生時刻が読めなくても報番号を残す', () => {
    // **報番号は別の事実なので巻き込まない。**
    const c = build(input({ mode: 'kyoshin', eews: [eew({ originTime: '壊れた値', serial: '3' })] }))
    expect(c.header.meta).toBe('第3報')
  })

  it('緊急地震速報で発生時刻も報番号も無ければ meta を出さない', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew({ originTime: '壊れた値' })] }))
    expect(c.header.meta).toBeUndefined()
  })

  // 安全弁: `null` という文字列が焼き付かない（これが元の症状）。
  it('meta に "null" を焼き付けない', () => {
    const c = build(input({ mode: 'quake', quake: quake({ time: '壊れた値' }) }))
    expect(c.header.meta ?? '').not.toContain('null')
  })
})

describe('buildShareCardContent — 出典', () => {
  // 正: 公開観測点の印を描いているなら、EarthScope を「加工して作成」の側に挙げる（どのモードでも描く）。
  it('公開観測点の印を描いているなら EarthScope を加工の側に挙げる', () => {
    for (const mode of ['quake', 'kyoshin', 'tsunami'] as const) {
      const line = build(input({ mode, showPublicStations: true })).notices.join('\n')
      const derivedPart = line.slice(line.lastIndexOf('／') + 1)
      expect(derivedPart).toContain(ATTRIBUTION_SOURCES.earthScope)
      expect(derivedPart).toContain('加工して作成')
    }
  })

  // 対照: 描いていなければ挙げない。
  it('公開観測点の印を描いていなければ EarthScope を挙げない', () => {
    const line = build(input({ mode: 'kyoshin' })).notices.join('\n')
    expect(line).not.toContain(ATTRIBUTION_SOURCES.earthScope)
  })

  it('気象庁の出典は常に入る', () => {
    const c = build(input({ mode: 'quake', quake: quake() }))
    const line = c.notices.join('\n')
    expect(line).toContain(ATTRIBUTION_SOURCES.jma)
    expect(line).toContain('加工して作成')
  })

  // 海底地形は設定で消せる。消していれば画像に写らないので挙げない。
  it('海底地形は表示しているときだけ挙げる', () => {
    const shown = build(input({ mode: 'quake', quake: quake() }))
    expect(shown.notices.join('\n')).toContain(ATTRIBUTION_SOURCES.bathymetry)
    const hidden = build(input({ mode: 'quake', quake: quake(), showBathymetry: false }))
    expect(hidden.notices.join('\n')).not.toContain(ATTRIBUTION_SOURCES.bathymetry)
  })

  // 境界線・活断層・プレート境界は元データを変換して使っている（加工にあたる）が、海底地形は
  // 配信されるタイルをそのまま描いている。まとめて「加工して作成」で括ると、加工していない
  // ものまで加工したと述べることになる。
  it('海底地形は「加工して作成」の側に含めない', () => {
    const c = build(input({ mode: 'quake', quake: quake() }))
    const line = c.notices.join('\n')
    const derivedPart = line.slice(line.indexOf('／'))
    expect(derivedPart).toContain('加工して作成')
    expect(derivedPart).not.toContain(ATTRIBUTION_SOURCES.bathymetry)
  })

  // プレート境界の出典（PB2002）は Open Data Commons Attribution License で、
  // 成果物を公に利用する際の帰属表示が利用条件そのもの。描いているのに挙げないのは違反になる。
  it('活断層・プレート境界を描いているなら出典に挙げる', () => {
    const c = build(input({ mode: 'quake', quake: quake() }))
    const line = c.notices.join('\n')
    expect(line).toContain(ATTRIBUTION_SOURCES.activeFaults)
    expect(line).toContain(ATTRIBUTION_SOURCES.plateBoundaries)
  })

  it('表示を切っているものは出典に挙げない', () => {
    const c = build(
      input({ mode: 'quake', quake: quake(), showActiveFaults: false, showPlateBoundaries: false }),
    )
    const line = c.notices.join('\n')
    expect(line).not.toContain(ATTRIBUTION_SOURCES.activeFaults)
    expect(line).not.toContain(ATTRIBUTION_SOURCES.plateBoundaries)
    expect(line).toContain(ATTRIBUTION_SOURCES.jma)
  })

  // 活断層は地震／リアルタイム震度／震源カタログモードで、プレート境界はそれに津波モードを加えて描かれる（JapanMapGL の
  // showOverlayLines・showPlateLines）。描かないモードでは挙げない。
  // 正（2026-10-22 ユーザー選択「プレート境界だけ出す (Recommended)」で覆した）: 津波モードでもプレート境界は挙げる
  it('津波モードでは、プレート境界は挙げ、活断層は挙げない', () => {
    const c = build(input({ mode: 'tsunami' }))
    const line = c.notices.join('\n')
    expect(line).not.toContain(ATTRIBUTION_SOURCES.activeFaults)
    expect(line).toContain(ATTRIBUTION_SOURCES.plateBoundaries)
  })

  // 正（2026-10-24 ユーザー選択「一緒に直す (Recommended)」）: 震源カタログモードも両方を描くので挙げる
  it('震源カタログモードでは、活断層・プレート境界の両方を挙げる', () => {
    const c = build(input({ mode: 'catalog' }))
    const line = c.notices.join('\n')
    expect(line).toContain(ATTRIBUTION_SOURCES.activeFaults)
    expect(line).toContain(ATTRIBUTION_SOURCES.plateBoundaries)
  })
})

describe('buildShareCardContent — 緊急地震速報の注意文', () => {
  // **要点**: 緊急地震速報の予報円と震源は、地図のモードに関わらず描かれる（JapanMapGL の
  // PsWaveGL / EewEpicentersGL）。モードで注意文の要否を決めると、地震モードで撮ったカードに
  // 予報円が写っているのに注意文が無い、という状態を作れてしまう。
  it('地震モードでも、発報中の緊急地震速報があれば注意文を入れる', () => {
    const c = build(input({ mode: 'quake', quake: quake(), eews: [eew()] }))
    expect(c.notices[0]).toBe(EEW_NOTICE)
  })

  it('取り消された緊急地震速報では注意文を入れない', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew({ cancelled: true })] }))
    expect(c.notices).not.toContain(EEW_NOTICE)
  })

  // 精度の話だけを残すと、速報が届く前に揺れが来る場合があるという行動に直結する留保が
  // 伝わらない。文言を縮めるときもこの部分は落とさない。
  it('注意文は精度だけでなく「間に合わないことがある」まで伝える', () => {
    expect(EEW_NOTICE).toContain('間に合わない')
    expect(EEW_NOTICE).toContain('誤報')
  })
})

describe('buildShareCardContent — 緊急地震速報', () => {
  it('区分と予想最大震度を見出しに出す', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew({ severity: 'Warning' })] }))
    expect(c.header.title).toBe('緊急地震速報')
    expect(c.header.subtitle).toContain('予想最大震度')
  })

  // 並びは発報を受けた順で深刻さとは無関係。先頭を採ると、連続する余震や離れた 2 地域で
  // ほぼ同時に起きたときに弱い方を見出しにしてしまう。
  it('複数発報しているときは受信順ではなく深刻な方を見出しにする', () => {
    const mild = eew({ severity: 'Forecast', scaleTo: 30, name: '和歌山県北部' })
    const severe = eew({ severity: 'Warning', scaleTo: 55, name: '日向灘' })
    const c = build(input({ mode: 'kyoshin', eews: [mild, severe] }))
    expect(c.header.title).toBe('緊急地震速報')
    expect(c.header.subtitle).toContain('日向灘')
  })

  // 仮定震源要素の報は、電文に数値が入っていても地震学的に意味を持たない仮の値。
  // 画面（RealtimeTab）は隠しているので、共有した後で訂正できない画像でも隠す。
  it('仮定震源要素では規模を出さない', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew({ condition: '仮定震源要素' })] }))
    expect(c.header.subtitle).not.toContain('M6.5')
    expect(c.header.subtitle).toContain('日向灘')
  })

  // 「非常に強い揺れを検知」の報も震源は仮。規模（NaN）と発生時刻（無い）を画像へ焼かず、
  // 予想最大震度は出す。
  it('強い揺れ検知の報では規模も発生時刻も出さず、予想最大震度は出す', async () => {
    // テストボタンと同じ電文（→ `utils/testTelegramScripts.ts` の `EEW_STRONG_SHAKING`）。
    // 仮定震源要素のまま予想震度を持つ形で、初報がそれにあたる
    const strong = first(await telegramEews('EEW_STRONG_SHAKING'), '強い揺れ検知の初報')
    const c = build(input({ mode: 'kyoshin', eews: [strong] }))
    expect(c.header.subtitle).toContain('豊後水道')
    expect(c.header.subtitle).not.toMatch(/M|NaN|発生/)
    expect(c.header.subtitle).toContain('予想最大震度')
  })

  // 対照。震源が確定していれば規模は出す（上のテストが「常に隠す」で通ってしまわないように）。
  it('震源が確定していれば規模を出す', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew()] }))
    expect(c.header.subtitle).toContain('M6.5')
  })

  // 安全弁。規模を隠しても、予想震度は隠さない（避難の判断に要る値で、仮定震源要素でも
  // 区域ごとの予想として発表される）。
  it('仮定震源要素でも予想最大震度は出す', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew({ condition: '仮定震源要素' })] }))
    expect(c.header.subtitle).toContain('予想最大震度')
  })

  // 震央地名が空の報は、画面のカードと同じ「震源調査中」を名前の位置に置く
  it('震央地名が空なら「震源調査中」で始め、規模と予想最大震度を続ける', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew({ name: '' })] }))
    expect(c.header.subtitle?.startsWith('震源調査中')).toBe(true)
    expect(c.header.subtitle).toContain('M6.5')
    expect(c.header.subtitle).toContain('予想最大震度')
  })

  it('発報が無ければリアルタイム震度の見出しにする', () => {
    const c = build(input({ mode: 'kyoshin' }))
    expect(c.header.title).toBe('リアルタイム震度')
  })
})

describe('buildShareCardContent — 津波', () => {
  it('等級が無ければ見出しを「津波情報」に落とす', () => {
    const c = build(input({ mode: 'tsunami' }))
    expect(c.header.title).toBe('津波情報')
  })

  // 正: 予報だけの津波も等級を名乗り、震源・区域数・発表時刻は他の等級と同じに出す（2026-10-21 ユーザー選択「おすすめで」）。
  it('予報だけなら見出しを「津波予報（若干の海面変動）」にし、震源と区域数を出す', () => {
    const c = build(input({ mode: 'tsunami', tsunamis: [tsunami({ grade: 'Forecast' })] }))
    expect(c.header.title).toBe('津波予報（若干の海面変動）')
    expect(c.header.subtitle).toContain('日向灘')
    expect(c.header.subtitle).toContain('1 区域')
    expect(c.header.meta).toContain('発表')
  })

  // 対照: 予報に等級の読めない区域が混じれば予報と言い切らず、従来どおり「津波情報」に落とす。
  it('予報と等級の読めない区域が混じれば「津波情報」に落とす', () => {
    const t = { ...tsunami({ grade: 'Forecast' }), areas: [
      { grade: 'Forecast', immediate: false, name: '宮崎県' },
      { grade: 'Unknown', immediate: false, name: '鹿児島県東部' },
    ] } as unknown as JMATsunami
    const c = build(input({ mode: 'tsunami', tsunamis: [t] }))
    expect(c.header.title).toBe('津波情報')
  })

  // 安全弁: 警報・注意報があれば、予報の区域が混じっても重いほうを名乗る。
  it('注意報と予報が混じれば注意報を名乗る', () => {
    const t = { ...tsunami({ grade: 'Watch' }), areas: [
      { grade: 'Watch', immediate: false, name: '宮崎県' },
      { grade: 'Forecast', immediate: false, name: '鹿児島県東部' },
    ] } as unknown as JMATsunami
    const c = build(input({ mode: 'tsunami', tsunamis: [t] }))
    expect(c.header.title).toBe('津波注意報')
  })

  // 解除表示中の津波は、見出しにも副見出しにも数えない（材料の出どころを 1 つの集合に揃える）。
  it('解除表示中の警報と発表中の予報が並べば、区域数と時刻は予報の側から取る', () => {
    const ended = { ...tsunami({ grade: 'Warning', areaName: '高知県' }), id: 't0', cancelledAt: 1,
      sourceEarthquakes: [{ hypocenterName: '土佐湾', magnitude: 7.0 }] } as unknown as JMATsunami
    const forecast = { ...tsunami({ grade: 'Forecast' }), id: 't2' } as JMATsunami
    const c = build(input({ mode: 'tsunami', tsunamis: [ended, forecast] }))
    expect(c.header.title).toBe('津波予報（若干の海面変動）')
    expect(c.header.subtitle).toContain('日向灘')
    expect(c.header.subtitle).not.toContain('土佐湾')
    expect(c.header.subtitle).toContain('1 区域')
  })

  // 見出しの文字色は付けない。注意報の `formatTsunamiGrade().color` は黒で、暗い見出し帯の上では読めなかった。
  it('どの等級でも見出しの文字色を付けない（既定の白）', () => {
    for (const grade of ['MajorWarning', 'Warning', 'Watch', 'Forecast']) {
      const c = build(input({ mode: 'tsunami', tsunamis: [tsunami({ grade })] }))
      expect(c.header.titleColor, grade).toBeUndefined()
    }
    expect(build(input({ mode: 'tsunami' })).header.titleColor).toBeUndefined()
  })

  // 原因地震が複数ある津波（EventID に番号が足された形）は全件を並べる（2026-10-15 ユーザー承認「全件を並べる」）。
  it('原因地震が複数あれば「／」で全件を並べる', () => {
    const t = {
      ...tsunami(),
      sourceEarthquakes: [
        { hypocenterName: '石川県能登地方', magnitude: 7.6 },
        { hypocenterName: '佐渡付近', magnitude: 6.1 },
      ],
    } as unknown as JMATsunami
    const c = build(input({ mode: 'tsunami', tsunamis: [t] }))
    expect(c.header.subtitle).toBe('石川県能登地方　M7.6　深さ 不明 ／ 佐渡付近　M6.1　深さ 不明　1 区域')
  })

  // 正: 震源名と規模が同じ別の地震は 1 つに畳まず、発生時刻を添えて見分ける（2026-10-21 ユーザー選択「B は案1」。
  // 2023-12-03 の VTSE41 がフィリピン付近の M7.0 を 2 つ載せた実例の形）。
  it('震源名と規模が同じ別の地震には発生時刻を添える', () => {
    const t = {
      ...tsunami(),
      sourceEarthquakes: [
        { hypocenterName: 'フィリピン付近', magnitude: 7.7, originTime: '2023-12-02T23:37:00+09:00' },
        { hypocenterName: 'フィリピン付近', magnitude: 7.0, originTime: '2023-12-03T19:36:00+09:00' },
        { hypocenterName: 'フィリピン付近', magnitude: 7.0, originTime: '2023-12-04T04:50:00+09:00' },
      ],
    } as unknown as JMATsunami
    const c = build(input({ mode: 'tsunami', tsunamis: [t] }))
    expect(c.header.subtitle).toBe('フィリピン付近　M7.7　深さ 不明 ／ フィリピン付近　M7.0　深さ 不明（地震発現時刻 19:36） ／ フィリピン付近　M7.0　深さ 不明（地震発現時刻 04:50）　1 区域')
  })

  // 安全弁: 時刻を読めない側は別の地震と決められないので、同じ文の地震と重ねる（時刻なしの行が並ばない）
  it('時刻を持たない同じ文の地震は、時刻を持つ地震と重ねる', () => {
    const t = {
      ...tsunami(),
      sourceEarthquakes: [
        { hypocenterName: 'フィリピン付近', magnitude: 7.0, originTime: '2023-12-03T19:36:00+09:00' },
        { hypocenterName: 'フィリピン付近', magnitude: 7.0 },
      ],
    } as unknown as JMATsunami
    const c = build(input({ mode: 'tsunami', tsunamis: [t] }))
    expect(c.header.subtitle).toBe('フィリピン付近　M7.0　深さ 不明　1 区域')
  })

  // 安全弁: 時刻を持たない地震が先に並んでも、時刻の違う 2 つの地震は畳まない（届いた順によらない）
  it('時刻を持たない地震が先に並んでも、時刻の違う地震を畳まない', () => {
    const t = {
      ...tsunami(),
      sourceEarthquakes: [
        { hypocenterName: 'フィリピン付近', magnitude: 7.0 },
        { hypocenterName: 'フィリピン付近', magnitude: 7.0, originTime: '2023-12-03T19:36:00+09:00' },
        { hypocenterName: 'フィリピン付近', magnitude: 7.0, originTime: '2023-12-04T04:50:00+09:00' },
      ],
    } as unknown as JMATsunami
    const c = build(input({ mode: 'tsunami', tsunamis: [t] }))
    expect(c.header.subtitle).toBe('フィリピン付近　M7.0　深さ 不明（地震発現時刻 19:36） ／ フィリピン付近　M7.0　深さ 不明（地震発現時刻 04:50）　1 区域')
  })

  // 対照: 同じ瞬間を違う表記で運んでも 1 つの地震として重ねる
  it('同じ瞬間を違う表記で運ぶ地震は重ねる', () => {
    const t = {
      ...tsunami(),
      sourceEarthquakes: [
        { hypocenterName: 'フィリピン付近', magnitude: 7.0, originTime: '2023-12-03T19:36:00+09:00' },
        { hypocenterName: 'フィリピン付近', magnitude: 7.0, originTime: '2023-12-03T10:36:00Z' },
      ],
    } as unknown as JMATsunami
    const c = build(input({ mode: 'tsunami', tsunamis: [t] }))
    expect(c.header.subtitle).toBe('フィリピン付近　M7.0　深さ 不明　1 区域')
  })

  // 対照: 1 件なら区切りは入らない。
  it('原因地震が 1 件なら区切りを入れない', () => {
    const c = build(input({ mode: 'tsunami', tsunamis: [tsunami()] }))
    expect(c.header.subtitle).toBe('日向灘　M8.1　深さ 不明　1 区域')
  })

  // 安全弁: 同じ津波の報が並んでも、同じ原因地震を二度書かない。
  it('複数の報が同じ原因地震を運んでも重ねない', () => {
    const c = build(input({ mode: 'tsunami', tsunamis: [tsunami(), { ...tsunami(), id: 't2' } as JMATsunami] }))
    expect(c.header.subtitle).toBe('日向灘　M8.1　深さ 不明　1 区域')
  })
})

describe('buildShareCardContent — 保存名', () => {
  it('保存名の語は ASCII に限る（日本語のファイル名を扱えない環境があるため）', () => {
    const cases = [
      build(input({ mode: 'quake', quake: quake() })),
      build(input({ mode: 'tsunami' })),
      build(input({ mode: 'kyoshin' })),
      build(input({ mode: 'kyoshin', eews: [eew()] })),
    ]
    for (const c of cases) expect(c.filenameLabel).toMatch(/^[a-z]+$/)
  })
})

describe('buildShareCardContent — 共有の本文', () => {
  it('見出しと副見出しを 1 行目に、時刻を 2 行目に、URL を最後に置く', () => {
    const c = build(input({ mode: 'quake', quake: quake() }))
    const lines = c.shareText.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('最大震度')
    expect(lines[0]).toContain('日向灘')
    expect(lines[0]).toContain('M5.2')
    // 地震の時刻は地震発現時刻なので、公式の名前で出す（「発生」は地震発生時刻の名前）。
    expect(lines[1]).toMatch(/^地震発現時刻 /)
    expect(lines[2]).toBe(APP_URL)
  })

  // 画像と本文で違うことを述べない。材料は見出しと同じものだけを使う。
  it('本文の中身は見出しから作る', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew({ severity: 'Warning' })] }))
    expect(c.shareText).toContain(c.header.title)
    expect(c.shareText).toContain(c.header.subtitle ?? '')
    expect(c.shareText).toContain(c.header.meta ?? '')
  })

  // 対照。項目が無いモードでも空行を作らない——読み手には何も伝わらないうえ、
  // 共有先で不自然な余白になる。
  it('副見出しも時刻も無ければ見出しと URL だけにする', () => {
    const c = build(input({ mode: 'kyoshin' }))
    expect(c.shareText).toBe(`リアルタイム震度\n${APP_URL}`)
  })

  // **要点**: 緊急地震速報の注意文は画像へ焼いてあり、本文と画像は共有シートで一緒に渡る。
  // 本文にも重ねると X の全角 140 字にほぼ届き、震源名が長ければ超える——利用者が削ることに
  // なり、削られた結果として注意文そのものが落ちうる。
  it('緊急地震速報でも本文に注意文は入れない（画像には入る）', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew({ severity: 'Warning' })] }))
    expect(c.notices).toContain(EEW_NOTICE)
    expect(c.shareText).not.toContain(EEW_NOTICE)
    expect(c.shareText).not.toContain('間に合わない')
  })

  // 安全弁。注意文を外したぶん、本文だけを見ても何の速報かは判るようにしておく。
  it('緊急地震速報の本文は区分と震源を伝える', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew({ severity: 'Warning' })] }))
    expect(c.shareText).toContain('緊急地震速報')
    expect(c.shareText).toContain('日向灘')
  })

  it('出典は本文に入れない（画像へ焼いてある）', () => {
    const c = build(input({ mode: 'quake', quake: quake() }))
    expect(c.shareText).not.toContain(ATTRIBUTION_SOURCES.jma)
  })

  // 津波は時刻の語が「発表」になり、震源と区域数が副見出しに入る。地震・緊急地震速報とは
  // 材料の作り方が別の関数なので、本文まで通しで固定する。
  it('津波でも等級・震源・区域数・発表時刻を本文にする', () => {
    const c = build(input({ mode: 'tsunami', tsunamis: [tsunami()] }))
    const lines = c.shareText.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('大津波警報')
    expect(lines[0]).toContain('日向灘')
    expect(lines[0]).toContain('1 区域')
    expect(lines[1]).toContain('発表')
    expect(lines[2]).toBe(APP_URL)
  })

  // 対照。等級を取れない電文では見出しだけに落ち、時刻の行も作らない。
  it('津波で等級が無ければ見出しと URL だけにする', () => {
    const c = build(input({ mode: 'tsunami' }))
    expect(c.shareText).toBe(`津波情報\n${APP_URL}`)
  })
})

// 緊急地震速報の規模の説明（「Ｍ８を超える巨大地震」）も地震情報と同じく画像に出す（2026-10-22 ユーザー承認
// 「吹き出しと共有カードも揃える (Recommended)」）。「不明」の語だけは落とす
describe('buildShareCardContent — 緊急地震速報の規模の説明', () => {
  it('正: 規模が数値にならない報は気象庁の説明を出す', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew({ magnitude: NaN, magnitudeCondition: 'Ｍ８を超える巨大地震' })] }))
    expect(JSON.stringify(c.header)).toContain('M8を超える巨大地震')
  })

  // 正（2026-10-23 ユーザー選択「「不明」も焼く」で覆した）: 説明が「Ｍ不明」でも、説明が無くても「M不明」と焼く
  it('正: 説明が「Ｍ不明」の規模は「M不明」と焼く', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew({ magnitude: NaN, magnitudeCondition: 'Ｍ不明' })] }))
    expect(c.header.subtitle).toContain('M不明')
  })

  it('正: 説明の無い不明の規模も「M不明」と焼く（「不明」だけにしない）', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew({ magnitude: NaN })] }))
    expect(c.header.subtitle).toContain('M不明')
    expect(c.header.subtitle).not.toMatch(/(^|　)不明/)
  })
})

// 2026-10-23 の棚卸し⑨⑩⑪の決定（C1d・C2a・C2b・C3）
describe('buildShareCardContent — 複数の緊急地震速報・深さ・揺れ検知', () => {
  // 正（2026-10-23 ユーザー選択「全件を並べる」・並べ方は 2026-10-24 ユーザー選択「副見出しで折り返す (Recommended)」）
  it('正: 複数の緊急地震速報が発表中なら、副見出しに深刻な順で全件を並べる', () => {
    const mild = eew({ name: '福島県沖', scaleTo: 30 })
    const severe = eew({ name: '日向灘', severity: 'Warning', scaleTo: 55 })
    const c = build(input({ mode: 'kyoshin', eews: [mild, severe] }))
    expect(c.header.subtitle).toBe('日向灘　M6.5　深さ 30km　予想最大震度 6弱 ／ 福島県沖　M6.5　深さ 30km　予想最大震度 3')
  })

  // 正（2026-10-23 ユーザー選択「どちらも出す (Recommended)」）: 緊急地震速報の深さを焼く。安全弁: 仮の震源では規模も深さも出さない
  it('正: 緊急地震速報の深さを焼き、仮定震源要素の報では規模も深さも出さない', () => {
    expect(build(input({ mode: 'kyoshin', eews: [eew()] })).header.subtitle).toContain('深さ 30km')
    const provisional = build(input({ mode: 'kyoshin', eews: [eew({ condition: '仮定震源要素' })] })).header.subtitle ?? ''
    expect(provisional).not.toContain('深さ')
    expect(provisional).not.toContain('M')
  })

  // 正（2026-10-23 ユーザー選択「どちらも出す (Recommended)」）: 津波の原因地震の深さを焼く
  it('正: 津波の原因地震の深さを焼く', () => {
    const t = tsunami()
    t.sourceEarthquakes = [{ hypocenterName: '日向灘', magnitude: 8.1, depth: 20 }]
    expect(build(input({ mode: 'tsunami', tsunamis: [t] })).header.subtitle).toBe('日向灘　M8.1　深さ 20km　1 区域')
  })

  // 正（2026-10-23 ユーザー選択「揺れ検知中は推定最大震度を出す (Recommended)」・文面は 2026-10-24「この文面で (Recommended)」）
  it('正: 緊急地震速報が無く揺れを検知していれば、見出しは「揺れ検知」と推定最大震度', () => {
    const c = build(input({ mode: 'kyoshin', kyoshinDetection: { state: 'confirmed', maxIndex: 30 } }))
    expect(c.header.title).toBe('揺れ検知')
    expect(c.header.subtitle).toMatch(/^推定最大震度 .+（強震モニタ）$/)
    expect(build(input({ mode: 'kyoshin', kyoshinDetection: { state: 'candidate', maxIndex: 30 } })).header.title).toBe('揺れの可能性')
  })

  it('対照: 揺れを検知していなければ従来どおり「リアルタイム震度」', () => {
    expect(build(input({ mode: 'kyoshin' })).header.title).toBe('リアルタイム震度')
  })

  // 安全弁: 緊急地震速報があれば揺れ検知より緊急地震速報の見出しを優先する
  it('安全弁: 緊急地震速報が発表中なら、揺れ検知より緊急地震速報を見出しにする', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew()], kyoshinDetection: { state: 'confirmed', maxIndex: 30 } }))
    expect(c.header.title).not.toBe('揺れ検知')
  })
})
