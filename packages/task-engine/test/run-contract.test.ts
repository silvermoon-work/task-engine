import assert from "node:assert/strict";
import test from "node:test";
import {
  compileInputSchema,
  compileJsonSchema,
  validateRunProgress,
} from "@silvermoon-work/task-protocol";

test("boolean 消息契约区分 Never 与任意 JSON，不放宽 Input object 根", () => {
  const never = compileJsonSchema(false);
  for (const value of [{}, null, true, false, 0, "", []])
    assert.throws(() => never.validate(value), { code: "invalid_input" });
  for (const schema of [true, {}]) {
    const contract = compileJsonSchema(schema);
    for (const value of [{}, null, true, 0, "文本", []])
      assert.deepEqual(contract.validate(value), value);
  }
  assert.throws(() => compileInputSchema(false), { code: "invalid_schema" });
  assert.throws(() => compileInputSchema({}), { code: "invalid_schema" });
});

test("通用 JSON Schema 保留本地引用和包含 $ref 字段的常量含义", () => {
  const contract = compileJsonSchema({
    $defs: { number: { type: "number", minimum: 1 } },
    $ref: "#/$defs/number",
  });
  assert.equal(contract.validate(2), 2);
  assert.throws(() => contract.validate(0), { code: "invalid_input" });
  const value = { $ref: "#/literal", nested: { $ref: "#" } };
  assert.deepEqual(compileJsonSchema({ const: value }).validate(value), value);
  assert.throws(() => compileJsonSchema({ $ref: "https://example.test/schema" }), {
    code: "invalid_schema",
  });
});

test("RunProgress 未知百分比不变成 0，阶段百分比不是终结依据", () => {
  assert.deepEqual(validateRunProgress({ stage: "allocation", message: "" }), {
    stage: "allocation",
    message: "",
  });
  for (const stage of ["preparation", "allocation", "execution"])
    for (const percent of [0, 37.5, 100])
      assert.equal(validateRunProgress({ stage, percent, message: "展示" }).percent, percent);
  for (const percent of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY, "0", null])
    assert.throws(() => validateRunProgress({ stage: "execution", percent, message: "" }));
  for (const value of [
    { stage: "completed", message: "" },
    { stage: "execution", message: {}, percent: 0 },
    { stage: "execution", message: "", data: { digest: "不是展示消息" } },
    { stage: "execution" },
  ])
    assert.throws(() => validateRunProgress(value), { code: "invalid_progress" });
});
