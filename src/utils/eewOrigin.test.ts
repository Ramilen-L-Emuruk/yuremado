import { afterEach, describe, expect, it, vi } from 'vitest'
import { withStoredEewOrigin } from './eewOrigin'

const eewPayload = (origin?: unknown) => ({ kind: 'event', event: { kind: 'eew', id: 'e1', ...(origin !== undefined && { origin }) } })

describe('withStoredEewOrigin', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('出どころの欄が無い保存データには補う（正）', () => {
    expect(withStoredEewOrigin(eewPayload(), 'archive').event).toMatchObject({ origin: 'archive' })
  })

  it('知っている値はそのまま残す（対照）', () => {
    const payload = eewPayload('dmdata')
    expect(withStoredEewOrigin(payload, 'archive')).toBe(payload)
  })

  it('知らない値は記録して置き換える（台帳が別の経路として数えないように）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(withStoredEewOrigin(eewPayload('DMDATA'), 'archive').event).toMatchObject({ origin: 'archive' })
    // 時計の未較正の警告も同じ口から出るので、出どころの行だけを数える
    expect(warn.mock.calls.filter(args => args.some(a => String(a).includes('出どころ（origin）')))).toHaveLength(1)
  })

  it('緊急地震速報でない積荷には触らない（安全弁）', () => {
    const payload = { kind: 'event', event: { kind: 'quake', origin: 'xx' } }
    expect(withStoredEewOrigin(payload, 'archive')).toBe(payload)
  })
})
