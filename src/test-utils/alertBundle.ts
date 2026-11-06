/**
 * テストの揺れ（`ConfirmedShock`）に付ける検知の束。場所ごとに別の束にする（同じ場所なら同じ束）。
 *
 * 始まりは読めない値（NaN）にしてある。速報へ走時で結ばない（`isBundleTiedToEew`）ので、束を足す前の
 * テストと同じ判定のまま通る。走時で結ぶ形を確かめるテストは、始まりを与えた束を自分で作る。
 */
export function testBundle(lat: number, lng: number): { id: string; startedAtMs: number; epicenter: { lat: number; lng: number } } {
  return { id: `b${lat},${lng}`, startedAtMs: NaN, epicenter: { lat, lng } }
}
