const {
  createAuthController,
  configureAuthController,
} = require("../../controllers/authController");
const authMiddlewareEntry = require("../../middleware/authMiddleware");

function createAuthModule({ config, logger, userModel, bcrypt, jwt, withRequestContext } = {}) {
  if (!config || typeof config !== "object") throw new Error("Auth config is required");
  const middleware = authMiddlewareEntry.createAuthMiddleware({
    jwtSecret: config.jwtSecret,
    jwtAdapter: jwt,
  });
  const controller = createAuthController({
    jwtSecret: config.jwtSecret,
    tokenExpiresIn: config.tokenExpiresIn,
    logger,
    userModel,
    bcrypt,
    jwt,
    withRequestContext,
  });

  return Object.freeze({ middleware, controller });
}

function installLegacyAuthBindings(auth) {
  if (!auth?.middleware || !auth?.controller) throw new Error("Auth runtime is required");
  authMiddlewareEntry.configureAuthMiddleware(auth.middleware);
  configureAuthController(auth.controller);
  return auth;
}

module.exports = {
  createAuthModule,
  installLegacyAuthBindings,
};
