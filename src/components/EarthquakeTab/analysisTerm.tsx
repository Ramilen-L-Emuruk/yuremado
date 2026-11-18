import type { ReactNode } from 'react'
import { DescriptionTip } from '../DescriptionTip'
import { useMessages } from '../../i18n/I18nProvider'
import type { AnalysisSource } from '../../services/relayAnalysis'

/**
 * 解析の窓の外（カードの要約の行・地図の凡例）からも使う小さな部品。
 * 窓の中身（`QuakeAnalysisDialog.tsx`・`QuakeAnalysisAgency.tsx`）は開いたときに読むので、
 * こちらから窓の部品を import しないこと（import すると窓ごと起動時のチャンクへ戻る）
 */

export type AnalysisWords = ReturnType<typeof useMessages>['quake']['analysis']
export interface Tip { text: string; src: string }

export const sourceName = (w: AnalysisWords, s: AnalysisSource) => (s === 'jma' ? w.jma : s === 'usgs' ? 'USGS' : s === 'emsc' ? 'EMSC' : 'GEOFON')

/**
 * 点線の語。押す・乗せる・焦点で説明を吹き出しに出す（設定の窓の説明と同じ部品）。
 * `also` は同じ語に重ねて要る 2 つ目の説明（気象庁の「CMT 解（精査後）」の「精査後」）で、出典ごと下に続ける
 */
export function Term({ label, tip, also = null, figure = null, className = 'text-inherit' }: { label: string; tip: Tip; also?: Tip | null; figure?: ReactNode; className?: string }) {
  const w = useMessages().quake.analysis
  return (
    <DescriptionTip
      label={label}
      labelClassName={className}
      description={(
        <span className="flex max-w-[19rem] flex-col gap-1 text-[#e5e7eb]">
          <span>{tip.text}</span>
          {figure}
          <span className="text-[10.5px] text-secondary">{w.credit}: {tip.src}</span>
          {also && <span>{also.text}</span>}
          {also && <span className="text-[10.5px] text-secondary">{w.credit}: {also.src}</span>}
        </span>
      )}
    />
  )
}
