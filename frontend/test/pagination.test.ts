import assert from "node:assert/strict";
import { test } from "node:test";
import { pageWindow } from "../src/lib/pagination.ts";

test("少ないページは全部並べる", () => {
  assert.deepEqual(pageWindow(1, 3), [1, 2, 3]);
});

test("遠い区間は省略する", () => {
  assert.deepEqual(pageWindow(10, 30), [1, null, 8, 9, 10, 11, 12, null, 30]);
});

test("端では省略が片側だけ", () => {
  assert.deepEqual(pageWindow(1, 30), [1, 2, 3, null, 30]);
});
