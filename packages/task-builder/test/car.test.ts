import assert from "node:assert/strict";
import test from "node:test";
import * as car from "@silvermoon-work/task-bundle-car";
import * as tree from "@silvermoon-work/task-bundle-car/tree";
import * as builderCar from "../src/car.js";
import * as builderTree from "../src/tree.js";

test("builder CAR/tree subpaths re-export the same compiler-free implementations", () => {
  assert.deepEqual(builderCar, car);
  assert.deepEqual(builderTree, tree);
});
