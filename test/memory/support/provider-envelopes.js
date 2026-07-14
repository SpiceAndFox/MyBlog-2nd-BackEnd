const { createInitialMemoryState } = require("../../../modules/memory/contracts");
const { buildNormalEnvelope } = require("../../../modules/memory/application/envelope");
const { sha256 } = require("./memory-builders");

const config = { overdueTodos: { maxRenderedItems: 2 } };

function envelope() {
  return buildNormalEnvelope({
    userId: 1, presetId: "default", state: createInitialMemoryState(),
    intent: { targetKey: "episodes", proposer: "episodeProposer", targetSections: ["recentEpisodes", "milestones"], cursorBefore: 0 },
    messages: [{ id: 1, role: "user", createdAt: "2026-07-12T00:00:00.000Z", contentKind: "raw", content: "你好", contentHash: sha256("你好") }],
    now: "2026-07-12T00:00:01Z", taskId: "00000000-0000-4000-8000-000000000007", tickId: 7, config,
  });
}

function sceneEnvelope() {
  return buildNormalEnvelope({
    userId: 1, presetId: "default", state: createInitialMemoryState(),
    intent: { targetKey: "scene", proposer: "currentStateProposer", targetSections: ["scene"], cursorBefore: 0 },
    messages: [{ id: 1, role: "user", createdAt: "2026-07-12T00:00:00.000Z", contentKind: "raw", content: "来到屋顶", contentHash: sha256("来到屋顶") }],
    now: "2026-07-12T00:00:01Z", taskId: "00000000-0000-4000-8000-000000000008", tickId: 8, config,
  });
}

module.exports = { envelope, sceneEnvelope };

