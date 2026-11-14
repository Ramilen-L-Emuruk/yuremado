import { describe, it, expect } from 'vitest'
import { DEFAULTS, sanitize, type AppSettings } from '../hooks/useSettings'
import { usageSettingValues } from '../services/usageStats'
import { INTENSITY_LABELS } from './intensity'
import { HEATMAP_PERIODS } from './quakeHeatmap'
import { SHARE_CARD_FORMATS } from './shareCard'
import {
  TIME_SIGNAL_CLOCKS, TIME_SIGNAL_INTERVALS, TIME_SIGNAL_ORDERS, TIME_SIGNAL_PHRASES, TIME_SIGNAL_SOUNDS, TIME_SIGNAL_WHILE_SPEAKING,
} from './timeSignal'
import { WAVE_SPAN_CHOICES } from './waveSpan'
import { LOCALE_SETTINGS } from '../i18n/messages'
import {
  USAGE_DEFAULT_HISTORY, USAGE_RETIRED_SETTINGS, USAGE_SETTING_COUNT, USAGE_SETTING_SPECS, usageDefaultAt, validUsageSettingValue,
} from './usageSettings'

const sorted = (xs: readonly (string | number)[]) => [...xs].map(String).sort()

describe('送る項目の決まりが、設定の読み込みと揃っている', () => {
  it('正: 既定値を記録の文字列にすると、決まりに書いた既定値と一致し、中継の検めも通る', () => {
    const values = usageSettingValues(DEFAULTS, DEFAULTS)
    expect(Object.keys(values).sort()).toEqual(Object.keys(USAGE_SETTING_SPECS).sort())
    for (const [name, spec] of Object.entries(USAGE_SETTING_SPECS)) {
      expect([name, values[name]]).toEqual([name, spec.default])
      expect([name, validUsageSettingValue(name, values[name])]).toEqual([name, values[name]])
    }
  })

  it('正: 選択肢の一覧が、設定の読み込みが受ける一覧と同じ', () => {
    const choices = (name: string) => {
      const rule = USAGE_SETTING_SPECS[name].rule
      if (rule.kind !== 'choice') throw new Error(`${name} は選択肢の項目ではない`)
      return sorted(rule.values)
    }
    // 震度の表は「すべて」の -1 も持つ
    const scales = sorted(Object.keys(INTENSITY_LABELS).map(Number))
    for (const name of ['notifyMinScale', 'ttsAlwaysReadScale', 'quakeListScaleMin', 'quakeListScaleMax', 'actionChecklistMinScale']) expect(choices(name)).toEqual(scales)
    expect(choices('timeSignalIntervalMin')).toEqual(sorted(TIME_SIGNAL_INTERVALS))
    expect(choices('timeSignalSound')).toEqual(sorted(TIME_SIGNAL_SOUNDS))
    expect(choices('timeSignalOrder')).toEqual(sorted(TIME_SIGNAL_ORDERS))
    expect(choices('timeSignalPhrase')).toEqual(sorted(TIME_SIGNAL_PHRASES))
    expect(choices('timeSignalClock')).toEqual(sorted(TIME_SIGNAL_CLOCKS))
    expect(choices('timeSignalWhileSpeaking')).toEqual(sorted(TIME_SIGNAL_WHILE_SPEAKING))
    expect(choices('heatmapPeriod')).toEqual(sorted(HEATMAP_PERIODS.map(p => p.key)))
    expect(choices('waveSpanSec')).toEqual(sorted(WAVE_SPAN_CHOICES))
    expect(choices('shareCardFormat')).toEqual(sorted(Object.keys(SHARE_CARD_FORMATS)))
    // 言語を足したら、ここ（中継へ写すので言語の表を import できない）にも足さないと落ちる
    expect(choices('locale')).toEqual(sorted(LOCALE_SETTINGS))
  })

  it('正: 選択肢の値はどれも設定の読み込みを素通りする（読み込みが落とす値を決まりに書いていない）', () => {
    for (const [name, spec] of Object.entries(USAGE_SETTING_SPECS)) {
      if (spec.rule.kind !== 'choice' || name.includes('.')) continue
      for (const v of spec.rule.values) {
        expect([name, sanitize({ [name]: v } as Partial<AppSettings>)[name as keyof AppSettings]]).toEqual([name, v])
      }
    }
  })

  it('正: 数の幅が、設定の読み込みが受ける幅と同じ（両端は素通りし、幅の外は幅の中へ丸めるか既定へ戻す）', () => {
    for (const [name, spec] of Object.entries(USAGE_SETTING_SPECS)) {
      const rule = spec.rule
      if (rule.kind !== 'number') continue
      const key = name as keyof AppSettings
      const read = (v: number) => sanitize({ [key]: v } as Partial<AppSettings>)[key] as number | null
      expect([name, read(rule.min), read(rule.max)]).toEqual([name, rule.min, rule.max])
      for (const outside of [rule.min - 1, rule.max + 1]) {
        const v = read(outside)
        expect([name, outside, v === null || (v >= rule.min && v <= rule.max)]).toEqual([name, outside, true])
      }
    }
  })

  it('安全弁: 中継が 1 回に書ける 250 件に、札の 1 件と合わせて収まる', () => {
    expect(USAGE_SETTING_COUNT + 1).toBeLessThanOrEqual(250)
  })
})

describe('中身を送らない項目', () => {
  const custom: AppSettings = {
    ...DEFAULTS,
    dmdataApiKey: 'secret-api-key', forecastKey: 'secret-forecast', arrivalToken: 'secret-arrival',
    voicevoxUrl: 'http://192.0.2.10:50021', seismoHostUrl: 'https://seismo.example.ts.net',
    homeLat: 35.123, homeLng: 139.456, notifyPrefectures: ['13', '14'],
  }
  const values = usageSettingValues(custom, DEFAULTS)

  it('正: 鍵・接続先・登録した地点は入れているかだけ、通知する地域は数だけになる', () => {
    expect([values.dmdataApiKey, values.forecastKey, values.arrivalToken, values.voicevoxUrl, values.seismoHostUrl]).toEqual(['1', '1', '1', '1', '1'])
    expect([values.homeLat, values.homeLng, values.notifyPrefectures]).toEqual(['1', '1', '2'])
  })

  it('正: どの値にも、入れた中身の文字列が出てこない', () => {
    const all = JSON.stringify(values)
    for (const s of ['secret', '192.0.2.10', 'example', '35.123', '139.456', '"13"', '"14"']) expect(all).not.toContain(s)
  })

  it('対照: 既定の VOICEVOX の接続先のままなら「入れていない」', () => {
    expect(usageSettingValues(DEFAULTS, DEFAULTS).voicevoxUrl).toBe('0')
  })
})

describe('validUsageSettingValue（中継の検め）', () => {
  it('正: 決まりに合う値はそのまま通す', () => {
    expect(validUsageSettingValue('soundVolume', '0.35')).toBe('0.35')
    expect(validUsageSettingValue('timeSignalVolume', 'null')).toBe('null')
    expect(validUsageSettingValue('timeSignalSound', 'chime')).toBe('chime')
    expect(validUsageSettingValue('ttsTelegramTextBlocks.quakeForecast', '0')).toBe('0')
    expect(validUsageSettingValue('notifyPrefectures', '47')).toBe('47')
  })

  it('安全弁: 知らない名前・形の違う値・幅の外・任意の文字列は落とす', () => {
    expect(validUsageSettingValue('__proto__', '1')).toBeNull()
    expect(validUsageSettingValue('toString', '1')).toBeNull()
    expect(validUsageSettingValue('dmdataApiKey', 'secret')).toBeNull()
    expect(validUsageSettingValue('soundVolume', '2')).toBeNull()
    expect(validUsageSettingValue('soundVolume', 'null')).toBeNull()
    expect(validUsageSettingValue('soundVolume', '0.12345')).toBeNull()
    expect(validUsageSettingValue('soundVolume', 0.5)).toBeNull()
    expect(validUsageSettingValue('timeSignalSound', 'beep')).toBeNull()
    expect(validUsageSettingValue('notifyPrefectures', '48')).toBeNull()
    expect(validUsageSettingValue('notifyEnabled', 'true')).toBeNull()
  })
})

describe('型で見られない選択肢と、本文の大きさ', () => {
  it('正: 必ず読む長周期の階級は、設定の読み込みが受ける値（-1〜4）と決まりが同じ', () => {
    const rule = USAGE_SETTING_SPECS.ttsAlwaysReadLpgmClass.rule
    if (rule.kind !== 'choice') throw new Error('選択肢の項目ではない')
    const accepted = [-3, -2, -1, 0, 1, 2, 3, 4, 5, 6].filter(v => sanitize({ ttsAlwaysReadLpgmClass: v }).ttsAlwaysReadLpgmClass === v)
    expect(sorted(rule.values)).toEqual(sorted(accepted))
  })
  it('安全弁: どの項目も最も長い値のとき、札の要求の本文は中継の上限（8 KB）を割る', () => {
    const longest = (name: string): string => {
      const rule = USAGE_SETTING_SPECS[name].rule
      switch (rule.kind) {
        case 'bool': case 'present': return '1'
        case 'count': return String(rule.max)
        case 'choice': return rule.values.map(String).reduce((a, b) => (b.length > a.length ? b : a))
        case 'number': return [String(rule.min), String(rule.max)].reduce((a, b) => (b.length > a.length ? b : a)) + '.123'
      }
    }
    const prefs = Object.fromEntries(Object.keys(USAGE_SETTING_SPECS).map(n => [n, longest(n)]))
    const body = JSON.stringify({ usage: {
      install: 'a'.repeat(32), version: '999.999.999', standalone: true, os: 'chromeos', browser: 'samsung', form: 'desktop', lang: 'abc-Abcd',
      settings: { apiKey: true, tts: true, sound: true, notify: true, seismo: true }, prefs,
    } })
    expect(new TextEncoder().encode(body).length).toBeLessThan(8192)
  })
})

describe('版ごとの既定と外した項目（#1619）', () => {
  // 正: 既定が変わる前の版の端末は、その版の既定で比べる
  it('既定が変わる前の版は前の既定', () => {
    expect(usageDefaultAt('notifyQuietWhileOpen', '6.15.0')).toBe('0')
    expect(usageDefaultAt('notifyQuietWhileOpen', '6.2.0')).toBe('0')
  })

  // 対照: 変わった後の版・既定の変わっていない項目・版の読めない端末は今の既定
  it('変わった後の版と、版の読めない端末は今の既定', () => {
    expect(usageDefaultAt('notifyQuietWhileOpen', '6.16.0')).toBe(USAGE_SETTING_SPECS.notifyQuietWhileOpen.default)
    expect(usageDefaultAt('notifyQuietWhileOpen', '')).toBe(USAGE_SETTING_SPECS.notifyQuietWhileOpen.default)
    expect(usageDefaultAt('notifyEnabled', '6.2.0')).toBe(USAGE_SETTING_SPECS.notifyEnabled.default)
    expect(usageDefaultAt('noSuchSetting', '6.2.0')).toBeUndefined()
  })

  // 安全弁: 表の項目は今の仕様にあり、前の既定も今の決まりに合う値。外した項目は今の仕様に無い
  it('表は今の仕様と食い違わない', () => {
    for (const [name, history] of Object.entries(USAGE_DEFAULT_HISTORY)) {
      expect(USAGE_SETTING_SPECS[name]).toBeDefined()
      for (const h of history) expect(validUsageSettingValue(name, h.value)).toBe(h.value)
    }
    for (const name of USAGE_RETIRED_SETTINGS) expect(USAGE_SETTING_SPECS[name]).toBeUndefined()
  })
})
