// 日本語以外の読み上げを端末の声で読む部品（声選び・読む単位の分け方）を固定する。
//
// 正・対照・安全弁の分担:
//   正   ＝ その言語の声を選ぶ・文の終わりで分ける・速報は文の中の区切りでも分ける
//   対照 ＝ 数の中の点（6.5）では分けない・短い断片は次へ付ける
//   安全弁＝ 中国語は字体の違う声を当てない・声が無ければ null（日本語の声を当てない）・分けた単位は元の文の切り出し
import { describe, it, expect } from 'vitest'
import { pickVoiceFor } from './systemSpeech'
import { splitForeignSpeechUnits } from './voicevox'

const voice = (name: string, lang: string, localService = true) => ({ name, lang, localService, default: false, voiceURI: name }) as SpeechSynthesisVoice

describe('その言語の声を選ぶ', () => {
  const voices = [
    voice('Kyoko', 'ja-JP'), voice('Samantha', 'en-US'), voice('Tingting', 'zh-CN'),
    voice('Meijia', 'zh-TW'), voice('Sinji', 'zh-HK'), voice('Yuna', 'ko-KR'),
    voice('Luciana', 'pt-BR'), voice('Joana', 'pt-PT'), voice('Monica', 'es-ES'),
  ]

  it('言語ごとに、その言語の声を選ぶ（正）', () => {
    expect(pickVoiceFor(voices, 'en')?.name).toBe('Samantha')
    expect(pickVoiceFor(voices, 'ko')?.name).toBe('Yuna')
    expect(pickVoiceFor(voices, 'pt-BR')?.name).toBe('Luciana')
    expect(pickVoiceFor(voices, 'es')?.name).toBe('Monica')
    expect(pickVoiceFor(voices, 'ja')?.name).toBe('Kyoko')
  })

  it('中国語は字体で分ける。繁体字は台湾の声を先に、無ければ香港の声（安全弁）', () => {
    expect(pickVoiceFor(voices, 'zh-Hans')?.name).toBe('Tingting')
    expect(pickVoiceFor(voices, 'zh-Hant')?.name).toBe('Meijia')
    expect(pickVoiceFor(voices.filter(v => v.name !== 'Meijia'), 'zh-Hant')?.name).toBe('Sinji')
    // 繁体字の声しか無い端末で、簡体字の画面に繁体字の声を当てない
    expect(pickVoiceFor([voice('Meijia', 'zh-TW')], 'zh-Hans')).toBeNull()
  })

  it('ブラジルの声が無ければ、ほかのポルトガル語の声（正）', () => {
    expect(pickVoiceFor([voice('Joana', 'pt-PT')], 'pt-BR')?.name).toBe('Joana')
  })

  it('その言語の声が無ければ null（日本語の声を当てない。安全弁）', () => {
    expect(pickVoiceFor([voice('Kyoko', 'ja-JP')], 'en')).toBeNull()
  })

  it('Android の形の言語タグ（en_US）も拾う（安全弁）', () => {
    expect(pickVoiceFor([voice('A', 'en_US')], 'en')?.name).toBe('A')
    expect(pickVoiceFor([voice('B', 'ko_KR')], 'ko')?.name).toBe('B')
    expect(pickVoiceFor([voice('C', 'es_ES')], 'es')?.name).toBe('C')
    expect(pickVoiceFor([voice('D', 'pt_PT')], 'pt-BR')?.name).toBe('D')
    expect(pickVoiceFor([voice('E', 'zh_TW')], 'zh-Hant')?.name).toBe('E')
  })

  it('端末の中で動く声を先に選ぶ（正）', () => {
    expect(pickVoiceFor([voice('Net', 'en-US', false), voice('Local', 'en-GB', true)], 'en')?.name).toBe('Local')
  })
})

describe('日本語以外の文を、端末の声で読む単位に分ける', () => {
  const EN = 'Earthquake Early Warning. Earthquake: Off the Coast of Sanriku.'

  it('文の終わりで分ける（正）', () => {
    expect(splitForeignSpeechUnits(EN, false, 'en')).toEqual([
      'Earthquake Early Warning.', ' Earthquake: Off the Coast of Sanriku.',
    ])
  })

  it('取り下げの判定を添えた読み上げは、文の中の区切りでも分ける（正）', () => {
    expect(splitForeignSpeechUnits('Tohoku, Kanto: watch out for strong tremors.', true, 'en')).toEqual([
      'Tohoku,', ' Kanto:', ' watch out for strong tremors.',
    ])
  })

  it('数の中の点では分けない（対照）', () => {
    expect(splitForeignSpeechUnits('Magnitude 6.5 earthquake. Next.', false, 'en')).toEqual([
      'Magnitude 6.5 earthquake.', ' Next.',
    ])
  })

  it('短い断片は次へ付ける（対照）', () => {
    // 「A,」は 2 字で下限（5 字）に満たない
    expect(splitForeignSpeechUnits('A, Kanto: watch out.', true, 'en')).toEqual(['A, Kanto:', ' watch out.'])
  })

  it('つなげると元の文に戻る。鳴った句の照合（spokenChunks.join）が文の中の空白で外れない（安全弁）', () => {
    for (const phrase of [
      'No intensity forecast: single-station.', 'Sem intensidade prevista: estação única.', 'Sin intensidad prevista: sismo profundo.',
    ]) {
      const text = `Upgraded to an Earthquake Early Warning. ${phrase}`
      const units = splitForeignSpeechUnits(text, true, phrase.startsWith('No') ? 'en' : phrase.startsWith('Sem') ? 'pt-BR' : 'es')
      expect(units.length).toBeGreaterThan(2)
      expect(units.join('')).toBe(text)
      expect(units.join('').includes(phrase)).toBe(true)
    }
  })

  it('中国語は全角の句点・読点で分ける（正）', () => {
    expect(splitForeignSpeechUnits('紧急地震警报。三陆冲发生地震。', false, 'zh-Hans')).toEqual(['紧急地震警报。', '三陆冲发生地震。'])
    expect(splitForeignSpeechUnits('东北、关东：请注意强烈震动。', true, 'zh-Hans')).toEqual(['东北、关东：', '请注意强烈震动。'])
  })

  it('長すぎる文は文の中の区切りで分ける（正）', () => {
    const names = Array.from({ length: 12 }, (_, i) => `Region${i}`).join(', ')
    const units = splitForeignSpeechUnits(`${names}: watch out for strong tremors.`, false, 'en')
    expect(units.length).toBeGreaterThan(1)
    expect(units.every(u => u.length <= 80)).toBe(true)
  })

  it('分けた単位はどれも元の文の切り出し（画面の追従が元の文の中を探すため。安全弁）', () => {
    const text = 'Upgraded to an Earthquake Early Warning.  Tohoku, Kanto: watch out for strong tremors.'
    for (const withdrawable of [false, true]) {
      for (const u of splitForeignSpeechUnits(text, withdrawable, 'en')) expect(text).toContain(u)
    }
  })
})
