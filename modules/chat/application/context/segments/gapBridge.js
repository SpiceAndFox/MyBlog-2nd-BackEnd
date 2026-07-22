function buildGapBridgeSegment({ gapBridge } = {}) {
  const content = String(gapBridge?.content || "").trim();
  if (content) return { messages: [{ role: "system", content }] };
  if (!gapBridge?.messages?.length) return null;
  return { messages: gapBridge.messages };
}

module.exports = {
  buildGapBridgeSegment,
};
