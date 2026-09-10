const { codePointLength } = require("../contracts/sectionPolicy");

function summarizeMemoryItems(state) {
  const rows = [];
  for (const [section, items] of Object.entries({ ...state.working, ...state.longTerm })) {
    if (!Array.isArray(items)) continue;
    for (const item of items) rows.push({ section, itemId: item.id, chars: codePointLength(item.text), sourceCount: item.sourceRefs.length });
  }
  for (const [field, item] of Object.entries(state.current.scene)) {
    rows.push({ section: "scene", field, chars: codePointLength(item.value), sourceCount: item.sourceRefs.length });
  }
  return rows;
}

function summarizeWriteEvents(events) {
  return events.map(event => {
    const operation = event.normalizedOperation;
    const values = [operation?.value, operation?.result, ...(operation?.parts || []).map(part => part.value)].filter(Boolean);
    return {
      section: event.section, action: event.op, decision: event.decision, reason: event.rejectReason || null,
      results: values.map(value => ({ chars: codePointLength(typeof value === "string" ? value : value.text),
        sourceCount: (value.sourceRefs || operation?.sourceRefs || []).length })),
    };
  });
}

module.exports = { summarizeMemoryItems, summarizeWriteEvents };
