const test = require("node:test");
const assert = require("node:assert/strict");
require("module-alias/register");

function replaceModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const userModel = {};
const bcrypt = {};
const jwt = { sign() {}, verify() {} };
replaceModule("../../models/userModel", userModel);
replaceModule("bcryptjs", bcrypt);
replaceModule("jsonwebtoken", jwt);
replaceModule("../../logger", {
  logger: { error() {} },
  withRequestContext(_req, detail) { return detail; },
});

const { createAuthModule } = require("../../modules/auth");
const { controller: authController, middleware: authMiddleware } = createAuthModule({
  config: { jwtSecret: "phase-b-secret", tokenExpiresIn: "7d" },
  userModel,
  bcrypt,
  jwt,
  logger: { error() {} },
  withRequestContext(_req, detail) { return detail; },
});

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(statusCode) { this.statusCode = statusCode; return this; },
    json(body) { this.body = body; return this; },
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

      userModel.findByUsername = async () => ({ password_hash: "hash" });
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
        "phase-b-secret",
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
        assert.equal(secret, "phase-b-secret");
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
