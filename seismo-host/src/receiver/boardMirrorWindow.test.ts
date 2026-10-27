import { describe, expect, it } from 'vitest'
import { voteOf } from './boardMirrorWatch'
import { compareBoardsInWindow } from './boardMirrorWindow'
import { IIS, IIS_AXES, config, mirroredConfig, packets, window } from './boardMirror.fixture'
import type { StationConfig } from './stationConfigTypes'

describe('compareBoardsInWindow（区間の生データから、2 軸の基板の鏡像を比べる）', () => {
  it('正: 設定どおりに測っていれば、いまの向きの票', () => {
    const out = compareBoardsInWindow({ ...window, packets: packets(IIS_AXES), config: config(IIS_AXES) })
    expect(out.map((o) => o.boardKey)).toEqual([IIS])
    expect(out[0]!.comparison.current).toBeGreaterThan(0.9)
    expect(voteOf(out[0]!.comparison)).toBe('ok')
  })

  it('正: 鏡像の解を入れて鉛直を合わせ直した設定なら、鏡像の票', () => {
    const out = compareBoardsInWindow({ ...window, packets: packets(IIS_AXES), config: mirroredConfig() })
    expect(out[0]!.comparison.mirrored).toBeGreaterThan(0.9)
    expect(voteOf(out[0]!.comparison)).toBe('mirrored')
  })

  it('対照: 同じ観測点に 3 軸のセンサーが無ければ比べない', () => {
    const c = config(IIS_AXES)
    const only: StationConfig = { ...c, boards: c.boards.filter((b) => b.boardKey === IIS) }
    expect(compareBoardsInWindow({ ...window, packets: packets(IIS_AXES), config: only })).toEqual([])
  })

  it('対照: 別の観測点の揺れの区間では比べない', () => {
    expect(compareBoardsInWindow({ ...window, stationId: 'st2', packets: packets(IIS_AXES), config: config(IIS_AXES) })).toEqual([])
  })

  it('安全弁: 同じパケットが二重に入っても数えは変わらない', () => {
    const once = compareBoardsInWindow({ ...window, packets: packets(IIS_AXES), config: config(IIS_AXES) })
    const twice = compareBoardsInWindow({ ...window, packets: [...packets(IIS_AXES), ...packets(IIS_AXES)], config: config(IIS_AXES) })
    expect(twice[0]!.comparison.aligned).toBe(once[0]!.comparison.aligned)
  })
})
