const test = require("node:test");
const assert = require("node:assert/strict");
require("module-alias/register");

function namedHandler(name) {
  const handler = (_req, _res, next) => next?.();
  Object.defineProperty(handler, "name", { value: name });
  return handler;
}

function controllerStub(prefix) {
  const handlers = new Map();
  return new Proxy({}, {
    get(_target, property) {
      if (!handlers.has(property)) handlers.set(property, namedHandler(`${prefix}_${String(property)}`));
      return handlers.get(property);
    },
  });
}

function replaceModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const auth = namedHandler("auth");
replaceModule("../../controllers/tagController", controllerStub("tag"));
replaceModule("../../controllers/articleController", controllerStub("article"));
replaceModule("../../controllers/diaryController", controllerStub("diary"));
replaceModule("../../middleware/uploadArticleCover", {
  single: (field) => namedHandler(`articleCover_${field}`),
});
replaceModule("../../middleware/uploadArticleContentImage", {
  single: (field) => namedHandler(`articleContent_${field}`),
});
replaceModule("../../middleware/uploadChatPresetAvatar", {
  single: (field) => namedHandler(`chatAvatar_${field}`),
});

const chatController = controllerStub("chat");
const { createChatRouter } = require("../../routes/chat");
const chatRouter = createChatRouter({
  authMiddleware: auth,
  chatController,
  uploadPresetAvatar: require("../../middleware/uploadChatPresetAvatar"),
});

const { createAuthRouter } = require("../../routes/auth");
const authRouter = createAuthRouter({ authMiddleware: auth, authController: controllerStub("authController") });

const { createDiariesRouter } = require("../../routes/diaries");
const diariesRouter = createDiariesRouter({ authMiddleware: auth });

const { createAdminTagsRouter } = require("../../routes/admin/tags");
const adminTagsRouter = createAdminTagsRouter({ authMiddleware: auth });

const { createAdminArticlesRouter } = require("../../routes/admin/articles");
const adminArticlesRouter = createAdminArticlesRouter({ authMiddleware: auth });

const routerDefinitions = [
  ["/api/tags", require("../../routes/tags"), false],
  ["/api/admin/tags", adminTagsRouter, true],
  ["/api/articles", require("../../routes/articles"), false],
  ["/api/admin/articles", adminArticlesRouter, false],
  ["/api/diaries", diariesRouter, false],
  ["/api/auth", authRouter, false],
  ["/api/chat", chatRouter, true],
];

function joinPath(prefix, routePath) {
  return routePath === "/" ? prefix : `${prefix}${routePath}`;
}

function inspectRoutes() {
  const routes = [];
  for (const [prefix, router, usesGlobalAuth] of routerDefinitions) {
    const globalAuthInstalled = router.stack.some((layer) => !layer.route && layer.handle === auth);
    assert.equal(globalAuthInstalled, usesGlobalAuth, `${prefix} global auth baseline changed`);
    for (const layer of router.stack.filter((entry) => entry.route)) {
      for (const method of Object.keys(layer.route.methods).filter((name) => layer.route.methods[name])) {
        routes.push({
          method: method.toUpperCase(),
          path: joinPath(prefix, layer.route.path),
          handlers: layer.route.stack.map((entry) => entry.handle.name),
          globalAuth: usesGlobalAuth,
        });
      }
    }
  }
  return routes;
}

test("HTTP methods, paths, auth placement, uploads, and controller bindings remain stable", () => {
  assert.deepEqual(inspectRoutes(), [
    { method: "GET", path: "/api/tags", handlers: ["tag_getAllTags"], globalAuth: false },
    { method: "POST", path: "/api/admin/tags", handlers: ["tag_createTag"], globalAuth: true },
    { method: "PUT", path: "/api/admin/tags/:id", handlers: ["tag_updateTag"], globalAuth: true },
    { method: "DELETE", path: "/api/admin/tags/:id", handlers: ["tag_deleteTag"], globalAuth: true },
    { method: "GET", path: "/api/articles", handlers: ["article_getAllPublishedArticles"], globalAuth: false },
    { method: "GET", path: "/api/articles/:id", handlers: ["article_getPublishedArticleById"], globalAuth: false },
    { method: "GET", path: "/api/admin/articles", handlers: ["auth", "article_getAllArticlesAdmin"], globalAuth: false },
    { method: "POST", path: "/api/admin/articles", handlers: ["auth", "articleCover_headerImage", "article_createArticle"], globalAuth: false },
    { method: "GET", path: "/api/admin/articles/:id", handlers: ["auth", "article_getArticleByIdAdmin"], globalAuth: false },
    { method: "PUT", path: "/api/admin/articles/:id", handlers: ["auth", "articleCover_headerImage", "article_updateArticle"], globalAuth: false },
    { method: "DELETE", path: "/api/admin/articles/:id", handlers: ["auth", "article_deleteArticle"], globalAuth: false },
    { method: "POST", path: "/api/admin/articles/upload-image", handlers: ["auth", "articleContent_image", "article_uploadContentImage"], globalAuth: false },
    { method: "GET", path: "/api/diaries", handlers: ["auth", "diary_getCurrentUserDiaries"], globalAuth: false },
    { method: "POST", path: "/api/diaries", handlers: ["auth", "diary_createDiary"], globalAuth: false },
    { method: "GET", path: "/api/diaries/:id", handlers: ["auth", "diary_getCurrentUserDiaryById"], globalAuth: false },
    { method: "POST", path: "/api/auth/login", handlers: ["authController_login"], globalAuth: false },
    { method: "GET", path: "/api/auth/me", handlers: ["auth", "authController_me"], globalAuth: false },
    { method: "PATCH", path: "/api/auth/me/time-zone", handlers: ["auth", "authController_updateTimeZone"], globalAuth: false },
    { method: "GET", path: "/api/chat/meta", handlers: ["chat_getMeta"], globalAuth: true },
    { method: "GET", path: "/api/chat/privacy-operations/:operationId", handlers: ["chat_getPrivacyOperation"], globalAuth: true },
    { method: "GET", path: "/api/chat/presets", handlers: ["chat_listPresets"], globalAuth: true },
    { method: "GET", path: "/api/chat/presets/trash", handlers: ["chat_listTrashedPresets"], globalAuth: true },
    { method: "POST", path: "/api/chat/presets", handlers: ["chat_createPreset"], globalAuth: true },
    { method: "PATCH", path: "/api/chat/presets/:presetId", handlers: ["chat_updatePreset"], globalAuth: true },
    { method: "POST", path: "/api/chat/presets/:presetId/memory/rebuild", handlers: ["chat_rebuildPresetMemory"], globalAuth: true },
    { method: "DELETE", path: "/api/chat/presets/:presetId", handlers: ["chat_deletePreset"], globalAuth: true },
    { method: "PATCH", path: "/api/chat/presets/:presetId/restore", handlers: ["chat_restorePreset"], globalAuth: true },
    { method: "DELETE", path: "/api/chat/presets/:presetId/permanent", handlers: ["chat_deletePresetPermanently"], globalAuth: true },
    { method: "POST", path: "/api/chat/presets/:presetId/avatar", handlers: ["chatAvatar_avatar", "chat_uploadPresetAvatar"], globalAuth: true },
    { method: "GET", path: "/api/chat/sessions", handlers: ["chat_listSessions"], globalAuth: true },
    { method: "GET", path: "/api/chat/sessions/trash", handlers: ["chat_listTrashedSessions"], globalAuth: true },
    { method: "POST", path: "/api/chat/sessions", handlers: ["chat_createSession"], globalAuth: true },
    { method: "DELETE", path: "/api/chat/sessions/:sessionId", handlers: ["chat_deleteSession"], globalAuth: true },
    { method: "PATCH", path: "/api/chat/sessions/:sessionId/restore", handlers: ["chat_restoreSession"], globalAuth: true },
    { method: "DELETE", path: "/api/chat/sessions/:sessionId/permanent", handlers: ["chat_deleteSessionPermanently"], globalAuth: true },
    { method: "GET", path: "/api/chat/sessions/:sessionId/messages", handlers: ["chat_listMessages"], globalAuth: true },
    { method: "PATCH", path: "/api/chat/sessions/:sessionId/messages/:messageId", handlers: ["chat_editMessage"], globalAuth: true },
    { method: "POST", path: "/api/chat/sessions/:sessionId/messages", handlers: ["chat_sendMessage"], globalAuth: true },
  ]);
});
