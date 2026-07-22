class ChatApplicationError extends Error {
  constructor(message, { code = "CHAT_APPLICATION_ERROR", status = 500, session, userMessage } = {}) {
    super(message);
    this.name = "ChatApplicationError";
    this.code = code;
    this.status = status;
    if (session) this.session = session;
    if (userMessage) this.userMessage = userMessage;
  }
}

function fail(message, options) {
  throw new ChatApplicationError(message, options);
}

module.exports = { ChatApplicationError, fail };
