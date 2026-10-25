// @vitest-environment jsdom
//
// ローカル履歴アーカイブへ入れた取消電文が、アプリ側で本当に取り下げられるか。
//
// アーカイブは取消電文も収録する（2026-10-23 ユーザー承認。選んだ選択肢は「取消も収録する
// (Recommended)」）。取り下げるのはアプリ側の `applyQuakeCancelToCard`（ライブと履歴の両方が通る）で、
// 当たる条件は「同じ地震（`sameQuakeEntry`）」かつ「取り消した種別の報をカードが受けている」こと。
// アーカイブは電文の id の後ろに NII の電文 ID を足すので（`localEarthquakeArchiveBuilder.ts`）、
// **その形のままでも当たること**をここで固定する。
//
// 材料は実電文（2024-01-01 23:04 の地震。震度速報 → 震度速報の取消 → 震源・震度情報の順に届いた。
// public/data/test-telegrams/nii/）。DOMParser を使うので jsdom で動かす。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseEarthquakeFromXml } from '../src/services/dmdataParser'
import { mergeQuakeHistory } from '../src/utils/quakeMerge'
import type { JMAQuake } from '../src/types/earthquake'

const DIR = join(__dirname, '..', 'public', 'data', 'test-telegrams', 'nii')

/** アーカイブへ入れるときと同じ形（電文の id の後ろに NII の電文 ID を足す）で読む。 */
function archived(file: string, headType: string, niiId: string): JMAQuake {
  const quake = parseEarthquakeFromXml(headType, readFileSync(join(DIR, file), 'utf-8'))
  if (!quake) throw new Error(`読めませんでした: ${file}`)
  return { ...quake, id: `${quake.id}-${niiId}` }
}

const intensity = () => archived('20240101140549_0_VXSE51_010000.xml', 'VXSE51', 'nii-a')
const cancel = () => archived('20240101141346_0_VXSE51_010000.xml', 'VXSE51', 'nii-b')
const detail = () => archived('20240101141410_0_VXSE53_010000.xml', 'VXSE53', 'nii-c')

describe('アーカイブへ入れた取消電文', () => {
  it('前提: 取消は同じ EventID・同じ種別の報として読める', () => {
    const c = cancel()
    const q = intensity()
    expect(c.cancelled).toBe(true)
    expect(c.eventId).toBe(q.eventId)
    expect(c.issue.type).toBe(q.issue.type)
  })

  it('正: 取り消された報しか無いカードは、履歴から消える', () => {
    const { cards } = mergeQuakeHistory([intensity(), cancel()], [], [], null)
    expect(cards).toHaveLength(0)
  })

  it('対照: 取消の後に届いた別の種別の報は残り、取り下げた震度速報はそのカードに混ざらない', () => {
    // 取消が届いた時点ではカードに震度速報しか無いので、カードごと消える。後から届いた
    // 震源・震度情報は新しいカードとして立つ（取り下げた報を土台にしない）
    const { cards } = mergeQuakeHistory([intensity(), cancel(), detail()], [], [], null)
    expect(cards).toHaveLength(1)
    expect(cards[0].issue.type).toBe('震源・震度情報')
    expect((cards[0].sourceTelegrams ?? [cards[0]]).map((t) => t.issue.type)).not.toContain('震度速報')
  })

  it('安全弁: 取消が無ければ震度速報のカードは残る（取消を入れたことで別の報まで消していない）', () => {
    const { cards } = mergeQuakeHistory([intensity()], [], [], null)
    expect(cards).toHaveLength(1)
    expect(cards[0].issue.type).toBe('震度速報')
  })
})
