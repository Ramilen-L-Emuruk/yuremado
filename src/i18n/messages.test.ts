import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// 対象のモジュールは頭で読む。テストの中で初めて読むと、全件並列のときに読み込みの待ちが 1 件目の時間に乗って時間切れになる
import { QUAKE_PERIOD_HOURS } from '../utils/quakeListView'
import { DIRECTIONS_16 } from '../utils/estimatedIntensity'
import { CHECKLIST_SOURCE_URLS } from '../utils/actionChecklist'
import { isLocale, JA_MESSAGES, LOCALE_SETTINGS, LOCALES, loadMessages, localeFromLanguageTags, localeTag, resolveLocale, type Messages } from './messages'
import { historicalArchiveLabel } from '../utils/historicalArchiveLabel'
import { regionLabel } from '../utils/regions'

// 日本語以外の辞書を先に一度読んでおく。`loadMessages` は `import()` で読むので、初回の変換の待ちが
// テスト本体に乗ると、全件を並列で回したときだけ既定の 5 秒を超える（実際に 2 件が時間切れになった）
await Promise.all(LOCALES.map((l) => loadMessages(l.id)))

/** 辞書の形（キーの並びと、値が文字列か関数か）を平らに書き出す。 */
function shapeOf(tree: unknown, prefix = ''): string[] {
  if (typeof tree === 'string') return [`${prefix}:string`]
  if (typeof tree === 'function') return [`${prefix}:function/${tree.length}`]
  if (tree === null || typeof tree !== 'object') return [`${prefix}:${typeof tree}`]
  return Object.keys(tree).sort().flatMap((k) => shapeOf((tree as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k))
}

describe('辞書の形', () => {
  it('どの言語の辞書も日本語の辞書と同じキー・同じ種類の値を持つ（型を `as` で外した辞書も実行時に落とす）', async () => {
    const jaShape = shapeOf(JA_MESSAGES)
    for (const { id } of LOCALES) {
      const messages = await loadMessages(id)
      expect(shapeOf(messages), id).toEqual(jaShape)
    }
  })

  it('どの言語の辞書にも空の文字列が無い（訳し忘れを空で埋めない）', async () => {
    const empties: string[] = []
    const walk = (tree: unknown, path: string) => {
      if (typeof tree === 'string') { if (tree.trim() === '') empties.push(path); return }
      if (tree && typeof tree === 'object') for (const [k, v] of Object.entries(tree)) walk(v, `${path}.${k}`)
    }
    for (const { id } of LOCALES) walk(await loadMessages(id), id)
    expect(empties).toEqual([])
  })

  it('キーが欠けた辞書・余った辞書・引数の違う関数は型チェックで落ちる', () => {
    // 試す節（nav・appUpdate）の外は日本語の辞書をそのまま借りる
    // 正: 欠けている
    // @ts-expect-error nav.telegrams が無い
    const missing: Messages = { ...JA_MESSAGES, nav: { earthquake: 'a', realtime: 'a', tsunami: 'a', catalog: 'a', settings: 'a' } }
    // 安全弁: 余っている（欠けを防いでも、別名で足したキーは素通りしない）
    const extra: Messages = {
      ...JA_MESSAGES,
      // @ts-expect-error nav.unknown は日本語の辞書に無い
      nav: { earthquake: 'a', realtime: 'a', tsunami: 'a', catalog: 'a', settings: 'a', telegrams: 'a', unknown: 'a' },
    }
    // 正: 差し込む値の型が違う関数
    const wrongArgs: Messages = {
      ...JA_MESSAGES,
      // @ts-expect-error reloadIn は秒（数）を受け取る
      appUpdate: { ...JA_MESSAGES.appUpdate, reloadIn: (seconds: string) => seconds },
    }
    // 対照: そろっていれば通る
    const complete: Messages = { ...JA_MESSAGES, nav: { earthquake: 'a', realtime: 'a', tsunami: 'a', catalog: 'a', settings: 'a', telegrams: 'a' } }
    expect([missing, extra, wrongArgs, complete]).toHaveLength(4)
  })
})

describe('端末の言語から画面の言語を決める', () => {
  it('ブラウザの言語の並びを前から見て、最初に当たった言語を使う', () => {
    expect(localeFromLanguageTags(['ko-KR', 'en-US'])).toBe('ko')
    expect(localeFromLanguageTags(['fr-FR', 'es-MX', 'en'])).toBe('es')
    expect(localeFromLanguageTags(['ja-JP'])).toBe('ja')
    expect(localeFromLanguageTags(['EN-gb'])).toBe('en')
  })

  it('中国語は文字の種類、無ければ地域で簡体と繁体を分ける', () => {
    expect(localeFromLanguageTags(['zh-CN'])).toBe('zh-Hans')
    expect(localeFromLanguageTags(['zh'])).toBe('zh-Hans')
    expect(localeFromLanguageTags(['zh-TW'])).toBe('zh-Hant')
    expect(localeFromLanguageTags(['zh-HK'])).toBe('zh-Hant')
    expect(localeFromLanguageTags(['zh-Hant-CN'])).toBe('zh-Hant')
    // 文字の種類が地域より先に効く（台湾の簡体字）
    expect(localeFromLanguageTags(['zh-Hans-TW'])).toBe('zh-Hans')
  })

  it('ポルトガル語はポルトガル式もブラジル式の辞書で出す', () => {
    expect(localeFromLanguageTags(['pt-PT'])).toBe('pt-BR')
    expect(localeFromLanguageTags(['pt'])).toBe('pt-BR')
  })

  it('どれにも当たらない・並びが空なら英語', () => {
    expect(localeFromLanguageTags(['fr-FR', 'de'])).toBe('en')
    expect(localeFromLanguageTags([])).toBe('en')
    // 言語の前の部分だけで見る（「jav」（ジャワ語）を日本語と取り違えない）
    expect(localeFromLanguageTags(['jav'])).toBe('en')
  })

  it('端末に合わせるときだけ端末の言語を見て、選んだ言語はそのまま使う', () => {
    expect(resolveLocale('auto', ['ko'])).toBe('ko')
    expect(resolveLocale('ja', ['ko'])).toBe('ja')
    expect(resolveLocale('es', [])).toBe('es')
  })
})

describe('言語の表', () => {
  it('設定に保存できる値は「端末に合わせる」と表の言語だけ', () => {
    expect(LOCALE_SETTINGS).toEqual(['auto', ...LOCALES.map((l) => l.id)])
  })


  it('表に無い値は言語として受け取らない', () => {
    expect(isLocale('xx')).toBe(false)
    expect(isLocale(undefined)).toBe(false)
    expect(isLocale(1)).toBe(false)
  })

  it('言語の id は重ならず、言語タグは空でない', () => {
    const ids = LOCALES.map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const { id } of LOCALES) expect(localeTag(id)).not.toBe('')
  })
})

describe('速報・津波の帯の語', () => {
  it('「ただちに津波来襲と予測」は、名目を付けない言語では津波タブの札（まもなく到達）と同じ語', async () => {
    for (const { id } of LOCALES) {
      const m = await loadMessages(id)
      if (id === 'ja') continue
      expect(m.alertDock.immediateArrival.labelled, id).toBe(false)
      expect(m.alertDock.immediateArrival.text, id).toBe(m.tsunami.arrivalCondition.imminent)
    }
    // 対照: 日本語は名目を付け、電文の文をそのまま出す
    expect(JA_MESSAGES.alertDock.immediateArrival).toEqual({ labelled: true, text: 'ただちに津波来襲と予測' })
  })
})

describe('地震回数の見出し', () => {
  it('英語・ポルトガル語・スペイン語は回数に単位を付け、1 回だけ単数にする', async () => {
    const en = await loadMessages('en')
    expect(en.specialInfo.countHeadline({ monthDay: '11/11', hour: '14' }, '23', '12')).toBe('Since 11/11 14:00: 23 earthquakes (12 felt)')
    expect(en.specialInfo.countHeadline(null, '23', null)).toBe('23 earthquakes')
    expect(en.specialInfo.countHeadline(null, '1', null)).toBe('1 earthquake')
    expect(en.specialInfo.countHeadline(null, null, '12')).toBe('12 felt')
    const es = await loadMessages('es')
    expect(es.specialInfo.countHeadline(null, '1', null)).toBe('1 terremoto')
    const pt = await loadMessages('pt-BR')
    expect(pt.specialInfo.countHeadline(null, '23', '12')).toBe('23 terremotos (12 sentidos)')
    expect(pt.specialInfo.countHeadline(null, '1', '1')).toBe('1 terremoto (1 sentido)')
    expect(es.specialInfo.countHeadline(null, null, '1')).toBe('1 sentido')
    // 安全弁: 日本語は前と同じ字面
    expect(JA_MESSAGES.specialInfo.countHeadline(null, '23', '12')).toBe('23回（うち有感 12回）')
  })
})

// 段 10: 通知の文とウィンドウの題名。日本語は外の道具（題名を見る AutoHotKey）と中継のプッシュ通知が字面を見るので変えない
describe('通知の文とウィンドウの題名', () => {
  it('日本語の題名・揺れ検知の通知は前と同じ字面', () => {
    const w = JA_MESSAGES.alertText
    expect(w.titleQuake('石川県能登地方', '5弱')).toBe('地震情報 石川県能登地方 最大震度5弱')
    expect(w.titleForeignQuake('メキシコ', 'M7.4')).toBe('遠地地震 メキシコ M7.4')
    expect(w.titleReloadCountdown(10, true, '揺れ窓')).toBe('10秒後に再読み込みします — 揺れ窓')
    expect(w.titleReloadCountdown(10, false, '揺れ窓')).toBe('10秒後に更新します — 揺れ窓')
    expect(w.withStage('南海トラフ地震臨時情報', '調査中')).toBe('南海トラフ地震臨時情報（調査中）')
    expect(w.titleInEffect('北海道・三陸沖後発地震注意情報')).toBe('北海道・三陸沖後発地震注意情報 発表中')
    expect(w.joinParts([w.titleLpgm, '石川県能登地方', w.titleLpgmMaxClass(3)])).toBe('長周期地震動 石川県能登地方 最大階級3')
    expect([w.titleShakingDetected, w.titlePossibleShaking, w.kyoshinDetected, w.kyoshinMax('5弱')])
      .toEqual(['揺れ検知', '揺れの可能性', '揺れを検知中', '最大リアルタイム震度 5弱'])
    expect(w.permissionFirst(JA_MESSAGES.settings.permission.request)).toBe('先に「通知を許可する」を押してください。')
  })

  it('英語の題名・揺れ検知の通知・テスト通知', async () => {
    const en = await loadMessages('en')
    const w = en.alertText
    expect(w.titleQuake('石川県能登地方', '5-')).toBe('Earthquake Information 石川県能登地方 · Max intensity 5-')
    expect(w.titleForeignQuake('メキシコ', 'M7.4')).toBe('Distant earthquake メキシコ M7.4')
    expect(w.titleReloadCountdown(10, true, '揺れ窓')).toBe('Reloading in 10s — 揺れ窓')
    expect(w.titleReloadCountdown(10, false, '揺れ窓')).toBe('Updating in 10s — 揺れ窓')
    expect(w.joinParts([w.titleLpgm, w.titleLpgmMaxClass(3)])).toBe('Long-period ground motion · Max class 3')
    expect(w.titleInEffect(en.telegramLog.controlTitle['北海道・三陸沖後発地震注意情報'])).toBe('Hokkaido and Sanriku-oki Subsequent Earthquake Advisory in effect')
    expect([w.titleShakingDetected, w.titlePossibleShaking]).toEqual(['Shaking detected', 'Possible shaking'])
    expect([w.kyoshinDetected, w.kyoshinOtherPlace, w.kyoshinReonset, w.kyoshinMax('3')])
      .toEqual(['Shaking detected', 'Shaking detected at another location', 'Shaking detected again at the same location', 'Max real-time intensity 3'])
    expect(w.permissionFirst(en.settings.permission.request)).toBe('Press "Allow notifications" first.')
    expect([w.testTitle, w.testBody]).toEqual(['Earthquake Information test', '東京都内陸部 (test) · Max intensity 4 · M5.5'])
  })

  it('英語・ポルトガル語・スペイン語の区域・観測点の残りは、1 つだけ単数にする', async () => {
    const en = await loadMessages('en')
    expect(en.alertText.tsunamiMoreAreas('A', 1)).toBe('A and 1 more area')
    expect(en.alertText.tsunamiMoreAreas('A', 2)).toBe('A and 2 more areas')
    const pt = await loadMessages('pt-BR')
    expect(pt.alertText.tsunamiMorePoints('A', 1)).toBe('A e mais 1 estação')
    const es = await loadMessages('es')
    expect(es.alertText.tsunamiMoreAreas('A', 3)).toBe('A y 3 áreas más')
  })
})

// 段 10b: 画面の外で組んでいた文（目録の名前・更新の印・地方名・地域の窓・出典の添え書き）
describe('段 10b の語', () => {
  it('収録済みの地震の名前は目録の id で引き、表に無い地震は目録の label のまま', async () => {
    const en = await loadMessages('en')
    expect(historicalArchiveLabel({ id: '2018-iburi', label: '2018年北海道胆振東部地震' }, en.settings.replay.archives)).toBe('2018 Hokkaido Eastern Iburi Earthquake')
    expect(historicalArchiveLabel({ id: '2018-iburi', label: '2018年北海道胆振東部地震' }, JA_MESSAGES.settings.replay.archives)).toBe('2018年北海道胆振東部地震')
    expect(historicalArchiveLabel({ id: 'something-new', label: '新しい地震' }, en.settings.replay.archives)).toBe('新しい地震')
  })

  it('目録の 4 件はすべての言語に名前がある（目録へ足したら辞書にも足す）', async () => {
    const ids = ['2016-kumamoto', '2016-tottori', '2018-osaka', '2018-iburi']
    for (const { id } of LOCALES) {
      const m = await loadMessages(id)
      expect(Object.keys(m.settings.replay.archives.names).sort(), id).toEqual([...ids].sort())
    }
  })

  it('更新の印の意味', async () => {
    const en = await loadMessages('en')
    expect(JA_MESSAGES.updateMark.raised).toBe('最新の情報で上がりました')
    expect(en.updateMark).toEqual({
      new: 'New in the latest report', raised: 'Raised in the latest report', lowered: 'Lowered in the latest report', changed: 'Changed in the latest report',
    })
  })

  it('地図の地方名は ASCII と日本語の地名の字だけで書く（地図の字は焼いた字形で描く）', async () => {
    const jaChars = new Set([...Object.keys(JA_MESSAGES.map.regionName).join('')])
    for (const { id } of LOCALES) {
      const m = await loadMessages(id)
      for (const name of Object.values(m.map.regionName)) {
        for (const ch of name) {
          const cp = ch.codePointAt(0) ?? 0
          expect(cp >= 0x20 && cp < 0x7f || jaChars.has(ch), `${id}: ${name}`).toBe(true)
        }
      }
    }
    const en = await loadMessages('en')
    expect(regionLabel('伊豆諸島', en.map)).toBe('Izu Islands')
    expect(regionLabel('伊豆諸島', JA_MESSAGES.map)).toBe('伊豆諸島')
  })

  it('地域の窓の地方の名前と、出典の添え書き（日本語は全角の括弧、英語は半角の括弧）', async () => {
    const en = await loadMessages('en')
    expect(en.quake.filter.groupName['九州沖縄']).toBe('Kyushu & Okinawa')
    expect(JA_MESSAGES.quake.filter.groupName['九州沖縄']).toBe('九州沖縄')
    expect(`PB2002 (Bird, 2003)${JA_MESSAGES.settings.credits.paren(JA_MESSAGES.settings.credits.plateBoundaries)}`).toBe('PB2002 (Bird, 2003)（プレート境界）')
    expect(`PB2002 (Bird, 2003)${en.settings.credits.paren(en.settings.credits.plateBoundaries)}`).toBe('PB2002 (Bird, 2003) (plate boundaries)')
  })
})

describe('行動チェックリストの語', () => {
  it('出典の名前は、どの言語もリンク先と同じ数（添字で対にするので、ずれると別の出典に別の URL が付く）', async () => {
    for (const { id } of LOCALES) {
      const m = await loadMessages(id)
      expect(m.actionChecklist.sources.length, id).toBe(CHECKLIST_SOURCE_URLS.length)
    }
  })
})

describe('地震タブの語', () => {
  it('期間の選択肢の時間すべてに、どの言語も札を持つ（時間を足して辞書を忘れると「N時間」に落ちる）', async () => {
    for (const { id } of LOCALES) {
      const m = await loadMessages(id)
      const missing = QUAKE_PERIOD_HOURS.filter(({ hours }) => !(String(hours) in m.quake.filter.periodHours)).map(({ hours }) => hours)
      expect(missing, id).toEqual([])
    }
  })

  it('推計の注記の照合に使う 16 方位の表は、日本語の辞書の 16 方位と同じ並び・同じ語', async () => {
    expect([...DIRECTIONS_16]).toEqual([...JA_MESSAGES.quake.direction16])
  })

  it('韓国語の主題の助詞は、差し込む語の最後の音で 은／는 を選ぶ', async () => {
    const ko = await loadMessages('ko')
    // 正: 받침のある語（진원・알림）は 은
    expect(ko.quake.borrowedSentence('진원', '진도 속보', null)).toMatch(/^진원은 /)
    expect(ko.quake.retracted('현저한 지진의 진원 요소 갱신 알림')).toMatch(/알림은 /)
    // 対照: 받침の無い語（정보）は 는
    expect(ko.quake.retracted('진원・진도 정보')).toMatch(/정보는 /)
    // 安全弁: ハングルで終わらない語（数字・記号）は 는 のまま
    expect(ko.quake.retracted('VXSE51#2')).toMatch(/#2는 /)
  })
})

describe('辞書から辿れるファイル（中継へ写すもの）', () => {
  // 中継は 7 言語の辞書を写してプッシュ通知の文を組む（relay-server-design.md §6.7「通知の言語」）。中継の型検査は画面の型
  // （DOM・React・MapLibre）を持たないので、辞書が型だけでも画面や地図の部品を読むと、写した先で型検査が通らなくなる。
  // 辞書が鍵に使う型は i18n/messageKeys.ts（何も読まない葉）に置く
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  /** 相対の import・export（型だけのものも含む）を辿って、読むファイルを全部集める */
  function closure(entries: readonly string[]): Set<string> {
    const seen = new Set<string>()
    const walk = (rel: string) => {
      if (seen.has(rel)) return
      seen.add(rel)
      const body = readFileSync(join(root, rel), 'utf8')
      for (const m of body.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'(\.[^']+)'/gms)) {
        const base = posix.join(posix.dirname(rel), m[1])
        const hit = ['.ts', '.tsx', '/index.ts'].map((e) => base + e).find((c) => existsSync(join(root, c)))
        if (hit) walk(hit)
      }
    }
    entries.forEach(walk)
    return seen
  }
  const files = closure([
    'src/i18n/messages.ts',
    ...LOCALES.map((l) => `src/i18n/messages/${l.id === 'zh-Hans' ? 'zhHans' : l.id === 'zh-Hant' ? 'zhHant' : l.id === 'pt-BR' ? 'ptBR' : l.id}.ts`),
  ])

  // 正: 7 言語の辞書と表を辿れている（入口の名前の読み替えを誤ると、何も辿らずに通ってしまう）
  it('7 言語の辞書を辿る', () => {
    for (const f of ['src/i18n/messages/ja.ts', 'src/i18n/messages/en.ts', 'src/i18n/messages/zhHant.ts', 'src/i18n/messageKeys.ts']) expect(files).toContain(f)
  })
  // 安全弁: 画面の部品・フック・地図の描画・.tsx は辿らない。components の下でも、何も読まない葉（設定の分類の表
  // settingsCategories.ts のように、辞書が鍵の型を読むために JSX から分けたもの）は写しても型が通るので許す
  it('画面・地図の部品へ届かない', () => {
    const importsAnything = (f: string) => /^\s*(?:import|export)\s[^;]*?from\s+'/m.test(readFileSync(join(root, f), 'utf8'))
    const ui = [...files].filter((f) => f.endsWith('.tsx') || /^src\/(hooks|gl)\//.test(f) || (/^src\/components\//.test(f) && importsAnything(f)))
    expect(ui).toEqual([])
  })
  // 安全弁: 辿った先が React・MapLibre を読まない
  it('React・MapLibre を読まない', () => {
    const offenders = [...files].filter((f) => /^\s*import\s[^;]*?from\s+'(react|react-dom|maplibre-gl)(\/[^']*)?'/m.test(readFileSync(join(root, f), 'utf8')))
    expect(offenders).toEqual([])
  })
})
