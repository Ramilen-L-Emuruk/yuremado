import { describe, expect, it } from 'vitest'
import { DETECTION_SETTINGS_DEFAULT, type DetectionSettings } from '../detection/detectionSettings'
import { DetectionControl } from './detectionControl'
import { EMPTY_HOST_SETTINGS, HostSettingsFile, type HostSettings } from './hostSettings'

const TUNED: DetectionSettings = {
  ...DETECTION_SETTINGS_DEFAULT,
  trigger: { ...DETECTION_SETTINGS_DEFAULT.trigger, onRatio: 3 },
}

function control(opts: { active?: DetectionSettings; writeFails?: boolean; initial?: HostSettings; discardedPending?: string } = {}) {
  const written: HostSettings[] = []
  const file = new HostSettingsFile('host-settings.json', opts.initial ?? EMPTY_HOST_SETTINGS, (_p, s) => {
    if (opts.writeFails === true) throw new Error('EACCES')
    written.push(s)
  })
  return { c: new DetectionControl({ active: opts.active ?? DETECTION_SETTINGS_DEFAULT, settingsFile: file, discardedPending: opts.discardedPending ?? null }), written, file }
}

describe('DetectionControl', () => {
  it('正: 起動時に捨てた待ちの値の理由を返し、保存しても次の起動まで出し続ける', () => {
    const { c } = control({ discardedPending: 'onRatio=not-above-one' })
    expect(c.get().discardedPending).toBe('onRatio=not-above-one')
    expect(c.setPending(TUNED)).toEqual({ ok: true })
    expect(c.get().discardedPending).toBe('onRatio=not-above-one')
  })

  it('正: 受け付けたら次の起動で使う値として書く（いまの値は変えない）', () => {
    const { c, written } = control()
    expect(c.setPending(TUNED)).toEqual({ ok: true })
    expect(written).toEqual([{ ...EMPTY_HOST_SETTINGS, pendingDetection: TUNED }])
    expect(c.get()).toEqual({ active: DETECTION_SETTINGS_DEFAULT, pending: TUNED, defaults: DETECTION_SETTINGS_DEFAULT, discardedPending: null })
  })

  it('正: いまと同じ値・null は、待っている変更を取り消す', () => {
    const { c } = control({ initial: { ...EMPTY_HOST_SETTINGS, pendingDetection: TUNED } })
    expect(c.setPending(DETECTION_SETTINGS_DEFAULT)).toEqual({ ok: true })
    expect(c.get().pending).toBeNull()
    expect(c.setPending(TUNED)).toEqual({ ok: true })
    expect(c.setPending(null)).toEqual({ ok: true })
    expect(c.get().pending).toBeNull()
  })

  it('正: 値が受け付けられなければ、項目ごとの断りを返して何も書かない', () => {
    const { c, written } = control()
    const bad = { ...TUNED, trigger: { ...TUNED.trigger, staSec: 90, offRatio: 4 } }
    expect(c.setPending(bad)).toEqual({
      ok: false,
      problem: 'invalid-values',
      problems: [
        { field: 'staSec', problem: 'sta-not-below-lta' },
        { field: 'offRatio', problem: 'off-not-below-on' },
      ],
    })
    expect(written).toEqual([])
  })

  it('対照: 形が違う本文は値の断りではなく形の誤りとして返す', () => {
    const { c } = control()
    expect(c.setPending({ trigger: {} })).toEqual({ ok: false, problem: 'invalid-body' })
    expect(c.setPending('x')).toEqual({ ok: false, problem: 'invalid-body' })
  })

  it('安全弁: 設定ファイルを書けなければ断り、待っている変更も変えない', () => {
    const { c } = control({ writeFails: true })
    expect(c.setPending(TUNED)).toEqual({ ok: false, problem: 'not-writable', detail: 'EACCES' })
    expect(c.get().pending).toBeNull()
  })

  it('安全弁: 保存先の係と同じ書き手を使えば、検出の値を書いても保存先の待ちを消さない', () => {
    const { c, file } = control({ initial: { ...EMPTY_HOST_SETTINGS, pendingDataRoot: 'D:\\seismo', pendingFrom: 'C:\\old' } })
    c.setPending(TUNED)
    expect(file.get()).toEqual({ ...EMPTY_HOST_SETTINGS, pendingDataRoot: 'D:\\seismo', pendingFrom: 'C:\\old', pendingDetection: TUNED })
  })
})
