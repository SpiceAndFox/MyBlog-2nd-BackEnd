function mapEventToRow(event, envelope, eventGroupId, index, { maintenanceTaskId = null } = {}) {
  const task = envelope.task;
  return {
    event_group_id: eventGroupId, event_index: index, user_id: task.userId, preset_id: task.presetId,
    task_id: task.taskId, tick_id: task.tickId, target_key: event.targetKey, section: event.section,
    event_kind: event.eventKind,
    decision: event.decision ?? (event.eventKind === "system_cleanup" ? "system_cleanup" : null),
    patch_id: event.patchId, op: event.op,
    item_id: event.itemId ?? event.normalizedOperation?.itemId ?? null,
    result_item_id: event.resultItemId, merged_from_item_ids: event.mergedFromItemIds,
    reject_reason: event.rejectReason,
    maintenance_task_id: maintenanceTaskId, patch_summary: event.patchSummary ?? null,
    normalized_operation: event.normalizedOperation, cleanup_type: event.cleanupKind ?? null,
  };
}

module.exports = { mapEventToRow };
