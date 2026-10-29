/**
 * 組み合わせの揺れ検知器を動かす Web Worker。中身は `utils/kyoshinEnsembleWorkerHost.ts`。
 * 主スレッド側は `utils/kyoshinEnsembleWorkerClient.ts` がこれを立てる。
 */
import { attachEnsembleWorkerHost, type EnsembleWorkerRequest, type EnsembleWorkerResponse } from '../utils/kyoshinEnsembleWorkerHost'

const scope = self as unknown as {
  postMessage(msg: EnsembleWorkerResponse, transfer?: Transferable[]): void
  onmessage: ((ev: MessageEvent<EnsembleWorkerRequest>) => void) | null
}

attachEnsembleWorkerHost({
  postMessage: (msg, transfer) => scope.postMessage(msg, transfer ?? []),
  setMessageHandler: (fn) => {
    scope.onmessage = (ev) => fn(ev.data)
  },
})
