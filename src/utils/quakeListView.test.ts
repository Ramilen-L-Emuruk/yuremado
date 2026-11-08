// 地震タブの絞り込み・並び替え・区切り・帯の札（2026-11-07 ユーザー選択。→ quakeListView.ts）
import { describe, it, expect } from 'vitest'
import type { EarthquakePoint, IntensityScale, IssueType, JMAQuake } from '../types/earthquake'
import { sanitize } from '../hooks/useSettings'
import {
  DEFAULT_QUAKE_LIST_FILTER, DEFAULT_QUAKE_LIST_SETTINGS, nextQuakeListSort, passesQuakeListFilter, quakeFilterChipLabels,
  quakeListFilterOf, quakeListFilterSettings, quakeListAutoLoadAllowed, quakeListPeriodStartLabel, quakeListSection, quakeListUnloadedBefore, quakeRegionBlocks, quakeRegionGroups, sortQuakeList,
  type QuakeFilterContext, type QuakeListFilter, keepIfSame, withLatestPinned, observedAreas,
  clearQuakeListFilter, wantsAttachedTypes, quakeListMatchedCount } from './quakeListView'

interface QuakeOpts {
  id: string
  scale?: IntensityScale
  time?: string
  magnitude?: number
  depth?: number
  name?: string
  code?: string
  type?: IssueType
  reports?: IssueType[]
  points?: Partial<EarthquakePoint>[]
}

function quake(o: QuakeOpts): JMAQuake {
  return {
    kind: 'quake',
    id: o.id,
    eventKey: o.id,
    time: o.time ?? '2026-11-07T03:00:00Z',
    issue: { source: 'dmdata', time: o.time ?? '2026-11-07T03:00:00Z', type: o.type ?? '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: o.time ?? '2026-11-07T03:00:00Z',
      hypocenter: {
        name: o.name ?? '茨城県南部', code: o.code ?? '301', latitude: 36, longitude: 140,
        depth: o.depth ?? 50, magnitude: o.magnitude ?? 4.5,
      },
      maxScale: o.scale ?? 30,
      domesticTsunami: 'なし',
    },
    points: (o.points ?? []).map(p => ({ pref: '茨城県', addr: '水戸市', isArea: false, scale: 30, ...p })) as EarthquakePoint[],
    reports: o.reports?.map(type => ({ type, keys: ['k'] })),
  } as JMAQuake
}

const NOW = Date.parse('2026-11-07T06:00:00Z')

function ctx(over: Partial<QuakeFilterContext> = {}): QuakeFilterContext {
  return {
    nowMs: NOW,
    pinnedKeys: new Set(),
    keyOf: q => q.id,
    attachedTypesOf: () => [],
    areaPrefIndex: null,
    ...over,
  }
}

const filter = (over: Partial<QuakeListFilter>): QuakeListFilter => ({ ...DEFAULT_QUAKE_LIST_FILTER, ...over })
const ids = (qs: readonly JMAQuake[]) => qs.map(q => q.id)
const pass = (qs: JMAQuake[], f: QuakeListFilter, c = ctx()) => ids(qs.filter(q => passesQuakeListFilter(q, f, c)))

describe('絞り込み', () => {
  // 正: 震度の下限と上限で絞る。対照: 絞らなければすべて出す
  it('震度の下限・上限で絞り、決めていなければすべて出す', () => {
    const qs = [quake({ id: 'a', scale: 20 }), quake({ id: 'b', scale: 40 }), quake({ id: 'c', scale: 55 })]
    expect(pass(qs, filter({ scale: { min: 30, max: null } }))).toEqual(['b', 'c'])
    expect(pass(qs, filter({ scale: { min: 30, max: 45 } }))).toEqual(['b'])
    expect(pass(qs, DEFAULT_QUAKE_LIST_FILTER)).toEqual(['a', 'b', 'c'])
  })

  // 正: 遠地地震は震度の絞りでは外さない。安全弁: 規模の絞りでは例外にしない（絞りごとに当てる）
  it('遠地地震は震度の絞りでは残し、規模の絞りでは普通に絞る', () => {
    const foreign = quake({ id: 'f', scale: -1, type: '遠地地震', magnitude: 6.0 })
    expect(pass([foreign], filter({ scale: { min: 30, max: null } }))).toEqual(['f'])
    expect(pass([foreign], filter({ magnitude: { min: 7, max: null } }))).toEqual([])
  })

  // 正: 「5弱以上（未入電）」は 5強以上の下限でも残す。対照: 未入電の点が無い 5弱は外す。安全弁: 上限 4 では外す
  it('「5弱以上（未入電）」は下限には通し、上限とは 5弱で比べる', () => {
    const unreceived = quake({ id: 'u', scale: 45, points: [{ scale: 45, unreceived: true }] })
    const plain = quake({ id: 'p', scale: 45, points: [{ scale: 45 }] })
    expect(pass([unreceived, plain], filter({ scale: { min: 50, max: null } }))).toEqual(['u'])
    expect(pass([unreceived], filter({ scale: { min: null, max: 40 } }))).toEqual([])
  })

  // 正: 固定した地震（通知・津波タブから開いた地震）はどの絞りでも残す。対照: 固定していない地震は絞りどおり外す
  // （津波の原因地震・国際津波関連情報の付いた地震も例外にしない。2026-11-08 選択「例外をやめる (Recommended)」）
  it('固定した地震だけはどの絞りでも残す', () => {
    const qs = [quake({ id: 'n', scale: 10 }), quake({ id: 'x', scale: 10 })]
    const c = ctx({ pinnedKeys: new Set(['n']) })
    expect(pass(qs, filter({ scale: { min: 40, max: null }, region: { basis: 'epicenter', names: ['三陸沖'], view: 'list' } }), c)).toEqual(['n'])
    expect(pass(qs, DEFAULT_QUAKE_LIST_FILTER, c)).toEqual(['n', 'x'])
  })

  // 正: 規模・深さが不明の地震は、下限か上限を決めたら外す。対照: 決めていなければ残す
  it('規模・深さが不明なら、範囲を決めたときだけ外す', () => {
    const unknown = quake({ id: 'u', magnitude: Number.NaN, depth: -1 })
    expect(pass([unknown], filter({ magnitude: { min: null, max: 9 } }))).toEqual([])
    expect(pass([unknown], filter({ depth: { min: 0, max: null } }))).toEqual([])
    expect(pass([unknown], DEFAULT_QUAKE_LIST_FILTER)).toEqual(['u'])
  })

  it('深さは両端を含み、ごく浅い（0km）も数える', () => {
    const qs = [quake({ id: 's', depth: 0 }), quake({ id: 'm', depth: 100 }), quake({ id: 'd', depth: 101 })]
    expect(pass(qs, filter({ depth: { min: 0, max: 100 } }))).toEqual(['s', 'm'])
  })

  // 正: 震央地名と、震度を観測した地域（細分区域）を切り替える
  it('地域は震央地名か、震度を観測した地域で絞る', () => {
    const q = quake({ id: 'q', name: '茨城県南部', points: [{ isArea: true, addr: '栃木県南部' }, { area: '千葉県北西部' }] })
    expect(pass([q], filter({ region: { basis: 'epicenter', names: ['茨城県南部'], view: 'list' } }))).toEqual(['q'])
    expect(pass([q], filter({ region: { basis: 'epicenter', names: ['栃木県南部'], view: 'list' } }))).toEqual([])
    expect(pass([q], filter({ region: { basis: 'observed', names: ['栃木県南部'], view: 'list' } }))).toEqual(['q'])
    expect(pass([q], filter({ region: { basis: 'observed', names: ['千葉県北西部'], view: 'list' } }))).toEqual(['q'])
    expect(pass([q], filter({ region: { basis: 'observed', names: ['茨城県南部'], view: 'list' } }))).toEqual([])
  })

  // 正: 受け取った種別のどれかが当たれば出す（2026-11-07 選択「札と同じ語で選ぶ (Recommended)」）
  it('種類は受け取った種別のどれかが当たれば出す', () => {
    const q = quake({ id: 'q', type: '震源・震度情報', reports: ['震度速報', '震源・震度情報'] })
    expect(pass([q], filter({ types: ['震度速報'] }))).toEqual(['q'])
    expect(pass([q], filter({ types: ['遠地地震'] }))).toEqual([])
  })

  it('期間は今から遡る時間で絞る', () => {
    const recent = quake({ id: 'r', time: '2026-11-07T00:00:00Z' })
    const old = quake({ id: 'o', time: '2026-11-05T00:00:00Z' })
    expect(pass([recent, old], filter({ period: { kind: 'hours', hours: 24 } }))).toEqual(['r'])
  })

  // 正: 日付の範囲は日本時間の日付で切る（2026-11-08 選択「日本時間で切る」）。端末の時刻帯によらない。
  // 境界: 11-05 00:00 JST（= 11-04 15:00Z）は入り、その 1 秒前は前の日。11-05 23:59:59 JST は入り、11-06 00:00 JST は外れる
  it('日付の範囲は日本時間の日付で切り、両端の日を含む', () => {
    const qs = [
      quake({ id: 'before', time: '2026-11-04T14:59:59Z' }),
      quake({ id: 'start', time: '2026-11-04T15:00:00Z' }),
      quake({ id: 'end', time: '2026-11-05T14:59:59Z' }),
      quake({ id: 'after', time: '2026-11-05T15:00:00Z' }),
    ]
    expect(pass(qs, filter({ period: { kind: 'range', from: '2026-11-05', to: '2026-11-05' } }))).toEqual(['start', 'end'])
  })

  // 正: 長周期・推計・英文は、その地震に付いた報で当てる（2026-11-08 選択「長周期・推計・英文も並べる」）。
  // 対照: 付いていない地震は外す。安全弁: 電文の種別の当たり方は変わらない
  it('種類の長周期・推計・英文は、その地震に付いた報で当てる', () => {
    const withLpgm = quake({ id: 'l' })
    const plain = quake({ id: 'p' })
    const c = ctx({ attachedTypesOf: q => (q.id === 'l' ? ['長周期地震動に関する観測情報'] : []) })
    expect(pass([withLpgm, plain], filter({ types: ['長周期地震動に関する観測情報'] }), c)).toEqual(['l'])
    expect(pass([withLpgm, plain], filter({ types: ['推計震度分布図'] }), c)).toEqual([])
    expect(pass([withLpgm, plain], filter({ types: ['震源・震度情報'] }), c)).toEqual(['l', 'p'])
  })
})

describe('並び替え', () => {
  const a = quake({ id: 'a', scale: 40, magnitude: 5.0, depth: 10, code: '300', time: '2026-11-07T01:00:00Z' })
  const b = quake({ id: 'b', scale: -1, magnitude: Number.NaN, depth: -1, code: '471', time: '2026-11-07T02:00:00Z' })
  const c = quake({ id: 'c', scale: 40, magnitude: 6.1, depth: 300, code: '288', time: '2026-11-07T03:00:00Z' })

  // 正: 値で並べ、同じ値は時刻の新しい順。安全弁: 不明は向きによらず末尾
  it('値で並べ、同じ値は新しい順、不明は向きによらず末尾', () => {
    expect(ids(sortQuakeList([a, b, c], { key: 'scale', dir: 'desc' }))).toEqual(['c', 'a', 'b'])
    expect(ids(sortQuakeList([a, b, c], { key: 'scale', dir: 'asc' }))).toEqual(['c', 'a', 'b'])
    expect(ids(sortQuakeList([a, b, c], { key: 'magnitude', dir: 'asc' }))).toEqual(['a', 'c', 'b'])
    expect(ids(sortQuakeList([a, b, c], { key: 'depth', dir: 'desc' }))).toEqual(['c', 'a', 'b'])
  })

  it('地域は震央地名コードの順、時刻は古い順も選べる', () => {
    expect(ids(sortQuakeList([a, b, c], { key: 'region', dir: 'asc' }))).toEqual(['c', 'a', 'b'])
    expect(ids(sortQuakeList([c, b, a], { key: 'time', dir: 'asc' }))).toEqual(['a', 'b', 'c'])
  })

  // 対照: 今の並び（新しい順）は元の順のまま（届いた順の並びを崩さない）
  it('新しい順は元の並びのまま返す', () => {
    expect(ids(sortQuakeList([c, b, a], { key: 'time', dir: 'desc' }))).toEqual(['c', 'b', 'a'])
  })

  it('見出しを押すと、同じ欄は向きを返し、別の欄は大きい方から（地域は北から）', () => {
    expect(nextQuakeListSort({ key: 'scale', dir: 'desc' }, 'scale')).toEqual({ key: 'scale', dir: 'asc' })
    expect(nextQuakeListSort({ key: 'time', dir: 'desc' }, 'magnitude')).toEqual({ key: 'magnitude', dir: 'desc' })
    expect(nextQuakeListSort({ key: 'time', dir: 'desc' }, 'region')).toEqual({ key: 'region', dir: 'asc' })
  })
})

describe('区切り', () => {
  it('震度は階級、規模は整数、深さは幅、地域は区切らない', () => {
    expect(quakeListSection(quake({ id: 'a', scale: 45 }), 'scale')?.label).toBe('震度5弱')
    expect(quakeListSection(quake({ id: 'a', magnitude: 5.9 }), 'magnitude')?.label).toBe('M5')
    expect(quakeListSection(quake({ id: 'a', magnitude: Number.NaN }), 'magnitude')?.label).toBe('M不明')
    expect(quakeListSection(quake({ id: 'a' }), 'region')).toBeNull()
  })

  // 境界: 30km は「30〜100km」、29km は「30km未満」、300km は「300km以上」
  it('深さの幅の境目', () => {
    const label = (depth: number) => quakeListSection(quake({ id: 'a', depth }), 'depth')?.label
    expect([label(29), label(30), label(99), label(100), label(300), label(-1)])
      .toEqual(['深さ30km未満', '深さ30〜100km', '深さ30〜100km', '深さ100〜300km', '深さ300km以上', '深さ不明'])
  })
})

describe('帯の札', () => {
  it('絞っていない札は名前だけ、絞った札は中身（地域と種類は数）', () => {
    expect(quakeFilterChipLabels(DEFAULT_QUAKE_LIST_FILTER)).toEqual({
      scale: '震度', magnitude: '規模', depth: '深さ', region: '地域', types: '種類', period: '期間',
    })
    expect(quakeFilterChipLabels(filter({
      scale: { min: 30, max: 45 }, magnitude: { min: 4, max: null }, depth: { min: 10, max: 100 },
      region: { basis: 'epicenter', names: ['a', 'b'], view: 'list' }, types: ['震度速報', '遠地地震', '震源情報'], period: { kind: 'hours', hours: 168 },
    }))).toEqual({
      scale: '震度3〜5弱', magnitude: 'M4.0以上', depth: '深さ10〜100km', region: '地域（2）', types: '種類（3）', period: '7日',
    })
  })
})

describe('設定との行き来', () => {
  it('条件を設定の形にして戻すと元に戻る', () => {
    const f = filter({
      scale: { min: 30, max: null }, magnitude: { min: 4.5, max: 7 }, depth: { min: null, max: 100 },
      region: { basis: 'observed', names: ['栃木県南部'], view: 'list' }, types: ['震度速報'], period: { kind: 'range', from: '2026-11-01', to: '2026-11-05' },
    })
    expect(quakeListFilterOf({ ...DEFAULT_QUAKE_LIST_SETTINGS, ...quakeListFilterSettings(f) })).toEqual(f)
  })

  // 正: 地域の窓の一覧／地図は、最後に選んだ方を残す（2026-11-08 選択「最後に選んだ方を覚える」）。
  // 安全弁: 読めない値は一覧に戻す
  it('地域の窓の一覧／地図を保存し、読めない値は一覧に戻す', () => {
    const f = filter({ region: { basis: 'epicenter', names: [], view: 'map' } })
    expect(quakeListFilterSettings(f).quakeListRegionView).toBe('map')
    expect(quakeListFilterOf({ ...DEFAULT_QUAKE_LIST_SETTINGS, ...quakeListFilterSettings(f) }).region.view).toBe('map')
    expect(sanitize({ quakeListRegionView: 'map' }).quakeListRegionView).toBe('map')
    expect(sanitize({ quakeListRegionView: 'globe' } as never).quakeListRegionView).toBe('list')
  })

  // 正: 保存に条件が無ければ、設定の窓にあった最低表示震度を震度の下限へ引き継ぐ。
  // 安全弁: 条件が保存されていれば、そちらが勝つ
  it('最低表示震度を震度の下限へ引き継ぎ、新しい項目があればそちらを使う', () => {
    expect(sanitize({ minDisplayScale: 30 } as never).quakeListScaleMin).toBe(30)
    expect(sanitize({ minDisplayScale: 30, quakeListScaleMin: 40 } as never).quakeListScaleMin).toBe(40)
    expect(sanitize({}).quakeListScaleMin).toBe(-1)
  })

  it('日付の範囲は始めと終わりがそろったときだけ残す', () => {
    const s = sanitize({ quakeListPeriodFrom: '2026-11-01', quakeListPeriodTo: null })
    expect([s.quakeListPeriodFrom, s.quakeListPeriodTo]).toEqual([null, null])
  })
})

describe('地域の一覧', () => {
  const NO_RANK = () => 0
  const PREFS = [{ code: '01', name: '北海道' }, { code: '08', name: '茨城県' }, { code: '09', name: '栃木県' }]

  // 正: 震央地名を県ごとにまとめ、北海道の陸の区域・海域・遠方を分け、件数を数える
  it('震央地名を県・北海道・海域・遠方にまとめて件数を出す（県名で始まる海の区域はその県）', () => {
    const qs = [
      quake({ id: 'a', name: '茨城県南部', code: '301' }),
      quake({ id: 'b', name: '茨城県南部', code: '301' }),
      quake({ id: 'c', name: '茨城県北部', code: '300' }),
      quake({ id: 'd', name: '釧路地方中南部', code: '161' }),
      quake({ id: 'e', name: '茨城県沖', code: '471' }),
      quake({ id: 'g', name: '三陸沖', code: '288' }),
      quake({ id: 'f', name: '中米', code: '945' }),
    ]
    const groups = quakeRegionGroups(qs, 'epicenter', [], PREFS, null, NO_RANK)
    expect(groups.map(g => [g.label, g.options.map(o => `${o.name}:${o.count}`)])).toEqual([
      ['北海道', ['釧路地方中南部:1']],
      ['茨城県', ['茨城県北部:1', '茨城県南部:2', '茨城県沖:1']],
      ['海域', ['三陸沖:1']],
      ['遠方', ['中米:1']],
    ])
  })

  // 正: 震度を観測した地域は観測点の県でまとめ、1 つの地震の同じ地域は 1 件と数える
  it('震度を観測した地域は観測点の県でまとめ、同じ地震の重複は 1 件', () => {
    const q = quake({ id: 'a', points: [{ pref: '栃木県', area: '栃木県南部' }, { pref: '栃木県', area: '栃木県南部' }, { pref: '茨城県', isArea: true, addr: '茨城県南部' }] })
    const groups = quakeRegionGroups([q], 'observed', [], PREFS, null, NO_RANK)
    expect(groups.map(g => [g.label, g.options.map(o => `${o.name}:${o.count}`)])).toEqual([
      ['茨城県', ['茨城県南部:1']],
      ['栃木県', ['栃木県南部:1']],
    ])
  })

  // 正: 都道府県のまとめの点（pref と addr が同じ県名）は区域ではないので数えず、区域は索引で引いた県にまとめる
  it('県のまとめの点は数えず、区域は索引の県にまとめる', () => {
    const index = new Map([['石狩地方中部', '北海道'], ['栃木県南部', '栃木県'], ['奈良県', '奈良県']])
    const q = quake({ id: 'a', points: [
      { pref: '北海道', isArea: true, addr: '北海道' },
      { pref: '', isArea: true, addr: '石狩地方中部' },
      { pref: '栃木県', isArea: true, addr: '栃木県' },
      { pref: '', area: '栃木県南部' },
    ] })
    const groups = quakeRegionGroups([q], 'observed', [], [...PREFS, { code: '29', name: '奈良県' }], index, NO_RANK)
    expect(groups.map(g => [g.label, g.options.map(o => `${o.name}:${o.count}`)])).toEqual([
      ['北海道', ['石狩地方中部:1']],
      ['栃木県', ['栃木県南部:1']],
    ])
  })

  // 対照: 区域名と県名が同じ奈良県は、索引に区域としてあれば残す
  it('区域名が県名と同じ奈良県は、索引に区域としてあれば数える', () => {
    const index = new Map([['奈良県', '奈良県']])
    const q = quake({ id: 'a', points: [{ pref: '奈良県', isArea: true, addr: '奈良県' }] })
    const groups = quakeRegionGroups([q], 'observed', [], [...PREFS, { code: '29', name: '奈良県' }], index, NO_RANK)
    expect(groups).toEqual([{ label: '奈良県', options: [{ name: '奈良県', count: 1 }] }])
  })

  // 正: 観測した地域の組の中は、渡した順位（気象庁の標準の並び）で並べる
  it('観測した地域の組の中は順位の順', () => {
    const index = new Map([['石狩地方中部', '北海道'], ['釧路地方中南部', '北海道']])
    const rank = (n: string) => ({ 石狩地方中部: 1, 釧路地方中南部: 2 } as Record<string, number>)[n] ?? 99
    const q = quake({ id: 'a', points: [{ pref: '', isArea: true, addr: '釧路地方中南部' }, { pref: '', isArea: true, addr: '石狩地方中部' }] })
    const groups = quakeRegionGroups([q], 'observed', [], PREFS, index, rank)
    expect(groups[0].options.map(o => o.name)).toEqual(['石狩地方中部', '釧路地方中南部'])
  })

  // 安全弁: 選んだままの地域は、読み込んだ地震に無くても 0 件で残す
  it('選んだままの地域は一覧に無くても 0 件で残す', () => {
    const groups = quakeRegionGroups([], 'epicenter', ['栃木県北部'], PREFS, null, NO_RANK)
    expect(groups).toEqual([{ label: '栃木県', options: [{ name: '栃木県北部', count: 0 }] }])
  })
})

describe('未読込みの注記', () => {
  const now = Date.parse('2026-11-07T06:00:00Z')
  // 正: 期間の始まりが読み込んだ一番古い日より前なら、その前の日を返す
  it('期間が読み込んだ範囲より前にかかれば、一番古い日の前の日', () => {
    expect(quakeListUnloadedBefore({ kind: 'hours', hours: 720 }, '2026-11-01', now)).toBe('10月31日')
  })
  // 対照: 範囲に収まるなら出さない。安全弁: 期間を決めていない・まだ読んでいないなら出さない
  it('範囲に収まる・期間なし・未読なら出さない', () => {
    expect(quakeListUnloadedBefore({ kind: 'hours', hours: 24 }, '2026-11-01', now)).toBeNull()
    expect(quakeListUnloadedBefore(null, '2026-11-01', now)).toBeNull()
    expect(quakeListUnloadedBefore({ kind: 'hours', hours: 720 }, null, now)).toBeNull()
  })
})

describe('期間に合わせて自動で読み足す範囲（今日から 90 日前まで）', () => {
  // 2026-11-07 15:00 JST。今日の頭は 11-07 00:00 JST、90 日前の日の頭は 08-09 00:00 JST
  const now = Date.parse('2026-11-07T06:00:00Z')
  // 正: 90 日前の日の頭ちょうどから始まる期間は読み足す
  it('始まりが 90 日前の日の頭なら読み足す', () => {
    expect(quakeListAutoLoadAllowed({ kind: 'range', from: '2026-08-09', to: '2026-11-07' }, now)).toBe(true)
    expect(quakeListAutoLoadAllowed({ kind: 'hours', hours: 720 }, now)).toBe(true)
  })
  // 対照: 1 日でも古ければ読み足さない（「もっと見る」で遡る）。今を含まない過去の期間も始まりで決まる
  it('始まりが 91 日前なら読み足さない', () => {
    expect(quakeListAutoLoadAllowed({ kind: 'range', from: '2026-08-08', to: '2026-11-07' }, now)).toBe(false)
    expect(quakeListAutoLoadAllowed({ kind: 'range', from: '2026-01-01', to: '2026-03-31' }, now)).toBe(false)
  })
  // 安全弁: 期間を決めていない・読めない日付なら読み足さない
  it('期間なし・読めない日付なら読み足さない', () => {
    expect(quakeListAutoLoadAllowed(null, now)).toBe(false)
    expect(quakeListAutoLoadAllowed({ kind: 'range', from: 'x', to: '2026-11-07' }, now)).toBe(false)
  })
  it('注記に出す期間の始まりは日本時間の月日', () => {
    expect(quakeListPeriodStartLabel({ kind: 'range', from: '2026-08-09', to: '2026-11-07' }, now)).toBe('8月9日')
    expect(quakeListPeriodStartLabel({ kind: 'hours', hours: 24 }, now)).toBe('11月6日')
  })
})

describe('最新の 1 枚と参照の保ち方', () => {
  const a = quake({ id: 'a' }), b = quake({ id: 'b' }), c = quake({ id: 'c' })
  const all = [a, b, c]
  const key = (q: JMAQuake) => q.id

  // 正: 最新が絞りで外れていれば、時刻の並びのまま足す（選んでいる地震を引数に取らないので、選び替えで行が出入りしない）
  it('最新が一覧に無ければ足す', () => {
    expect(withLatestPinned([b, c], all, a).map(key)).toEqual(['a', 'b', 'c'])
    expect(withLatestPinned([c], all, a).map(key)).toEqual(['a', 'c'])
  })

  // 対照: 最新が既に一覧にあれば、同じ配列をそのまま返す
  it('最新が一覧にあれば同じ配列を返す', () => {
    const filtered = [a, c]
    expect(withLatestPinned(filtered, all, a)).toBe(filtered)
  })

  // 安全弁: 最新が無い（全部取消・0 件）ときは何も足さない
  it('最新が無いときは同じ配列', () => {
    const filtered = [b]
    expect(withLatestPinned(filtered, all, null)).toBe(filtered)
    expect(withLatestPinned([], [], null)).toEqual([])
  })

  // 正: 同じカードの並びなら前回の配列を返し、1 枚でも作り直されていれば新しい配列
  it('同じカードの並びなら前回の配列を返す', () => {
    const prev = [a, b]
    expect(keepIfSame(prev, [a, b])).toBe(prev)
    const b2 = { ...b }
    expect(keepIfSame(prev, [a, b2])).not.toBe(prev)
    expect(keepIfSame(null, [a])).toEqual([a])
  })
})

describe('観測した地域の判定', () => {
  // 正: 都道府県のまとめの点は区域として数えない（地域の窓の一覧と同じ）
  it('県のまとめの点は数えず、区域名が県名と同じ奈良県は索引にあれば数える', () => {
    const q = quake({ id: 'a', points: [{ pref: '茨城県', isArea: true, addr: '茨城県' }, { pref: '', area: '茨城県南部' }] })
    expect([...observedAreas(q, new Map([['茨城県南部', '茨城県']]))]).toEqual(['茨城県南部'])
    const nara = quake({ id: 'n', points: [{ pref: '奈良県', isArea: true, addr: '奈良県' }] })
    expect([...observedAreas(nara, new Map([['奈良県', '奈良県']]))]).toEqual(['奈良県'])
    expect([...observedAreas(nara, null)]).toEqual([])
  })
})

describe('保存した条件の検め', () => {
  // 正: 下限と上限・始めと終わりが逆なら入れ替え、規模は 0.1 刻みにそろえる
  it('逆転は入れ替え、規模は 0.1 刻みにそろえる', () => {
    const s = sanitize({
      quakeListScaleMin: 50, quakeListScaleMax: 30, quakeListMagnitudeMin: 6.04, quakeListMagnitudeMax: 3,
      quakeListDepthMin: 300, quakeListDepthMax: 10, quakeListPeriodFrom: '2026-11-07', quakeListPeriodTo: '2026-11-01',
    })
    expect([s.quakeListScaleMin, s.quakeListScaleMax]).toEqual([30, 50])
    expect([s.quakeListMagnitudeMin, s.quakeListMagnitudeMax]).toEqual([3, 6])
    expect([s.quakeListDepthMin, s.quakeListDepthMax]).toEqual([10, 300])
    expect([s.quakeListPeriodFrom, s.quakeListPeriodTo]).toEqual(['2026-11-01', '2026-11-07'])
  })

  // 対照: 並びの合った値はそのまま。震度の片方だけ（もう片方は -1）は入れ替えない
  it('並びの合った値・片方だけの震度はそのまま', () => {
    const s = sanitize({ quakeListScaleMin: 50, quakeListScaleMax: -1, quakeListMagnitudeMin: 3.5, quakeListMagnitudeMax: 6 })
    expect([s.quakeListScaleMin, s.quakeListScaleMax]).toEqual([50, -1])
    expect([s.quakeListMagnitudeMin, s.quakeListMagnitudeMax]).toEqual([3.5, 6])
  })

  // 安全弁: 暦に無い日は捨て、片方が残らないので期間の日付は両方とも外れる
  it('暦に無い日は捨てて、日付の範囲ごと外す', () => {
    const s = sanitize({ quakeListPeriodFrom: '2026-13-45', quakeListPeriodTo: '2026-11-07' })
    expect([s.quakeListPeriodFrom, s.quakeListPeriodTo]).toEqual([null, null])
  })
})

describe('地域の一覧を地方で束ねる', () => {
  const g = (label: string) => ({ label, options: [{ name: label + 'の地名', count: 1 }] })
  const ALL = [
    { code: '01', name: '北海道' }, { code: '07', name: '福島県' }, { code: '08', name: '茨城県' },
    { code: '14', name: '神奈川県' }, { code: '15', name: '新潟県' }, { code: '24', name: '三重県' }, { code: '47', name: '沖縄県' },
  ]
  // 正: 県は地方へ入り、地方の順に並ぶ。境目の県（福島→東北・茨城→関東・神奈川→関東・新潟→中部・三重→近畿・沖縄→九州沖縄）
  // 安全弁: 県でない組（海域・遠方）は、それだけの段として元の並びのまま後ろに残る
  it('県を 8 地方へ束ね、海域・遠方はそのまま後ろに置く', () => {
    const groups = ['北海道', '福島県', '茨城県', '神奈川県', '新潟県', '三重県', '沖縄県', '海域', '遠方'].map(g)
    expect(quakeRegionBlocks(groups, ALL).map(b => [b.label, b.groups.map(x => x.label)])).toEqual([
      ['北海道', ['北海道']],
      ['東北', ['福島県']],
      ['関東', ['茨城県', '神奈川県']],
      ['中部', ['新潟県']],
      ['近畿', ['三重県']],
      ['九州沖縄', ['沖縄県']],
      ['海域', ['海域']],
      ['遠方', ['遠方']],
    ])
  })

  // 対照: 地名の無い地方は段を作らない
  it('地名の無い地方は出さない', () => {
    expect(quakeRegionBlocks([], ALL)).toEqual([])
    expect(quakeRegionBlocks([g('海域')], ALL).map(b => b.label)).toEqual(['海域'])
  })
})

describe('すべて解除・件数', () => {
  // 正: 絞りと地域の基準は既定へ戻る。安全弁: 「一覧／地図」は残す（2026-11-08 選択「最後に選んだ方を覚える」）
  it('すべて解除は既定へ戻し、一覧／地図だけを残す', () => {
    const f = filter({ scale: { min: 30, max: null }, types: ['震度速報'], period: { kind: 'hours', hours: 24 },
      region: { basis: 'observed', names: ['栃木県南部'], view: 'map' } })
    expect(clearQuakeListFilter(f)).toEqual({ ...DEFAULT_QUAKE_LIST_FILTER, region: { basis: 'epicenter', names: [], view: 'map' } })
  })

  // 正: 長周期・推計・英文のどれかを選んだときだけ、付いた報を引く。対照: 電文の種別だけなら引かない
  it('付いた報を引くのは、種類に長周期・推計・英文があるときだけ', () => {
    expect(wantsAttachedTypes(filter({ types: ['推計震度分布図'] }))).toBe(true)
    expect(wantsAttachedTypes(filter({ types: ['震度速報', '遠地地震'] }))).toBe(false)
    expect(wantsAttachedTypes(DEFAULT_QUAKE_LIST_FILTER)).toBe(false)
  })

  // 件数は条件に合う地震だけ（2026-11-08 選択「条件に合う数だけ」）。固定の 1 件は、条件にも合うときだけ数える
  it('固定の 1 件は、条件に合わなければ数えず、合えば数える', () => {
    const f = filter({ scale: { min: 40, max: null } })
    const strong = quake({ id: 's', scale: 50 })
    const weakPinned = quake({ id: 'w', scale: 10 })
    const strongPinned = quake({ id: 'p', scale: 45 })
    // 正: 条件に合わない固定は引く
    expect(quakeListMatchedCount([strong, weakPinned], f, ctx({ pinnedKeys: new Set(['w']) }))).toBe(1)
    // 対照: 条件にも合う固定は引かない
    expect(quakeListMatchedCount([strong, strongPinned], f, ctx({ pinnedKeys: new Set(['p']) }))).toBe(2)
    // 安全弁: 固定が一覧に無ければ何も引かない・固定が無ければそのまま
    expect(quakeListMatchedCount([strong], f, ctx({ pinnedKeys: new Set(['gone']) }))).toBe(1)
    expect(quakeListMatchedCount([strong], f, ctx())).toBe(1)
  })
})
