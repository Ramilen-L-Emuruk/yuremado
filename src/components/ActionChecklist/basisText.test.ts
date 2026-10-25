import { describe, it, expect } from 'vitest'
import { checklistBasisText, checklistHeadline } from './index'

// 帯の見出しの下に添える 1 行（2026-10-25 ユーザー選択「この文面で直す (Recommended)」）。
describe('checklistBasisText', () => {
  it('ホーム地点の周りで判定したときは経路ごとの範囲を言う', () => {
    expect(checklistBasisText('eew', 'near')).toBe('緊急地震速報・ホーム地点の地域の予想')
    expect(checklistBasisText('eew', 'nearDetected')).toBe('緊急地震速報・ホーム地点から 30km 以内で検知')
    expect(checklistBasisText('kyoshin', 'near')).toBe('強震モニタ・ホーム地点から 30km 以内')
    expect(checklistBasisText('quake', 'near')).toBe('地震情報・ホーム地点から 30km 以内の観測点')
  })

  // 区域の点（震度速報など）で判定したときは円の半径を名乗らない（2026-10-25 選択「観測点と区域で分ける」）
  it('地震情報を区域の点で判定したときは地域と言う', () => {
    expect(checklistBasisText('quake', 'nearArea')).toBe('地震情報・ホーム地点の地域')
    expect(checklistHeadline('quake', 'nearArea')).toBe(checklistHeadline('quake', 'near'))
  })

  it('全国基準のときは全国の最大と言う', () => {
    expect(checklistBasisText('eew', 'nationwide')).toBe('緊急地震速報・全国の最大')
    expect(checklistBasisText('kyoshin', 'nationwide')).toBe('強震モニタ・全国の最大')
    expect(checklistBasisText('quake', 'nationwide')).toBe('地震情報・全国の最大')
  })
})

describe('checklistHeadline', () => {
  // 正: ホーム地点の周りで判定したときは場所を主張する言い方
  it('近くで判定したときの緊急地震速報は「来ます」', () => {
    expect(checklistHeadline('eew', 'near')).toBe('強い揺れが来ます')
    expect(checklistHeadline('eew', 'nearDetected')).toBe('強い揺れが来ます')
  })

  // 対照: 全国基準へ倒れたとき・地点が無いときは「来ます」と言わない
  it('全国基準の緊急地震速報は「予想されています」', () => {
    expect(checklistHeadline('eew', 'nationwide')).toBe('強い揺れが予想されています')
  })

  // 安全弁: 場所を主張しない経路は範囲によらず同じ
  it('強震モニタと地震情報は範囲で言い方を変えない', () => {
    expect(checklistHeadline('kyoshin', 'near')).toBe(checklistHeadline('kyoshin', 'nationwide'))
    expect(checklistHeadline('quake', 'near')).toBe(checklistHeadline('quake', 'nationwide'))
  })
})
