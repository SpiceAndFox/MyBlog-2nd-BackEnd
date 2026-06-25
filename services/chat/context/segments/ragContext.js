function buildRagContextSegment({ ragContext } = {}) {
  const messages = Array.isArray(ragContext?.messages) ? ragContext.messages : [];
  if (!messages.length) return null;
  return { messages };
}

module.exports = {
  buildRagContextSegment,
};

