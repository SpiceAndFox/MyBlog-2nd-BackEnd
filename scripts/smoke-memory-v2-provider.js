const dotenv = require("dotenv");
dotenv.config();
const crypto = require("node:crypto");
const {
  loadMemoryProviderConfig, createStructuredTransport, createMemoryProviderAdapter,
  loadProposerPrompt, contracts, domain,
} = require("../modules/memory");
const { buildNormalEnvelope } = require("../modules/memory/application/envelope");

function hash(content) {
  return `sha256:${crypto.createHash("sha256").update(content, "utf8").digest("hex")}`;
}

async function main() {
  const provider = loadMemoryProviderConfig(process.env);
  const adapter = createMemoryProviderAdapter({
    invokeStructured: createStructuredTransport(provider),
    promptLoader: loadProposerPrompt,
  });
  const content = "我明确承诺明天把借来的书归还。";
  const message = {
    id: 1,
    role: "user",
    createdAt: "2026-07-14T00:00:00.000Z",
    contentKind: "raw",
    content,
    contentHash: hash(content),
  };
  const config = {
    overdueTodos: { maxRenderedItems: 10, maxRenderedChars: 1000 },
    quote: { threshold: 0.75, maxCodePoints: 200 },
    scene: { ttlMs: 86_400_000, maxRenderedChars: 1000 },
    sectionBudgets: Object.fromEntries(
      ["todos", "standingAgreements", "recentEpisodes", "milestones", "worldFacts", "userProfile", "assistantProfile", "relationship"]
        .map((section) => [section, { maxItems: 20, maxRenderedChars: 2000 }]),
    ),
  };
  const state = contracts.createInitialMemoryState();
  const envelope = buildNormalEnvelope({
    userId: 1,
    presetId: "semantic-smoke",
    state,
    intent: { targetKey: "todos", proposer: "todoProposer", targetSections: ["todos"], cursorBefore: 0, trigger: { type: "lagThreshold" } },
    messages: [message],
    now: new Date("2026-07-14T00:00:01.000Z"),
    userTimeZone: "UTC",
    config,
  });
  const result = await adapter.propose(envelope);
  if (result.status !== "ok") throw new Error(`Semantic smoke Provider failure: ${result.reason}`);
  const reduction = domain.reduceProposal({
    state,
    task: envelope.task,
    proposal: result.output,
    observedMessages: envelope.observedMessages,
    databaseMessages: [{ ...message, userId: 1, presetId: "semantic-smoke" }],
    config,
    idFactory: () => crypto.randomUUID(),
  });
  const accepted = reduction.events.find((event) => event.section === "todos" && event.op === "addItem" && event.decision === "accepted");
  if (!accepted) throw new Error("Semantic smoke expected an accepted todos.addItem decision");
  process.stdout.write(`${JSON.stringify({ status: "supported", adapter: provider.adapter, model: result.model || provider.model, semanticCase: "todo-add", decision: accepted.decision })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
