function createUserRepository({ database } = {}) {
  if (!database?.query) throw new Error("Auth user repository requires a database query adapter");

  return Object.freeze({
    async findByUsername(username) {
      const { rows } = await database.query("SELECT * FROM users WHERE username = $1", [username]);
      return rows[0];
    },

    async findById(id) {
      const { rows } = await database.query(
        "SELECT id, username, avatar_url, time_zone, created_at FROM users WHERE id = $1",
        [id],
      );
      return rows[0] || null;
    },

    async updateTimeZone(id, timeZone) {
      const { rows } = await database.query(
        "UPDATE users SET time_zone = $2 WHERE id = $1 RETURNING id, username, avatar_url, time_zone, created_at",
        [id, timeZone],
      );
      return rows[0] || null;
    },
  });
}

module.exports = { createUserRepository };
