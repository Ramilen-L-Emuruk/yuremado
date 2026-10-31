import { describe, it, expect } from 'vitest'
import { buildSiteIndex, resolveMembers, deriveKyoshinView } from './kyoshinDetectionView'
import { siteKey } from './kyoshinSiteKeys'
import { kyoshinDetectionScaleLabel } from './kyoshinIntensity'
import type { EnsembleDetection } from './kyoshinEnsembleTracker'
import { fakeEnsembleDetection } from '../test-utils/ensembleDetection'
import type { SiteCoords } from '../services/kyoshin'

/** テスト用ラッパー（欠測の保持の印を渡さない呼び出し） */
function derive(detections: EnsembleDetection[], sites: SiteCoords, indices: number[]) {
  return deriveKyoshinView(detections, sites, indices)
}

/** テスト用の検知。テストが見る欄（id・段・メンバー・最大震度）だけを必ず渡させる */
function fakeEvent(
  overrides: Partial<EnsembleDetection> & Pick<EnsembleDetection, 'id' | 'confidence' | 'memberKeys' | 'maxIntensity'>,
): EnsembleDetection {
  return fakeEnsembleDetection(overrides)
}

describe('buildSiteIndex: 座標衝突時も両方の観測点を索引に残す', () => {
  it('同一座標2点は computeSiteKeys と同じ #2 サフィックスで両方引ける', () => {
    // 2026-08-08 天草・芦北地方の誤報調査で発覚: Yahoo 強震モニタの公開座標は同一値が複数回
    // 現れることがある（実例: site#561/#1358 がともに [32.2, 130.4]）。以前は Map のキーが
    // 座標だけだったため後発の点が先発を上書きし、カード表示・confirmedShocks から先発点の
    // 実測値が消えていた。
    const sites: SiteCoords = [
      [35.0, 139.0],
      [32.2, 130.4],
      [32.2, 130.4], // 座標衝突の別観測点
    ]
    const indices = [7, 11, 6] // 32.2,130.4 の1件目=震度3相当(11)・2件目=静穏(6)
    const byKey = buildSiteIndex(sites, indices)

    const base = siteKey(32.2, 130.4)
    expect(byKey.get(base)?.index).toBe(11)
    expect(byKey.get(`${base}#2`)?.index).toBe(6)
    expect(byKey.size).toBe(3)
  })

  it('resolveMembers で衝突した2点をどちらも別々に解決できる', () => {
    const sites: SiteCoords = [
      [32.2, 130.4],
      [32.2, 130.4],
    ]
    const indices = [11, 6]
    const byKey = buildSiteIndex(sites, indices)
    const base = siteKey(32.2, 130.4)
    const pts = resolveMembers([base, `${base}#2`], byKey)
    expect(pts.map((p) => p.index).sort((a, b) => a - b)).toEqual([6, 11])
  })
})

describe('deriveKyoshinView: candidatePeakIndex（共有カードの副見出しに震度の呼び名を付ける値）', () => {
  const sites: SiteCoords = [
    [35.0, 139.0],
    [35.1, 139.1],
  ]
  const keyA = siteKey(35.0, 139.0)
  const keyB = siteKey(35.1, 139.1)
  const likely = [fakeEvent({ id: 'evt-1', confidence: 'likely', memberKeys: [keyA, keyB], maxIntensity: null })]

  it('正: 主候補のメンバーが全員欠測なら -1（呼び名を付けない。音の基準の candidateMaxIndex は 0 のまま）', () => {
    const view = derive(likely, sites, [-1, -1])
    expect(view.candidatePeakIndex).toBe(-1)
    expect(kyoshinDetectionScaleLabel(view.candidatePeakIndex)).toBeNull()
    expect(view.candidateMaxIndex).toBe(0)
  })

  it('対照: 値を持つメンバーが震度0未満でも、その値を返す（「0以下」と名乗る）', () => {
    const view = derive(likely, sites, [-1, 3])
    expect(view.candidatePeakIndex).toBe(3)
    expect(kyoshinDetectionScaleLabel(view.candidatePeakIndex)).toBe('0以下')
  })

  it('安全弁: likely が無ければ -1', () => {
    expect(derive([], sites, [9, 7]).candidatePeakIndex).toBe(-1)
  })
})

describe('deriveKyoshinView: candidateMaxIndex（likely 中の音レベル追跡の基準値）', () => {
  const sites: SiteCoords = [
    [35.0, 139.0],
    [35.1, 139.1],
    [35.2, 139.2],
  ]
  const keyA = siteKey(35.0, 139.0)
  const keyB = siteKey(35.1, 139.1)
  const keyC = siteKey(35.2, 139.2)

  it('likely イベントが無ければ 0', () => {
    const view = derive([], sites, [9, 7, 6])
    expect(view.candidateMaxIndex).toBe(0)
  })

  it('主 likely イベントのメンバー観測点の最大インデックスを返す', () => {
    const indices = [9, 11, 6] // keyB=11 が最大だが、keyC はメンバーではないので無視される
    const detections = [
      fakeEvent({ id: 'evt-1', confidence: 'likely', memberKeys: [keyA, keyB], maxIntensity: 2.5 }),
    ]
    const view = derive(detections, sites, indices)
    expect(view.candidateMaxIndex).toBe(11)
  })

  it('複数 likely イベントがあれば maxIntensity が最大の主イベント側を採用する', () => {
    const indices = [9, 11, 13]
    const detections = [
      fakeEvent({ id: 'evt-1', confidence: 'likely', memberKeys: [keyA], maxIntensity: 1.5 }),
      fakeEvent({ id: 'evt-2', confidence: 'likely', memberKeys: [keyC], maxIntensity: 4.0 }),
    ]
    const view = derive(detections, sites, indices)
    expect(view.candidateMaxIndex).toBe(13) // evt-2 (keyC) 側
  })

  it('confirmed イベントのみのときは candidateMaxIndex は 0（likely が無いため）', () => {
    const indices = [9, 11, 6]
    const detections = [
      fakeEvent({ id: 'evt-1', confidence: 'confirmed', memberKeys: [keyA, keyB], maxIntensity: 2.5 }),
    ]
    const view = derive(detections, sites, indices)
    expect(view.candidateMaxIndex).toBe(0)
  })
})

// 検知点マーカー（KyoshinDetectedPointsGL）の描画対象は detectedPoints ＋ unconfirmedPoints の 2 本で、
// リアルタイムタブの検知カードが集計する集合（全イベント）と一致していなければならない。
// candidatePoints は候補カメラフィット専用（主 likely 1 件へ絞る）なので、こちらとは用途が別。
describe('deriveKyoshinView: unconfirmedPoints（検知点マーカーの描画対象）', () => {
  const sites: SiteCoords = [
    [35.0, 139.0],
    [35.1, 139.1],
    [35.2, 139.2],
    [35.3, 139.3],
  ]
  const keyA = siteKey(35.0, 139.0)
  const keyB = siteKey(35.1, 139.1)
  const keyC = siteKey(35.2, 139.2)
  const keyD = siteKey(35.3, 139.3)
  const indices = [9, 10, 11, 12]

  it('likely のメンバーを全件含む（複数 likely を主 1 件へ絞らない）', () => {
    const detections = [
      fakeEvent({ id: 'evt-1', confidence: 'likely', memberKeys: [keyA], maxIntensity: 1.5 }),
      fakeEvent({ id: 'evt-2', confidence: 'likely', memberKeys: [keyB], maxIntensity: 4.0 }),
      fakeEvent({ id: 'evt-3', confidence: 'likely', memberKeys: [keyC], maxIntensity: 0.2 }),
    ]
    const view = derive(detections, sites, indices)
    expect(view.unconfirmedPoints.map((p) => p.index).sort((a, b) => a - b)).toEqual([9, 10, 11])
    // 候補フィットは主 likely（maxIntensity 最大 = evt-2）1 件のみ
    expect(view.candidatePoints.map((p) => p.index)).toEqual([10])
  })

  it('confirmed のメンバーは含まない（confirmed は detectedPoints 側）', () => {
    const detections = [
      fakeEvent({ id: 'evt-1', confidence: 'confirmed', memberKeys: [keyA], maxIntensity: 5.0 }),
      fakeEvent({ id: 'evt-3', confidence: 'likely', memberKeys: [keyC], maxIntensity: 2.0 }),
    ]
    const view = derive(detections, sites, indices)
    expect(view.unconfirmedPoints.map((p) => p.index)).toEqual([11]) // keyC のみ
    expect(view.detectedPoints.map((p) => p.index)).toEqual([9]) // keyA のみ
  })

  it('検知が無ければ空', () => {
    const view = derive([], sites, indices)
    expect(view.unconfirmedPoints).toEqual([])
  })

  it('同一観測点が複数の likely に属していても重複しない', () => {
    const detections = [
      fakeEvent({ id: 'evt-1', confidence: 'likely', memberKeys: [keyA, keyD], maxIntensity: 1.5 }),
      fakeEvent({ id: 'evt-2', confidence: 'likely', memberKeys: [keyD], maxIntensity: 0.2 }),
    ]
    const view = derive(detections, sites, indices)
    expect(view.unconfirmedPoints.map((p) => p.index).sort((a, b) => a - b)).toEqual([9, 12])
  })

  // 描画側（buildDetectedFC）は重複を弾かない。同一座標に複数の実体がある観測点を取り違えて
  // 落とさないよう、confirmed との排除は観測点キーを持つこちらで済ませる。
  it('confirmed と likely の両方に属する観測点は unconfirmedPoints から除かれる', () => {
    const detections = [
      fakeEvent({ id: 'evt-1', confidence: 'confirmed', memberKeys: [keyA, keyB], maxIntensity: 3.0 }),
      fakeEvent({ id: 'evt-2', confidence: 'likely', memberKeys: [keyB, keyC], maxIntensity: 1.5 }),
    ]
    const view = derive(detections, sites, indices)
    expect(view.detectedPoints.map((p) => p.index).sort((a, b) => a - b)).toEqual([9, 10])
    expect(view.unconfirmedPoints.map((p) => p.index)).toEqual([11]) // keyB は confirmed 側にあるので除外
  })
})

// 地図に描く点・カメラの寄せ先は束の描く点（`drawnKeys`。震度0 未満が続いた点を外したもの）から取り、
// 確信度・地域の発報（音）の入力は加わった点すべて（`memberKeys`）で見る。
describe('deriveKyoshinView: 描く点（drawnKeys）と加わった点（memberKeys）の使い分け', () => {
  const sites: SiteCoords = [
    [35.0, 139.0], // 震度1（揺れの芯）
    [35.1, 139.0], // 震度0・芯の近く
    [40.0, 139.0], // 震度0 未満・遠い（束の側で描く点から外した）
  ]
  const keyStrong = siteKey(35.0, 139.0)
  const keyNear = siteKey(35.1, 139.0)
  const keyFar = siteKey(40.0, 139.0)
  const indices = [7, 6, 3]

  it('[正] 描く点から外れた点は detectedPoints（地図・カメラ）に出ない', () => {
    const view = derive(
      [fakeEvent({ id: 'evt-1', confidence: 'confirmed', memberKeys: [keyStrong, keyNear, keyFar], drawnKeys: [keyStrong, keyNear], maxIntensity: 0.5 })],
      sites,
      indices,
    )
    expect(view.detectedPoints.map((p) => p.key).sort()).toEqual([keyNear, keyStrong].sort())
  })

  it('[対照] 描く点に残っていれば、遠い震度0・震度0 未満の点も detectedPoints に出す（孤立した震度0 を落とさない）', () => {
    const view = derive(
      [fakeEvent({ id: 'evt-1', confidence: 'confirmed', memberKeys: [keyStrong, keyNear, keyFar], maxIntensity: 0.5 })],
      sites,
      [7, 6, 6],
    )
    expect(view.detectedPoints.map((p) => p.key).sort()).toEqual([keyFar, keyNear, keyStrong].sort())
  })

  it('[安全弁] 地域の発報の入力（confirmedShocks）は描く点から外れた点も含めて見る', () => {
    const view = derive(
      [fakeEvent({ id: 'evt-1', confidence: 'confirmed', memberKeys: [keyFar, keyStrong], drawnKeys: [keyStrong], maxIntensity: 0.5, epicenter: [35.0, 139.0] })],
      sites,
      [3, 6, 9], // 描く点から外れた keyFar のほうが強い
    )
    expect(view.confirmed).toBe(true)
    expect(view.confirmedShocks[0].index).toBe(9)
    expect(view.confirmedShocks[0].peak).toEqual({ lat: 40.0, lng: 139.0 })
  })

  it('[正] likely も描く点だけを unconfirmedPoints と candidatePoints に出す', () => {
    const view = derive(
      [fakeEvent({ id: 'evt-2', confidence: 'likely', memberKeys: [keyNear, keyFar], drawnKeys: [keyNear], maxIntensity: 0.0 })],
      sites,
      indices,
    )
    expect(view.unconfirmedPoints.map((p) => p.key)).toEqual([keyNear])
    expect(view.candidatePoints.map((p) => p.key)).toEqual([keyNear])
  })

  it('[安全弁] 主 likely の最大インデックス（音の段）は描く点から外れた点も含めて見る', () => {
    const view = derive(
      [fakeEvent({ id: 'evt-2', confidence: 'likely', memberKeys: [keyNear, keyFar], drawnKeys: [keyNear], maxIntensity: 0.0 })],
      sites,
      [7, 6, 9],
    )
    expect(view.candidateMaxIndex).toBe(9)
  })
})

// 欠測ホールド（utils/kyoshinMissingHold.ts）で作った保持値を渡したときの振る舞い。
// 保持は「表示の補完」だが、地域の最大震度（音・通知・地域単位発報の入力）にも意図的に効かせている。
// 欠測を素通しすると、最大震度を担う観測点が 1 秒欠測した瞬間に「揺れが弱まった」と解釈され、
// 復帰時に更新音が誤って鳴る（useKyoshinAlerts の postPeakMinLevel）。
describe('deriveKyoshinView: 欠測ホールドの保持値と stale フラグ', () => {
  const holdSites: SiteCoords = [
    [35.0, 139.0],
    [35.1, 139.1],
  ]
  const hKeyA = siteKey(35.0, 139.0)
  const hKeyB = siteKey(35.1, 139.1)
  const confirmedEvent = fakeEvent({
    id: 'evt-1',
    confidence: 'confirmed',
    memberKeys: [hKeyA, hKeyB],
    maxIntensity: 5.0,
    epicenter: [35.05, 139.05],
  })

  it('保持中フラグが DetectedPoint へ伝わる（描画側が薄く描くため）', () => {
    // hKeyA が欠測 → 直前値 17 を保持中。hKeyB は生きている。
    const view = deriveKyoshinView([confirmedEvent], holdSites, [17, 15], [true, false])
    const byKey = new Map(view.detectedPoints.map((p) => [p.key, p]))
    expect(byKey.get(hKeyA)?.stale).toBe(true)
    expect(byKey.get(hKeyB)?.stale).toBe(false)
  })

  it('最大震度を担う点が欠測しても、保持値なら confirmedShocks の index が落ちない', () => {
    const held = deriveKyoshinView([confirmedEvent], holdSites, [17, 15], [true, false])
    // 保持値 17 を持つ hKeyA が最大＝寄り先（peak）もその観測点になる。
    expect(held.confirmedShocks).toEqual([
      // points は区域名（読み上げ）を決める点。束が 1 つなので描いた点と同じ
      { lat: 35.05, lng: 139.05, index: 17, peak: { lat: 35.0, lng: 139.0 }, points: held.detectedPoints },
    ])
    // 保持しない場合（欠測を素通し）は次点の 15 まで落ちる＝揺れが弱まったように見える。
    // 寄り先も次点の観測点（hKeyB）へ移る。
    const raw = deriveKyoshinView([confirmedEvent], holdSites, [-1, 15])
    expect(raw.confirmedShocks).toEqual([
      { lat: 35.05, lng: 139.05, index: 15, peak: { lat: 35.1, lng: 139.1 }, points: raw.detectedPoints },
    ])
  })

  it('likely 中の音レベルの基準（candidateMaxIndex）も保持値で落ちない', () => {
    const likely = fakeEvent({ id: 'evt-2', confidence: 'likely', memberKeys: [hKeyA, hKeyB], maxIntensity: 4.0 })
    const held = deriveKyoshinView([likely], holdSites, [15, 11], [true, false])
    expect(held.candidateMaxIndex).toBe(15)
    const raw = deriveKyoshinView([likely], holdSites, [-1, 11])
    expect(raw.candidateMaxIndex).toBe(11)
  })

  it('stale を渡さない経路では stale=false になる（保持を通さない呼び出し）', () => {
    const view = derive([confirmedEvent], holdSites, [17, 15])
    expect(view.detectedPoints.every((p) => p.stale === false)).toBe(true)
  })
})

// 揺れフォーカス（音が鳴った点へカメラを寄せる。map-rendering-spec §6）の寄り先。
// **重心ではなく「最大震度を記録した観測点」でなければならない。** 広域に広がったイベントでは
// 重心が強い点から大きく離れ、画の中心に何も無い状態になる（2024-01-01 16:08 能登の再生で実測:
// 石川〜千葉に広がったイベントの重心は新潟県境付近・震度4の観測点は能登で約 140km のずれ）。
describe('deriveKyoshinView: confirmedShocks の寄り先（peak）', () => {
  const wideSites: SiteCoords = [
    [37.45, 137.15], // 能登（最大震度）
    [36.5, 138.5], // 長野
    [35.7, 140.0], // 千葉
  ]
  const wideKeys = wideSites.map(([lat, lng]) => siteKey(lat, lng))

  it('[正] 重心ではなく、最大震度を記録した観測点の座標を返す', () => {
    const view = derive(
      [fakeEvent({
        id: 'evt-1',
        confidence: 'confirmed',
        memberKeys: wideKeys,
        maxIntensity: 4.0,
        epicenter: [37.45, 137.15],
      })],
      wideSites,
      [13, 8, 7], // 能登が震度4相当・他は震度1〜2
    )
    expect(view.confirmedShocks).toHaveLength(1)
    const shock = view.confirmedShocks[0]
    expect(shock.index).toBe(13)
    expect(shock.peak).toEqual({ lat: 37.45, lng: 137.15 })
    // 照合に使う位置はメンバーの重心（別地点判定の距離閾値がこれを前提にしている）
    expect(shock.lat).toBeCloseTo(36.55, 9)
    expect(shock.lng).toBeCloseTo(138.55, 9)
  })

  it('[対照] 最大が動けば寄り先も動く', () => {
    const view = derive(
      [fakeEvent({
        id: 'evt-1',
        confidence: 'confirmed',
        memberKeys: wideKeys,
        maxIntensity: 4.0,
        epicenter: [36.55, 138.55],
      })],
      wideSites,
      [7, 8, 13], // 今度は千葉が最大
    )
    expect(view.confirmedShocks[0].peak).toEqual({ lat: 35.7, lng: 140.0 })
  })

  it('[安全弁] 同じ最大値が並んだら memberKeys の並びで先の観測点を採る（結果が揺れない）', () => {
    const view = derive(
      [fakeEvent({
        id: 'evt-1',
        confidence: 'confirmed',
        memberKeys: wideKeys,
        maxIntensity: 4.0,
        epicenter: [36.55, 138.55],
      })],
      wideSites,
      [13, 13, 13], // 全点が同じ最大
    )
    expect(view.confirmedShocks[0].peak).toEqual({ lat: 37.45, lng: 137.15 })
  })

  it('[安全弁] メンバーが索引に無くてもイベントは落とさない（検知の位置へ落として残す）', () => {
    // 観測点リストの入れ替え中は sites が空へゲートされ、メンバーが 1 つも引けなくなる。
    // ここでイベントごと消すと、地域単位の発報（stepAlertRegions）が「確定が消えた」と読んで
    // 発報済み・EEW 吸収済みの記録を捨て、入れ替えの直後に同じ地域が鳴り直す。
    const view = derive(
      [fakeEvent({
        id: 'evt-1',
        confidence: 'confirmed',
        memberKeys: wideKeys,
        maxIntensity: 4.0,
        epicenter: [37.0, 137.5], // 束を作った 1 点の位置
      })],
      [], // sites が空（＝索引が空）
      [],
    )
    expect(view.confirmedShocks).toEqual([
      // 値を持つメンバーが無いので index は欠測（-1）。0 は計測震度 -3.0 という値になってしまう
      // 区域名を決める点も無い（読み上げは地名を言わない）
      { lat: 37.0, lng: 137.5, index: -1, peak: { lat: 37.0, lng: 137.5 }, points: [] },
    ])
  })
})

// 地域単位の発報の位置は、束を作った 1 点（`epicenter`）ではなく解決できたメンバーの重心にする。
// 広がった揺れでは束の起点がメンバー全体の真ん中から外れ、距離のしきい値の前提が崩れる。
describe('deriveKyoshinView: confirmedShocks の位置はメンバーの重心', () => {
  const sites: SiteCoords = [
    [35.0, 139.0],
    [36.0, 140.0],
  ]
  const keys = sites.map(([lat, lng]) => siteKey(lat, lng))

  it('[正] epicenter ではなく、解決できたメンバーの重心を返す', () => {
    const view = derive(
      [fakeEvent({ id: 'evt-1', confidence: 'confirmed', memberKeys: keys, maxIntensity: 2.0, epicenter: [35.0, 139.0] })],
      sites,
      [9, 9],
    )
    expect(view.confirmedShocks[0].lat).toBeCloseTo(35.5, 9)
    expect(view.confirmedShocks[0].lng).toBeCloseTo(139.5, 9)
  })

  it('[正] 索引に無いメンバーは重心の計算から外す', () => {
    const view = derive(
      [fakeEvent({ id: 'evt-1', confidence: 'confirmed', memberKeys: [...keys, 'unknown-key'], maxIntensity: 2.0, epicenter: [0, 0] })],
      sites,
      [9, 9],
    )
    expect(view.confirmedShocks[0].lat).toBeCloseTo(35.5, 9)
    expect(view.confirmedShocks[0].lng).toBeCloseTo(139.5, 9)
  })

  it('[安全弁] 1 点も解決できなければ epicenter を使う', () => {
    const view = derive(
      [fakeEvent({ id: 'evt-1', confidence: 'confirmed', memberKeys: ['unknown-key'], maxIntensity: 2.0, epicenter: [34.0, 133.0] })],
      sites,
      [9, 9],
    )
    expect(view.confirmedShocks).toEqual([{ lat: 34.0, lng: 133.0, index: -1, peak: { lat: 34.0, lng: 133.0 }, points: [] }])
  })
})

// 確かな段の要約の index は、通知の「最大リアルタイム震度」の呼び名（`kyoshinDetectionScaleLabel`）へ渡る。
// 欠測を 0 に丸めると、計測震度 -3.0 の値があるように「0以下」と名乗る
describe('deriveKyoshinView: confirmedShocks の index と欠測', () => {
  const sites: SiteCoords = [
    [35.0, 139.0],
    [36.0, 140.0],
  ]
  const keys = sites.map(([lat, lng]) => siteKey(lat, lng))
  const confirmed = () => [fakeEvent({ id: 'evt-1', confidence: 'confirmed', memberKeys: keys, maxIntensity: null, epicenter: [35.0, 139.0] })]

  it('[正] メンバーが全員欠測なら -1 にし、通知の呼び名を付けない', () => {
    const view = derive(confirmed(), sites, [-1, -1])
    expect(view.confirmedShocks[0].index).toBe(-1)
    expect(kyoshinDetectionScaleLabel(view.confirmedShocks[0].index)).toBeNull()
  })

  it('[対照] 震度0 未満の値（index 0 = 計測震度 -3.0）は欠測ではないので「0以下」と呼ぶ', () => {
    const view = derive(confirmed(), sites, [0, -1])
    expect(view.confirmedShocks[0].index).toBe(0)
    expect(kyoshinDetectionScaleLabel(view.confirmedShocks[0].index)).toBe('0以下')
  })

  it('[安全弁] 1 点でも震度の値があれば、その値を採る（欠測の点は最大に効かない）', () => {
    const view = derive(confirmed(), sites, [9, -1])
    expect(view.confirmedShocks[0].index).toBe(9)
  })
})

describe('deriveKyoshinView: 最大震度が無い likely の扱い', () => {
  const sites: SiteCoords = [
    [35.0, 139.0],
    [36.0, 140.0],
  ]
  const keyA = siteKey(35.0, 139.0)
  const keyB = siteKey(36.0, 140.0)

  it('[対照] 最大震度が null の likely は、値のある likely より前にあっても主候補にならない', () => {
    const view = derive(
      [
        fakeEvent({ id: 'evt-null', confidence: 'likely', memberKeys: [keyA], maxIntensity: null }),
        fakeEvent({ id: 'evt-low', confidence: 'likely', memberKeys: [keyB], maxIntensity: 0.1 }),
      ],
      sites,
      [9, 7],
    )
    expect(view.candidateId).toBe('evt-low')
    expect(view.candidatePoints.map((p) => p.key)).toEqual([keyB])
  })

  it('[安全弁] likely が最大震度 null の 1 件だけなら、それを主候補にする（候補を消さない）', () => {
    const view = derive(
      [fakeEvent({ id: 'evt-null', confidence: 'likely', memberKeys: [keyA], maxIntensity: null })],
      sites,
      [9, 7],
    )
    expect(view.candidate).toBe(true)
    expect(view.candidateId).toBe('evt-null')
  })
})
