function buildRecentWindowSegment({ recent } = {}) {
  const messages = Array.isArray(recent?.messages) ? recent.messages : [];
  if (messages.length <= 1) return null;
  const history = messages.slice(0, -1);
  if (!history.length) return null;
  return { messages: history };
}

module.exports = {
  buildRecentWindowSegment,
};
