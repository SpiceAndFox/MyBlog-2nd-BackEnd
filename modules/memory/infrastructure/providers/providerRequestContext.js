// Provider-independent metadata. It is never appended to the model's input.
// Gateway transports decide whether/how to use scope and task identity.
function buildProviderRequestContext(task = {}) {
  return {
    ...(task.userId !== undefined || task.presetId !== undefined
      ? { scope: { userId: task.userId, presetId: task.presetId } } : {}),
    ...(task.taskId !== undefined ? { taskId: task.taskId } : {}),
  };
}

module.exports = { buildProviderRequestContext };
