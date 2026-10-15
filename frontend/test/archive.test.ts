import assert from "node:assert/strict";
import { test } from "node:test";
import { groupByYear, parseMonth } from "../src/lib/archive.ts";

test("月別の件数を新しい年から年ごとにまとめる", () => {
  const years = groupByYear([
    { month: "2020-03", count: 2 },
    { month: "2019-11", count: 5 },
    { month: "2019-01", count: 1 },
  ]);
  assert.deepEqual(
    years.map((y) => [y.year, y.total]),
    [["2020", 2], ["2019", 6]],
  );
  assert.equal(years[1].months[10], 5);
  assert.equal(years[1].months[0], 1);
  assert.equal(years[1].months[5], 0);
});

test("年月を検証して YYYY-MM にする", () => {
  assert.equal(parseMonth("2019", "11"), "2019-11");
  assert.equal(parseMonth("2019", "3"), "2019-03");
  assert.equal(parseMonth("2019", "13"), null);
  assert.equal(parseMonth("2019", "0"), null);
  assert.equal(parseMonth("19", "3"), null);
  assert.equal(parseMonth(undefined, "3"), null);
});
