// 画面の上端（ステータスバー）を誰が避けるかを固定する（規則は docs/spec/architecture-spec.md
// 「画面いっぱいへの広がりとセーフエリア」規則 2・規則 4）。
//
// 上端はルートの外枠が余白で避け、外枠の中の部品は避けない。片方だけ動かすと、ステータスバーの裏まで
// 広がる iOS の起動でだけ、余白が消える（地図にぼかしが掛かる）か二重に下がる。どちらも iOS の実機でしか
// 見えず、型検査にも描画のテストにも掛からない（jsdom は env() の値を解かない）ので、書き方を文字で見る。
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative, sep } from 'node:path'
import { OVERLAY_BACKDROP_PAD, ROOT_FRAME_TOP_INSET } from './rootFrame'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const boundary = readFileSync(new URL('./components/ErrorBoundary.tsx', import.meta.url), 'utf8')
const settings = readFileSync(new URL('./components/SettingsTab/SettingsDialog.tsx', import.meta.url), 'utf8')

describe('画面の上端を避ける受け持ち', () => {
  // 正: 外枠（App のルートと、例外時の代わりの画面）が上の安全領域の分だけ余白を取る
  it('外枠は上の安全領域の分の余白を取る', () => {
    expect(ROOT_FRAME_TOP_INSET).toBe('env(safe-area-inset-top, 0px)')
    expect(app).toContain('style={{ paddingTop: ROOT_FRAME_TOP_INSET }}')
    expect(boundary).toContain('paddingTop: `calc(1.5rem + ${ROOT_FRAME_TOP_INSET})`')
  })

  // 対照: 外枠の中の部品（地図の上の隅の列など）は上の安全領域を足さない。足すと二重に下がる
  it('App の中で上の安全領域を直に書いている箇所は無い', () => {
    expect(app).not.toContain('safe-area-inset-top')
  })

  // 安全弁: 例外時の代わりの画面は p-6 の上の余白（1.5rem）を保ったまま足す。外枠の外に描く設定の窓は、
  // 外枠の余白が効かないので見出しが自分で避ける
  it('代わりの画面の余白と、外枠の外の窓の避け方は残っている', () => {
    expect(boundary).toMatch(/className=\{`\$\{ROOT_FRAME_CLASS\}[^`]*\bp-6\b/)
    expect(settings).toMatch(/paddingTop: 'max\(0\.5rem,\s*env\(safe-area-inset-top/)
  })
})

// 画面全体を覆う窓は、`src` の .tsx から外枠のクラス（`fixed inset-0 z-100000`）で探す。手で並べると、新しい窓を足したときに漏れる
const srcDir = fileURLToPath(new URL('.', import.meta.url))
const tsxFiles = (readdirSync(srcDir, { recursive: true }) as string[])
  .filter(f => f.endsWith('.tsx') && !/\.(test|spec)\.tsx$/.test(f))
// 設定の窓は外枠ではなく見出しが上端を避ける（狭い画面で窓が画面いっぱいになり、見出しの背景をステータスバーの下まで伸ばすため）
const HEADER_AVOIDS_TOP = new Set(['components/SettingsTab/SettingsDialog.tsx'])

describe('外枠の外に描く、画面全体を覆う窓', async () => {
  const overlays = (await Promise.all(tsxFiles.map(async f => ({
    path: relative(srcDir, join(srcDir, f)).split(sep).join('/'),
    src: await readFile(join(srcDir, f), 'utf8'),
  })))).filter(({ src }) => src.includes('fixed inset-0 z-100000'))
  const padded = overlays.filter(({ path }) => !HEADER_AVOIDS_TOP.has(path))

  // 探し方そのものが効いていることを確かめる（0 件で全部通る形にしない）
  it('窓を見つけている', () => {
    expect(padded.length).toBeGreaterThanOrEqual(6)
    expect(overlays.map(o => o.path)).toEqual(expect.arrayContaining([...HEADER_AVOIDS_TOP]))
  })

  // 正: 窓の外枠は上の安全領域を避ける余白を持つ
  it('外枠の余白は上だけ安全領域の大きいほうを取る', () => {
    expect(OVERLAY_BACKDROP_PAD).toContain('pt-[max(0.5rem,env(safe-area-inset-top,0px))]')
    expect(OVERLAY_BACKDROP_PAD).toContain('sm:pt-[max(1.5rem,env(safe-area-inset-top,0px))]')
    for (const { path, src } of padded) {
      expect(src, path).toContain('bg-black/60 ${OVERLAY_BACKDROP_PAD}')
    }
  })

  // 安全弁: 残りの 3 辺は今までどおり p-2・sm:p-6
  it('残りの辺の余白は p-2・sm:p-6 のまま', () => {
    expect(OVERLAY_BACKDROP_PAD.split(' ')).toEqual(expect.arrayContaining(['p-2', 'sm:p-6']))
  })

  // 対照: 上の安全領域を見ずに p-2・sm:p-6 だけを直に書いた窓は無い
  it('画面全体を覆う窓で、上の安全領域を見ていないものは無い', () => {
    for (const { path, src } of padded) {
      expect(src, path).not.toMatch(/fixed inset-0 z-100000[^"`]*\bp-2 sm:p-6\b/)
    }
  })
})
