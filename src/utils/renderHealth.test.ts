// 描画物の不調の集約を固定する。
// 背景は docs/spec/map-rendering-spec.md §16「描けているかを画面に出す」。
import { describe, it, expect, beforeEach } from 'vitest'
import { reportRenderFailure, clearRenderFailure, subscribeRenderHealth, getRenderHealth, resetRenderHealthForTest, clearRenderFailuresFor } from './renderHealth'

beforeEach(() => {
  resetRenderHealthForTest()
})

describe('renderHealth', () => {
  // 正: 何も無ければ空。
  it('既定は空', () => {
    expect(getRenderHealth().broken).toEqual([])
    expect(getRenderHealth().uninteractive).toEqual([])
  })

  // 正: 種別ごとに分かれて出る。
  it('種別ごとに分けて持つ', () => {
    reportRenderFailure('a', 'catalog', 'draw')
    reportRenderFailure('b', 'dayNight', 'interact')
    expect(getRenderHealth().broken).toEqual(['catalog'])
    expect(getRenderHealth().uninteractive).toEqual(['dayNight'])
  })

  // **正: 同じレイヤーが両方を抱えられる。**
  // 鍵に種別を含めていないと、描けない側が毎フレーム報告するので掴めない側が必ず消える。
  it('同じレイヤーが描けないと掴めないを同時に持てる', () => {
    reportRenderFailure('a', 'catalog', 'draw')
    reportRenderFailure('a', 'catalog', 'interact')
    expect(getRenderHealth().broken).toEqual(['catalog'])
    expect(getRenderHealth().uninteractive).toEqual(['catalog'])
  })

  // 対照: 片方だけ解除しても、もう片方は残る。
  it('片方を解除しても他方は残る', () => {
    reportRenderFailure('a', 'catalog', 'draw')
    reportRenderFailure('a', 'catalog', 'interact')
    clearRenderFailure('a', 'draw')
    expect(getRenderHealth().broken).toEqual([])
    expect(getRenderHealth().uninteractive).toEqual(['catalog'])
  })

  // **安全弁: 繰り返し報告しても増えない。** 描画ループから毎フレーム呼ばれる経路がある。
  it('同じ報告を繰り返しても 1 件のまま', () => {
    for (let i = 0; i < 100; i++) reportRenderFailure('a', 'catalog', 'draw')
    expect(getRenderHealth().broken).toEqual(['catalog'])
  })

  // **安全弁: 変化が無ければ通知しない。** 毎フレームの報告で購読側が再描画されると、
  // 不調を知らせるためにフレームを落とすことになる。
  it('変化が無ければ購読者を起こさない', () => {
    let calls = 0
    subscribeRenderHealth(() => { calls++ })
    reportRenderFailure('a', 'catalog', 'draw')
    expect(calls).toBe(1)
    for (let i = 0; i < 100; i++) reportRenderFailure('a', 'catalog', 'draw')
    expect(calls).toBe(1)
  })

  // **安全弁: 中身が同じならスナップショットの参照も変えない。**
  // `useSyncExternalStore` は参照で変化を見るため、作り直すと無駄な再描画になる。
  it('中身が同じならスナップショットの参照が変わらない', () => {
    reportRenderFailure('a', 'catalog', 'draw')
    const first = getRenderHealth()
    reportRenderFailure('a', 'catalog', 'draw')
    expect(getRenderHealth()).toBe(first)
  })

  // 対照: 中身が変われば参照も変わる（上の安全弁が「常に同じ」になっていないこと）。
  it('中身が変われば参照も変わる', () => {
    reportRenderFailure('a', 'catalog', 'draw')
    const first = getRenderHealth()
    reportRenderFailure('b', 'quakeHypocenters', 'draw')
    expect(getRenderHealth()).not.toBe(first)
    expect(getRenderHealth().broken).toEqual(['catalog', 'quakeHypocenters'])
  })

  // 正: 解除で消え、購読者にも伝わる。
  it('解除すると消えて通知が飛ぶ', () => {
    let calls = 0
    reportRenderFailure('a', 'catalog', 'draw')
    subscribeRenderHealth(() => { calls++ })
    clearRenderFailure('a', 'draw')
    expect(getRenderHealth().broken).toEqual([])
    expect(calls).toBe(1)
  })

  // 安全弁: 記録が無いのに解除しても通知しない（消えたものを何度も消しにくる経路がある）。
  it('記録が無い解除では通知しない', () => {
    let calls = 0
    subscribeRenderHealth(() => { calls++ })
    clearRenderFailure('a', 'draw')
    expect(calls).toBe(0)
  })

  // **安全弁: ID に区切り文字が入っても別の組と混ざらない。**
  it('ID に区切り文字が入っても衝突しない', () => {
    reportRenderFailure('draw:a', 'psWave', 'interact')
    reportRenderFailure('a', 'subThreshold', 'draw')
    expect(getRenderHealth().broken).toEqual(['subThreshold'])
    expect(getRenderHealth().uninteractive).toEqual(['psWave'])
  })

  // 正: 名前を変えて報告し直したら差し替わる。
  it('同じ ID で名前を変えたら差し替わる', () => {
    reportRenderFailure('a', 'tsunamiSource', 'draw')
    reportRenderFailure('a', 'eewEpicenters', 'draw')
    expect(getRenderHealth().broken).toEqual(['eewEpicenters'])
  })
})

describe('自分が置いた報告だけ取り下げる（clearRenderFailure）', () => {
  // 安全弁: **ガードが別の鍵で付けた記録を巻き込まないこと。**
  // `Map/gl/guardRender.ts` は受け止めた例外を `<id>:uncaught` という別の鍵で記録し、
  // 「自分が報告したか」をクロージャの中だけで覚えている。外から消すと消されたことに
  // 気づけず、**例外が続いていても二度と報告しない**（画面は「描けている」と言い続ける）。
  it('ガードが別の鍵で付けた記録は巻き込まない', () => {
    reportRenderFailure('pswave', 'psWave', 'draw')
    reportRenderFailure('pswave:uncaught', 'psWave', 'draw')
    clearRenderFailure('pswave', 'draw')
    // 表示名は同じなので畳まれるが、記録自体は残っている（ガードが自分で取り下げる）。
    expect(getRenderHealth().broken).toEqual(['psWave'])
    clearRenderFailure('pswave:uncaught', 'draw')
    expect(getRenderHealth().broken).toEqual([])
  })

  // 対照: 種別が違うものは残すこと（描けないのを消したからといって、掴めないほうまで消さない）。
  it('種別が違う記録は残る', () => {
    reportRenderFailure('a', 'catalog', 'draw')
    reportRenderFailure('a', 'catalog', 'interact')
    clearRenderFailure('a', 'draw')
    expect(getRenderHealth().broken).toEqual([])
    expect(getRenderHealth().uninteractive).toEqual(['catalog'])
  })
})

describe('レイヤーを外したときの後始末（clearRenderFailuresFor）', () => {
  // 正: **ガードが足した記録も、レイヤーの ID で消せること。**
  // 鍵が違うぶん本人は消せず、外れた後は `render()` も呼ばれないのでガードの側にも
  // 機会が無い。ここで一緒に消さないと、画面から消えた描画物の名前が永久に居座る。
  it('その ID に付けられた記録を、種別も派生鍵もまとめて消す', () => {
    reportRenderFailure('pswave', 'psWave', 'draw')
    reportRenderFailure('pswave:uncaught', 'psWave', 'draw')
    reportRenderFailure('pswave', 'psWave', 'interact')
    clearRenderFailuresFor('pswave')
    expect(getRenderHealth().broken).toEqual([])
    expect(getRenderHealth().uninteractive).toEqual([])
  })

  // 対照: **名前が似ているだけの別レイヤーを巻き込まないこと。** 区切りまで見ずに前方一致で
  // 消すと、`hypocenter-depth` の後始末が `hypocenter-depth-2` を道連れにする。
  it('ID が前方一致するだけの別レイヤーは巻き込まない', () => {
    reportRenderFailure('hypocenter-depth', 'quakeHypocenters', 'draw')
    reportRenderFailure('hypocenter-depth-2', 'tsunamiSource', 'draw')
    clearRenderFailuresFor('hypocenter-depth')
    expect(getRenderHealth().broken).toEqual(['tsunamiSource'])
  })
})
