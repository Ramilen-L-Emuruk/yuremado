import { Marquee } from './Marquee'
import { useSyncExternalStore } from 'react'
import { useMessages } from '../i18n/I18nProvider'
import { subscribeRenderHealth, getRenderHealth, type MapLayerName } from '../utils/renderHealth'

/**
 * 名前を並べるときに出す上限。超えたぶんは件数でまとめる。
 * 同時に壊れるのは 1〜2 件が普通で、全部並べると地図を覆う。
 */
const MAX_NAMES = 3

/**
 * 地図の描画物が描けているかを知らせる（`utils/renderHealth.ts`）。
 *
 * 取得の失敗を出す `MapDataStatus` と対になる。あちらは「データが来なかった」、
 * こちらは**「来たのに描けなかった」**。
 *
 * これが無いと、たとえば震源カタログは件数だけ正しく出したまま地図が空になり、
 * 利用者は絞り込みの結果と区別できない。正常時は何も描かない。
 */
export function MapRenderStatus() {
  const health = useSyncExternalStore(subscribeRenderHealth, getRenderHealth, getRenderHealth)
  const messages = useMessages()
  const t = messages.mapCorner
  const nameList = (names: readonly MapLayerName[]): string =>
    t.nameList(names.slice(0, MAX_NAMES).map((n) => messages.map.layerName[n]), Math.max(0, names.length - MAX_NAMES))
  if (health.broken.length === 0 && health.uninteractive.length === 0) return null

  return (
    <div className="bg-panel/90 rounded-sm text-xs px-2 py-0.5 roomy:text-lg roomy:px-2.5 roomy:py-1 text-amber-300">
      {/* 文の形（言い切り・名前を主語に置く・この帯だけ括弧を使わない）の規約と理由は
          `docs/spec/settings-pwa-spec.md` §5.5「通知の文の形」。 */}
      {health.broken.length > 0 && (
        <Marquee text={t.cannotDraw(nameList(health.broken))} />
      )}
      {health.uninteractive.length > 0 && (
        <Marquee text={t.notClickable(nameList(health.uninteractive))} />
      )}
      {/* **手掛かりは 2 つに共通なので 1 行にまとめる。** 片方にだけ添えると、もう片方は
          打つ手が無いように読める（実際にはどちらも同じ——一時的な不調なら作り直しで直り、
          恒久的なものならどちらも直らない）。
          再読み込みを挙げているのは、地図ごと作り直すとシェーダーも判定も新しく用意されるため。
          アプリが自分で作り直す機会（投影の切り替え）もあるが、利用者に案内できる操作ではない。 */}
      <Marquee className="opacity-80" text={messages.errorScreen.reloadMayFix} />
    </div>
  )
}
