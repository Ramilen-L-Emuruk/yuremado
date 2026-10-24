import type { Map as MapLibreMap, MapMouseEvent, Popup } from 'maplibre-gl'
import { closeMapPopup } from './popupRegistry'
import { log } from '../../../utils/logger'

/**
 * 津波の観測点の印（観測棒・到達確認・欠測。どれも `maplibregl.Marker` の DOM 要素）の吹き出しを開け閉めする。
 *
 * **3 つの開き方を 1 か所に持つ**（別々に書くと、どれか 1 つの印だけ開き方が違う形でずれる）。
 * - マウスを乗せている間だけ開く（従来どおり）
 * - **印を押すと開いたままにする**（2026-10-21 ユーザー選択「押しても開く (Recommended)」。タッチでは乗せる操作が無い）。
 *   もう一度押すか、地図の別の場所を押すと閉じる。閉じるボタンは付けない（2026-10-24 ユーザー選択
 *   「もう一度か別の場所 (Recommended)」）
 * - **津波タブの観測点の行を押したとき、寄せたあとに開く**（2026-10-21 ユーザー選択「吹き出しも開く (Recommended)」。
 *   → {@link openTsunamiMarkerPopup}）
 *
 * **1 枚だけ出す。** 開いたままにするときは、地図の吹き出し（区域・海岸線。`popupRegistry`）と他の印の吹き出しを閉じる。
 * **印を押したことは地図の click へ伝えない** —— 伝えると、下地の海岸線の吹き出しが同時に開く
 * （MapLibre は地図の入れ物で DOM の click を受けて地図の click を出すので、印の上で伝播を止めれば届かない）。
 *
 * **マウスの判定は `pointerType` で行う。** iOS の Safari はタップでもマウスの乗せ外しを真似て発火するので、
 * `mouseenter` で開くと、続く click で開いたままにする前に閉じたり開いたりする。
 */
export interface TsunamiMarkerPopup {
  /** 開いたままにする（行から指したとき）。 */
  pin(): void
  /** 外す（印が地図から消えるとき）。 */
  dispose(): void
}

/** 印の種類。同じ観測点に棒と欠測の印が重なるとき、行から開くのは前の種類を優先する（数値を持つ棒が先）。 */
export type TsunamiMarkerKind = 'bar' | 'arrival' | 'missing'
const KIND_ORDER: readonly TsunamiMarkerKind[] = ['bar', 'arrival', 'missing']

interface Entry { kind: TsunamiMarkerKind; handle: TsunamiMarkerPopup; close: () => void; isPinned: () => boolean }
const entriesByMap = new WeakMap<MapLibreMap, Map<string, Entry[]>>()
/**
 * 開いたままの吹き出しを持っていた印が外れた観測点名。**同じ描き直しの中で同じ名前の印ができたら、そちらで開き直す**
 * —— 到達確認の印に波高が付くと観測棒へ、観測棒が欠測へ転じると欠測の印へ移る。印を作り直しただけで、読んでいた
 * 吹き出しが黙って閉じないようにする。印の外しと作り直しは別々のコンポーネントの effect なので、どちらが先かは決まらない。
 */
const pinCarryByMap = new WeakMap<MapLibreMap, string>()

function bestEntry(list: readonly Entry[]): Entry | undefined {
  return [...list].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))[0]
}

function entriesOf(map: MapLibreMap): Map<string, Entry[]> {
  let entries = entriesByMap.get(map)
  if (!entries) {
    entries = new Map()
    entriesByMap.set(map, entries)
  }
  return entries
}

function closeOthers(map: MapLibreMap, except: Entry): void {
  for (const list of entriesOf(map).values()) for (const e of list) if (e !== except) e.close()
}

/**
 * 印の要素に吹き出しを結ぶ。`lngLat` は開くたびに引く（差分更新で座標が変わっても古い位置へ開かない）。
 */
export function attachTsunamiMarkerPopup(
  map: MapLibreMap,
  el: HTMLElement,
  popup: Popup,
  name: string,
  kind: TsunamiMarkerKind,
  lngLat: () => [number, number],
): TsunamiMarkerPopup {
  let pinned = false
  const show = () => { popup.setLngLat(lngLat()).addTo(map) }
  const close = () => {
    pinned = false
    popup.remove()
  }
  const pin = () => {
    pinCarryByMap.delete(map)
    closeMapPopup(map)
    closeOthers(map, entry)
    // 開けてから「開いたまま」にする（開く途中で投げたとき、出ていない吹き出しを開いたままと数えない）
    show()
    pinned = true
  }
  // 開いたままの吹き出しが他にあるときは、乗せても開かない（出すのは 1 枚だけ）
  const anyPinned = () => [...entriesOf(map).values()].some(l => l.some(e => e.isPinned()))
  const onEnter = (e: PointerEvent) => { if (e.pointerType === 'mouse' && !pinned && !anyPinned()) show() }
  const onLeave = (e: PointerEvent) => { if (e.pointerType === 'mouse' && !pinned) popup.remove() }
  const onClick = (e: MouseEvent) => {
    e.stopPropagation()
    if (pinned) close()
    else pin()
  }
  // 地図の別の場所を押したら閉じる（印の上の click は上で止めているので、ここへ来るのは印の外だけ）。
  const onMapClick = (_e: MapMouseEvent) => { if (pinned) close() }
  el.addEventListener('pointerenter', onEnter)
  el.addEventListener('pointerleave', onLeave)
  el.addEventListener('click', onClick)
  map.on('click', onMapClick)

  const handle: TsunamiMarkerPopup = {
    pin,
    dispose: () => {
      el.removeEventListener('pointerenter', onEnter)
      el.removeEventListener('pointerleave', onLeave)
      el.removeEventListener('click', onClick)
      map.off('click', onMapClick)
      popup.remove()
      const wasPinned = pinned
      pinned = false
      const list = entriesOf(map).get(name) ?? []
      const rest = list.filter(e => e !== entry)
      if (rest.length > 0) entriesOf(map).set(name, rest)
      else entriesOf(map).delete(name)
      if (!wasPinned) return
      // 同じ観測点の別の印が先にできていればそちらで開き直す。まだなら、この描き直しの中でできる印へ引き継ぐ
      const next = bestEntry(rest)
      if (next) {
        // 地図ごと外している最中は、外し終わった地図へ開こうとして投げうる。投げると残りの印の後始末が止まるので閉じ込める
        try { next.handle.pin() } catch (err) { log.debug('[tsunamiMarkerPopup] 作り直した印で吹き出しを開き直せなかった', err) }
        return
      }
      pinCarryByMap.set(map, name)
      // 同じ描き直しの中でできなければ捨てる（しばらくして同じ観測点が現れたとき、勝手に開かない）
      setTimeout(() => { if (pinCarryByMap.get(map) === name) pinCarryByMap.delete(map) }, 0)
    },
  }
  const entry: Entry = { kind, handle, close, isPinned: () => pinned }
  const list = entriesOf(map).get(name) ?? []
  entriesOf(map).set(name, [...list, entry])
  if (pinCarryByMap.get(map) === name) pin()
  return handle
}

/**
 * 印の吹き出しをすべて閉じる（行から地図を寄せるとき。`closeMapPopup` は地図の吹き出しだけを閉じ、印の吹き出しは
 * そちらに登録していないので、別に閉じないと前の観測点を指したまま画面の端に残る）。
 */
export function closeTsunamiMarkerPopups(map: MapLibreMap): void {
  pinCarryByMap.delete(map)
  for (const list of entriesOf(map).values()) for (const e of list) e.close()
}

/**
 * 観測点名の印の吹き出しを開いたままにする（津波タブの行を押して寄せたあと）。印が無ければ何もせず偽を返す
 * （座標表にはあるが印を描いていない観測点＝予測だけの観測点。寄せるだけで終わる）。
 */
export function openTsunamiMarkerPopup(map: MapLibreMap, name: string): boolean {
  const list = entriesOf(map).get(name)
  if (!list || list.length === 0) return false
  bestEntry(list)!.handle.pin()
  return true
}
