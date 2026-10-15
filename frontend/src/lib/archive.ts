import type { MonthCount } from "./api";

export interface YearGroup {
  year: string;
  total: number;
  /** 1〜12 月の記事数。無い月は 0 */
  months: number[];
}

/** `YYYY-MM` の月別件数を、新しい年から並べた年ごとのカレンダーにする。 */
export function groupByYear(months: MonthCount[]): YearGroup[] {
  const byYear = new Map<string, YearGroup>();
  for (const { month, count } of months) {
    const [year, mm] = month.split("-");
    const group = byYear.get(year) ?? { year, total: 0, months: Array(12).fill(0) };
    group.months[Number(mm) - 1] += count;
    group.total += count;
    byYear.set(year, group);
  }
  return [...byYear.values()].sort((a, b) => b.year.localeCompare(a.year));
}

/** `2019` と `11` を検証して `2019-11` にする。範囲外なら null。 */
export function parseMonth(year: string | undefined, month: string | undefined): string | null {
  if (!year || !month || !/^\d{4}$/.test(year) || !/^\d{1,2}$/.test(month)) return null;
  const m = Number(month);
  if (m < 1 || m > 12) return null;
  return `${year}-${String(m).padStart(2, "0")}`;
}
