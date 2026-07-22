const pg = require("pg");

// 创建数据库连接池
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  end: () => pool.end(),
  getClient: () => pool.connect(),
};
