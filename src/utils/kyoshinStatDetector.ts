/**
 * 組み合わせの検知器の「統計」の部分。観測点ごとの「いまの新しい上がり」の珍しさ（平常のゆらぎの表から引いた確率）を、
 * 近くの点で束ねて「偶然では起きない」度合い（ポアソンの裾の確率）で判定する走査統計。
 *
 * 1. 点ごとの量（`kyoshinOnsetFeatures.ts`）: y = 直近 6 秒の内に新しく達した段のうち、いまも保っている最大／
 *    y3 = 同じく 3 秒（近くの点が揃って上がったか）
 * 2. 点ごとの珍しさ: s_i = −log10 P_i(y ≥ いまの値)。P_i は平常の日の表を全体の裾へ縮めたもの（擬似件数 SHRINK）と、
 *    その点の直近（時定数 ONLINE_TAU で忘れる）の裾の大きいほう（荒れている点は割り引く）
 * 3. 走査: 珍しい点を中心に、半径 R の中で (a) s ≥ a の点の数が平常の期待値に比べてどれだけ多いか（ポアソンの裾）、
 *    (b) s ≥ 1 の点の s の和の裾（切り詰めた積の検定）の最小の裾を、組の数で割り引いて S = −log10(裾) − log10(組の数)
 * 4. 段階: S ≥ T_EARLY で早い段。S ≥ T_CONF で確かな段。確かな段は、点が長い基準より上にいる間は下ろさない
 * 5. 1 つの揺れ = 1 つの id: S の大きい候補から順に、すでに別の候補が取った点を半分以上借りている候補はその候補の支えにする。
 *    新しい候補は、生きている事象の点から MERGE_KM 以内ならその事象へ（ただし古い事象へ強い候補が来たら別の揺れとして出し直す）
 * 6. 位置 = 候補の中で 25 km 以内の珍しさの和が最大の点、始まり = その点の今回の立ち上がり（START_BACK 秒より前へは遡らない）
 *
 * 値はすべて、組み合わせの検知器を評価したときのもの。変えると評価で測った検知率と誤報の率が成り立たなくなる。
 */
import { KMAX, NONE, OnsetFeatures } from './kyoshinOnsetFeatures'
import { quietSiteKey, type QuietTables } from './kyoshinQuietTables'

export interface DetectorReport {
  id: string
  tier: 'early' | 'confirmed'
  lat: number
  lng: number
  startMs: number
  /** この秒にこの検知を支えた観測点（観測点の並びの番号） */
  sites: readonly number[]
}

export interface DetectorFrame {
  /** データ時刻（ミリ秒） */
  ms: number
  /** 観測点の並びの震度の段（-1 = 欠測） */
  values: Int8Array
}

const T_EARLY = 10
const T_CONF = 20
const CONF_HOLD = 1
/** 早い段は出してからこの秒数は出し続け、確かな段へ上がらなければ下ろす（事象は覚えたまま黙る） */
const EARLY_MAX = 2
/** 早い段は、生まれてから続けてこの秒数だけ支えがあった事象にだけ出す（1 = 生まれた秒から出す） */
const EARLY_ON = 1
const CONF_KEEP = 10
/** 確かな段へ上がっていない事象を、支えが切れてから覚えておく秒数（同じ揺れの続きに同じ id を使う） */
const MEMORY = 10
/** 確かな段まで上がって消えた事象を覚えておく秒数（近くで候補が出たら同じ id で戻す。揺れの後半の波を別の検知にしない） */
const GHOST = 20
/** 確かな段へ上がらないまま、この秒数より前に始まった事象へは強い候補を入れない（新しい揺れとして出し直す） */
const STALE = 12
/** 確かな段の事象でも、強い候補がこの秒数より途絶えていたら、新しい強い候補は別の揺れとして出し直す */
const REFRESH = 15
const SUSTAIN_R = 2
const SUSTAIN_N = 3
const SUSTAIN_MAX = 120
const SHRINK = 2000
const ONLINE_TAU = 1800
const ONLINE_A = 600
const RADII = [25, 60, 150, 400]
const RADII_Y3 = [25, 60]
const LEVELS = [1, 1.5, 2, 3, 4]
const MERGE_KM = 80
const TPM_MIN = 5
const START_BACK = 3
const K1 = KMAX + 1

const RAD = Math.PI / 180
const hav = (a: number, b: number, c: number, d: number) => {
  const x = Math.sin((c - a) * RAD / 2) ** 2 + Math.cos(a * RAD) * Math.cos(c * RAD) * Math.sin((d - b) * RAD / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(x))
}

/** log10 P(X ≥ m; μ)。X はポアソン分布 */
const LF: number[] = [0]
for (let k = 1; k < 4000; k++) LF[k] = LF[k - 1] + Math.log(k)
function logPoisTail(m: number, mu: number): number {
  if (m <= mu) return 0
  let t = Math.exp(-mu + m * Math.log(mu) - LF[m]), sum = t
  for (let k = m + 1; k < m + 400; k++) { t *= mu / k; sum += t; if (t < sum * 1e-12) break }
  return Math.min(0, Math.log10(sum))
}

/**
 * 切り詰めた積の検定: 珍しさ s ≥ 1 の点の s の和 W の裾。log10 P(W ≥ w)。
 * 平常なら s ≥ 1 の点の数は Pois(μ)、各点の s − 1 は率 ln10 の指数分布なので
 * P(W ≥ w) = Σ_m Pois(m; μ) · P(Gamma(m, 1) ≥ (w − m)·ln10)
 */
const LN10 = Math.log(10)
function logTPM(w: number, mu: number): number {
  const Mc = 80
  let pm = Math.exp(-mu), cum = pm, total = 0
  for (let m = 1; m <= Mc; m++) {
    pm *= mu / m; cum += pm
    const x = (w - m) * LN10
    let g = 1
    if (x > 0) { let t = Math.exp(-x), sm = t; for (let k = 1; k < m; k++) { t *= x / k; sm += t } g = Math.min(1, sm) }
    total += pm * g
    if (pm < 1e-300) break
  }
  total += Math.max(0, 1 - cum)
  return total <= 0 ? -300 : Math.min(0, Math.log10(total))
}

type ChanDef = { name: 'y' | 'y3'; radii: number[]; levels: number[]; centerMin: number; memMin: number }
const CHANS: ChanDef[] = [
  { name: 'y', radii: RADII, levels: LEVELS, centerMin: LEVELS[0], memMin: 1.5 },
  { name: 'y3', radii: RADII_Y3, levels: LEVELS, centerMin: LEVELS[0], memMin: 1.5 },
]
const ALL_RADII = [...new Set(CHANS.flatMap(c => c.radii))].sort((a, b) => a - b)

/** 観測点の近傍（近い順）と、半径ごとに何点目までが入るか。観測点リストが同じなら使い回す */
const nbrCache = new WeakMap<object, { nbr: Int32Array[]; cut: Int32Array[] }>()
function neighbors(sites: readonly (readonly [number, number])[]) {
  let c = nbrCache.get(sites)
  if (c) return c
  const n = sites.length, Rmax = Math.max(...ALL_RADII), nbr: Int32Array[] = [], cut: Int32Array[] = []
  for (let i = 0; i < n; i++) {
    const list: [number, number][] = []
    for (let j = 0; j < n; j++) { const d = hav(sites[i][0], sites[i][1], sites[j][0], sites[j][1]); if (d <= Rmax) list.push([j, d]) }
    list.sort((a, b) => a[1] - b[1])
    nbr.push(Int32Array.from(list.map(x => x[0])))
    const ct = new Int32Array(ALL_RADII.length)
    for (let r = 0; r < ALL_RADII.length; r++) { let e = 0; while (e < list.length && list[e][1] <= ALL_RADII[r]) e++; ct[r] = e }
    cut.push(ct)
  }
  c = { nbr, cut }
  nbrCache.set(sites, c)
  return c
}

export function createStatDetector(sites: readonly (readonly [number, number])[], tables: QuietTables) {
  const n = sites.length, G = tables.glob
  const { nbr, cut: cutAll } = neighbors(sites)
  const F = new OnsetFeatures(n)
  const decay = Math.exp(-1 / ONLINE_TAU)
  const chans = CHANS.map(def => {
    const L = def.levels.length
    const P0 = new Float64Array(n * K1)
    for (let i = 0; i < n; i++) {
      const s = tables.tails[quietSiteKey(sites[i])]
      P0[i * K1] = 1
      for (let k = 1; k <= KMAX; k++) {
        const g = G[def.name][k - 1] / G.n
        P0[i * K1 + k] = Math.max(1e-8, s ? (s[def.name][k - 1] + SHRINK * g) / (s.n + SHRINK) : g)
      }
    }
    const ri = def.radii.map(r => ALL_RADII.indexOf(r))
    return {
      def, L, P0, P: Float64Array.from(P0), lgP: new Float64Array(n * K1), q: new Float64Array(n * L),
      onN: new Float64Array(n), onC: new Float64Array(n * K1), s: new Float64Array(n), ri,
      cnt: new Int32Array(L), mus: new Float64Array(L), penalty: Math.log10(def.radii.length * L * CHANS.length),
    }
  })
  type Chan = typeof chans[number]
  const refresh = (ch: Chan) => {
    const { P0, P, lgP, q, onN, onC, L } = ch, lv = ch.def.levels
    for (let i = 0; i < n; i++) {
      for (let k = 1; k <= KMAX; k++) {
        let p = P0[i * K1 + k]
        const pr = (onC[i * K1 + k] + ONLINE_A * p) / (onN[i] + ONLINE_A)
        if (pr > p) p = pr
        P[i * K1 + k] = p; lgP[i * K1 + k] = -Math.log10(p)
      }
      for (let l = 0; l < L; l++) { let v = 0; for (let k = 1; k <= KMAX; k++) if (lgP[i * K1 + k] >= lv[l]) { v = P[i * K1 + k]; break } q[i * L + l] = v }
    }
  }
  chans.forEach(refresh)
  const featOf = (name: ChanDef['name']) => (name === 'y' ? F.y : F.y3)
  const inEvent = new Uint8Array(n)
  type Ev = {
    id: string; seed: number; startMs: number; members: Set<number>; lastSupport: number; confStreak: number
    confirmed: boolean; lastConf: number; lastStrong: number; best: number; born: number; run: number; ripe: number
  }
  const events: Ev[] = [], ghosts: (Ev & { goneMs: number })[] = []
  let seq = 0, tick = 0
  const near = (c: number, e: Ev) => { for (const m of e.members) if (hav(sites[c][0], sites[c][1], sites[m][0], sites[m][1]) <= MERGE_KM) return true; return false }
  return {
    /** 平常のゆらぎの表を差し替える。点ごとの確率の基準（P0）だけを作り直し、直近に数えた分と追っている検知は残す */
    setTables(next: QuietTables): void {
      const Gn = next.glob
      for (const ch of chans) {
        for (let i = 0; i < n; i++) {
          const s = next.tails[quietSiteKey(sites[i])]
          for (let k = 1; k <= KMAX; k++) {
            const g = Gn[ch.def.name][k - 1] / Gn.n
            ch.P0[i * K1 + k] = Math.max(1e-8, s ? (s[ch.def.name][k - 1] + SHRINK * g) / (s.n + SHRINK) : g)
          }
        }
        refresh(ch)
      }
    },
    push(f: DetectorFrame): DetectorReport[] {
      F.push(f.values)
      tick++
      const sig: { c: number; S: number; mem: number[]; s: Float64Array }[] = []
      for (const ch of chans) {
        const feat = featOf(ch.def.name), sv = ch.s, { lgP, onN, onC, q, L, cnt, mus } = ch, lv = ch.def.levels
        for (let i = 0; i < n; i++) {
          const v = feat[i]
          sv[i] = v === NONE || v <= 0 ? 0 : lgP[i * K1 + Math.min(v, KMAX)]
          // 直近の数えを更新（事象に入っている点は数えない）
          if (v !== NONE && !inEvent[i]) {
            onN[i] = onN[i] * decay + 1
            for (let k = 1; k <= KMAX; k++) onC[i * K1 + k] = onC[i * K1 + k] * decay + (v >= k ? 1 : 0)
          }
        }
        if (tick % 5 === 0) refresh(ch)
        for (let c = 0; c < n; c++) {
          if (sv[c] < ch.def.centerMin) continue
          const nb = nbr[c], ct = cutAll[c]
          let S = 0, Rb = 0
          cnt.fill(0); mus.fill(0)
          let e = 0, W = 0
          for (const r of ch.ri) {
            for (; e < ct[r]; e++) {
              const j = nb[e], s = sv[j]
              if (s >= 1) W += s
              for (let l = 0; l < L; l++) { mus[l] += q[j * L + l]; if (s >= lv[l]) cnt[l]++ }
            }
            if (lv[0] === 1 && cnt[0] >= 2 && W >= TPM_MIN) {
              const v = -logTPM(W, mus[0]) - ch.penalty
              if (v > S) { S = v; Rb = ct[r] }
            }
            for (let l = 0; l < L; l++) {
              if (cnt[l] < 2) continue
              const v = -logPoisTail(cnt[l], mus[l]) - ch.penalty
              if (v > S) { S = v; Rb = ct[r] }
            }
          }
          if (S >= T_EARLY) {
            const mem: number[] = []
            for (let t = 0; t < Rb; t++) if (sv[nb[t]] >= ch.def.memMin) mem.push(nb[t])
            sig.push({ c, S, mem, s: sv })
          }
        }
      }
      // 事象へ割り当てる（S の大きい候補から）。先の候補の点を半分以上借りているだけの候補は、その候補の支えとして扱う
      sig.sort((a, b) => b.S - a.S)
      const touched = new Set<Ev>()
      const owner = new Map<number, Ev>()
      for (const g of sig) {
        let ev: Ev | undefined
        let ov = 0
        const votes = new Map<Ev, number>()
        for (const j of g.mem) { const o = owner.get(j); if (o) { ov++; votes.set(o, (votes.get(o) ?? 0) + 1) } }
        if (g.mem.length && ov * 2 >= g.mem.length) ev = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0]
        const old = (e: Ev) => g.S >= T_CONF && (e.confirmed ? f.ms - e.lastStrong > REFRESH * 1000 : f.ms - e.startMs > STALE * 1000)
        if (ev && old(ev)) ev = undefined
        if (!ev) {
          const idx = events.findIndex(e => near(g.c, e))
          if (idx >= 0) {
            const e = events[idx]
            if (old(e)) { events.splice(idx, 1); touched.delete(e) } else ev = e
          }
        }
        if (!ev) {
          const gi = ghosts.findIndex(e => e.confirmed && !old(e) && f.ms - e.goneMs < GHOST * 1000 && near(g.c, e))
          if (gi >= 0) { ev = ghosts[gi]; ghosts.splice(gi, 1); events.push(ev) }
        }
        if (!ev) {
          // 種 = 候補の点のうち、25 km 以内に上がった点の珍しさがいちばん多く集まっている点
          const cand = g.mem.length ? g.mem : [g.c]
          let seed = cand[0], bestD = -1
          for (const j of cand) {
            const nj = nbr[j]
            let d = 0
            for (let t = 0; t < cutAll[j][0]; t++) if (g.s[nj[t]] >= 1) d += g.s[nj[t]]
            if (d > bestD) { bestD = d; seed = j }
          }
          // 始まり = 種の今回の立ち上がり。ただし検知の START_BACK 秒より前へは遡らない（近くの点の雑音の立ち上がりを拾わないため）
          const t0 = F.up1[seed] >= 0 ? F.up1[seed] : F.t - 1
          const startMs = f.ms - Math.min(START_BACK, F.t - 1 - t0) * 1000
          ev = {
            id: `s${seq++}`, seed, startMs, members: new Set([seed]), lastSupport: f.ms, confStreak: 0, confirmed: false,
            lastConf: -Infinity, lastStrong: -Infinity, best: 0, born: f.ms, run: 0, ripe: Infinity,
          }
          events.push(ev)
        }
        for (const j of g.mem) { ev.members.add(j); if (!owner.has(j)) owner.set(j, ev) }
        if (!touched.has(ev)) { touched.add(ev); ev.best = 0 }
        ev.best = Math.max(ev.best, g.S)
        ev.lastSupport = f.ms
      }
      inEvent.fill(0)
      const out: DetectorReport[] = []
      for (let k = events.length - 1; k >= 0; k--) {
        const e = events[k]
        const live = touched.has(e)
        // 生まれてから続けて支えがあった秒数（途切れたら数えるのをやめる）。EARLY_ON 秒に届いた時刻から早い段を出す
        if (e.run >= 0) { if (live) { e.run++; if (e.run >= EARLY_ON && e.ripe === Infinity) e.ripe = f.ms } else e.run = -1 }
        if (live && e.best >= T_CONF) {
          e.confStreak++
          if (e.confStreak >= CONF_HOLD) { e.confirmed = true; e.lastConf = f.ms; e.lastStrong = f.ms }
        } else e.confStreak = 0
        // 確かな段の事象は、点がまだ長い基準より上にいる間（揺れの続き）は下ろさない
        if (e.confirmed && f.ms - e.lastStrong < SUSTAIN_MAX * 1000) {
          let c = 0
          for (const m of e.members) if (F.r[m] !== NONE && F.r[m] >= SUSTAIN_R && ++c >= SUSTAIN_N) break
          if (c >= SUSTAIN_N) e.lastConf = f.ms
        }
        const confAlive = e.confirmed && f.ms - e.lastConf < CONF_KEEP * 1000
        if (!confAlive && f.ms - e.lastSupport > (e.confirmed ? 0 : MEMORY * 1000)) {
          events.splice(k, 1)
          if (e.confirmed) ghosts.push({ ...e, goneMs: f.ms })
          continue
        }
        for (const m of e.members) inEvent[m] = 1
        const lat = sites[e.seed][0], lng = sites[e.seed][1], members = [...e.members]
        if (confAlive || (e.ripe !== Infinity && f.ms - e.ripe < EARLY_MAX * 1000)) out.push({ id: e.id, tier: 'early', lat, lng, startMs: e.startMs, sites: members })
        if (confAlive) out.push({ id: e.id, tier: 'confirmed', lat, lng, startMs: e.startMs, sites: members })
      }
      for (let k = ghosts.length - 1; k >= 0; k--) if (f.ms - ghosts[k].goneMs >= GHOST * 1000) ghosts.splice(k, 1)
      return out
    },
  }
}
