import { describe, expect, it, vi } from 'vitest'
import type { TelegramLogEntry } from '../../types/earthquake'
import { NON_EEW_HANDLED_TYPES, EEW_HEAD_TYPES, DISPATCHED_WITHOUT_PARSER } from '../../services/dmdataTelegramPayload'
import {
  HEAD_TYPE_LABEL, KIND_LABEL, KIND_OPTIONS, ORIGIN_OPTIONS, headTypeLabel, localizedErrorMessage, localizedTelegramTitle,
  matchesTelegramFilter, operationBadgeOf, originBadgeOf, originFilterLabel, readKindFilter, telegramLogKindOf, telegramTitleOf,
} from './labels'
import { ja } from '../../i18n/messages/ja'
import { en } from '../../i18n/messages/en'
import { es } from '../../i18n/messages/es'
import { ko } from '../../i18n/messages/ko'
import { ptBR } from '../../i18n/messages/ptBR'
import { zhHans } from '../../i18n/messages/zhHans'
import { zhHant } from '../../i18n/messages/zhHant'
import { TELEGRAM_LOG_ERROR } from '../../utils/telegramLogErrorMark'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

describe('HEAD_TYPE_LABEL', () => {
  // 鍵がコードの文字列なので、型検査では書き漏らしを捕まえられない。アプリが扱う種別の集合と
  // 突き合わせる。集合はそれぞれの単一情報源から読むので、種別を足せばここが落ちる。
  it('DMDATA で扱う全コードに種別名がある', () => {
    const handled = [...NON_EEW_HANDLED_TYPES, ...EEW_HEAD_TYPES, ...DISPATCHED_WITHOUT_PARSER]
    expect(handled.length).toBeGreaterThan(0)
    expect(handled.filter(code => !(code in HEAD_TYPE_LABEL))).toEqual([])
  })

  it('VYSE51・VYSE52 は括弧書きで見分けられる', () => {
    expect(HEAD_TYPE_LABEL.VYSE51).toBe('南海トラフ地震関連解説情報（臨時解説）')
    expect(HEAD_TYPE_LABEL.VYSE52).toBe('南海トラフ地震関連解説情報（定例解説）')
  })
})

describe('headTypeLabel', () => {
  it('載っているコードは種別名、扱わないコードはコードそのものを返す', () => {
    expect(headTypeLabel('VYSE50')).toBe('南海トラフ地震臨時情報')
    // 扱わないコード（試験報を捨てたときに種別を問わず記録したもの）には名前を付けない
    expect(headTypeLabel('561')).toBe('561')
  })

  it('継承したキーは引かない', () => {
    expect(headTypeLabel('constructor')).toBe('constructor')
    expect(headTypeLabel('toString')).toBe('toString')
  })
})

describe('telegramLogKindOf', () => {
  it('扱う全コードが種別を持つ（種別を持たない行でも絞り込みに当たる）', () => {
    const handled = [
      ...NON_EEW_HANDLED_TYPES, ...EEW_HEAD_TYPES, ...DISPATCHED_WITHOUT_PARSER,
    ]
    expect(handled.filter(headType => telegramLogKindOf({ headType, kind: undefined }) === undefined)).toEqual([])
  })

  it('コードから引いた種別は、読めた行の種別と食い違わない', () => {
    expect(telegramLogKindOf({ headType: 'IXAC41', kind: undefined })).toBe('estimatedIntensity')
    expect(telegramLogKindOf({ headType: 'VYSE52', kind: undefined })).toBe('nankaiCommentary')
    expect(telegramLogKindOf({ headType: 'VXSE42', kind: undefined })).toBe('eew')
    expect(telegramLogKindOf({ headType: 'VTSE41', kind: undefined })).toBe('tsunami')
  })

  it('読めた行は読んだ結果の種別を使い、扱わないコードは種別を持たない', () => {
    expect(telegramLogKindOf({ headType: 'VXSE53', kind: 'quake' })).toBe('quake')
    expect(telegramLogKindOf({ headType: '561', kind: undefined })).toBeUndefined()
  })
})

describe('KIND_OPTIONS', () => {
  it('種別の短い名前を書いた順にすべて並べる', () => {
    expect(KIND_OPTIONS).toEqual([
      'eew', 'quake', 'tsunami', 'lpgm', 'nankai', 'nankaiCommentary', 'kohatsu',
      'quakeNotice', 'earthquakeCount', 'estimatedIntensity', 'internationalTsunami',
    ])
    expect(KIND_OPTIONS.every(kind => KIND_LABEL[kind].length > 0)).toBe(true)
  })
})

// ログの時刻の前置き（`timestampPrefix`）が時計の未較正を別に警告することがあるので、
// この部品の記録だけを数える
const ownWarnings = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls.filter((args: unknown[]) => args.some((a: unknown) => typeof a === 'string' && a.includes('[TelegramTab]')))

describe('readKindFilter', () => {
  it('種別と読み取りの結果をそのまま読む', () => {
    expect(readKindFilter('nankaiCommentary')).toBe('nankaiCommentary')
    expect(readKindFilter('estimatedIntensity')).toBe('estimatedIntensity')
    expect(readKindFilter('filtered')).toBe('filtered')
    expect(readKindFilter('error')).toBe('error')
    expect(readKindFilter('all')).toBe('all')
  })

  it('知らない値は全種別へ倒し、記録を残す', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(readKindFilter('VYSE50')).toBe('all')
      expect(readKindFilter('')).toBe('all')
      expect(ownWarnings(warn)).toHaveLength(2)
    } finally {
      warn.mockRestore()
    }
  })

  // 上の「記録を残す」と対で見る。こちら単独では、記録の仕組みが壊れても通ってしまう
  it('知っている値では記録を残さない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      readKindFilter('all')
      readKindFilter('kohatsu')
      expect(ownWarnings(warn)).toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('matchesTelegramFilter', () => {
  const entry = (
    patch: Partial<TelegramLogEntry>,
  ): Pick<TelegramLogEntry, 'source' | 'origin' | 'status' | 'kind' | 'headType'> => ({
    source: 'dmdss', origin: 'live', status: 'parsed', kind: undefined, headType: '561', ...patch,
  })

  it('いままで絞れなかった 6 種別でも絞れる', () => {
    for (const kind of ['nankai', 'nankaiCommentary', 'kohatsu', 'quakeNotice', 'earthquakeCount', 'estimatedIntensity'] as const) {
      expect(matchesTelegramFilter(entry({ kind }), kind, 'all')).toBe(true)
      expect(matchesTelegramFilter(entry({ kind: 'quake' }), kind, 'all')).toBe(false)
    }
  })

  it('結合待ちの断片・読み取りに失敗した行も、電文種別コードから種別で当たる', () => {
    const fragment = entry({ status: 'filtered', headType: 'IXAC41' })
    expect(matchesTelegramFilter(fragment, 'estimatedIntensity', 'all')).toBe(true)
    expect(matchesTelegramFilter(fragment, 'filtered', 'all')).toBe(true)
    const failed = entry({ status: 'error', headType: 'VYSE50' })
    expect(matchesTelegramFilter(failed, 'nankai', 'all')).toBe(true)
    expect(matchesTelegramFilter(failed, 'error', 'all')).toBe(true)
    expect(matchesTelegramFilter(failed, 'kohatsu', 'all')).toBe(false)
  })

  it('扱わないコードの行（種別を持たない）は種別では当たらず、スキップでは当たる', () => {
    const skipped = entry({ status: 'filtered' })
    expect(matchesTelegramFilter(skipped, 'quake', 'all')).toBe(false)
    expect(matchesTelegramFilter(skipped, 'filtered', 'all')).toBe(true)
    expect(matchesTelegramFilter(skipped, 'error', 'all')).toBe(false)
    expect(matchesTelegramFilter(skipped, 'all', 'all')).toBe(true)
  })

})

describe('telegramTitleOf', () => {
  const xml = (title: string) =>
    `<?xml version="1.0"?><Report><Control><Title>${title}</Title><Status>通常</Status></Control><Head><Title>見出しの題</Title></Head></Report>`

  // 正: XML の電文は Control/Title をそのまま出す（Head の Title は使わない）
  it('XML の電文は Control の Title を返す', () => {
    expect(telegramTitleOf({ headType: 'VXSE62', rawBody: xml('長周期地震動に関する観測情報') })).toBe('長周期地震動に関する観測情報')
  })

  // 対照: XML でない本文（復号に失敗した base64・二進）は短い名前へ倒す
  it('XML でない本文は種別名を返す', () => {
    expect(telegramTitleOf({ headType: 'VXSE62', rawBody: 'PFJlcG9ydD4=' })).toBe('長周期')
    expect(telegramTitleOf({ headType: 'IXAC41', rawBody: new Uint8Array([1, 2]) })).toBe('推計震度分布図作図用データ')
  })

  // 安全弁: Control が無い・Title が空の XML も短い名前へ倒す（空の名前を出さない）
  it('Control/Title が読めない XML は種別名を返す', () => {
    expect(telegramTitleOf({ headType: 'VXSE53', rawBody: '<Report/>' })).toBe('震源・震度')
    expect(telegramTitleOf({ headType: 'VXSE53', rawBody: '<Report><Head><Title>見出し</Title></Head></Report>' })).toBe('震源・震度')
    expect(telegramTitleOf({ headType: 'ZZZZ99', rawBody: '<Report/>' })).toBe('ZZZZ99')
  })
})

describe('telegramTitleOf の許容幅', () => {
  // 訓練・試験の読み取り（telegramOperationStatus.ts）と同じく、接頭辞と属性の付いた Control も読む
  it('接頭辞・属性の付いた Control の Title を読む', () => {
    const body = '<jmx:Report><jmx:Control xmlns:jmx="x"><jmx:Title> 震源に関する情報 </jmx:Title></jmx:Control></jmx:Report>'
    expect(telegramTitleOf({ headType: 'VXSE52', rawBody: body })).toBe('震源に関する情報')
  })

  // 安全弁: 空の Title は名前にしない
  it('空の Title は種別名へ倒す', () => {
    expect(telegramTitleOf({ headType: 'VXSE52', rawBody: '<Report><Control><Title>  </Title></Control></Report>' })).toBe('震源情報')
  })
})

describe('いま出している言語で引く名前（localizedTelegramTitle ほか）', () => {
  const xml = (title: string) => `<Report><Control><Title>${title}</Title></Control></Report>`

  // 正: 表にある題名・コードは、その言語の辞書で引く
  it('英語の辞書では、決まった題名と題名の読めない行の名前を訳す', () => {
    expect(localizedTelegramTitle({ headType: 'VXSE53', rawBody: xml('震源・震度に関する情報') }, en.telegramLog)).toBe('Earthquake and Seismic Intensity Information')
    expect(localizedTelegramTitle({ headType: 'IXAC41', rawBody: new Uint8Array([1]) }, en.telegramLog)).toBe('Estimated seismic intensity map data')
    expect(localizedErrorMessage('body decode failed', en.telegramLog)).toBe('Could not decode the body')
  })

  // 対照: 日本語の辞書では今までどおり電文の題名・日本語の名前（赤字の欄は日本語の文）
  it('日本語の辞書では電文の題名をそのまま出し、赤字の欄は日本語の文にする', () => {
    expect(localizedTelegramTitle({ headType: 'VXSE53', rawBody: xml('震源・震度に関する情報') }, ja.telegramLog)).toBe('震源・震度に関する情報')
    expect(localizedTelegramTitle({ headType: 'VXSE53', rawBody: '<Report/>' }, ja.telegramLog)).toBe('震源・震度')
    expect(localizedErrorMessage('bufr decode failed', ja.telegramLog)).toBe('推計震度分布図を読めませんでした')
  })

  // 安全弁: 表に無い題名・コード・印は、電文の文字・コード・印のまま出す（継承したキーも引かない）
  it('表に無いものはそのまま出す', () => {
    expect(localizedTelegramTitle({ headType: 'VXSE53', rawBody: xml('知らない題名') }, en.telegramLog)).toBe('知らない題名')
    expect(localizedTelegramTitle({ headType: 'ZZZZ99', rawBody: '<Report/>' }, en.telegramLog)).toBe('ZZZZ99')
    expect(localizedTelegramTitle({ headType: 'toString', rawBody: '<Report/>' }, en.telegramLog)).toBe('toString')
    expect(localizedErrorMessage('something else', en.telegramLog)).toBe('something else')
  })

  it('日本語の辞書の題名の表は、鍵と値が同じ（日本語は電文の題名のまま）', () => {
    for (const [title, label] of Object.entries(ja.telegramLog.controlTitle)) expect(label).toBe(title)
  })

  it('題名を読めた行の日本語の名前は、言語で引く前と同じ', () => {
    for (const title of Object.keys(ja.telegramLog.controlTitle)) {
      const entry = { headType: 'VXSE53', rawBody: xml(title) }
      expect(localizedTelegramTitle(entry, ja.telegramLog)).toBe(telegramTitleOf(entry))
    }
  })
})

describe('経路の札と絞り込みの名前', () => {
  // 正: テスト・再生の行は経路の鍵を返し、名前はその言語の辞書で引く
  it('テスト・再生の行は札を出す', () => {
    expect(originBadgeOf('test')).toBe('test')
    expect(originBadgeOf('replay')).toBe('replay')
    expect(en.telegramLog.origin.test).toBe('Test button')
  })

  // 対照: ライブの行は札を出さない
  it('ライブの行は札を出さない', () => {
    expect(originBadgeOf('live')).toBeNull()
  })

  // 安全弁: 選択肢の並びと名前は今までどおり（「すべての経路」が先頭）
  it('絞り込みの選択肢は すべて・ライブ・テスト・再生 の順で、日本語の名前は今までと同じ', () => {
    expect(ORIGIN_OPTIONS.map(o => originFilterLabel(o, ja.telegramLog))).toEqual(['すべての経路', 'ライブ', 'テスト', '再生'])
    expect(ORIGIN_OPTIONS.map(o => originFilterLabel(o, en.telegramLog))).toEqual(['All origins', 'Live', 'Test button', 'Replay'])
  })
})

describe('訓練・試験の印の鍵', () => {
  it('鍵で引いた英語の名前は、訓練・試験・どちらか言えないを分ける', () => {
    const label = (e: { operationStatus?: '訓練' | '試験'; isTest: boolean }) => {
      const b = operationBadgeOf(e)
      return b ? en.telegramLog.operation[b.key] : null
    }
    expect(label({ operationStatus: '訓練', isTest: true })).toBe('Drill')
    expect(label({ operationStatus: '試験', isTest: true })).toBe('Test')
    expect(label({ isTest: true })).toBe('Drill/Test')
    expect(label({ isTest: false })).toBeNull()
  })
})

describe('辞書の表と、電文・受信の側の値の突き合わせ', () => {
  // 赤字の欄の印を受信の側に足して辞書へ書き忘れると、英語などの画面に印がそのまま出る。日本語の辞書は型で縛り、ほかの言語は鍵の集合をここで見る
  it('どの言語の赤字の欄の表も、受信の側の印をすべて持つ', () => {
    const marks = Object.values(TELEGRAM_LOG_ERROR).sort()
    for (const dict of [ja, en, es, ko, ptBR, zhHans, zhHant]) expect(Object.keys(dict.telegramLog.errorMessage).sort()).toEqual(marks)
  })

  // テストボタンで流す電文の題名が表に無いと、日本語以外の画面で題名が日本語のまま出る（実配信の題名の数え方は i18n-spec §4）
  it('テストボタンで流す電文の Control/Title は、すべて題名の表にある', async () => {
    const root = path.resolve(__dirname, '../../../public/data/test-telegrams')
    const files = (await readdir(root, { recursive: true })).filter(f => f.endsWith('.xml'))
    const bodies = await Promise.all(files.map(f => readFile(path.join(root, f), 'utf8')))
    const titles = new Set<string>()
    for (const body of bodies) {
      const title = telegramTitleOf({ headType: '-', rawBody: body })
      if (title !== '-') titles.add(title)
    }
    expect(titles.size).toBeGreaterThan(0)
    expect([...titles].filter(t => !Object.prototype.hasOwnProperty.call(ja.telegramLog.controlTitle, t))).toEqual([])
  })
})
