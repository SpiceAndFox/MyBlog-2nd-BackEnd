const crypto = require("node:crypto");

const ITEM_SECTIONS = [
  "todos", "standingAgreements", "recentEpisodes", "milestones",
  "worldFacts", "userProfile", "assistantProfile", "relationship",
];

function createSectionBudgets(maxItems = 20, maxRenderedChars = 2000) {
  return Object.fromEntries(ITEM_SECTIONS.map((section) => [section, { maxItems, maxRenderedChars }]));
}

function createMemoryTestConfig(overrides = {}) {
  const base = {
    admission: { concurrency: 1, queueMax: 8 },
    compaction: { retryMax: 1 },
    providerRecovery: {
      retryMax: 1,
      transportInvalidRetryMax: 1,
      schemaInvalidRetryMax: 1,
      backoffBaseMs: 1,
      backoffMaxMs: 2,
      haltAfterConsecutiveErrors: 3,
    },
    scene: { ttlMs: 86_400_000, maxRenderedChars: 1000 },
    overdueTodos: { maxRenderedItems: 10, maxRenderedChars: 1000 },
    librarian: { lagThreshold: 96 },
    sectionBudgets: createSectionBudgets(),
  };
  return {
    ...base,
    ...overrides,
    admission: { ...base.admission, ...overrides.admission },
    compaction: { ...base.compaction, ...overrides.compaction },
    providerRecovery: { ...base.providerRecovery, ...overrides.providerRecovery },
    scene: { ...base.scene, ...overrides.scene },
    overdueTodos: { ...base.overdueTodos, ...overrides.overdueTodos },
    librarian: { ...base.librarian, ...overrides.librarian },
    sectionBudgets: overrides.sectionBudgets || base.sectionBudgets,
  };
}

function withLibrarianRepositoryStubs(repositories = {}) {
  const librarianTasks = new Map();
  const librarianCheckpoints = new Map();
  return {
    ...repositories,
    async withTransaction(work) {
      if (repositories.withTransaction) return repositories.withTransaction(work);
      return work({});
    },
    state: {
      async getState() { return null; },
      async writeState() {},
      ...repositories.state,
    },
    source: {
      async getBoundary() { return 0; },
      async listCompleteTurnBoundaries() { return []; },
      async listSchedulingMessages() { return []; },
      ...repositories.source,
    },
    runtime: {
      async createTask(row) {
        if (!librarianTasks.has(row.task_id)) librarianTasks.set(row.task_id, structuredClone(row));
        return structuredClone(librarianTasks.get(row.task_id));
      },
      async getTask(taskId) {
        const row = librarianTasks.get(taskId);
        return row ? structuredClone(row) : null;
      },
      async getTaskForUpdate(taskId) {
        const row = librarianTasks.get(taskId);
        return row ? structuredClone(row) : null;
      },
      async updateTask(taskId, changes) {
        const row = librarianTasks.get(taskId);
        if (row) Object.assign(row, structuredClone(changes));
        return row ? structuredClone(row) : null;
      },
      async appendOpsLog() {},
      async getLibrarianCheckpoint(userId, presetId, sourceGeneration) {
        return structuredClone(
          librarianCheckpoints.get(`${userId}:${presetId}:${sourceGeneration}`) || null,
        );
      },
      async initializeLibrarianRebuildSchedule(userId, presetId, sourceGeneration, schedule) {
        const key = `${userId}:${presetId}:${sourceGeneration}`;
        const checkpoint = librarianCheckpoints.get(key) || {};
        checkpoint.rebuildSchedule ||= structuredClone(schedule);
        librarianCheckpoints.set(key, checkpoint);
        return structuredClone(checkpoint.rebuildSchedule);
      },
      async upsertLibrarianCheckpoint(userId, presetId, checkpoint) {
        librarianCheckpoints.set(
          `${userId}:${presetId}:${checkpoint.sourceGeneration}`,
          structuredClone(checkpoint),
        );
        return structuredClone(checkpoint);
      },
      ...repositories.runtime,
    },
    audit: {
      async insertSnapshot() {},
      async insertEventGroup() {},
      async insertEvents() {},
      ...repositories.audit,
    },
    userTimeZones: {
      async getTimeZone() { return "UTC"; },
      ...repositories.userTimeZones,
    },
  };
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value), "utf8").digest("hex")}`;
}

function sequence(...values) {
  let index = 0;
  return () => values[index++] || `id-${index}`;
}

module.exports = {
  ITEM_SECTIONS,
  createSectionBudgets,
  createMemoryTestConfig,
  withLibrarianRepositoryStubs,
  sha256,
  sequence,
};
