import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// NIIからの取得をこのモジュールの外側で差し替える。取り込みの流れ（一覧 → 電文 → 採否）は
// この1つのモジュールを通るので、ここを押さえれば通信なしで最後まで走らせられる。
const { nii } = vi.hoisted(() => ({
  nii: { listing: [] as { id: string; time: string; typeLabel: string }[] },
}))

vi.mock('./niiJmaXmlArchive', () => ({
  fetchDayListing: vi.fn(async () => nii.listing),
  fetchRawXml: vi.fn(async () => '<Report/>'),
  fetchText: vi.fn(async () => ''),
  flushSuppressedCacheWarnings: vi.fn(),
}))

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseNiiTime, resolveQuakeHeadType, resolveTsunamiHeadType, mergeIndexEntry, buildQuakeAndTsunamiSection, coveredRangesFromDates, eventIdOfPubHistDir, finalizeArchive } from './localEarthquakeArchiveBuilder'
import { flushSuppressedCacheWarnings } from './niiJmaXmlArchive'
import type { JMAQuake } from '../src/types/earthquake'
import type { HistoricalArchiveEntry } from '../src/types/historicalArchive'

function indexEntry(id: string, from: string) {
  return { id, label: id, description: id, from, to: from, coveredRanges: [{ from, to: from }], firstEventTime: from }
}

describe('coveredRangesFromDates', () => {
  it('続いた日は 1 つの範囲にまとめ、離れた日は分ける（胆振東部の 6 日）', () => {
    const ranges = coveredRangesFromDates(
      ['20180906', '20180907', '20181005', '20181006', '20190221', '20190222'],
      new Date('2018-09-06T00:00:00+09:00'),
      new Date('2019-02-23T00:00:00+09:00'),
    )
    expect(ranges).toEqual([
      { from: '2018-09-05T15:00:00.000Z', to: '2018-09-07T15:00:00.000Z' },
      { from: '2018-10-04T15:00:00.000Z', to: '2018-10-06T15:00:00.000Z' },
      { from: '2019-02-20T15:00:00.000Z', to: '2019-02-22T15:00:00.000Z' },
    ])
  })

  it('収録範囲で切る（熊本は 4/14 の正午から）', () => {
    const ranges = coveredRangesFromDates(
      ['20160414', '20160415'],
      new Date('2016-04-14T12:00:00+09:00'),
      new Date('2016-04-16T00:00:00+09:00'),
    )
    expect(ranges).toEqual([{ from: '2016-04-14T03:00:00.000Z', to: '2016-04-15T15:00:00.000Z' }])
  })

  it('書式の崩れた日・収録範囲に掛からない日だけなら止める', () => {
    expect(() => coveredRangesFromDates(['2018-09-06'], new Date(0), new Date(1e13))).toThrow()
    expect(() => coveredRangesFromDates(['20000101'], new Date('2018-09-06T00:00:00+09:00'), new Date('2018-09-07T00:00:00+09:00'))).toThrow()
  })
})

describe('mergeIndexEntry', () => {
  it('正: 新規エントリを収録範囲の開始時刻(from)順に挿入する', () => {
    const index = [indexEntry('2018-osaka', '2018-06-17T15:00:00.000Z'), indexEntry('2018-iburi', '2018-09-05T15:00:00.000Z')]
    const result = mergeIndexEntry(index, indexEntry('2016-kumamoto', '2016-04-14T03:00:00.000Z'))
    expect(result.map((e) => e.id)).toEqual(['2016-kumamoto', '2018-osaka', '2018-iburi'])
  })

  it('対照（バグ回帰）: 単純追記だと実行順のままになってしまう', () => {
    // mergeIndexEntryを使わず配列末尾へ追記するだけの旧実装だと、地震の発生順ではなく
    // ビルドスクリプトを実行した順に並んでしまっていた（実際に発生していた不具合）。
    const index = [indexEntry('2018-osaka', '2018-06-17T15:00:00.000Z')]
    const naiveAppend = [...index, indexEntry('2016-kumamoto', '2016-04-14T03:00:00.000Z')]
    expect(naiveAppend.map((e) => e.id)).toEqual(['2018-osaka', '2016-kumamoto']) // 発生順ではない
    expect(mergeIndexEntry(index, indexEntry('2016-kumamoto', '2016-04-14T03:00:00.000Z')).map((e) => e.id))
      .toEqual(['2016-kumamoto', '2018-osaka']) // 発生順に直る
  })

  it('安全弁: 同じidが既にある場合は置き換える（重複させない）', () => {
    const index = [indexEntry('2016-kumamoto', '2016-04-14T03:00:00.000Z')]
    const updated = indexEntry('2016-kumamoto', '2016-04-14T03:00:00.000Z')
    updated.description = '更新後の説明'
    const result = mergeIndexEntry(index, updated)
    expect(result).toHaveLength(1)
    expect(result[0].description).toBe('更新後の説明')
  })
})

describe('parseNiiTime', () => {
  it('正: NII表示形式（オフセットが分無しの2桁）をDateへ変換する', () => {
    const d = parseNiiTime('2016-04-14 21:28:06+09')
    expect(d.toISOString()).toBe('2016-04-14T12:28:06.000Z')
  })

  it('対照（バグ回帰）: 素の new Date() では Invalid Date になる形式であることを確認する', () => {
    // parseNiiTime が無かった旧実装は `new Date(item.time.replace(' ', 'T'))` を使っており、
    // この形式では常に Invalid Date を返していた（時刻ウィンドウが無警告で無効化された事故）。
    expect(Number.isNaN(new Date('2016-04-14T21:28:06+09').getTime())).toBe(true)
  })

  it('安全弁: 解釈できない形式は例外にする（Invalid Dateを黙って返さない）', () => {
    expect(() => parseNiiTime('not-a-time')).toThrow()
    expect(() => parseNiiTime('2016/04/14 21:28:06+09')).toThrow()
  })
})

describe('resolveQuakeHeadType', () => {
  it('正: 具体的なラベルから順に判定する', () => {
    expect(resolveQuakeHeadType('震度速報')).toBe('VXSE51')
    expect(resolveQuakeHeadType('顕著な地震の震源要素更新のお知らせ')).toBe('VXSE61')
    expect(resolveQuakeHeadType('震源・震度に関する情報')).toBe('VXSE53')
    expect(resolveQuakeHeadType('震源に関する情報')).toBe('VXSE52')
  })

  it('対照: 「震源・震度」を含むラベルが「震源」だけの判定に丸め込まれない', () => {
    // 判定順を誤ると「震源・震度」も includes('震源') に一致してVXSE52になる。
    expect(resolveQuakeHeadType('震源・震度情報')).toBe('VXSE53')
  })

  it('安全弁: 未知のラベルは黙ってスキップせず例外にする', () => {
    expect(() => resolveQuakeHeadType('謎の電文種別')).toThrow()
  })
})

// 津波の種別ラベル。**沖合（VTSE52）と沿岸（VTSE51）でパーサーの扱いが変わる**ため、
// ここを誤ると「重要」の基準（大津波警報のみ／大津波警報・津波警報）が入れ替わる。
describe('resolveTsunamiHeadType', () => {
  it('正: 具体的なラベルから順に判定する', () => {
    // NII の表示ラベルは末尾に説明のつかない "a" が付くことがある（同ファイル冒頭の注記）
    expect(resolveTsunamiHeadType('沖合の津波観測に関する情報')).toBe('VTSE52')
    expect(resolveTsunamiHeadType('津波情報a')).toBe('VTSE51')
    expect(resolveTsunamiHeadType('津波警報・注意報・予報a')).toBe('VTSE41')
  })

  it('対照: 「津波情報」を含むラベルは「警報」の語があっても VTSE51 のまま', () => {
    // 判定順を誤ると、解除等で「警報」を名乗る津波情報が VTSE41 として記録される。
    expect(resolveTsunamiHeadType('津波情報（津波警報解除）')).toBe('VTSE51')
  })

  it('対照: 「沖合」は他のどの語より先に見る', () => {
    // ここが崩れると沿岸として扱われ、「重要」のバッジが実際より軽い基準で出る。
    expect(resolveTsunamiHeadType('沖合の津波観測に関する情報（津波警報）')).toBe('VTSE52')
  })

  it('安全弁: 未知のラベルは黙ってスキップせず例外にする', () => {
    expect(() => resolveTsunamiHeadType('謎の津波電文')).toThrow()
  })
})

// キャッシュの不調は同じ原因の2回目以降を間引くため、間引いた件数はここで出すしかない
// （→ `niiJmaXmlArchive.ts` の `flushSuppressedCacheWarnings`）。呼び忘れると、
// 653通ぶんの失敗が1行の記録だけで終わる。
describe('キャッシュの不調の要約は、取り込みを抜けるときに必ず出す', () => {
  function options() {
    const quake = {
      time: '2016/04/14 21:26:00',
      cancelled: false,
      earthquake: { hypocenter: { name: '熊本県熊本地方' } },
      points: [],
    } as unknown as JMAQuake
    return {
      dates: ['20160414'],
      windowStart: new Date('2016-04-14T00:00:00+09:00'),
      windowEnd: new Date('2016-04-16T00:00:00+09:00'),
      parseEarthquakeFromXml: () => quake,
      parseTsunamiFromXml: () => null,
    }
  }

  beforeEach(() => {
    vi.mocked(flushSuppressedCacheWarnings).mockClear()
    nii.listing = [{ id: 'uuid-1', time: '2016-04-14 21:28:06+09', typeLabel: '震度速報' }]
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('正: 取り込みが成功した実行で出す', async () => {
    await buildQuakeAndTsunamiSection(options())
    expect(flushSuppressedCacheWarnings).toHaveBeenCalled()
  })

  it('安全弁: 途中で例外になった実行でも出す', async () => {
    // **取得が失敗して止まった実行こそ効く** —— キャッシュが読めず毎回取りに行っていたことが、
    // 配信元が応じなくなった原因の手掛かりになる
    nii.listing = []
    await expect(buildQuakeAndTsunamiSection(options())).rejects.toThrow()
    expect(flushSuppressedCacheWarnings).toHaveBeenCalled()
  })
})

// 収録範囲に入る電文は、どの地震のものでも入れる（2026-10-23 ユーザー承認「窓の全地震を入れる (Recommended)」）。
// 取消電文も入れる（同日「取消も収録する (Recommended)」）。
describe('収録範囲の電文は地震を問わず全部入れる', () => {
  function quakeOf(name: string, cancelled: boolean): JMAQuake {
    return {
      id: `dmdata-quake-20160415000000-1-${name}`,
      time: '2016/04/15 00:00:00',
      cancelled,
      earthquake: { hypocenter: { name } },
      points: [],
    } as unknown as JMAQuake
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function run(quakes: JMAQuake[], times: string[]) {
    nii.listing = times.map((time, i) => ({ id: `uuid-${i}`, time, typeLabel: '震源・震度に関する情報' }))
    const queue = [...quakes]
    return buildQuakeAndTsunamiSection({
      dates: ['20160415'],
      windowStart: new Date('2016-04-14T12:00:00+09:00'),
      windowEnd: new Date('2016-04-20T00:00:00+09:00'),
      parseEarthquakeFromXml: () => queue.shift() ?? null,
      parseTsunamiFromXml: () => null,
    })
  }

  it('正: 震央地名が地震活動と違う地震も入れる', async () => {
    const entries = await run(
      [quakeOf('熊本県熊本地方', false), quakeOf('茨城県北部', false)],
      ['2016-04-15 00:05:00+09', '2016-04-15 00:06:00+09'],
    )
    const names = entries.map((e) => (e.payload as { event: JMAQuake }).event.earthquake.hypocenter.name)
    expect(names).toEqual(['熊本県熊本地方', '茨城県北部'])
  })

  it('正: 取消電文も入れる（id には NII の電文 ID を足す）', async () => {
    const entries = await run([quakeOf('', true)], ['2016-04-15 00:05:00+09'])
    expect(entries).toHaveLength(1)
    const event = (entries[0].payload as { event: JMAQuake }).event
    expect(event.cancelled).toBe(true)
    expect(event.id).toBe('dmdata-quake-20160415000000-1--uuid-0')
  })

  // 収録範囲は半開区間（終わりは含まない）。EEW（`isInWindow`）と `coveredRanges` にそろえてある
  it('正: 収録範囲の終わりちょうど（4/20 0:00）の電文は入れない', async () => {
    // 1 件も採らない取り込みは止まる決まりなので、範囲の中の 1 件と並べて流す
    // 電文は 2 件ぶん用意する（終わりちょうどの電文が入ってしまえば 2 件になる）
    const entries = await run([quakeOf('熊本県熊本地方', false), quakeOf('茨城県北部', false)], ['2016-04-15 00:05:00+09', '2016-04-20 00:00:00+09'])
    expect(entries).toHaveLength(1)
  })

  it('対照: 終わりの 1 秒前の電文は入れる', async () => {
    const entries = await run([quakeOf('熊本県熊本地方', false)], ['2016-04-19 23:59:59+09'])
    expect(entries).toHaveLength(1)
  })

  it('安全弁: 始まりちょうど（4/14 12:00）の電文は入れる（始まりは含む）', async () => {
    const entries = await run([quakeOf('熊本県熊本地方', false)], ['2016-04-14 12:00:00+09'])
    expect(entries).toHaveLength(1)
  })

  it('安全弁: 収録範囲の外の電文は入れない（範囲で切ることは残っている）', async () => {
    const entries = await run([quakeOf('熊本県熊本地方', false)], ['2016-04-15 00:05:00+09', '2016-04-20 00:00:01+09'])
    expect(entries).toHaveLength(1)
  })
})

describe('eventIdOfPubHistDir', () => {
  it('正: ディレクトリ名の末尾 14 桁を EventID として取り出す（年月を含む形も）', () => {
    expect(eventIdOfPubHistDir('20160416012510')).toBe('20160416012510')
    expect(eventIdOfPubHistDir('2018/09/20180906030805')).toBe('20180906030805')
  })

  it('安全弁: 14 桁でなければ例外', () => {
    expect(() => eventIdOfPubHistDir('2018/09/201809060308')).toThrow()
  })
})

// 「再生」ボタンの起点（firstEventTime）は、窓の最初の報ではなく呼び出し側が明示した時刻
// （2026-10-25 ユーザー選択「前の起点に戻す (Recommended)」）。
describe('finalizeArchive の再生の起点', () => {
  const entry = (id: string, time: string) => ({ time, payload: { kind: 'event', event: { id, kind: 'quake' } } }) as unknown as HistoricalArchiveEntry
  const entries = [entry('a', '2016-04-14T12:30:00+09:00'), entry('b', '2016-04-14T21:26:42.5+09:00')]

  async function run(replayStartTime: string) {
    const dir = await mkdtemp(join(tmpdir(), 'archive-'))
    const indexPath = join(dir, 'index.json')
    await writeFile(indexPath, '[]\n', 'utf-8')
    await finalizeArchive({
      id: 'test',
      label: 'テスト',
      description: 'テスト',
      windowStart: new Date('2016-04-14T12:00:00+09:00'),
      windowEnd: new Date('2016-04-20T00:00:00+09:00'),
      dates: ['20160414'],
      entries,
      outPath: join(dir, 'test.json'),
      indexPath,
      replayStartTime,
    })
    return JSON.parse(await readFile(indexPath, 'utf-8'))[0].firstEventTime as string
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('正: 窓の最初の報（12:30）ではなく、指定した起点（21:26 の報）を書く', async () => {
    expect(await run('2016-04-14T12:26:42.500Z')).toBe('2016-04-14T12:26:42.500Z')
  })

  it('安全弁: 起点と同じ時刻の報が無ければ止まる（地震の取り違えを書き出さない）', async () => {
    await expect(run('2016-04-14T12:26:43.000Z')).rejects.toThrow(/同じ時刻の報がありません/)
  })

  it('安全弁: 起点が収録範囲の外なら止まる', async () => {
    await expect(run('2016-04-14T02:00:00.000Z')).rejects.toThrow(/収録範囲の外/)
  })
})
