const { createChatRepository } = require("./repositories/chatRepository");
const { createChatPresetRepository } = require("./repositories/presetRepository");
const { createChatGistRepository } = require("./repositories/gistRepository");

function createChatPersistence({ database } = {}) {
  return Object.freeze({
    chatRepository: createChatRepository({ database }),
    presetRepository: createChatPresetRepository({ database }),
    gistRepository: createChatGistRepository({ database }),
  });
}

module.exports = { createChatPersistence };
