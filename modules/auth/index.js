const { createAuthController } = require("./controller");
const { createAuthMiddleware } = require("./middleware");
const { createUserRepository } = require("./userRepository");
const { createUserTimeZoneReader } = require("./userTimeZoneReader");

function createAuthModule({ config, logger, userModel, bcrypt, jwt, withRequestContext, database } = {}) {
  if (!config || typeof config !== "object") throw new Error("Auth config is required");
  const userRepository = userModel || createUserRepository({ database });
  const middleware = createAuthMiddleware({
    jwtSecret: config.jwtSecret,
    jwtAdapter: jwt,
  });
  const controller = createAuthController({
    jwtSecret: config.jwtSecret,
    tokenExpiresIn: config.tokenExpiresIn,
    logger,
    userModel: userRepository,
    bcrypt,
    jwt,
    withRequestContext,
  });

  const userTimeZoneReader = database ? createUserTimeZoneReader({ database }) : null;
  return Object.freeze({ middleware, controller, userTimeZoneReader });
}

module.exports = {
  createAuthModule,
  createUserTimeZoneReader,
};
