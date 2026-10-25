// プレート境界線データ（public/data/plate-boundaries.json）を読み込むユーティリティ。
//
// データは scripts/build-plate-boundaries.mjs で生成・更新する。
// 出典: PB2002 (Bird, 2003) — https://github.com/fraxen/tectonicplates（Open Data Commons Attribution License）

import { fetchJsonWithTimeout } from './fetchJson'

export type LatLng = [number, number]

/**
 * 境界の種別。PB2002 の原典が歩ごとに付ける 7 分類（`scripts/lib/plateSteps.mjs`）。
 *
 * SUB 沈み込み帯／OCB 海洋の収束境界／CCB 大陸の収束境界／OSR 海洋の拡大軸／CRB 大陸のリフト／
 * OTF 海洋のトランスフォーム断層／CTF 大陸のトランスフォーム断層
 */
export type PlateBoundaryClass = 'SUB' | 'OCB' | 'CCB' | 'OSR' | 'CRB' | 'OTF' | 'CTF'

/** 凡例と色の系統。7 分類を 4 つにまとめる（2026-10-25 ユーザー承認「B の案でよい (Recommended)」）。 */
export type PlateBoundaryGroup = 'subduction' | 'convergent' | 'divergent' | 'transform'

/** 分類ごとの吹き出しの語と系統。吹き出しは 7 分類のまま出し、色と凡例は系統で分ける。 */
export const PLATE_BOUNDARY_CLASSES: Record<PlateBoundaryClass, { label: string; group: PlateBoundaryGroup }> = {
  SUB: { label: '沈み込み帯', group: 'subduction' },
  OCB: { label: '海洋の収束境界', group: 'convergent' },
  CCB: { label: '大陸の収束境界', group: 'convergent' },
  OSR: { label: '海洋の拡大軸', group: 'divergent' },
  CRB: { label: '大陸のリフト', group: 'divergent' },
  OTF: { label: '海洋のトランスフォーム断層', group: 'transform' },
  CTF: { label: '大陸のトランスフォーム断層', group: 'transform' },
}

export interface PlateBoundarySegment {
  plateA: string
  plateB: string
  type: PlateBoundaryClass
  lines: LatLng[][]
}

const DATA_URL = `${import.meta.env.BASE_URL}data/plate-boundaries.json`

let cache: PlateBoundarySegment[] | null = null
let inflight: Promise<PlateBoundarySegment[]> | null = null

/**
 * 全球のプレート境界線データを取得する。初回のみ fetch し、以降はキャッシュを返す。
 * 取得に失敗した場合（タイムアウトを含む）は inflight を破棄して次回リトライ可能にする。
 */
export function loadPlateBoundaries(): Promise<PlateBoundarySegment[]> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetchJsonWithTimeout<PlateBoundarySegment[]>(DATA_URL, 'plate-boundaries')
      .then((data) => {
        cache = data
        return data
      })
      .catch((err) => {
        inflight = null
        throw err
      })
  }
  return inflight
}
