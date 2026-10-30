import { describe, it, expect } from 'vitest'
import { GRADES_IN_CARD_ORDER, TSUNAMI_GRADE_NAME } from './tsunami'
import { tsunamiToText, tsunamiDowngradeToText } from './ttsText'
import type { JMATsunami, TsunamiArea, TsunamiGrade } from '../types/earthquake'

/**
 * 津波の等級を読む順が、カードが等級カードを積む順（`GRADES_IN_CARD_ORDER`）と一致していること。
 *
 * 一致していないと、読み上げに合わせたカードの追従スクロールが上下へ往復する
 * （→ docs/spec/audio-tts-spec.md §4「津波の区域の並び順」）。読み上げ側が並びを手書きで
 * 写していると、等級を増やしたときに片方だけ漏れる。
 */
describe('津波の等級を読む順', () => {
  /** 読み上げが等級として語れるもの（`'Unknown'` は呼び名が空文字のため対象外）。 */
  const speakableGrades = GRADES_IN_CARD_ORDER.filter(g => g !== 'Unknown')

  function makeTsunami(areas: TsunamiArea[]): JMATsunami {
    const now = '2026-01-01T00:00:00Z'
    return {
      kind: 'tsunami',
      id: 'test-tsunami-grade-order',
      time: now,
      cancelled: false,
      issue: { source: 'テスト', time: now, type: 'Focus' },
      areas,
    }
  }

  function makeArea(grade: TsunamiGrade, index: number): TsunamiArea {
    return {
      grade,
      immediate: false,
      name: `検証区域${index}`,
      code: `90${index}`,
      maxHeight: { description: `${index + 1}ｍ`, value: index + 1 },
    }
  }

  // 正: 等級ごとの区域が、カードと同じ順（重い等級が先）で読まれる。
  // 電文の並びをわざと逆にして渡し、電文順がそのまま残っていないことも併せて見る
  it('カードが等級カードを積む順で読む', () => {
    const areas = speakableGrades.map(makeArea)
    const text = tsunamiToText(makeTsunami([...areas].reverse()))

    const positions = areas.map(a => text.indexOf(a.name))
    expect(positions.some(p => p < 0)).toBe(false)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  // 正: どの等級も呼び名を伴って読まれる（呼び名が空の等級を混ぜていない）
  it('等級の呼び名を欠いた文を作らない', () => {
    const text = tsunamiToText(makeTsunami(speakableGrades.map(makeArea)))
    expect(text).not.toContain('にが発表')
    expect(text).not.toContain('。が発表')
  })

  // 対照: 呼び名を持たない `'Unknown'` の区域は、上位の等級と混ざって届いても読まない
  it('等級が取れない区域は読まない', () => {
    const text = tsunamiToText(makeTsunami([
      { grade: 'Warning', immediate: true, name: '青森県太平洋沿岸', code: '901', maxHeight: { description: '３ｍ', value: 3 } },
      { grade: 'Unknown', immediate: false, name: '等級不明の区域', code: '902', maxHeight: { description: '１ｍ', value: 1 } },
    ]))

    expect(text).toContain('青森県太平洋沿岸')
    expect(text).not.toContain('等級不明の区域')
    expect(text).not.toContain('にが発表')
  })

  // 安全弁: 区域はあるのに等級が 1 つも取れない電文で、引き下げ側が解除の文言へ落ちる。
  // `'Unknown'` を並びへ含めるとここが「〇〇に切り替えられました。」の壊れた文に化ける
  it('全区域の等級が取れない電文は等級として語らない', () => {
    const tsunami = makeTsunami([makeArea('Unknown', 0)])

    expect(tsunamiDowngradeToText(tsunami)).toContain('津波警報等は全て解除されました。')
    expect(tsunamiToText(tsunami)).toBe('')
  })

  // 安全弁: `'Unknown'` だけを除く根拠。他の等級に呼び名の無いものが混ざったら、
  // 上の「呼び名を欠いた文を作らない」が守れなくなる
  it('呼び名を持たない等級は Unknown だけ', () => {
    for (const grade of speakableGrades) {
      expect(TSUNAMI_GRADE_NAME[grade]).not.toBe('')
    }
    expect(TSUNAMI_GRADE_NAME.Unknown).toBe('')
  })
})

/**
 * 電文の名前で帯を分けた区域（「大津波警報：発表」と「大津波警報」）の並びを、カード・並べ替え・読み上げで共有すること
 * （→ `splitAreasByKindName`）。カードだけで分けると、52 と 53 が混ざる報で読み上げの順がカードの上下を往復する。
 */
describe('電文の名前で分けた区域の並び', () => {
  const issued = (name: string, code: string, h: number): TsunamiArea => ({
    name, code, grade: 'MajorWarning', kindName: '大津波警報：発表', immediate: false,
    maxHeight: { value: h, description: `${h}m` },
  })
  const kept = (name: string, code: string, h: number): TsunamiArea => ({
    name, code, grade: 'MajorWarning', kindName: '大津波警報', immediate: false,
    maxHeight: { value: h, description: `${h}m` },
  })
  // 電文順は「大津波警報」→「大津波警報：発表」→「大津波警報」と混ざる
  const areas = [kept('岩手県', '210', 10), issued('青森県太平洋沿岸', '201', 10), kept('宮城県', '220', 10)]

  it('正: 帯は電文の名前ごとに分かれ、「大津波警報：発表」が先に来る', async () => {
    const { splitAreasByKindName } = await import('./tsunami')
    expect(splitAreasByKindName(areas).map(p => [p.label, p.areas.map(a => a.name)])).toEqual([
      ['大津波警報：発表', ['青森県太平洋沿岸']],
      ['大津波警報', ['岩手県', '宮城県']],
    ])
  })

  it('正: カードの並べ替えも同じ順になる（波高が同じでも名前の違う区域を 1 つの見出しへ混ぜない）', async () => {
    const { groupAreasForCardDisplay, sortAreasAcrossGradesForCardDisplay } = await import('./tsunami')
    expect(groupAreasForCardDisplay(areas, []).map(g => g.areas.map(a => a.name)))
      .toEqual([['青森県太平洋沿岸'], ['岩手県', '宮城県']])
    expect(sortAreasAcrossGradesForCardDisplay(areas, []).map(a => a.name))
      .toEqual(['青森県太平洋沿岸', '岩手県', '宮城県'])
  })

  it('正: 読み上げも同じ順で区域を挙げる', () => {
    const text = tsunamiToText({ ...makeTsunamiForOrder(areas) })
    expect(text.indexOf('青森県太平洋沿岸')).toBeLessThan(text.indexOf('岩手県'))
    expect(text.indexOf('岩手県')).toBeLessThan(text.indexOf('宮城県'))
  })

  it('対照: 名前を持たない区域（標準版）はアプリの呼び名に 1 つでまとまり、電文順を保つ', async () => {
    const { splitAreasByKindName } = await import('./tsunami')
    const plain = areas.map(({ kindName: _k, ...a }) => a)
    expect(splitAreasByKindName(plain).map(p => [p.label, p.areas.map(a => a.name)])).toEqual([
      ['大津波警報', ['岩手県', '青森県太平洋沿岸', '宮城県']],
    ])
  })

  function makeTsunamiForOrder(list: TsunamiArea[]): JMATsunami {
    const now = '2026-01-01T00:00:00Z'
    return { kind: 'tsunami', id: 't', time: now, issue: { source: 'test', time: now, type: '' }, cancelled: false, areas: list } as unknown as JMATsunami
  }
})
