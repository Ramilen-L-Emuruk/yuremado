import { describe, it, expect } from 'vitest'
import { fixPlaceName, leftoverForeignChars } from './placeNameFixes'

describe('fixPlaceName', () => {
  it('正: 繁体字の県名の字を県名の表にそろえ、日本の新字体を繁体字にする', () => {
    expect(fixPlaceName('zh-Hant', 'epi', '新潟県上中下越', '新瀉灣上中下越')).toBe('新潟縣上中下越')
    expect(fixPlaceName('zh-Hant', 'pref', '栃木県', '櫔木縣')).toBe('櫪木縣')
    expect(fixPlaceName('zh-Hant', 'epi', '国後島付近', '國後島付近')).toBe('國後島附近')
    expect(fixPlaceName('zh-Hant', 'city', '三重御浜町', '三重禦浜町')).toBe('三重御濱町')
    expect(fixPlaceName('zh-Hant', 'city', '高崎市', '髙崎市')).toBe('高崎市')
    expect(fixPlaceName('zh-Hant', 'epi', '沖縄本島近海', '沖縄本島近海')).toBe('沖繩本島近海')
  })
  it('正: 繁体字の、簡体から機械で戻したとみられる誤字を直す', () => {
    expect(fixPlaceName('zh-Hant', 'city', '東京世田谷区', '東京世田穀區')).toBe('東京世田谷區')
    expect(fixPlaceName('zh-Hant', 'city', '筑後市', '築後市')).toBe('筑後市')
    expect(fixPlaceName('zh-Hant', 'city', '北九州小倉北区', '北九洲小倉北區')).toBe('北九州小倉北區')
  })
  it('正: 簡体字の日本の字体と誤字を直す', () => {
    expect(fixPlaceName('zh-Hans', 'epi', '福井県嶺北', '福井県嶺北')).toBe('福井县岭北')
    expect(fixPlaceName('zh-Hans', 'epi', '十勝沖', '十腾冲')).toBe('十胜冲')
    expect(fixPlaceName('zh-Hans', 'epi', '愛媛県中予', '爱媛县中预')).toBe('爱媛县中予')
  })
  it('正: 名前ごとの上書きは、表の種類と名前が両方合うときだけ当たる', () => {
    expect(fixPlaceName('zh-Hant', 'city', '飛騨市', '飛騨市')).toBe('飛驒市')
    expect(fixPlaceName('zh-Hans', 'epi', '苫小牧沖', '占小牧冲')).toBe('苫小牧冲')
    expect(fixPlaceName('ko', 'city', '千葉中央区', '치바 주오 구')).toBe('지바 주오구')
  })
  it('対照: 同じ名前でも種類が違えば上書きは当たらない', () => {
    expect(fixPlaceName('zh-Hans', 'city', '苫小牧沖', '占小牧冲')).toBe('占小牧冲')
  })
  it('正: 韓国語の県名の綴りをそろえ、行政の接尾辞の前の空白を詰める', () => {
    expect(fixPlaceName('ko', 'epi', '神奈川県東部', '카나강 현 동부')).toBe('가나가와현 동부')
    expect(fixPlaceName('ko', 'city', '前橋市', '마에바시 시')).toBe('마에바시시')
    expect(fixPlaceName('ko', 'epi', '三重県南東沖', '미에 현 남동쪽 바다')).toBe('미에현 남동쪽 앞바다')
  })
  it('正: 韓国語の「沖」（바다・오키）を 앞바다 にそろえ、末尾の置き換えで直らないものは上書きで直す', () => {
    expect(fixPlaceName('ko', 'epi', '宮城県沖', '미야기현 바다')).toBe('미야기현 앞바다')
    expect(fixPlaceName('ko', 'epi', '釧路沖', '구시로 오키')).toBe('구시로 앞바다')
    expect(fixPlaceName('ko', 'epi', '三陸沖', '산리 쿠바다')).toBe('산리쿠 앞바다')
  })
  it('正: 香川県・伊豆諸島・繁体の「内」を直す（「나카가와」（中川）の「카가와」には当てない）', () => {
    expect(fixPlaceName('ko', 'pref', '香川県', '카가와현')).toBe('가가와현')
    expect(fixPlaceName('ko', 'city', '中川村', '나카가와 촌')).toBe('나카가와촌')
    expect(fixPlaceName('ko', 'tsunamiArea', '伊豆諸島', '이두제도')).toBe('이즈 제도')
    expect(fixPlaceName('zh-Hant', 'epi', '内浦湾', '内浦灣')).toBe('內浦灣')
  })
  it('対照: 「沖縄」の字や「沖」を含まない名前の 바다 は変えない', () => {
    expect(fixPlaceName('ko', 'tsunamiArea', '沖縄本島地方', '오키나와 본섬 지방')).toBe('오키나와 본섬 지방')
    expect(fixPlaceName('ko', 'epi', '日本海中部', '일본해 중부 바다')).toBe('일본해 중부 바다')
  })
  it('正: 長い語を先に当てる（「쿄토부 오키」は「쿄토부」より先）', () => {
    expect(fixPlaceName('ko', 'epi', '京都府沖', '쿄토부 오키')).toBe('교토부 앞바다')
    expect(fixPlaceName('ko', 'tsunamiArea', '京都府', '쿄토부')).toBe('교토부')
    expect(fixPlaceName('zh-Hant', 'epi', '新潟県上中下越', '新瀉灣上中下越')).toBe('新潟縣上中下越')
  })
  it('正: 韓国語の地方名の割れと訓読みを直す', () => {
    expect(fixPlaceName('ko', 'epi', '山形県置賜地方', '야마가타현 오키 타마 지방')).toBe('야마가타현 오키타마 지방')
    expect(fixPlaceName('ko', 'epi', '新潟県下越地方', '니가타현 시모고에 지방')).toBe('니가타현 가에쓰 지방')
    expect(fixPlaceName('ko', 'tsunamiArea', '新潟県上中下越', '니가타현 카미 나카 시모고에')).toBe('니가타현 조에쓰·주에쓰·가에쓰')
  })
  it('対照: 接尾辞と同じ字で始まる語の前の空白は詰めない', () => {
    expect(fixPlaceName('ko', 'epi', '熊本県球磨地方', '구마모토현 구마 지방')).toBe('구마모토현 구마 지방')
  })
  it('対照: 語と語の間の空白（현 の後）と、直しに当たらない訳はそのまま', () => {
    expect(fixPlaceName('ko', 'epi', '三重県北部', '미에현 북부')).toBe('미에현 북부')
    expect(fixPlaceName('zh-Hant', 'epi', '千葉県南部', '千葉縣南部')).toBe('千葉縣南部')
  })
  it('安全弁: 英字の言語には当てない', () => {
    expect(fixPlaceName('en', 'city', '飛騨市', 'Off the Coast of 浜')).toBe('Off the Coast of 浜')
  })
})

describe('leftoverForeignChars', () => {
  it('正: 繁体字に日本の新字体が残っていれば、その字を返す', () => {
    expect(leftoverForeignChars('zh-Hant', '伊勢湾')).toBe('湾')
    expect(leftoverForeignChars('zh-Hant', '沖縄本島')).toBe('縄')
  })
  it('正: 簡体字に日本の字体や繁体字が残っていれば、その字を返す', () => {
    expect(leftoverForeignChars('zh-Hans', '鹿儿岛県西部')).toBe('県')
    expect(leftoverForeignChars('zh-Hans', '安芸灘')).toBe('芸灘')
  })
  it('対照: その字体で正しい字と、直さないと決めた字だけなら空', () => {
    expect(leftoverForeignChars('zh-Hant', '伊勢灣')).toBe('')
    expect(leftoverForeignChars('zh-Hans', '中国地方')).toBe('')
    expect(leftoverForeignChars('zh-Hant', '台灣付近')).toBe('')
  })
  it('正: OpenCC が変えない日本の字体（舎・騨など）も見つける', () => {
    expect(leftoverForeignChars('zh-Hant', '本鄉廳舎')).toBe('舎')
    expect(leftoverForeignChars('zh-Hans', '岐阜县飞騨地方')).toBe('騨')
    expect(leftoverForeignChars('zh-Hant', '盛岡市薮川')).toBe('薮')
  })
  it('対照: 簡体字でもある字（薮・梼）と、簡体で残すと決めた地名の字（摺）は簡体では数えない', () => {
    expect(leftoverForeignChars('zh-Hans', '盛冈市薮川')).toBe('')
    expect(leftoverForeignChars('zh-Hans', '梼原町')).toBe('')
    expect(leftoverForeignChars('zh-Hans', '土佐清水市足摺岬')).toBe('')
  })
  it('正: OpenCC が返す古い形・まれな字（拡張 A）・繁体の「内」も見つける', () => {
    expect(leftoverForeignChars('zh-Hans', '国分寺市竝木町')).toBe('竝')
    expect(leftoverForeignChars('zh-Hans', '八丈町㭴立')).toBe('㭴')
    expect(leftoverForeignChars('zh-Hant', '内浦灣')).toBe('内')
  })
  it('安全弁: 中国語以外は見ない', () => {
    expect(leftoverForeignChars('ko', '県')).toBe('')
  })
})
