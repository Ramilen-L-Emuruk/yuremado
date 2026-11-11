import { describe, it, expect } from 'vitest'
import { checklistBasisText, checklistHeadline } from './index'
import { ja } from '../../i18n/messages/ja'
import { en } from '../../i18n/messages/en'

const w = ja.actionChecklist

// 帯の見出しの下に添える 1 行（2026-10-25 ユーザー選択「この文面で直す (Recommended)」）。
describe('checklistBasisText', () => {
  it('登録地点の周りで判定したときは経路ごとの範囲を言う', () => {
    expect(checklistBasisText('eew', 'near', w)).toBe('緊急地震速報・登録地点の地域の予想')
    expect(checklistBasisText('eew', 'nearDetected', w)).toBe('緊急地震速報・登録地点から 30km 以内で検知')
    expect(checklistBasisText('kyoshin', 'near', w)).toBe('リアルタイム震度・登録地点から 30km 以内')
    expect(checklistBasisText('quake', 'near', w)).toBe('地震情報・登録地点から 30km 以内の観測点')
  })

  // 区域の点（震度速報など）で判定したときは円の半径を名乗らない（2026-10-25 選択「観測点と区域で分ける」）
  it('地震情報を区域の点で判定したときは地域と言う', () => {
    expect(checklistBasisText('quake', 'nearArea', w)).toBe('地震情報・登録地点の地域')
    expect(checklistHeadline('quake', 'nearArea', w)).toBe(checklistHeadline('quake', 'near', w))
  })

  it('全国基準のときは全国の最大と言う', () => {
    expect(checklistBasisText('eew', 'nationwide', w)).toBe('緊急地震速報・全国の最大')
    expect(checklistBasisText('kyoshin', 'nationwide', w)).toBe('リアルタイム震度・全国の最大')
    expect(checklistBasisText('quake', 'nationwide', w)).toBe('地震情報・全国の最大')
  })
})

describe('checklistHeadline', () => {
  // 正: 登録地点の周りで判定したときは場所を主張する言い方
  it('近くで判定したときの緊急地震速報は「来ます」', () => {
    expect(checklistHeadline('eew', 'near', w)).toBe('強い揺れが来ます')
    expect(checklistHeadline('eew', 'nearDetected', w)).toBe('強い揺れが来ます')
  })

  // 対照: 全国基準へ倒れたとき・地点が無いときは「来ます」と言わない
  it('全国基準の緊急地震速報は「予想されています」', () => {
    expect(checklistHeadline('eew', 'nationwide', w)).toBe('強い揺れが予想されています')
  })

  // 安全弁: 場所を主張しない経路は範囲によらず同じ
  it('強震モニタと地震情報は範囲で言い方を変えない', () => {
    expect(checklistHeadline('kyoshin', 'near', w)).toBe(checklistHeadline('kyoshin', 'nationwide', w))
    expect(checklistHeadline('quake', 'near', w)).toBe(checklistHeadline('quake', 'nationwide', w))
  })
})

// 段 9b: 語は辞書から引く。英語では範囲の半径も同じ値で組む
describe('英語の辞書', () => {
  it('根拠の行と見出しを英語で組む', () => {
    expect(checklistBasisText('eew', 'nearDetected', en.actionChecklist)).toBe('Earthquake Early Warning · detected within 30 km of your registered location')
    expect(checklistBasisText('quake', 'nationwide', en.actionChecklist)).toBe('Earthquake Information · nationwide maximum')
    expect(checklistHeadline('eew', 'near', en.actionChecklist)).toBe('Strong shaking is coming')
    expect(checklistHeadline('eew', 'nationwide', en.actionChecklist)).toBe('Strong shaking is expected')
  })
})
