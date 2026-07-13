const db = require("../db");

const userModel = {
  async findByUsername(username) {
    const query = "SELECT * FROM users WHERE username = $1";
    const { rows } = await db.query(query, [username]);
    return rows[0];
  },

  async findById(id) {
    const query = "SELECT id, username, avatar_url, time_zone, created_at FROM users WHERE id = $1";
    const { rows } = await db.query(query, [id]);
    return rows[0] || null;
  },

  async updateTimeZone(id, timeZone) {
    const query = "UPDATE users SET time_zone = $2 WHERE id = $1 RETURNING id, username, avatar_url, time_zone, created_at";
    const { rows } = await db.query(query, [id, timeZone]);
    return rows[0] || null;
  },
};

module.exports = userModel;
