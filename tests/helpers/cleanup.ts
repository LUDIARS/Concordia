/**
 * テストリソースの後始末レジストリ.
 *
 * makeTestDb / makeTestApp が生成した DB ハンドル・tmpdir・env 退避を登録し、
 * tests/helpers/setup.ts (vitest setupFiles) の afterEach が毎テスト後に
 * LIFO で flush する。テストファイル側に後始末コードを書かなくても
 * リークしないことを保証するための仕組み。
 */

const cleanups: Array<() => void> = [];

export function registerCleanup(fn: () => void): void {
  cleanups.push(fn);
}

export function flushCleanups(): void {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    try {
      fn();
    } catch {
      // 後始末の失敗でテスト結果を汚さない (close 済み DB の二重 close 等)
    }
  }
}
