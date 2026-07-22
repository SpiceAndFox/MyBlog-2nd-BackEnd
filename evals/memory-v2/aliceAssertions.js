function acceptedOperations(report, section) {
  return (report?.replay?.reducerPreflight?.events || [])
    .filter((event) => event.decision === "accepted" && event.section === section);
}

function evaluateAliceTaskReplay(report) {
  const task = report?.task || {};
  const observed = new Set(task.observedMessageIds || []);
  const includes = (ids) => ids.every((id) => observed.has(id));
  const includesNewEvidence = (ids) => includes(ids)
    && ids.some((id) => id > Number(task.sourceBoundary?.cursorBefore ?? 0));
  const assertions = [];
  const add = (id, applicable, passed, detail) => assertions.push({
    id,
    applicable,
    passed: applicable ? Boolean(passed) : null,
    detail,
  });

  const agreementCheck = (id, ids) => {
    const applicable = task.targetKey === "standingAgreements" && includesNewEvidence(ids);
    const accepted = acceptedOperations(report, "standingAgreements")
      .some((event) => ["addItem", "updateItem"].includes(event.op));
    add(id, applicable, accepted,
      applicable ? "expected an accepted standing agreement add/update" : "required messages are outside this task");
  };
  agreementCheck("alice_strawberry_agreement_528_529", [528, 529]);
  agreementCheck("alice_daily_breakfast_agreement_729_730", [729, 730]);

  const creationApplicable = task.targetKey === "todos" && includesNewEvidence([684, 687, 696]);
  const created = acceptedOperations(report, "todos").some((event) => event.op === "addItem");
  add("alice_sandwich_todo_creation_684_696", creationApplicable, created,
    creationApplicable ? "expected an accepted addItem" : "commitment messages are outside this task");

  const completionApplicable = task.targetKey === "todos" && includesNewEvidence([724, 727, 728]);
  const completed = acceptedOperations(report, "todos").some((event) => event.op === "completeTodo");
  add("alice_sandwich_todo_completion_724_728", completionApplicable, completed,
    completionApplicable ? "expected an accepted completeTodo" : "completion messages are outside this task");

  const tomorrowApplicable = task.targetKey === "todos" && includesNewEvidence([1078, 1079, 1080]);
  const tomorrowAdds = report?.replay?.semanticResult?.sectionResults?.todos?.changes?.filter((change) => (
    change.action === "add" && change.dueAt?.mode === "relative" && change.dueAt.days === 1
  )) || [];
  const acceptedTodoAdds = acceptedOperations(report, "todos").filter((event) => event.op === "addItem").length;
  add("alice_two_tomorrow_todos_1078_1080", tomorrowApplicable,
    tomorrowAdds.length >= 2 && acceptedTodoAdds >= 2,
    tomorrowApplicable ? "expected two accepted todo adds with relative days=1" : "required messages are outside this task");

  const episodeApplicable = task.targetKey === "episodes"
    && task.sourceBoundary?.targetMessageId >= 1077
    && [...observed].some((id) => id >= 975 && id <= 1077);
  const episodeWritten = acceptedOperations(report, "recentEpisodes")
    .some((event) => ["addItem", "updateItem"].includes(event.op));
  add("alice_night_out_episode_975_1077", episodeApplicable, episodeWritten,
    episodeApplicable ? "expected an accepted recent episode add/update" : "the closing episode window is outside this task");

  const applicable = assertions.filter((entry) => entry.applicable);
  return {
    passed: applicable.length ? applicable.every((entry) => entry.passed) : null,
    applicableCount: applicable.length,
    assertions,
  };
}

module.exports = { evaluateAliceTaskReplay };
