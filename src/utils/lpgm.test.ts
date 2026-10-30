import { describe, it, expect } from 'vitest'
import { isValidLpgmClass, isObservedLpgmClass, getLpgmClassLabel, getLpgmClassColor, getLpgmClassRadius, lpgmCategoryNote, lpgmCategoryNoteWithRegions, lpgmHeadlineRegions, lpgmPeriodLabel, buildLpgmRows, canOpenLpgmNotes, lpgmQuakeFactParts, type LpgmRowDeps } from './lpgm'
import type { JMALpgm, LpgmPoint, LpgmRegion } from '../types/earthquake'
import { LPGM_ICON_BASE_RADIUS } from '../components/Map/gl/lpgmIcons'

describe('isValidLpgmClass', () => {
  it('階級 1〜4 を受け入れる', () => {
    for (const v of [1, 2, 3, 4]) expect(isValidLpgmClass(v)).toBe(true)
  })

  it('範囲外の値を弾く', () => {
    for (const v of [0, -1, 5, 99]) expect(isValidLpgmClass(v)).toBe(false)
  })

  it('非整数・特殊値を弾く', () => {
    for (const v of [1.5, NaN, Infinity, -Infinity]) expect(isValidLpgmClass(v)).toBe(false)
  })

  // 型検査が及ばない経路（実地震シナリオ JSON・as キャスト）を守るための関数なので、
  // 実行時に型どおりでない値が来ても誤って通さないことを固定する。
  it('型を迂回した文字列・null・undefined を弾く', () => {
    for (const v of ['1', 'toString', null, undefined]) {
      expect(isValidLpgmClass(v as unknown as number)).toBe(false)
    }
  })
})

describe('getLpgmClassLabel', () => {
  it('階級 1〜4 はそのままラベル化する', () => {
    expect(getLpgmClassLabel(1)).toBe('階級1')
    expect(getLpgmClassLabel(4)).toBe('階級4')
  })

  // 以前はフォールバックが無く、壊れた入力がそのまま「階級99」として地図ラベルに出ていた。
  it('範囲外の値は「階級不明」にフォールバックする', () => {
    for (const v of [-1, 5, 99, NaN, 1.5]) expect(getLpgmClassLabel(v)).toBe('階級不明')
  })

  // 意図的に覆した（2026-10-22 ユーザー選択「画面には残す (Recommended)」・表記は 2026-10-24 選択「この形でよい (Recommended)」）:
  // 階級 0 は観測情報の正常な値で、「階級0」と出す
  it('階級 0 は「階級0」', () => {
    expect(getLpgmClassLabel(0)).toBe('階級0')
  })
})

describe('getLpgmClassColor', () => {
  it('範囲外の値はグレーにフォールバックする', () => {
    expect(getLpgmClassColor(99)).toBe('#9ca3af')
  })

  it('階級 0 は灰色（階級 1〜4 の色の外）', () => {
    expect(getLpgmClassColor(0)).toBe('#9ca3af')
    for (const cls of [1, 2, 3, 4]) expect(getLpgmClassColor(cls)).not.toBe('#9ca3af')
  })
})

describe('isObservedLpgmClass', () => {
  it('観測情報の値域は 0〜4', () => {
    for (const v of [0, 1, 2, 3, 4]) expect(isObservedLpgmClass(v)).toBe(true)
  })

  // 対照: 予測の側（`isValidLpgmClass`）は 0 を通さない。0 の意味が違うので混ぜない
  it('予測の判定は 0 を通さない', () => {
    expect(isValidLpgmClass(0)).toBe(false)
  })

  it('値域の外・整数でない値は通さない', () => {
    for (const v of [-1, 5, 1.5, NaN]) expect(isObservedLpgmClass(v)).toBe(false)
  })
})

describe('getLpgmClassRadius', () => {
  // 階級が上がるほど大きく見せるための表。以前は階級によらず固定で、最も重い階級4 が
  // 階級1 と同じ大きさだった（map-rendering-spec.md §15）。
  it('階級が上がるほど大きくなる', () => {
    const radii = [1, 2, 3, 4].map(getLpgmClassRadius)
    expect(radii).toEqual([8, 10, 12, 14])
    for (let i = 1; i < radii.length; i++) expect(radii[i]).toBeGreaterThan(radii[i - 1])
  })

  it('範囲外の値は最小半径にフォールバックする', () => {
    for (const v of [0, 5, 99, NaN, -1]) expect(getLpgmClassRadius(v)).toBe(8)
  })

  // アイコン画像は LPGM_ICON_BASE_RADIUS(=32) で焼いて icon-size で縮小して表示する。
  // 区域バッジは半径に +8 の下駄を履くため、その最大がベース半径を超えると等倍でも
  // 拡大＝文字のぼやけになる（倍率を上げたときの限界は map-rendering-spec.md §15 を参照）。
  it('区域バッジの最大半径が等倍でベース半径を超えない', () => {
    const maxRegionRadius = Math.max(...[1, 2, 3, 4].map(c => getLpgmClassRadius(c) + 8))
    expect(maxRegionRadius).toBeLessThanOrEqual(LPGM_ICON_BASE_RADIUS)
  })
})

// 長周期地震動に関する観測情報の種類（電文の `LgCategory`）。
// **分類番号そのものは利用者に出さない。** 値 2・4 が意味するのは「階級を観測した地域のうち
// 最大震度が4以下の地域がある」＝揺れは強くないのに高層階が大きく揺れた地域がある、という状況。
describe('長周期の観測情報の種類', () => {
  // 正: 2・4 のときだけ意味を出す
  it('2 と 4 では意味を出す', () => {
    expect(lpgmCategoryNote(2)).toBe('震度が小さくても高層階が大きく揺れた地域があります')
    expect(lpgmCategoryNote(4)).toBe('震度が小さくても高層階が大きく揺れた地域があります')
  })

  // 対照: 1・3 は階級を観測した地域がどこも震度5弱以上。震度の表示だけで状況が伝わるので何も足さない
  // 意図的に覆した（2026-10-22 ユーザー選択「1・3 にも一文を出す (Recommended)」、文面は 2026-10-24 選択「この文面でよい (Recommended)」）
  it('1 と 3 では、数える地域の階級の下限を書いて震度5弱以上と伝える', () => {
    expect(lpgmCategoryNote(1)).toBe('長周期地震動階級1以上を観測した地域は、いずれも震度5弱以上です')
    expect(lpgmCategoryNote(3)).toBe('長周期地震動階級3以上を観測した地域は、いずれも震度5弱以上です')
  })

  // 安全弁: 種類を持たない電文・値域の外では何も出さない（分類番号を画面に漏らさない）
  it('無い値・値域の外では何も出さない', () => {
    expect(lpgmCategoryNote(undefined)).toBe('')
    expect(lpgmCategoryNote(0)).toBe('')
    expect(lpgmCategoryNote(9)).toBe('')
  })
})

// 見出し文の地域名を一文に添える（2026-10-30 ユーザー選択「一文に地域名を添える (Recommended)」）。
// 見出し文は 2024-01-01 能登の長周期地震動に関する観測情報（NII 収録・nii/20240101072337_0_VXSE62_010000.xml）
const NOTO_LPGM_HEADLINE = '０１日１６時１０分ころの地震により、長周期地震動階級４を観測した地域があります。\n'
  + '以下の地域では、最大震度は４以下でしたが、大きな長周期地震動階級（階級３以上）を観測しています。\n'
  + '高層ビル高層階では非常に大きな揺れとなっていた可能性があります。\n長野県中部\n'

describe('見出し文の地域名', () => {
  it('正: 「以下の地域」の後ろに並ぶ地域名だけを取り出す（句点で終わる文は地域名にしない）', () => {
    expect(lpgmHeadlineRegions(NOTO_LPGM_HEADLINE)).toEqual(['長野県中部'])
  })

  it('安全弁: 地域名の後ろの段落（空行の後の文・行）は地域名に混ぜない', () => {
    const withTail = NOTO_LPGM_HEADLINE + '\n＊＊別の段落の行＊＊\n'
    expect(lpgmHeadlineRegions(withTail)).toEqual(['長野県中部'])
    expect(lpgmHeadlineRegions(NOTO_LPGM_HEADLINE + '詳しくは本文を参照してください。\n他の行\n')).toEqual(['長野県中部'])
  })

  it('安全弁: 「以下の地域」の後ろに地域名が無ければ空（記録を残す）', () => {
    expect(lpgmHeadlineRegions('以下の地域では、最大震度は４以下でした。\n')).toEqual([])
  })

  it('正: 種類 2・4 の一文に括弧で添える', () => {
    expect(lpgmCategoryNoteWithRegions(4, NOTO_LPGM_HEADLINE)).toBe('震度が小さくても高層階が大きく揺れた地域があります（長野県中部）')
  })

  it('対照: 地域を並べない見出し文・種類 1・3 には添えない', () => {
    const plain = '０１日１６時５６分ころの地震により、長周期地震動階級２を観測した地域があります。'
    expect(lpgmHeadlineRegions(plain)).toEqual([])
    expect(lpgmCategoryNoteWithRegions(2, plain)).toBe('震度が小さくても高層階が大きく揺れた地域があります')
    expect(lpgmCategoryNoteWithRegions(3, NOTO_LPGM_HEADLINE)).toBe(lpgmCategoryNote(3))
  })

  it('安全弁: 見出し文が無い・種類が無いときは何も足さない', () => {
    expect(lpgmHeadlineRegions(undefined)).toEqual([])
    expect(lpgmCategoryNoteWithRegions(undefined, NOTO_LPGM_HEADLINE)).toBe('')
  })
})

describe('lpgmPeriodLabel', () => {
  // 電文の `PeriodicBand` は 1〜7 で、気象庁は 1.5〜2.5 秒台を第 1 帯とし
  // 1 秒刻みで 7.5〜8.5 秒台の第 7 帯まで置く（電文解説資料 Ⅱ.37）。
  it('帯の番号を中心周期で書く（番号のままでは意味が伝わらない）', () => {
    expect(lpgmPeriodLabel(1)).toBe('2秒')
    expect(lpgmPeriodLabel(7)).toBe('8秒')
  })

  it('値域の外は「周期不明」に倒す（型検査が及ばない経路から来る）', () => {
    expect(lpgmPeriodLabel(0)).toBe('周期不明')
    expect(lpgmPeriodLabel(8)).toBe('周期不明')
    expect(lpgmPeriodLabel(1.5)).toBe('周期不明')
    expect(lpgmPeriodLabel(NaN)).toBe('周期不明')
  })
})

describe('buildLpgmRows', () => {
  // 座標表からの逆引きは「電文が県を書いていない区域」の代理なので、既定では引けない状態で試す。
  const deps: LpgmRowDeps = { prefOfArea: () => null, rank: () => 0, onUnplaceableStation: () => {} }
  const region = (name: string, maxLgInt: number, extra: Partial<LpgmRegion> = {}): LpgmRegion =>
    ({ code: '', name, maxLgInt, ...extra })
  const station = (name: string, lgInt: number, extra: Partial<LpgmPoint> = {}): LpgmPoint =>
    ({ code: '', name, pref: '', lgInt, ...extra })

  // 正: 県内の階級がばらついていても県 1 行にまとめる。以前は「全区域が揃って同一階級」の
  // ときだけまとめており、実電文ではほとんどの県が個別区域として平らに並んでいた。
  it('正: 県内の階級がばらついていても県 1 行にまとめ、配下へ区域を入れる', () => {
    const rows = buildLpgmRows(
      [region('石川県能登', 4, { pref: '石川県' }), region('石川県加賀', 3, { pref: '石川県' })],
      [], [], deps,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('石川県')
    expect(rows[0].areas.map(a => a.name)).toEqual(['石川県能登', '石川県加賀'])
  })

  // 対照: 県を引けない区域は最上段に残す（区域名のまま並び、開いても県は現れない）。
  // **種別を持たせる** —— 区域名と県名は一致しうるので、画面の鍵を名前だけで作れない。
  it('対照: 都道府県を引けない区域は最上段の葉のまま残す', () => {
    expect(buildLpgmRows([region('どこかの区域', 2)], [], [], deps)).toEqual([
      { kind: 'area', name: 'どこかの区域', maxLgInt: 2, areas: [], stations: [] },
    ])
  })

  // 安全弁: 配下が 1 つも立たなくても、電文が県の階級を書いていれば行にする。
  // 区域の階級がどれも読めず観測点も無い電文で、気象庁が報告している県が消えないこと
  // （震度側の `buildIntensityRows` も都道府県ロールアップ点をループ対象に含めている）。
  it('安全弁: 区域も観測点も無くても、電文が県の階級を書いていれば行にする', () => {
    const rows = buildLpgmRows([], [], [{ code: '17', name: '石川県', maxLgInt: 4, maxInt: 70 }], deps)
    expect(rows).toEqual([
      { kind: 'pref', name: '石川県', maxLgInt: 4, maxInt: 70, areas: [], stations: [] },
    ])
  })

  it('電文が県を書いていない区域は座標表から逆引きする', () => {
    const rows = buildLpgmRows([region('石川県能登', 4)], [], [], {
      prefOfArea: n => (n === '石川県能登' ? '石川県' : null),
      rank: () => 0,
      onUnplaceableStation: () => {},
    })
    expect(rows[0].name).toBe('石川県')
  })

  it('観測点は電文の区域名（Area/Name）で区域の下へ入れる', () => {
    const rows = buildLpgmRows(
      [region('石川県能登', 4, { pref: '石川県' })],
      [station('七尾市本府中町', 4, { pref: '石川県', area: '石川県能登', int: 55 })],
      [], deps,
    )
    expect(rows[0].areas[0].stations).toEqual([{ name: '七尾市本府中町', lgInt: 4, int: 55 }])
  })

  it('区域が分からない観測点は県の直下へ置く', () => {
    const rows = buildLpgmRows(
      [region('石川県能登', 4, { pref: '石川県' })],
      [station('七尾市本府中町', 4, { pref: '石川県' })],
      [], deps,
    )
    expect(rows[0].areas[0].stations).toEqual([])
    expect(rows[0].stations.map(s => s.name)).toEqual(['七尾市本府中町'])
  })

  it('県も区域も分からない観測点は置き場が無いので落とす', () => {
    const rows = buildLpgmRows([region('石川県能登', 4, { pref: '石川県' })], [station('どこか', 4)], [], deps)
    expect(rows[0].stations).toEqual([])
    expect(rows[0].areas[0].stations).toEqual([])
  })

  // 安全弁: 県・区域の値は電文が書いているものを優先し、配下から積み上げ直さない。
  // 積み上げに寄せると、区域や観測点を 1 つ読み落としたときに静かに低く出る。
  it('安全弁: 県の階級・震度は電文（prefs）を優先し、配下から積み上げない', () => {
    const rows = buildLpgmRows(
      [region('石川県能登', 4, { pref: '石川県', maxInt: 70 })],
      [],
      [{ code: '17', name: '石川県', maxLgInt: 3, maxInt: 50 }],
      deps,
    )
    expect(rows[0].maxLgInt).toBe(3)
    expect(rows[0].maxInt).toBe(50)
  })

  it('電文が県の値を持たなければ配下から積み上げる', () => {
    const rows = buildLpgmRows(
      [
        region('石川県能登', 4, { pref: '石川県', maxInt: 70 }),
        region('石川県加賀', 3, { pref: '石川県', maxInt: 50 }),
      ],
      [], [], deps,
    )
    expect(rows[0].maxLgInt).toBe(4)
    expect(rows[0].maxInt).toBe(70)
  })

  // 区域の読み取り失敗は「その電文の区域が全滅したとき」しか記録されないので、
  // 配下から立てないと市町村を持たない長周期でも観測点ごと画面から消える。
  it('区域自身の階級が読めなくても、観測点があれば区域の行を立てる', () => {
    const rows = buildLpgmRows(
      [],
      [station('七尾市本府中町', 4, { pref: '石川県', area: '石川県能登', int: 55 })],
      [], deps,
    )
    expect(rows[0].name).toBe('石川県')
    expect(rows[0].areas[0]).toMatchObject({ name: '石川県能登', maxLgInt: 4, maxInt: 55 })
  })

  // 意図的に覆した（2026-10-22 ユーザー選択「画面には残す (Recommended)」）: 階級 0 の区域・観測点も行にする
  it('階級 0 の区域・観測点も行にする', () => {
    const rows = buildLpgmRows(
      [region('石川県能登', 0, { pref: '石川県' })],
      [station('七尾市本府中町', 0, { pref: '石川県', area: '石川県能登' })],
      [], deps,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'pref', name: '石川県', maxLgInt: 0 })
    expect(rows[0].areas[0]).toMatchObject({ name: '石川県能登', maxLgInt: 0 })
    expect(rows[0].areas[0].stations.map(s => s.lgInt)).toEqual([0])
  })

  // 安全弁: 値域の外（負の値）は今までどおり行にしない
  it('値域の外の階級は行にしない', () => {
    const rows = buildLpgmRows(
      [region('石川県能登', -1, { pref: '石川県' })],
      [station('七尾市本府中町', 5, { pref: '石川県', area: '石川県能登' })],
      [], deps,
    )
    expect(rows).toEqual([])
  })

  // 正: 区域も県も分からない観測点は置き場が無い。黙って消さず、呼び出し側へ知らせる
  // （2026-10-22 ユーザー選択「消すときに記録を残す (Recommended)」）
  it('区域も県も分からない観測点は、置けなかったことを知らせる', () => {
    const dropped: string[] = []
    const rows = buildLpgmRows(
      [], [station('どこか', 2)], [],
      { ...deps, onUnplaceableStation: name => dropped.push(name) },
    )
    expect(rows).toEqual([])
    expect(dropped).toEqual(['どこか'])
  })

  // 対照: 県だけ分かる観測点は県の直下に置けるので、知らせない
  it('県だけ分かる観測点は知らせない', () => {
    const dropped: string[] = []
    buildLpgmRows([], [station('どこか', 2, { pref: '石川県' })], [], { ...deps, onUnplaceableStation: name => dropped.push(name) })
    expect(dropped).toEqual([])
  })

  it('並びは階級の降順、同じ階級どうしは気象庁の標準順', () => {
    const ranks: Record<string, number> = { 青森県: 1, 岩手県: 2, 青森県津軽北部: 1, 岩手県内陸南部: 2 }
    const rows = buildLpgmRows(
      [
        region('岩手県内陸南部', 2, { pref: '岩手県' }),
        region('青森県津軽北部', 2, { pref: '青森県' }),
        region('石川県能登', 4, { pref: '石川県' }),
      ],
      [], [], { prefOfArea: () => null, rank: n => ranks[n] ?? 99, onUnplaceableStation: () => {} },
    )
    expect(rows.map(r => r.name)).toEqual(['石川県', '青森県', '岩手県'])
  })

  it('観測点の並びも階級の降順', () => {
    const rows = buildLpgmRows(
      [region('石川県能登', 4, { pref: '石川県' })],
      [
        station('弱いほう', 2, { pref: '石川県', area: '石川県能登' }),
        station('強いほう', 4, { pref: '石川県', area: '石川県能登' }),
      ],
      [], deps,
    )
    expect(rows[0].areas[0].stations.map(s => s.name)).toEqual(['強いほう', '弱いほう'])
  })
})

// 補足を開けるか。**カードの見出しを出す条件と、読み上げ側の診断で共有する**
// （→ docs/spec/audio-tts-spec.md §6「読み上げに合わせて気象庁の文を開く」）。書き写すと、
// 片方だけが「開ける」と判断して診断が鳴らない／正常な見送りで記録が埋まる、のどちらかになる。
describe('canOpenLpgmNotes', () => {
  const base = { id: 'l1', time: '', eventId: 'e1', originTime: '', maxClass: 3, cancelled: false }
  const make = (over: Record<string, unknown>) => ({ ...base, ...over } as unknown as JMALpgm)

  // 正: 添えられた文が 1 つでもあれば開ける
  it('付加文が 1 つでもあれば開ける', () => {
    expect(canOpenLpgmNotes(make({ forecastText: 'あ' }))).toBe(true)
    expect(canOpenLpgmNotes(make({ varCommentText: 'あ' }))).toBe(true)
    expect(canOpenLpgmNotes(make({ freeFormText: 'あ' }))).toBe(true)
  })

  // 正: 詳細ページへのリンクだけでも開ける（開けば行き先がある）
  it('詳細ページへのリンクだけでも開ける', () => {
    expect(canOpenLpgmNotes(make({ uri: 'https://example.invalid/' }))).toBe(true)
  })

  // 対照: 中身が 1 つも無ければ開けない（押せる見た目だけ与えない）
  it('中身が 1 つも無ければ開けない', () => {
    expect(canOpenLpgmNotes(make({}))).toBe(false)
    expect(canOpenLpgmNotes(null)).toBe(false)
    expect(canOpenLpgmNotes(undefined)).toBe(false)
  })

  // 安全弁: **階級を観測していない電文では見出しごと出ない。** 中身があっても開けないので、
  // 読み上げ側はここを「開く先が無い」と判定できなければならない
  // 意図的に覆した: 階級 0 の報も画面に残すので、補足も開ける
  it('階級 0 の報でも、中身があれば開ける', () => {
    expect(canOpenLpgmNotes(make({ maxClass: 0, freeFormText: 'あ' }))).toBe(true)
  })

  // 安全弁: 取消の報は開けない（取消は一覧ごと消える）
  it('取消の報は中身があっても開けない', () => {
    expect(canOpenLpgmNotes(make({ maxClass: 0, cancelled: true, freeFormText: 'あ' }))).toBe(false)
  })
})

// 地震カードの長周期の欄に並べる値（2026-10-29 ユーザー承認「1行・名前と深さ (Recommended)」）
describe('lpgmQuakeFactParts', () => {
  const base: JMALpgm = {
    id: 'x', eventId: '20240101161000', time: '2024-01-01T16:23:00+09:00', originTime: '2024-01-01T16:10:00+09:00',
    maxClass: 4, cancelled: false,
    hypocenter: { name: '石川県能登地方', depth: 10 },
    magnitude: 7.6, magnitudeType: 'Mj', maxInt: 70, arrivalTime: '2024-01-01T16:10:00+09:00',
  }

  // 正: 震央地名・深さ・規模・最大震度・地震発現時刻を、地震カードと同じ書き方で並べる
  it('震央地名・深さ・規模・最大震度・地震発現時刻を並べる', () => {
    expect(lpgmQuakeFactParts(base).map(p => p.text)).toEqual([
      '石川県能登地方', '深さ10km', 'Mj7.6', '最大震度7', '地震発現時刻 1月1日 16:10',
    ])
  })

  // 対照: 値が無い項目は語ごと省く（「不明」を並べない）
  it('値が無い項目は語ごと省く', () => {
    const parts = lpgmQuakeFactParts({ ...base, hypocenter: undefined, magnitude: undefined, maxInt: undefined, arrivalTime: undefined })
    expect(parts).toEqual([])
  })

  // 安全弁: 深さ 0 は「ごく浅い」、数値の無い規模は気象庁の説明を出す、読めない時刻は「不明」を出す
  it('深さ 0・説明だけの規模・読めない時刻も地震カードと同じ語になる', () => {
    const texts = lpgmQuakeFactParts({
      ...base, hypocenter: { name: '石川県能登地方', depth: 0 }, magnitude: Number.NaN, magnitudeCondition: 'Ｍ８を超える巨大地震', arrivalTime: '壊れた値',
    }).map(p => p.text)
    expect(texts).toContain('ごく浅い')
    expect(texts.some(t => t.includes('巨大地震'))).toBe(true)
    expect(texts).toContain('地震発現時刻不明')
  })

  it('印を引く欄は地震カードと同じ名前', () => {
    expect(lpgmQuakeFactParts(base).map(p => p.field)).toEqual(['hypocenterName', 'depth', 'magnitude', 'maxScale', undefined])
  })
})
