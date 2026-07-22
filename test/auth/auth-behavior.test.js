const test = require("node:test");
const assert = require("node:assert/strict");
require("module-alias/register");

// Characterization tests for the Auth module public entry.
// All dependencies are passed explicitly to createAuthModule so the suite
// stays valid after the Auth internals are moved into modules/auth (Phase F):
// it never references legacy controller/middleware/model paths.

const { createAuthModule } = require("../../modules/auth");

const userModel = {
  async findByUsername() { return null; },
  async findById() { return null; },
  async updateTimeZone() { return null; },
};
const bcrypt = { async compare() { return false; } };
const jwt = { sign() { return "signed-token"; }, verify() {} };
const logger = { error() {} };
function withRequestContext(_req, detail) { return detail; }

const { controller: authController, middleware: authMiddleware } = createAuthModule({
  config: { jwtSecret: "phase-f-secret", tokenExpiresIn: "7d" },
  userModel,
  bcrypt,
  jwt,
  logger,
  withRequestContext,
});

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(statusCode) { this.statusCode = statusCode; return this; },
    json(body) { this.body = body; return this; },
  };
}

function userRecord(overrides = {}) {
  return {
    id: 7,
    username: "lina",
    avatar_url: "https://cdn.test/lina.png",
    time_zone: "Asia/Shanghai",
    created_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function expectedUser(user) {
  return {
    user: {
      id: user.id,
      username: user.username,
      avatar_url: user.avatar_url || null,
      time_zone: user.time_zone,
      created_at: user.created_at,
    },
  };
}

test("login keeps its validation, credential-failure, and token response contract", async (t) => {
  await t.test("missing credentials are a 400 response", async () => {
    const res = response();
    await authController.login({ body: { username: "lina" } }, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: "用户名和密码不能为空" });
  });

  await t.test("unknown users and password mismatches share the same 401 response", async () => {
    userModel.findByUsername = async () => null;
    let res = response();
    await authController.login({ body: { username: "lina", password: "wrong" } }, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "认证失败：用户名或密码错误" });

    userModel.findByUsername = async () => ({ id: 7, username: "lina", password_hash: "hash" });
    bcrypt.compare = async () => false;
    res = response();
    await authController.login({ body: { username: "lina", password: "wrong" } }, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "认证失败：用户名或密码错误" });
  });

  await t.test("valid credentials return the seven-day signed bearer token", async () => {
    userModel.findByUsername = async () => ({ id: 7, username: "lina", password_hash: "hash" });
    bcrypt.compare = async () => true;
    let signArguments;
    jwt.sign = (...args) => { signArguments = args; return "signed-token"; };
    const res = response();
    await authController.login({ body: { username: "lina", password: "correct" } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { message: "登录成功", token: "signed-token" });
    assert.deepEqual(signArguments, [
      { id: 7, username: "lina" },
      "phase-f-secret",
      { expiresIn: "7d" },
    ]);
  });
});

test("bearer authentication keeps its status codes, messages, and decoded user contract", async (t) => {
  await t.test("a missing Authorization header remains 403", () => {
    const res = response();
    authMiddleware({ headers: {} }, res, () => assert.fail("next must not run"));
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: "需要提供Token用于认证" });
  });

  await t.test("a malformed Bearer header remains 401", () => {
    const res = response();
    authMiddleware({ headers: { authorization: "Token abc" } }, res, () => assert.fail("next must not run"));
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'Token格式不正确，应为 "Bearer <token>"' });
  });

  await t.test("an invalid token remains 401", () => {
    jwt.verify = (token, secret, callback) => {
      assert.equal(token, "bad");
      assert.equal(secret, "phase-f-secret");
      callback(new Error("invalid"));
    };
    const res = response();
    authMiddleware({ headers: { authorization: "Bearer bad" } }, res, () => assert.fail("next must not run"));
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "Token无效或已过期" });
  });

  await t.test("a valid token attaches the decoded user before continuing", () => {
    const decoded = { id: 7, username: "lina" };
    jwt.verify = (_token, _secret, callback) => callback(null, decoded);
    const req = { headers: { authorization: "Bearer valid" } };
    let continued = false;
    authMiddleware(req, response(), () => { continued = true; });
    assert.equal(continued, true);
    assert.equal(req.user, decoded);
  });
});

test("GET /me keeps its authorization, not-found, and success contract", async (t) => {
  await t.test("a missing req.user is a 401 response", async () => {
    const res = response();
    await authController.me({ user: undefined }, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "Unauthorized" });
  });

  await t.test("an unknown user id is a 404 response", async () => {
    userModel.findById = async () => null;
    const res = response();
    await authController.me({ user: { id: 7 } }, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: "User not found" });
  });

  await t.test("a found user returns the public user shape with avatar_url coerced to null", async () => {
    const user = userRecord({ avatar_url: undefined });
    userModel.findById = async () => user;
    const res = response();
    await authController.me({ user: { id: 7 } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, expectedUser(user));
    assert.equal(res.body.user.avatar_url, null);
  });

  await t.test("a repository error is a 500 response", async () => {
    userModel.findById = async () => { throw new Error("db down"); };
    const res = response();
    await authController.me({ user: { id: 7 } }, res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: "Internal Server Error" });
  });
});

test("PATCH /me/time-zone keeps its validation, not-found, and success contract", async (t) => {
  await t.test("a missing req.user is a 401 response", async () => {
    const res = response();
    await authController.updateTimeZone({ user: undefined, body: { time_zone: "Asia/Shanghai" } }, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "Unauthorized" });
  });

  await t.test("an empty time_zone is a 400 response", async () => {
    const res = response();
    await authController.updateTimeZone({ user: { id: 7 }, body: { time_zone: "  " } }, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: "time_zone must be a valid IANA time zone" });
  });

  await t.test("an invalid IANA time_zone is a 400 response", async () => {
    const res = response();
    await authController.updateTimeZone({ user: { id: 7 }, body: { time_zone: "Foo/Bar" } }, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: "time_zone must be a valid IANA time zone" });
  });

  await t.test("an unknown user id is a 404 response", async () => {
    userModel.updateTimeZone = async () => null;
    const res = response();
    await authController.updateTimeZone({ user: { id: 7 }, body: { time_zone: "Asia/Shanghai" } }, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: "User not found" });
  });

  await t.test("a valid time_zone updates and returns the public user shape", async () => {
    const user = userRecord({ time_zone: "Asia/Tokyo" });
    userModel.updateTimeZone = async (_id, timeZone) => {
      assert.equal(timeZone, "Asia/Tokyo");
      return user;
    };
    const res = response();
    await authController.updateTimeZone({ user: { id: 7 }, body: { time_zone: "Asia/Tokyo" } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, expectedUser(user));
  });

  await t.test("a repository error is a 500 response", async () => {
    userModel.updateTimeZone = async () => { throw new Error("db down"); };
    const res = response();
    await authController.updateTimeZone({ user: { id: 7 }, body: { time_zone: "Asia/Shanghai" } }, res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: "Internal Server Error" });
  });
});
