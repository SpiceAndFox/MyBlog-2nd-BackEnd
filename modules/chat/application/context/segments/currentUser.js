function buildCurrentUserSegment({ recent } = {}) {
  const messages = Array.isArray(recent?.messages) ? recent.messages : [];
  if (!messages.length) return null;

  const last = messages[messages.length - 1];
  if (!last) return null;
  if (last.role !== "user") throw new Error("Invalid recent window: expected last message to be user");

  return { messages: [last] };
}

module.exports = {
  buildCurrentUserSegment,
};
