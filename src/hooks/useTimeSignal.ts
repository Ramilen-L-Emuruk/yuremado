// 時報を鳴らす。境の時刻・文・音と声の位置は `utils/timeSignal.ts` が決め、ここは時計を見て予約するだけ。
//
// **合図（ポーン・チャイムの頭）は AudioContext の時刻へ先に予約する。** タイマーの発火で鳴らすと、
// タブが裏に回ったときの間引き（1 秒〜1 分）の分だけずれる。境の {@link TIME_SIGNAL_PREPARE_MS} 前に支度して
// 音を予約する。支度の窓を間引きの周期（1 分）より長く取るので、裏のタブでも境を飛び越えにくい。
// 声だけはタイマーで始める（読み上げの入口が「今すぐ鳴らす」形のため）ので、遅れて起きたら読まない
// （{@link TIME_SIGNAL_LATE_SPEECH_MS}）。
//
// **他の読み上げを切らない。** 読み上げに待ち行列は無く、呼べば鳴っているものを止める（`voicevox.ts` の
// `speakOnce`）。声を出す前・先に合成する前に、読み上げの最中か・読み上げが控えているかを見て、
// そうなら声を省く（音は設定で「音だけ鳴らす」なら鳴らす）。逆に、時報の声の最中に届いた電文の
// 読み上げは時報の声を止める —— それで正しい（2026-11-04 ユーザー選択）。

import { useEffect, useRef } from 'react'
import { createLogThrottle, log } from '../utils/logger'
import { serverNow } from '../utils/clock'
import { getAudioContext, isAlertSpeechPending, scheduleTimeSignalSound, type TimeSignalSoundHandle } from '../utils/alertSound'
import {
  isSpeaking, measureSystemSpeechSec, prewarmVoicevox, routesToSystemVoice, speakWithVoicevoxUncounted,
  type ChunkScheduledListener, type PrewarmedSpeech,
} from '../utils/voicevox'
import { isSystemSpeechSupported } from '../utils/systemSpeech'
import { hasPendingSpeech } from '../utils/pendingSpeech'
import { nextSpeechId, recordReplayEvent, truncateReplayText } from '../utils/replayEventLog'
import {
  TIME_SIGNAL_LATE_SPEECH_MS, TIME_SIGNAL_MAX_SPEECH_SEC, TIME_SIGNAL_PREPARE_MS, TIME_SIGNAL_RESYNC_TOLERANCE_MS,
  TIME_SIGNAL_SOUND_SHAPE,
  isInQuietHours, nextSignalAt, speechStartOffsetSec, timeSignalSpeechText,
} from '../utils/timeSignal'
import type { AppSettings } from './useSettings'

/** 時報が読む設定。`useTimeSignal` へは設定の丸ごとを渡す（読むのはこれだけ）。 */
type TimeSignalSettings = Pick<AppSettings,
  | 'timeSignalEnabled' | 'timeSignalIntervalMin' | 'timeSignalSound' | 'timeSignalOrder' | 'timeSignalPhrase'
  | 'timeSignalClock' | 'timeSignalQuietEnabled' | 'timeSignalQuietStartMin' | 'timeSignalQuietEndMin'
  | 'timeSignalWhileSpeaking' | 'timeSignalVolume' | 'timeSignalSpeakerId'
  | 'soundVolume' | 'ttsEnabled' | 'ttsVoice' | 'voicevoxSpeakerId'>

/** 時計を見る間隔（ms）。境の支度はこの刻みで始まるので、{@link TIME_SIGNAL_PREPARE_MS} より十分短く取る */
const TICK_MS = 1000

/** 境を過ぎてから支度を捨てるまで（ms）。声と音の余韻が終わるのを待つ */
const PLAN_RETAIN_AFTER_MS = 15_000

/** 声を出す何 ms 前に先に合成するか。合成は 150〜350 ms で済むので、余裕を見て数秒前に投げる */
const PREWARM_LEAD_MS = 6_000

/**
 * 端末の声で「声が先」にするとき、境の何 ms 前に声の長さを測るか（2026-11-08 ユーザー選択「鳴らす少し前にその回の文だけ (Recommended)」）。
 * 端末の声には合成の口が無いので、音量 0 で 2 回読んで測る（`voicevox.ts` の `measureSystemSpeechSec`）。
 * 測る数秒と、測った後に声を始めるまでの余裕を見て 1 分前に置く（支度は {@link TIME_SIGNAL_PREPARE_MS} 前に済んでいる）。
 */
const SYSTEM_MEASURE_LEAD_MS = 60_000

/**
 * 同じ境で予約を取り直す上限。時計の揺れが許容を超え続ける環境で、取り直しのたびに合成を頼み直し続けないため。
 * 超えたら、その境は今の予約のまま鳴らす。
 */
const MAX_RESYNC_PER_SIGNAL = 3

/** 時計の確認がこれより長く止まっていたら、タイマーが間引かれたとみなす（ms）。1 秒刻みの揺れでは届かない */
const MISSED_TICK_GAP_MS = 5_000

/** 鳴らせなかったことの警告を間引く間隔（ms）。境ごとに出るとログが埋まる */
const WARN_INTERVAL_MS = 30 * 60_000

/** 1 回分の支度。境ごとに作り、鳴り終わるか取り消すと捨てる */
interface Plan {
  /** 境の時刻（`serverNow()` の時刻） */
  at: number
  /** 支度したときに読んだ設定。変わったら支度をやり直す */
  key: string
  /** 合図を置いた AudioContext の時刻 */
  mark: number
  sound: TimeSignalSoundHandle | null
  prewarm: PrewarmedSpeech | null
  timers: ReturnType<typeof setTimeout>[]
  cancelled: boolean
  /** この境で予約を取り直した回数 */
  resyncs: number
}

/** 他の読み上げの最中か、読み上げが控えているか */
function otherSpeechBusy(): boolean {
  const speaking = isSpeaking()
  return speaking || hasPendingSpeech(speaking, performance.now()) || isAlertSpeechPending()
}

/**
 * 録画ツール向けの記録（→ `docs/spec/recording-interface-spec.md`）。時報の音と声も載せる
 * （2026-11-04 ユーザー選択「記録に載せる」）。電文のものではないので持ち主（`telegram`）は空、声の主題は `timeSignal`。
 * **投げない**（記録の失敗で時報を止めない。`useLiveEventHandler` の記録の関数と同じ扱い）。
 */
const TIME_SIGNAL_REPLAY_TOPIC = 'timeSignal'

function recordTimeSignalSound(): void {
  try {
    recordReplayEvent({ type: 'sound', sound: TIME_SIGNAL_REPLAY_TOPIC, telegram: null })
  } catch (err) {
    log.warn('[timeSignal] 時報の音を記録できなかった（時報は続行）', err)
  }
}

/** 声 1 本の始まりを記録し、終わりを記録する関数とチャンクの予約を記録する関数を返す */
function recordTimeSignalSpeech(text: string): { chunk: ChunkScheduledListener; end: (spoke: boolean) => void } {
  const speechId = nextSpeechId()
  const startedAt = Date.now()
  try {
    const [t, textLength, textTruncated] = truncateReplayText(text)
    recordReplayEvent({
      type: 'speechStart', speechId, channel: 'other', topic: TIME_SIGNAL_REPLAY_TOPIC, eewKey: null, subject: null,
      telegram: null, text: t, textLength, textTruncated,
    })
  } catch (err) {
    log.warn('[timeSignal] 時報の声の始まりを記録できなかった（時報は続行）', err)
  }
  return {
    chunk: (index, startAt, chunks) => {
      try {
        const [t] = truncateReplayText(chunks[index] ?? '')
        recordReplayEvent({ type: 'speechChunk', speechId, index, chunkCount: chunks.length, text: t, startAt })
      } catch (err) {
        log.warn('[timeSignal] 時報の声のチャンクを記録できなかった（時報は続行）', err)
      }
    },
    end: spoke => {
      try {
        recordReplayEvent({ type: 'speechEnd', speechId, spoke, durationMs: Date.now() - startedAt })
      } catch (err) {
        log.warn('[timeSignal] 時報の声の終わりを記録できなかった（時報は続行）', err)
      }
    },
  }
}

/**
 * `serverNow()` の時刻 `atMs` に当たる AudioContext の時刻（秒）。
 *
 * 出力の時刻の対応（`getOutputTimestamp`）が取れれば、それで「耳に届く時刻」に合わせる。取れなければ
 * `currentTime` から差を足す（出力の遅れのぶん遅れて聞こえる）。
 */
function audioTimeFor(ctx: AudioContext, atMs: number): number {
  const now = serverNow()
  const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null
  if (ts && typeof ts.contextTime === 'number' && typeof ts.performanceTime === 'number' && ts.performanceTime > 0) {
    const perfAt = performance.now() + (atMs - now)
    return ts.contextTime + (perfAt - ts.performanceTime) / 1000
  }
  return ctx.currentTime + (atMs - now) / 1000
}

function settingsKey(s: TimeSignalSettings, voicevoxUrl: string): string {
  return JSON.stringify([
    s.timeSignalIntervalMin, s.timeSignalQuietEnabled, s.timeSignalQuietStartMin, s.timeSignalQuietEndMin,
    s.timeSignalSound, s.timeSignalOrder, s.timeSignalPhrase, s.timeSignalClock, s.timeSignalWhileSpeaking,
    s.timeSignalVolume, s.timeSignalSpeakerId, s.soundVolume, s.ttsEnabled, s.ttsVoice, s.voicevoxSpeakerId, voicevoxUrl,
  ])
}

const fmt = (ms: number) => new Date(ms).toLocaleTimeString()

function cancelPlan(plan: Plan, reason: string | null): void {
  if (plan.cancelled) return
  plan.cancelled = true
  for (const t of plan.timers) clearTimeout(t)
  plan.sound?.cancel()
  plan.prewarm?.abort()
  if (reason !== null) log.debug(`[timeSignal] ${fmt(plan.at)} の支度を取り消した（${reason}）`)
}

/**
 * 時報を鳴らす。
 *
 * @param voicevoxUrl 読み上げの接続先。入力が落ち着くのを待った値を渡す（`App.tsx` の `debouncedVoicevoxUrl`。
 *   打っている途中の URL へ先行合成を投げないため）
 */
export function useTimeSignal(settings: TimeSignalSettings, voicevoxUrl: string): void {
  const latest = useRef({ settings, voicevoxUrl })
  latest.current = { settings, voicevoxUrl }

  useEffect(() => {
    if (!settings.timeSignalEnabled) return
    let plan: Plan | null = null
    /** 支度を終えた（鳴らした・飛ばした）境。同じ境を二度支度しない */
    let doneAt: number | null = null
    /** 前に時計を見た時刻。境を飛び越えて起きたかを見る */
    let lastTickAt: number | null = null
    /** 前に時計を見たときの performance.now()。時計の確認が実際に止まっていたかを測る */
    let lastTickPerf: number | null = null
    /** 音声出力が止まっていて飛ばしている最中か（続く間は警告を 1 回だけ出す） */
    let suspendedStreak = false
    /** 音も声も出ない組み合わせを警告した設定（同じ設定では繰り返さない） */
    let silentConfigWarnedKey: string | null = null
    const warnMissed = createLogThrottle(WARN_INTERVAL_MS)
    const warnPrewarm = createLogThrottle(WARN_INTERVAL_MS)

    const prepare = (at: number): void => {
      const { settings: s, voicevoxUrl: url } = latest.current
      doneAt = at
      if (s.timeSignalQuietEnabled && isInQuietHours(at, s.timeSignalQuietStartMin, s.timeSignalQuietEndMin)) {
        log.debug(`[timeSignal] ${fmt(at)} は鳴らさない時間帯のため飛ばす`)
        return
      }
      // 端末の声で読むか（声が「システムの読み上げ」・VOICEVOX の接続先が正しくない・繋がらなかった直後）。読み上げの入口が同じ判定で声を選ぶ
      const systemVoice = routesToSystemVoice(url)
      const wantSpeech = s.ttsEnabled && (!systemVoice || isSystemSpeechSupported())
      if (s.timeSignalSound === 'none' && !wantSpeech) {
        const key = settingsKey(s, url)
        if (silentConfigWarnedKey !== key) {
          silentConfigWarnedKey = key
          log.warn('[timeSignal] 音を「鳴らさない」にしていて、読み上げも使えない（読み上げが切か、端末の声が使えない）ため、時報は何も鳴らない')
        }
        return
      }
      const ctx = getAudioContext()
      if (!ctx || ctx.state !== 'running') {
        // 画面を一度も操作していない（自動再生の制限）・端末の割り込みで止まった。再開は試すが、効くのは
        // 操作のあとだけなので、この回は飛ばす。続いている間は 1 回だけ警告する
        if (ctx?.state === 'suspended') ctx.resume().catch(() => { /* 操作の前は再開できない */ })
        if (!suspendedStreak) {
          suspendedStreak = true
          log.warn(`[timeSignal] 音声出力がまだ使えないため時報を飛ばす（state=${ctx?.state ?? 'なし'}）。画面を一度操作すると鳴るようになる`)
        } else {
          log.debug(`[timeSignal] ${fmt(at)} を飛ばす（音声出力がまだ使えない state=${ctx?.state ?? 'なし'}）`)
        }
        return
      }
      if (suspendedStreak) {
        suspendedStreak = false
        log.info('[timeSignal] 音声出力が使えるようになったので、時報を鳴らす')
      }
      const mark = audioTimeFor(ctx, at)
      const sound = s.timeSignalSound === 'none' ? null : scheduleTimeSignalSound(s.timeSignalSound, mark, s.timeSignalVolume)
      if (s.timeSignalSound !== 'none' && sound === null) {
        log.debug(`[timeSignal] ${fmt(at)} を飛ばす（音を予約できなかった）`)
        return
      }
      const text = timeSignalSpeechText(at, s.timeSignalClock, s.timeSignalPhrase)
      const speakerId = s.timeSignalSpeakerId ?? s.voicevoxSpeakerId
      const volume = s.timeSignalVolume ?? s.soundVolume
      const skipWhenBusy = s.timeSignalWhileSpeaking === 'skip'
      const p: Plan = { at, key: settingsKey(s, url), mark, sound, prewarm: null, timers: [], cancelled: false, resyncs: 0 }
      plan = p
      log.debug(`[timeSignal] ${fmt(at)} の支度をした（音=${s.timeSignalSound} 順番=${s.timeSignalOrder} 声=${wantSpeech ? text : 'なし'}）`)

      const after = (atMs: number, run: () => void): void => {
        p.timers.push(setTimeout(() => { if (!p.cancelled) run() }, Math.max(0, atMs - serverNow())))
      }
      /** 他の読み上げの最中なら、「鳴らさない」ではこの回ごと取り消す。省いたら真 */
      const yieldIfBusy = (what: string): boolean => {
        if (!otherSpeechBusy()) return false
        if (skipWhenBusy) cancelPlan(p, '他の読み上げの最中')
        else log.debug(`[timeSignal] ${what}を省く（他の読み上げの最中）`)
        return true
      }

      // 音の鳴り始めの少し前に、他の読み上げの最中かを見る（「鳴らさない」なら音ごと取り消す）
      const soundStartMs = at - TIME_SIGNAL_SOUND_SHAPE[s.timeSignalSound].leadSec * 1000
      if (sound !== null && skipWhenBusy) after(soundStartMs - 300, () => { yieldIfBusy('音') })
      // 音は予約済みなので、鳴り始めの時刻に記録だけする（取り消した回は記録しない）
      if (sound !== null) after(soundStartMs, recordTimeSignalSound)

      if (!wantSpeech) return
      const speakAt = (startMs: number): void => {
        after(startMs, () => {
          const late = serverNow() - startMs
          if (late > TIME_SIGNAL_LATE_SPEECH_MS) {
            log.debug(`[timeSignal] 声を出さない（${Math.round(late)}ms 遅れて起きた）`)
            return
          }
          if (yieldIfBusy('声')) return
          const rec = recordTimeSignalSpeech(text)
          void speakWithVoicevoxUncounted(url, text, speakerId, volume, undefined, p.prewarm, rec.chunk).then(
            outcome => {
              rec.end(outcome.spoke)
              if (!outcome.spoke) log.debug('[timeSignal] 声が鳴らなかった（割り込まれたか、合成できなかった）')
            },
            err => {
              rec.end(false)
              log.warn('[timeSignal] 声を出せなかった', err)
            },
          )
        })
      }
      /** 先に合成する。他の読み上げの最中・控えているときは投げない（電文の合成の前に割り込まないため） */
      const prewarm = (): PrewarmedSpeech | null => {
        if (otherSpeechBusy()) return null
        p.prewarm = prewarmVoicevox(url, text, speakerId)
        return p.prewarm
      }

      if (s.timeSignalOrder === 'soundFirst') {
        const startMs = at + speechStartOffsetSec(s.timeSignalSound, 'soundFirst', 0) * 1000
        after(startMs - PREWARM_LEAD_MS, () => { prewarm() })
        speakAt(startMs)
        return
      }
      const order = s.timeSignalOrder
      const soundKind = s.timeSignalSound
      if (systemVoice) {
        // 端末の声で読みが先: 1 分前に音量 0 で読んで長さを測り、長さから始める時刻を逆算する。測れなかった（他の読み上げが
        // 割り込んだ・端末の声が黙った）ら、この回は音が先にする（2026-11-08 ユーザー選択）
        after(at - SYSTEM_MEASURE_LEAD_MS, () => {
          const soundFirstMs = at + speechStartOffsetSec(soundKind, 'soundFirst', 0) * 1000
          if (otherSpeechBusy()) {
            log.debug('[timeSignal] 他の読み上げの最中なので声の長さを測らず、この回は音を先に鳴らす')
            speakAt(soundFirstMs)
            return
          }
          void measureSystemSpeechSec(text).then(sec => {
            if (p.cancelled) return
            if (sec === null) {
              log.debug('[timeSignal] 声の長さを測れなかったので、この回は音を先に鳴らす')
              speakAt(soundFirstMs)
              return
            }
            const startMs = at + speechStartOffsetSec(soundKind, order, sec) * 1000
            if (startMs < serverNow()) {
              log.debug('[timeSignal] 測るのが間に合わず、音の前に読み終われないので、この回は音を先に鳴らす')
              speakAt(soundFirstMs)
              return
            }
            speakAt(startMs)
          }, err => {
            if (p.cancelled) return
            log.warn('[timeSignal] 声の長さを測れなかった（この回は音を先に鳴らす）', err)
            speakAt(soundFirstMs)
          })
        })
        return
      }
      // 読み上げが先: 声の長さが要るので、いちばん長い声でも間に合う時刻に合成し、長さから始める時刻を逆算する
      const latestStartMs = at + speechStartOffsetSec(soundKind, order, TIME_SIGNAL_MAX_SPEECH_SEC) * 1000
      after(latestStartMs - PREWARM_LEAD_MS, () => {
        const w = prewarm()
        if (w === null) {
          if (yieldIfBusy('声')) return
          // 支度の後に VOICEVOX が繋がらなくなった（読み上げは端末の声へ落ちる）。長さが分からないので、この回は音が先にする
          if (routesToSystemVoice(latest.current.voicevoxUrl)) {
            log.debug('[timeSignal] VOICEVOX に繋がらなくなったので、この回は音を先に鳴らす')
            speakAt(at + speechStartOffsetSec(soundKind, 'soundFirst', 0) * 1000)
            return
          }
          log.debug('[timeSignal] 声を出さない（音声出力を先に用意できなかった）')
          return
        }
        void w.first.then(buffer => {
          if (p.cancelled) return
          if (buffer === null) {
            // 他の読み上げが始まって打ち切られたのでなければ、VOICEVOX が答えていない
            if (!otherSpeechBusy()) warnPrewarm(() => log.warn('[timeSignal] 時報の声を先に合成できなかった（VOICEVOX が答えていない）'))
            return
          }
          const startMs = at + speechStartOffsetSec(soundKind, order, buffer.duration) * 1000
          if (startMs < serverNow()) {
            log.debug('[timeSignal] 声を出さない（合成が間に合わず、音の前に読み終われない）')
            return
          }
          speakAt(startMs)
        }, () => { /* 合成の失敗は prewarmVoicevox 側が記録する */ })
      })
    }

    const tick = (): void => {
      const now = serverNow()
      const { settings: s, voicevoxUrl: url } = latest.current
      // 前の確認から今までに、支度しないまま境を過ぎていないか（裏のタブでタイマーが間引かれた）。
      // **止まっていたかは実際の経過（performance.now）で見る。** 時計の値で見ると、リプレイの停止や較正の
      // 切り替えで時計が跳んだだけのときにも「止まっていた」と誤って警告する
      const perfNow = performance.now()
      if (lastTickAt !== null && lastTickPerf !== null && now > lastTickAt && perfNow - lastTickPerf > MISSED_TICK_GAP_MS) {
        const missed = nextSignalAt(lastTickAt, s.timeSignalIntervalMin)
        if (missed <= now && missed !== doneAt && (plan === null || plan.at !== missed)
          && !(s.timeSignalQuietEnabled && isInQuietHours(missed, s.timeSignalQuietStartMin, s.timeSignalQuietEndMin))) {
          warnMissed(() => log.warn(`[timeSignal] ${fmt(missed)} の時報を鳴らせなかった（時計の確認が ${Math.round((perfNow - lastTickPerf!) / 1000)} 秒止まっていた。タブが裏に回っていた可能性）`))
        }
      }
      lastTickAt = now
      lastTickPerf = perfNow

      if (plan !== null) {
        const p: Plan = plan
        if (now > p.at + PLAN_RETAIN_AFTER_MS) {
          cancelPlan(p, null)
          plan = null
        } else if (!p.cancelled) {
          // 時計が動いた（リプレイの頭出し・停止・較正のし直し）・設定が変わったら、予約を取り消す。境の前なら取り直す
          const ctx = getAudioContext()
          const drifted = ctx !== null && Math.abs(audioTimeFor(ctx, p.at) - p.mark) * 1000 > TIME_SIGNAL_RESYNC_TOLERANCE_MS
          const changed = p.key !== settingsKey(s, url)
          if (drifted && !changed && p.resyncs >= MAX_RESYNC_PER_SIGNAL) {
            // 揺れ続ける環境。取り直しを打ち切り、今の予約のまま鳴らす（警告は境ごとに 1 回）
            if (p.resyncs === MAX_RESYNC_PER_SIGNAL) {
              p.resyncs++
              log.warn(`[timeSignal] 時計の対応が揺れ続けるため、${fmt(p.at)} は今の予約のまま鳴らす`)
            }
          } else if (drifted || changed) {
            cancelPlan(p, drifted ? '時計が動いた' : '設定が変わった')
            plan = null
            if (now < p.at) {
              doneAt = null
              const at = nextSignalAt(now, s.timeSignalIntervalMin)
              if (at - now <= TIME_SIGNAL_PREPARE_MS) {
                prepare(at)
                // 同じ境の取り直しなら回数を引き継ぐ
                const next = plan as Plan | null
                if (next !== null && next.at === p.at && !changed) next.resyncs = p.resyncs + 1
              }
            }
            return
          }
        }
      }
      if (plan !== null) return
      const at = nextSignalAt(now, s.timeSignalIntervalMin)
      if (at === doneAt || at - now > TIME_SIGNAL_PREPARE_MS) return
      prepare(at)
    }

    tick()
    const id = setInterval(tick, TICK_MS)
    return () => {
      clearInterval(id)
      if (plan !== null) cancelPlan(plan, '時報を切った')
    }
  }, [settings.timeSignalEnabled])
}

