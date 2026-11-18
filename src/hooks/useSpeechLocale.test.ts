// 読み上げの言語の決め方（文と声を 1 度に決める）を固定する。
//
// 正・対照・安全弁の分担:
//   正   ＝ 語表があり組を作れて声もある言語は、その言語で読む
//   対照 ＝ 日本語の画面・語表がまだ無い言語は日本語で読み、設定の窓にも出さない（段1 の今はすべての言語がここ）
//   安全弁＝ 声が無ければ日本語で読み設定の窓に出す・声の一覧が未着なら「無い」と決めつけない・組を作れない言語は日本語で読む
import { describe, it, expect, vi } from 'vitest'
import type { Locale } from '../i18n/messages'

// 語表のある言語を差し替える（段1 の今は日本語だけなので、語表のある言語の分岐は差し替えないと通らない）
const withWords = new Set<Locale>(['ja'])
vi.mock('../i18n/speechWords', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../i18n/speechWords')>()
  return { ...actual, speechWordsFor: (l: Locale) => (withWords.has(l) ? actual.jaSpeech : null) }
})

const { decideSpeechLocale: decideWith } = await import('./useSpeechLocale')

// 第 4 引数（声の一覧を待ち終えたか）は、待っている途中の判定を見る形にそろえる。第 5 引数（地名の表が読めているか）は読めている形
const decideSpeechLocale = (l: Locale, v: (x: Locale) => boolean | null, b: (x: Locale) => boolean, settled = false, placeNamesReady = true) =>
  decideWith(l, v, b, settled, placeNamesReady)
const anyVoice = () => true
const noVoice = () => false
const voicesNotYet = () => null
const buildable = () => true

function withKoWords(fn: () => void): void {
  withWords.add('ko')
  try { fn() } finally { withWords.delete('ko') }
}

describe('読み上げの言語の決め方', () => {
  it('日本語の画面は日本語で読む（対照）', () => {
    expect(decideSpeechLocale('ja', noVoice, buildable)).toEqual({ speechLocale: 'ja', missingVoice: false })
  })

  it('語表がまだ無い言語は、声があっても日本語で読み、設定の窓に出さない（対照）', () => {
    expect(decideSpeechLocale('en', anyVoice, buildable)).toEqual({ speechLocale: 'ja', missingVoice: false })
  })

  it('語表があり組を作れて声もある言語は、その言語で読む（正）', () => {
    withKoWords(() => expect(decideSpeechLocale('ko', anyVoice, buildable)).toEqual({ speechLocale: 'ko', missingVoice: false }))
  })

  it('声が無ければ日本語で読み、設定の窓に出す（安全弁）', () => {
    withKoWords(() => expect(decideSpeechLocale('ko', noVoice, buildable)).toEqual({ speechLocale: 'ja', missingVoice: true }))
  })

  it('声の一覧がまだ届いていなければ日本語で読み、「声が無い」とは出さない（安全弁）', () => {
    withKoWords(() => expect(decideSpeechLocale('ko', voicesNotYet, buildable)).toEqual({ speechLocale: 'ja', missingVoice: false }))
  })

  it('声の一覧を待ち終えても空なら、声が無いとして設定の窓に出す（安全弁。理由が分からないまま日本語に固定しない）', () => {
    withKoWords(() => expect(decideSpeechLocale('ko', voicesNotYet, buildable, true)).toEqual({ speechLocale: 'ja', missingVoice: true }))
  })

  // 2026-11-18 ユーザー選択「そろうまで日本語、回線で読み直す (Recommended)」
  it('語表があっても地名の表がまだ無ければ、声があっても日本語で読み、「声が無い」とも出さない（対照）', () => {
    withKoWords(() => expect(decideSpeechLocale('ko', anyVoice, buildable, true, false)).toEqual({ speechLocale: 'ja', missingVoice: false }))
  })

  it('地名の表があっても語表がまだ無ければ日本語で読む（対照）', () => {
    expect(decideSpeechLocale('en', anyVoice, buildable, true, true)).toEqual({ speechLocale: 'ja', missingVoice: false })
  })

  it('組を作れない言語は、声があっても日本語で読む（安全弁。文だけ日本語へ落ちて声が食い違うのを防ぐ）', () => {
    withKoWords(() => expect(decideSpeechLocale('ko', anyVoice, () => false)).toEqual({ speechLocale: 'ja', missingVoice: false }))
  })
})
