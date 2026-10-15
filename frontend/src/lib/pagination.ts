/** 1 と最終ページ、現在ページの前後を並べ、飛ばした区間は null(省略記号)にする。 */
export function pageWindow(page: number, lastPage: number, around = 2): (number | null)[] {
  const keep = new Set<number>([1, lastPage]);
  for (let i = page - around; i <= page + around; i++) if (i >= 1 && i <= lastPage) keep.add(i);
  const out: (number | null)[] = [];
  let prev = 0;
  for (const n of [...keep].sort((a, b) => a - b)) {
    if (n - prev > 1) out.push(null);
    out.push(n);
    prev = n;
  }
  return out;
}
