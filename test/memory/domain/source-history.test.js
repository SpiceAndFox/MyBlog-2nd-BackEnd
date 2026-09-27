const test = require("node:test");
const assert = require("node:assert/strict");
const { snapshotRecoveryBounds } = require("../../../modules/memory/domain/sourceHistory");

test("recovery bounds include every intervening source mutation, including forgotten influence", () => {
  const history = [
    { source_generation: "4", source_unchanged: false, affected_from_message_id: "800" },
    { source_generation: "3", source_unchanged: true, affected_from_message_id: null },
    { source_generation: "2", source_unchanged: false, affected_from_message_id: "300" },
  ];
  assert.deepEqual([...snapshotRecoveryBounds(4, 900, history)], [[4, 900], [3, 800], [2, 800], [1, 300]]);
});

test("legacy gaps and unknown changes cannot certify old generations", () => {
  for (const history of [[], [{ source_generation: 3, source_unchanged: true }],
    [{ source_generation: 4, source_unchanged: false, affected_from_message_id: null }]]) {
    assert.deepEqual([...snapshotRecoveryBounds(4, 900, history)], [[4, 900]]);
  }
});
