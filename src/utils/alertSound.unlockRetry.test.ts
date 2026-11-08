import { describe, it, expect, beforeAll } from 'vitest'

// `unlockAudio()` が「AudioContext が動き出すまで、呼ばれるたびに再開を試す」ことの検証。
//
// **なぜ専用ファイルなのか。** alertSound は AudioContext をモジュール変数に 1 つだけ持つ。再開が効かない
// （iPhone で指が触れた瞬間の pointerdown のように、操作と数えられない瞬間に呼ばれた）形を作るには、
// resume() を呼んでも状態が変わらない偽物が要り、他のテストの偽物（resume で即 running）とは同居できない。

class FakeNode {
  connect(): void { /* 接続先は検証対象ではない */ }
}

class FakeAudioContext {
  readonly sampleRate = 48000
  currentTime = 0
  state: string = 'suspended'
  readonly destination = new FakeNode()
  resumeCalls = 0
  /** true の間は resume() しても動き出さない（操作と数えられない瞬間の再開） */
  denyResume = true

  resume(): Promise<void> {
    this.resumeCalls++
    if (this.denyResume) return Promise.reject(new Error('操作の中ではない（テスト用）'))
    // 実ブラウザと同じく、動き出すのは resume() から戻った後（非同期）
    return Promise.resolve().then(() => { this.state = 'running' })
  }
  createGain(): FakeNode & { gain: { value: number } } {
    return Object.assign(new FakeNode(), { gain: { value: 1 } })
  }
  createDynamicsCompressor(): FakeNode {
    return Object.assign(new FakeNode(), {
      threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 },
      attack: { value: 0 }, release: { value: 0 },
    })
  }
}

const ctx = new FakeAudioContext()

beforeAll(() => {
  ;(globalThis as unknown as { window: unknown }).window = {
    AudioContext: function FakeCtor(this: unknown) { return ctx } as unknown as typeof AudioContext,
  }
})

const sound = await import('./alertSound')

describe('unlockAudio: 動き出すまで呼ばれるたびに再開を試す', () => {
  it('正: 再開が効かなかったら false を返し、次の呼び出しでもう一度再開を試す', async () => {
    expect(sound.unlockAudio()).toBe(false)
    expect(ctx.resumeCalls).toBe(1)
    await Promise.resolve()
    expect(sound.unlockAudio()).toBe(false)
    expect(ctx.resumeCalls).toBe(2)
  })

  it('正: 再開が効いて動き出したら、次の呼び出しで true を返す（呼び出し側は見張りを外せる）', async () => {
    ctx.denyResume = false
    // 再開は非同期なので、効く操作の呼び出し自体はまだ false（呼び出し側は見張りを外さない）
    expect(sound.unlockAudio()).toBe(false)
    await Promise.resolve()
    await Promise.resolve()
    expect(ctx.state).toBe('running')
    expect(sound.unlockAudio()).toBe(true)
  })

  it('対照: 動いている間は再開を呼ばない', () => {
    const before = ctx.resumeCalls
    expect(sound.unlockAudio()).toBe(true)
    expect(ctx.resumeCalls).toBe(before)
  })

  it('安全弁: 電話などで止まった（interrupted）ときも再開を試す', () => {
    ctx.state = 'interrupted'
    const before = ctx.resumeCalls
    sound.unlockAudio()
    expect(ctx.resumeCalls).toBe(before + 1)
  })
})
