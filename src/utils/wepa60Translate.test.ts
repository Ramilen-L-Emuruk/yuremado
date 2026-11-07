import { describe, expect, it } from 'vitest'
import { translateWepa60, type Wepa60TranslatedLine } from './wepa60Translate'

// 自作の文（気象庁の仕様書 No.40401 別紙の書式と、控えの実電文の行の並びに倣った）
const BULLETIN = [
  'WEPA60 RJTD 180729',
  'TSUNAMI BULLETIN NUMBER 002',
  '   ISSUED BY NWPTAC(JMA)',
  '   ISSUED AT 0729Z 18 SEP 2022',
  '',
  'HYPOCENTRAL PARAMETERS (REVISION)',
  'ORIGIN TIME:0644Z 18 SEP 2022',
  'PRELIMINARY EPICENTER:LAT23.0NORTH LON121.1EAST',
  ' TAIWAN',
  ' TAIWAN',
  'MAG:7.1 (MW)',
  '',
  'EVALUATION',
  ' THERE IS A POSSIBILITY OF A DESTRUCTIVE LOCAL TSUNAMI',
  ' NEAR THE EPICENTER',
  '',
  'THIS BULLETIN IS FOR',
  'TAIWAN',
  'EAST COASTS OF PHILIPPINES (CANCELLATION)',
  '',
  'ESTIMATED TSUNAMI ARRIVAL TIMES AND WAVE AMPLITUDES',
  'TAIWAN',
  ' LOCATION              COORDINATES  ARRIVAL TIME  AMPL',
  ' HUALIEN               24.0N 121.6E (CANCELLATION)',
  ' TAITUNG               22.7N 121.2E 0645Z 18 SEP  0.3-1M (REVISION)',
  '',
  'MEASUREMENTS OR REPORTS OF TSUNAMI (REVISION)',
  ' LOCATION                       COORDINATES ARRIVAL TIME  AMPL',
  ' OFUNATO                        39.0N 141.8E',
  '                       MAXIMUM TSUNAMI WAVE 1507Z 08 DEC  0.2M',
  '',
  'MAXIMUM TSUNAMI WAVE - HALF THE AMPLITUDE FROM THE TROUGH',
  'TO THE CREST',
  '',
  'THIS WILL BE THE FINAL BULLETIN UNLESS CHANGES IN THE POTENTIAL',
  'FOR TSUNAMI GENERATION ARE DEEMED POSSIBLE BASED ON EARTHQUAKE',
  'RE-EVALUATION OR REPORTS INDICATING TSUNAMI OBSERVATION ARE',
  'RECEIVED.',
  '',
  '=',
].join('\n')

const ISSUED = '2022-09-18T07:29:00.000Z'
const ctx = {
  regionNames: { TAIWAN: '台湾', 'VANUATU ISLANDS': 'バヌアツ諸島' },
  tsunamiStationNameAt: (lat: number, lon: number) => (Math.abs(lat - 39.0) < 0.1 && Math.abs(lon - 141.8) < 0.1 ? { name: '大船渡', ambiguous: false } : undefined),
}
const texts = (lines: Wepa60TranslatedLine[]) => lines.map(l => l.text)
const untranslated = (lines: Wepa60TranslatedLine[]) => lines.filter(l => l.untranslated).map(l => l.text)

describe('translateWepa60', () => {
  // 正: 書式どおりの報は、見出し・震源・評価・対象地域・予想の表・観測の表・注意書きがすべて訳せる
  it('書式どおりの報は全部の行を訳す', () => {
    const out = translateWepa60(BULLETIN, ISSUED, ctx)
    expect(untranslated(out)).toEqual([])
    expect(texts(out)).toEqual(expect.arrayContaining([
      '北西太平洋津波情報 第2報',
      '発表元: 北西太平洋津波情報センター（気象庁）',
      '発表時刻: 2022年9月18日 16時29分（日本時間）',
      '震源要素（更新）',
      '地震発生時刻: 2022年9月18日 15時44分（日本時間）',
      '暫定震央: 北緯23.0度 東経121.1度',
      '台湾',
      '台湾周辺',
      'マグニチュード 7.1（モーメントマグニチュード）',
      '評価',
      '震源付近に被害をもたらす局地的な津波の可能性がある',
      '対象地域',
      'フィリピン東岸（取消）',
      '予想到達時刻・予想高さ',
      '地点　座標　到達時刻　高さ',
      '花蓮　北緯24.0度 東経121.6度（取消）',
      '台東　北緯22.7度 東経121.2度　9月18日15時45分（日本時間）　0.3〜1m（更新）',
      '津波観測値（更新）',
      '大船渡　北緯39.0度 東経141.8度',
      '最大波の高さは、波の谷から山までの高さの半分。',
      '地震の再評価で津波発生の可能性が変わる場合や、津波を観測したという報告を受けた場合を除き、これを最終報とする。',
      '=',
    ]))
  })

  // 安全弁: 年の無い時刻（DD MMM）は発表の年から補い、半年以上離れた月は年をまたいだとみる
  it('観測時刻の年は発表時刻から補い、年またぎも読む', () => {
    const out = texts(translateWepa60(BULLETIN, ISSUED, ctx))
    // 発表は 2022-09、観測は 12 月（3 か月後）なので同じ年。日本時間で 12 月 9 日 0 時 07 分
    expect(out).toContain('最大波 12月9日0時07分（日本時間） 0.2m')
    const jan = translateWepa60(BULLETIN.replace('1507Z 08 DEC', '2350Z 31 DEC'), '2023-01-01T01:00:00.000Z', ctx)
    expect(texts(jan)).toContain('最大波 1月1日8時50分（日本時間） 0.2m')
  })

  // 正: 観測の高さは電文の書き方のまま出す（実電文に `0.0M` がある。「0m」に丸めると波が無かったと読める）
  it('観測の高さ 0.0M は 0.0m のまま出す', () => {
    const out = texts(translateWepa60(BULLETIN.replace('08 DEC  0.2M', '08 DEC  0.0M'), ISSUED, ctx))
    expect(out).toContain('最大波 12月9日0時07分（日本時間） 0.0m')
  })

  // 正: 電文は 10 度未満の緯度を `08.6`・`09.2N` と頭に 0 を付けて書く。訳では頭の 0 を外し、小数の桁は残す
  it('座標の頭の 0 を外し、小数の桁は残す', () => {
    const out = texts(translateWepa60(
      BULLETIN.replace('LAT23.0NORTH', 'LAT08.6NORTH').replace('22.7N 121.2E', '09.2N 126.0E'),
      ISSUED, ctx,
    ))
    expect(out).toContain('暫定震央: 北緯8.6度 東経121.1度')
    expect(out).toContain('台東　北緯9.2度 東経126.0度　9月18日15時45分（日本時間）　0.3〜1m（更新）')
  })

  // 安全弁: 時刻として成り立たない値（25 時・61 分・0 日）は、Date が繰り上げた別の時刻を出さずに未訳で残す
  it('時刻として成り立たない値は未訳で残す', () => {
    const out = translateWepa60(BULLETIN.replace('0645Z 18 SEP', '2561Z 18 SEP').replace('ORIGIN TIME:0644Z 18 SEP', 'ORIGIN TIME:0644Z 0 SEP'), ISSUED, ctx)
    expect(untranslated(out)).toEqual([
      'ORIGIN TIME:0644Z 0 SEP 2022',
      'TAITUNG               22.7N 121.2E 2561Z 18 SEP  0.3-1M (REVISION)',
    ])
  })

  // 安全弁: 無い日付（2 月 31 日）は、Date が 3 月へ繰り上げた日付を出さずに未訳で残す
  it('無い日付は未訳で残す', () => {
    const out = translateWepa60(BULLETIN.replace('1507Z 08 DEC', '1507Z 31 FEB'), ISSUED, ctx)
    expect(untranslated(out)).toEqual(['MAXIMUM TSUNAMI WAVE 1507Z 31 FEB  0.2M'])
  })

  // 安全弁: 震源要素の見出しに書式の外の語が付いていたら、見出しの行を英語のまま残す（中身の行は訳す）
  it('震源要素の見出しの書式の外の語は残す', () => {
    const out = translateWepa60(BULLETIN.replace('HYPOCENTRAL PARAMETERS (REVISION)', 'HYPOCENTRAL PARAMETERS (UPDATED BY PTWC)'), ISSUED, ctx)
    expect(untranslated(out)).toEqual(['HYPOCENTRAL PARAMETERS (UPDATED BY PTWC)'])
    expect(texts(out)).toContain('暫定震央: 北緯23.0度 東経121.1度')
  })

  // 対照: 書式の外の文（備考など）は推して訳さず、英語のまま印を付けて残す
  it('書式の外の段落は英語のまま未訳の印を付ける', () => {
    const out = translateWepa60(BULLETIN.replace('\n=', '\nTHIS IS A REMARK NOT IN THE FORMAT.\n\n='), ISSUED, ctx)
    expect(untranslated(out)).toEqual(['THIS IS A REMARK NOT IN THE FORMAT.'])
  })

  // 安全弁: 名簿に無い地点は、名前を推して訳さない（英語の名前のまま、行に未訳の印）
  it('名簿に無い地点は英語の名前のまま未訳の印を付ける', () => {
    const out = translateWepa60(BULLETIN.replace(' HUALIEN ', ' NEWPOINT'), ISSUED, ctx)
    expect(untranslated(out)).toEqual(['NEWPOINT　北緯24.0度 東経121.6度（取消）'])
  })

  // 震央の 1 行目は電文の地名を先に訳し、地名の表に無いときだけ地震カードの震央地名を使う
  // （2026-11-08 ユーザー選択「電文の地名を先に (Recommended)」）
  it('震央の 1 行目は電文の地名を先に訳し、表に無いときだけ地震カードの震央地名を使う', () => {
    // 正: 表にある地名は、カードの名前が渡されても電文の地名で訳す
    const known = texts(translateWepa60(BULLETIN, ISSUED, { ...ctx, quakeName: '台湾付近' }))
    expect(known).toContain('台湾')
    expect(known).not.toContain('台湾付近')
    // 対照: 表に無い地名は、カードの名前で補う
    const unknown = translateWepa60(BULLETIN.replace(' TAIWAN\n TAIWAN', ' NEW REGION\n TAIWAN'), ISSUED, { ...ctx, quakeName: '台湾付近' })
    // 補ったと分かるよう、電文の英語名を添える（2026-11-08 ユーザー選択「英語名を添える (Recommended)」）
    expect(texts(unknown)).toContain('台湾付近（NEW REGION）')
    // 安全弁: カードの名前も無ければ英語のまま未訳
    expect(untranslated(translateWepa60(BULLETIN.replace(' TAIWAN\n TAIWAN', ' NEW REGION\n TAIWAN'), ISSUED, ctx))).toEqual(['NEW REGION'])
  })

  // 観測の表の日本の地点: 座標で当てた候補が 2 つ以上あれば英語名を添える（2026-11-08 ユーザー選択「候補が 2 つなら英語名を添える (Recommended)」）
  it('座標で当てた観測点の候補が 2 つ以上なら英語名を添える', () => {
    const out = texts(translateWepa60(BULLETIN, ISSUED, { ...ctx, tsunamiStationNameAt: () => ({ name: '大船渡', ambiguous: true }) }))
    expect(out).toContain('大船渡（OFUNATO）　北緯39.0度 東経141.8度')
  })

  // 正: 巨大地震のときの表現（規模 8 超・あらかじめ想定した規模・定性的な高さ）と深さ
  it('MAG:OVER 8・定性的な高さ・深さを訳す', () => {
    const huge = BULLETIN
      .replace('MAG:7.1 (MW)', 'FOCAL DEPTH:139KM MAG:OVER 8\nTHIS INFORMATION IS BASED ON THE PREDEFINED MAGNITUDE')
      .replace('0.3-1M (REVISION)', 'HUGE')
    const out = translateWepa60(huge, ISSUED, ctx)
    expect(untranslated(out)).toEqual([])
    expect(texts(out)).toEqual(expect.arrayContaining([
      '深さ 139km　マグニチュード 8 超',
      'この情報は、あらかじめ想定したマグニチュードに基づく。',
      '台東　北緯22.7度 東経121.2度　9月18日15時45分（日本時間）　巨大',
    ]))
  })

  // 正: 決めた 8 つの外の地震区でも、同じ名前が気象庁の地名の表にあれば日本語にする。表にも無ければ原文のまま
  it('震央の 2 行目は地震区の表、無ければ地名の表で引く', () => {
    const vanuatu = translateWepa60(BULLETIN.replace(' TAIWAN\n TAIWAN', ' VANUATU ISLANDS\n VANUATU ISLANDS'), ISSUED, ctx)
    expect(texts(vanuatu).filter(t => t === 'バヌアツ諸島')).toHaveLength(2)
    const unknown = translateWepa60(BULLETIN.replace(' TAIWAN\n TAIWAN', ' TAIWAN\n SOMEWHERE ELSE'), ISSUED, ctx)
    expect(untranslated(unknown)).toEqual(['SOMEWHERE ELSE'])
  })
})
