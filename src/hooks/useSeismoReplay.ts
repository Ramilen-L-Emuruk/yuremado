// 再生中（テスト時刻設定）に、自作地震計の帯と下端の波形を**再生時刻のぶん**ホストから読み返して出す層。
//
// **ライブの押し出し（`useSeismoStation`）は使えない。** ホストが押し出すのは「いまの震度」だけなので、繋いだままだと
// 画面の他が過去なのにここだけ現在になる（以前はそのため再生中は繋がず、帯も波形も出していなかった）。
// ホストには過去の分を返す口がある —— 震度の推移（`GET /quake-intensity` の `realtimeSeries`。1 回 10 分まで）と、
// 合成波形のサンプル（`GET /waves`。1 回 2 分まで）。それを再生時刻に合わせて先回りして読み、
// ライブと同じ形（`SeismoStations`）で返す（2026-10-22 選択「当時のデータで出す (Recommended)」）。
//
// **記録の無い時刻は出さない**（同じ選択の説明）。震度は再生時刻の手前 {@link READING_STALE_MS} 以内に値があるときだけ
// 帯に並べ、波形は読み返せた分だけ描く。
//
// **取れなかったら間隔を広げつつ上限つきで取り直す**（`utils/retrySchedule.ts`）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchSeismoStatus, isValidSeismoHostUrl, type SeismoStationInfo, type SeismoWaveWant } from '../services/seismoStream'
import { fetchSeismoQuakeIntensity, QUAKE_INTENSITY_RANGE_MAX_MS, type RealtimeIntensityPoint } from '../services/seismoQuakeIntensity'
import { fetchSeismoWaveSamples, SAMPLES_RANGE_MAX_MS } from '../services/seismoWaveSamples'
import { serverNow } from '../utils/clock'
import { createLogThrottle, log } from '../utils/logger'
import { retryDelayAfter } from '../utils/retrySchedule'
import { SeismoWaveBuffer, type SeismoWaveWindow } from '../utils/seismoWaveBuffer'
import { READING_STALE_MS, sameStates, WAVE_RETAIN_SEC, type SeismoStations, type SeismoStationState } from './useSeismoStation'

/** 姿を作り直す間隔（ms）。ライブの作り直し（0.5 秒）より粗くてよい —— 震度の推移は 1 秒刻み。 */
const TICK_MS = 1000

/** 震度・波形を、再生時刻よりこれだけ先まで読んでおく（ms）。読み返しの往復で帯や絵が途切れないため。 */
const AHEAD_MS = 60_000

/** これより新しい本当の時刻は、まだ控えへ入りきっていないとみなして読まない（ms）。地震カードの伸ばす係と同じ。 */
const ARCHIVE_LAG_MS = 10_000

/** 再生時刻がこれより大きく飛んだら（送り・巻き戻し）、読んだ分を捨てて読み直す（ms）。 */
const JUMP_MS = 30_000

/**
 * 1 回の読み返しで進める長さの下限（ms）。**再生時刻が本当の時刻に近いと、控えに入りきった分しか読めず 1 秒ずつしか進まない** ——
 * そのたびに訊くと、観測点ごとに毎秒ホストを叩く。10 秒ぶん溜まってから訊く。
 */
const MIN_STEP_MS = 10_000

/** 観測点の一覧を見直す間隔（ms）。ライブの台帳と同じ 60 秒（ホストに観測点が増えたら拾う）。 */
const STATIONS_REFRESH_MS = 60_000

/**
 * 波形の入れ物の長さ（秒）。**表示に要る長さ（`WAVE_RETAIN_SEC`）に、先回りして読む分を足す** —— 入れ物は新しい側から決まった長さ
 * しか残さないので、足さないと、再生時刻より先の分が過去側を押し出して左が空く。
 */
const REPLAY_WAVE_RETAIN_SEC = WAVE_RETAIN_SEC + (AHEAD_MS + SAMPLES_RANGE_MAX_MS) / 1000

/** 空のときの参照を固定する。 */
const EMPTY: readonly SeismoStationState[] = []
const EMPTY_TALLY = { gapSamples: 0, restarts: 0, droppedSamples: 0 }

/** 1 観測点ぶんの読み返した分。 */
interface StationReplay {
  info: SeismoStationInfo
  /** 震度の推移（時刻順）。 */
  series: RealtimeIntensityPoint[]
  /** 震度を読み終えた範囲の終わり（データの時刻）。**まだ読んでいなければ `null`。** */
  seriesTo: number | null
  /** 読んだ区間の「普段」の計測震度（最後に読めた値）。 */
  usualMeasured: number | null
  wave: SeismoWaveBuffer
  /** 波形を読み終えた範囲の終わり（データの時刻）。 */
  waveTo: number | null
  /** 取り直しの待ち（単調時計）と、続けて失敗した回数。種類ごと。 */
  retry: { series: { failures: number; at: number } | null; wave: { failures: number; at: number } | null }
  /** 諦めた種類（再生時刻が飛んで読み直すまで、もう訊かない）。 */
  gaveUp: { series: boolean; wave: boolean }
}

function freshStation(info: SeismoStationInfo): StationReplay {
  return {
    info,
    series: [],
    seriesTo: null,
    usualMeasured: null,
    wave: new SeismoWaveBuffer(REPLAY_WAVE_RETAIN_SEC),
    waveTo: null,
    retry: { series: null, wave: null },
    gaveUp: { series: false, wave: false },
  }
}

/** 再生時刻の手前 {@link READING_STALE_MS} 以内でいちばん新しい値。**無ければ `null`**（記録の無い時刻は出さない）。 */
export function replayIntensityAt(series: readonly RealtimeIntensityPoint[], nowMs: number): RealtimeIntensityPoint | null {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const p = series[i]
    if (p.atMs > nowMs) continue
    if (nowMs - p.atMs >= READING_STALE_MS) return null
    return p.value === null ? null : p
  }
  return null
}

/** 窓を再生時刻で切る（先回りして読んだ分を、まだ来ていない時刻として描かない）。 */
export function cutWindowAt(win: SeismoWaveWindow, nowMs: number): SeismoWaveWindow | null {
  const n = Math.floor((nowMs - win.firstSampleMs) / win.msPerSample) + 1
  if (n <= 0) return null
  if (n >= win.gal[0].length) return win
  return {
    ...win,
    gal: [win.gal[0].subarray(0, n), win.gal[1].subarray(0, n), win.gal[2].subarray(0, n)],
    memberCount: win.memberCount.subarray(0, n),
  }
}

export function useSeismoReplay(options: {
  /** 自作地震計が有効か（設定）。 */
  readonly enabled: boolean
  readonly baseUrl: string
  /** 再生の時刻オフセット。**`null`（ライブ）なら何もしない**（ライブは `useSeismoStation` の担当）。 */
  readonly replayOffsetMs: number | null
  /** 波形も読むか（設定「波形グラフ」が「表示しない」なら `'none'`）。 */
  readonly wave: SeismoWaveWant
}): SeismoStations {
  const { enabled, baseUrl, replayOffsetMs, wave } = options
  const active = enabled && replayOffsetMs !== null && isValidSeismoHostUrl(baseUrl)
  const [stations, setStations] = useState<readonly SeismoStationState[]>(EMPTY)
  const bookRef = useRef(new Map<string, StationReplay>())
  const waveWanted = wave !== 'none'

  const readLiveWave = useCallback((stationId: string, fromMs: number | null): SeismoWaveWindow | null => {
    const snap = bookRef.current.get(stationId)?.wave.snapshot(fromMs) ?? null
    return snap === null ? null : cutWindowAt(snap, serverNow())
  }, [])
  // **地震カードには何も渡さない。** カードは再生中も自分で読み返す（`useSeismoQuakeWaves`）し、押し出しの継ぎ足しは
  // 再生中は止まる。ここで再生の窓を渡すと、カードが同じ区間を 2 か所から継ぐ。
  const readWave = useCallback((): SeismoWaveWindow | null => null, [])
  const subscribeWaveRevised = useCallback(() => () => {}, [])

  useEffect(() => {
    bookRef.current = new Map()
    setStations(EMPTY)
    if (!active) return
    const ctrl = new AbortController()
    const book = bookRef.current
    let stationsReady = false
    let statusRetry: { failures: number; at: number } | null = null
    let statusBusy = false
    const busy = new Set<string>()
    let lastNow = Number.NaN
    let lastReal = Number.NaN
    /** 観測点の一覧を最後に読めた時刻（単調時計）。 */
    let stationsAt = Number.NEGATIVE_INFINITY
    const throttledError = createLogThrottle(300_000)

    const loadStations = async (): Promise<void> => {
      if (statusBusy || (statusRetry !== null && statusRetry.at > performance.now())) return
      statusBusy = true
      let status: Awaited<ReturnType<typeof fetchSeismoStatus>>
      try {
        status = await fetchSeismoStatus(baseUrl)
      } finally {
        statusBusy = false
      }
      if (ctrl.signal.aborted) return
      if (status.kind === 'ok' && status.stations.length > 0) {
        stationsReady = true
        statusRetry = null
        stationsAt = performance.now()
        // **増えた観測点は足す**（ライブと同じく 60 秒ごとに見直す）。読み返した分を持つ観測点は作り直さない。
        for (const info of status.stations) if (!book.has(info.stationId)) book.set(info.stationId, freshStation(info))
        return
      }
      noteStatusFailure()
    }

    /** 観測点の一覧を読めなかった回を数える（投げた回も数える。数えないと毎秒読み直す）。 */
    const noteStatusFailure = (): void => {
      // 一覧を読めていれば、見直しの失敗では諦めない（次の見直しで読む）。
      if (stationsReady) {
        stationsAt = performance.now()
        return
      }
      const failures = (statusRetry?.failures ?? 0) + 1
      const delay = retryDelayAfter(failures)
      if (delay === null) {
        log.warn(`[seismo] 再生中の自作地震計: 観測点を ${failures} 回続けて読めず、取り直しを諦めた（再生を始め直すと読み直す）`)
        statusRetry = { failures, at: Number.POSITIVE_INFINITY }
        return
      }
      statusRetry = { failures, at: performance.now() + delay }
    }

    /** 失敗を数え、次に訊く時刻を決める（使い切ったら諦めて記録へ残す）。 */
    const noteFailure = (st: StationReplay, kind: 'series' | 'wave', why: string): void => {
      const failures = (st.retry[kind]?.failures ?? 0) + 1
      const delay = retryDelayAfter(failures)
      if (delay === null) {
        st.gaveUp[kind] = true
        st.retry[kind] = null
        log.warn(`[seismo] 再生中の自作地震計: ${kind === 'series' ? '震度' : '波形'}を ${failures} 回続けて読めず、取り直しを諦めた（${st.info.stationId}・${why}）`)
        return
      }
      st.retry[kind] = { failures, at: performance.now() + delay }
    }

    const due = (st: StationReplay, kind: 'series' | 'wave'): boolean => {
      const r = st.retry[kind]
      return !st.gaveUp[kind] && (r === null || r.at <= performance.now())
    }

    /** 読み返しの続きの長さが足りるか（{@link MIN_STEP_MS}。最初の 1 回は再生時刻の手前から読むので 1 秒でよい）。 */
    const enoughStep = (from: number | null, fromMs: number, toMs: number): boolean =>
      toMs - fromMs >= (from === null ? 1000 : MIN_STEP_MS)

    const readSeries = async (st: StationReplay, nowMs: number, realNowMs: number): Promise<void> => {
      const fromMs = st.seriesTo ?? nowMs - READING_STALE_MS
      const toMs = Math.min(fromMs + QUAKE_INTENSITY_RANGE_MAX_MS, realNowMs - ARCHIVE_LAG_MS)
      if (!enoughStep(st.seriesTo, fromMs, toMs)) return
      const key = `series|${st.info.stationId}`
      busy.add(key)
      let result: Awaited<ReturnType<typeof fetchSeismoQuakeIntensity>>
      try {
        result = await fetchSeismoQuakeIntensity({ baseUrl, stationId: st.info.stationId, fromMs, toMs, signal: ctrl.signal })
      } finally {
        busy.delete(key)
      }
      if (ctrl.signal.aborted || book.get(st.info.stationId) !== st) return
      if (result.kind === 'ok') {
        const last = st.series[st.series.length - 1]?.atMs ?? Number.NEGATIVE_INFINITY
        for (const p of result.intensity.realtimeSeries) if (p.atMs > last) st.series.push(p)
        // 古い分は捨てる（抱える長さは波形と同じ）。
        const keepFrom = nowMs - WAVE_RETAIN_SEC * 1000
        if (st.series.length > 0 && st.series[0].atMs < keepFrom) st.series = st.series.filter((p) => p.atMs >= keepFrom)
        if (result.intensity.usualMeasured !== null) st.usualMeasured = result.intensity.usualMeasured
        // **書き終えてから進め、失敗の数を戻す**（先に戻すと、取り込む途中で投げた回が毎回 1 回目に数え直され、上限に届かない）。
        st.seriesTo = toMs
        st.retry.series = null
        return
      }
      if (result.kind === 'aborted') return
      if (result.kind === 'not-supported' || result.kind === 'bad-request') {
        st.gaveUp.series = true
        log.warn(`[seismo] 再生中の自作地震計: 震度の推移を読めない（${st.info.stationId}・${result.kind}）。帯は出さない`)
        return
      }
      noteFailure(st, 'series', result.kind)
    }

    const readWaves = async (st: StationReplay, nowMs: number, realNowMs: number): Promise<void> => {
      const fromMs = st.waveTo ?? nowMs - WAVE_RETAIN_SEC * 1000
      const toMs = Math.min(fromMs + SAMPLES_RANGE_MAX_MS, realNowMs - ARCHIVE_LAG_MS)
      if (!enoughStep(st.waveTo, fromMs, toMs)) return
      const key = `wave|${st.info.stationId}`
      busy.add(key)
      let result: Awaited<ReturnType<typeof fetchSeismoWaveSamples>>
      try {
        result = await fetchSeismoWaveSamples({ baseUrl, stationId: st.info.stationId, fromMs, toMs, signal: ctrl.signal })
      } finally {
        busy.delete(key)
      }
      if (ctrl.signal.aborted || book.get(st.info.stationId) !== st) return
      if (result.kind === 'ok') {
        for (const c of result.samples.chunks) {
          st.wave.push({
            firstSampleMs: c.firstSampleMs,
            msPerSample: c.msPerSample,
            gal: [Array.from(c.gal[0]), Array.from(c.gal[1]), Array.from(c.gal[2])],
            memberCount: Array.from(c.memberCount),
          })
        }
        // **書き終えてから進め、失敗の数を戻す**（途中で投げたら、同じ範囲をもう一度読む。数えた失敗は残す）。
        st.waveTo = toMs
        st.retry.wave = null
        return
      }
      if (result.kind === 'aborted') return
      if (result.kind === 'bad-request') {
        st.gaveUp.wave = true
        log.warn(`[seismo] 再生中の自作地震計: 波形を読む範囲が通らない（${st.info.stationId}・${result.detail}）。下端の波形は出さない`)
        return
      }
      noteFailure(st, 'wave', result.kind)
    }

    // **投げた回も失敗に数える**（数えないと、待ちも上限も通らずに毎秒読み直す）。
    const onStatusThrown = (error: unknown): void => {
      if (ctrl.signal.aborted) return
      throttledError(() => log.error('[seismo] 再生中の自作地震計: 観測点を読む途中で投げた', error))
      noteStatusFailure()
    }

    const tick = (): void => {
      if (!stationsReady) {
        void loadStations().catch(onStatusThrown)
        return
      }
      if (performance.now() - stationsAt >= STATIONS_REFRESH_MS) {
        void loadStations().catch(onStatusThrown)
      }
      const nowMs = serverNow()
      if (!Number.isFinite(nowMs)) return
      // **再生時刻が飛んだら読み直す**（送り・巻き戻し・始め直し）。読んだ分を残すと、別の時刻の値を描く。
      // **実時間の経過と比べる** —— 隠れたタブでは巡回が間引かれる（1 分に 1 回まで）ので、巡回の間隔と比べると
      // 間引かれるたびに「飛んだ」と読んでしまう。
      const real = performance.now()
      if (Number.isFinite(lastNow) && Math.abs(nowMs - lastNow - (real - lastReal)) > JUMP_MS) {
        for (const [id, st] of book) book.set(id, freshStation(st.info))
      }
      lastNow = nowMs
      lastReal = real
      const realNowMs = nowMs - (replayOffsetMs ?? 0)
      const next: SeismoStationState[] = []
      for (const st of book.values()) {
        const id = st.info.stationId
        if ((st.seriesTo ?? Number.NEGATIVE_INFINITY) < nowMs + AHEAD_MS && !busy.has(`series|${id}`) && due(st, 'series')) {
          void readSeries(st, nowMs, realNowMs).catch((error) => {
            if (ctrl.signal.aborted) return
            throttledError(() => log.error(`[seismo] 再生中の自作地震計: 震度を読み返す途中で投げた（${id}）`, error))
            if (book.get(id) === st) noteFailure(st, 'series', 'exception')
          })
        }
        if (waveWanted && (st.waveTo ?? Number.NEGATIVE_INFINITY) < nowMs + AHEAD_MS && !busy.has(`wave|${id}`) && due(st, 'wave')) {
          void readWaves(st, nowMs, realNowMs).catch((error) => {
            if (ctrl.signal.aborted) return
            throttledError(() => log.error(`[seismo] 再生中の自作地震計: 波形を読み返す途中で投げた（${id}）`, error))
            if (book.get(id) === st) noteFailure(st, 'wave', 'exception')
          })
        }
        const point = replayIntensityAt(st.series, nowMs)
        const waveSampleCount = st.wave.sampleCount
        // **記録の無い時刻は出さない。** 震度も波形も無ければ行を作らない。
        if (point === null && waveSampleCount === 0) continue
        next.push({
          stationId: id,
          displayName: st.info.displayName,
          lat: st.info.lat,
          lon: st.info.lon,
          intensity: point?.value ?? null,
          usualMeasured: point === null ? null : st.usualMeasured,
          atMs: point?.atMs ?? null,
          // 震度が無く波形だけ読めた時刻は「波形のみ」（赤くしない —— 途絶ではなく、その時刻の記録が無いだけ）。
          source: point === null ? { kind: 'wave-only' } : { kind: 'station' },
          waveSampleCount,
          waveSource: 'station',
          waveStale: false,
          waveTally: EMPTY_TALLY,
        })
      }
      next.sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'))
      setStations((prev) => (sameStates(prev, next) ? prev : next))
    }
    tick()
    const timer = setInterval(tick, TICK_MS)
    return () => {
      clearInterval(timer)
      ctrl.abort()
    }
  }, [active, baseUrl, replayOffsetMs, waveWanted])

  // **再生中も URL の形が違えば「地震計 未接続」を出す**（ライブと同じ扱い。再生中はライブの層が切れているので、こちらが立てる）。
  const urlUnusable = enabled && replayOffsetMs !== null && !isValidSeismoHostUrl(baseUrl)
  return useMemo(
    () => ({ stations, stream: null, urlUnusable, unreadableCount: 0, readWave, readLiveWave, subscribeWaveRevised }),
    [stations, urlUnusable, readWave, readLiveWave, subscribeWaveRevised],
  )
}
