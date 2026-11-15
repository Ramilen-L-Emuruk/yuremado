import { describe, it, expect } from 'vitest'
import { hangulFromKana, hasNonConnectiveKana, learnCharMap, zhFromJapanese } from './placeNameCjk'

describe('hangulFromKana', () => {
  it('正: 語頭は平音・語中は激音、ン・ッは前の音節の終声', () => {
    expect(hangulFromKana('イズミチョウ')).toBe('이즈미초')
    expect(hangulFromKana('ヤクバ')).toBe('야쿠바')
    expect(hangulFromKana('カマイシ')).toBe('가마이시')
    expect(hangulFromKana('サッポロ')).toBe('삿포로')
    expect(hangulFromKana('センダイ')).toBe('센다이')
  })
  it('正: 長音（ー・オウ・ウウ・オオ）は書かない。シャ行は ㅑㅠㅛ、チャ・ジャ行は ㅏㅜㅗ', () => {
    expect(hangulFromKana('トウキョウ')).toBe('도쿄')
    expect(hangulFromKana('センター')).toBe('센타')
    expect(hangulFromKana('ショウガッコウ')).toBe('쇼갓코')
    expect(hangulFromKana('ジュウニ')).toBe('주니')
  })
  it('正: 小さいァ行（ディ・ファ・ウィ）は前の子音にその母音を付ける', () => {
    expect(hangulFromKana('アルカディア')).toBe('아루카디아')
    expect(hangulFromKana('ファミリー')).toBe('파미리')
  })
  it('正: 名前の漢字から語の頭と分かる「ウ」は長音として落とさない', () => {
    expect(hangulFromKana('ホリノウチ', '堀之内')).toBe('호리노우치')
    expect(hangulFromKana('トヨウラ', '豊浦')).toBe('도요우라')
  })
  it('対照: 名前を渡さないとき・「ウ」が前の音の長音の読み（青梅・河内）は落とす', () => {
    expect(hangulFromKana('ホリノウチ')).toBe('호리노치')
    expect(hangulFromKana('ヒガシオウメ', '東青梅')).toBe('히가시오메')
    expect(hangulFromKana('コウチチョウ', '河内町')).toBe('고치초')
    expect(hangulFromKana('トゴウチ', '戸河内')).toBe('도고치')
    expect(hangulFromKana('トウキョウ', '東京')).toBe('도쿄')
  })
  it('安全弁: 表に無い文字を含めば作らない', () => {
    expect(hangulFromKana('クシロオキ１００ｋｍＡ')).toBeNull()
    expect(hangulFromKana('ンア')).toBeNull()
    expect(hangulFromKana('')).toBeNull()
  })
})

describe('learnCharMap', () => {
  it('正: 2 回以上出て 8 割以上が同じ字のものを学ぶ', () => {
    const m = learnCharMap([['八戸市', '八户市'], ['三戸町', '三户町'], ['戸田市', '户田市']])
    expect(m.get('戸')).toBe('户')
  })
  it('対照: 1 回しか出ない字・揺れている字は学ばない', () => {
    const m = learnCharMap([['田舎館村', '田舍馆村'], ['高崎市', '髙崎市'], ['高松市', '高松市'], ['高知市', '髙知市']])
    expect(m.has('舎')).toBe(false)
    expect(m.has('高')).toBe(false)
  })
  it('安全弁: 長さの違う組は数えない', () => {
    const m = learnCharMap([['国後島', '国后岛岛'], ['国後島', '国后岛岛']])
    expect(m.size).toBe(0)
  })
  it('対照: 「付近→附近」からは「付→附」を学ばない（地名の「見付」「付知」を変えない）', () => {
    const m = learnCharMap([['国後島付近', '国后岛附近'], ['択捉島付近', '择捉岛附近'], ['肝付町', '肝付町']])
    expect(m.has('付')).toBe(false)
  })
})

describe('zhFromJapanese', () => {
  const learned = new Map([['戸', '户']])
  it('正: 学んだ字を先に当て、残りは OpenCC で変える', () => {
    expect(zhFromJapanese('zh-Hans', '八戸市役所', learned)).toBe('八户市役所')
    expect(zhFromJapanese('zh-Hant', '会津美里町本郷庁舎', new Map())).toBe('會津美里町本鄉廳舍')
    expect(zhFromJapanese('zh-Hans', '会津美里町本郷庁舎', new Map())).toBe('会津美里町本乡厅舍')
  })
  it('正: OpenCC が返す古い形（竝・硏・鄕）をそろえ、直さないと決めた字（真・台）は日本の字のまま', () => {
    expect(zhFromJapanese('zh-Hant', '国分寺市並木町', new Map())).toBe('國分寺市並木町')
    expect(zhFromJapanese('zh-Hans', '国分寺市並木町', new Map())).toBe('国分寺市并木町')
    expect(zhFromJapanese('zh-Hant', '筑波研究学園', new Map())).toBe('筑波研究學園')
    expect(zhFromJapanese('zh-Hant', '真岡市台町', new Map())).toBe('真岡市台町')
  })
  it('正: OpenCC が変えない日本の字体（舎・厩・内）を繁体の形にする', () => {
    expect(zhFromJapanese('zh-Hant', '一関市千厩町', new Map())).toBe('一關市千廄町')
    expect(zhFromJapanese('zh-Hant', '中札内村', new Map())).toBe('中札內村')
  })
  it('対照: 簡体では、OpenCC が別の字に置き換える地名の字（摺・麹・碕・樫・於）を日本の字のまま残す', () => {
    expect(zhFromJapanese('zh-Hans', '土佐清水市足摺岬', new Map())).toBe('土佐清水市足摺岬')
    expect(zhFromJapanese('zh-Hans', '琴浦町赤碕', new Map())).toBe('琴浦町赤碕')
    expect(zhFromJapanese('zh-Hant', '土佐清水市足摺岬', new Map())).toBe('土佐清水市足摺岬')
  })
  it('正: 繋ぎの仮名は辞書と同じ扱い（ヶ・ケは落とし、の・ノは「之」）。全角の数字と英字は半角', () => {
    expect(zhFromJapanese('zh-Hans', '龍ケ崎市', new Map())).toBe('龙崎市')
    expect(zhFromJapanese('zh-Hant', '一ノ関', new Map())).toBe('一之關')
    expect(zhFromJapanese('zh-Hans', '新篠津村第４７線', new Map())).toMatch(/第47线$/)
  })
  it('安全弁: 繋ぎ以外の仮名を含めば作らない', () => {
    expect(zhFromJapanese('zh-Hans', '札幌厚別区もみじ台', learned)).toBeNull()
    expect(hasNonConnectiveKana('岩見沢市鳩が丘')).toBe(true)
    expect(hasNonConnectiveKana('龍ケ崎市')).toBe(false)
  })
})
