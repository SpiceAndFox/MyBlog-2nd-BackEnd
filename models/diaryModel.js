const db = require("../db");

const diaryModel = {
  async findByAuthor({ authorId, filters = {}, page = 1, limit = 10 }) {
    let query = `
      SELECT
        d.id, d.title, d.summary, d.status, d.published_at, d.created_at, d.updated_at
      FROM diaries d
    `;

    const whereClauses = ["d.author_id = $1", "d.status = $2"];
    const params = [authorId, "published"];
    let paramIndex = 3;

    if (filters.year) {
      whereClauses.push(`EXTRACT(YEAR FROM d.published_at) = $${paramIndex}`);
      params.push(filters.year);
      paramIndex++;
    }

    if (filters.month) {
      whereClauses.push(`EXTRACT(MONTH FROM d.published_at) = $${paramIndex}`);
      params.push(filters.month);
      paramIndex++;
    }

    query += " WHERE " + whereClauses.join(" AND ");
    query += " ORDER BY d.published_at DESC, d.created_at DESC";

    const countQuery = `SELECT count(*) FROM (${query}) AS count_subquery`;
    const totalResult = await db.query(countQuery, params);
    const totalDiaries = parseInt(totalResult.rows[0].count, 10);
    const totalPages = Math.max(1, Math.ceil(totalDiaries / limit));

    const offset = (page - 1) * limit;
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const { rows: diaries } = await db.query(query, params);

    return { articles: diaries, pagination: { total: totalDiaries, page, limit, totalPages } };
  },

  async findByIdForAuthor(id, authorId) {
    const query = `
      SELECT
        d.id, d.title, d.content, d.summary, d.status,
        d.published_at, d.created_at, d.updated_at,
        u.username AS author
      FROM diaries d
      LEFT JOIN users u ON d.author_id = u.id
      WHERE d.id = $1 AND d.author_id = $2 AND d.status = 'published'
    `;

    const { rows } = await db.query(query, [id, authorId]);
    return rows[0] || null;
  },

  async create({ title, content, summary, status, author_id, published_at }) {
    const query = `
      INSERT INTO diaries
        (title, content, summary, status, author_id, published_at)
      VALUES
        ($1, $2, $3, $4, $5, $6)
      RETURNING id, title, summary, status, author_id, published_at, created_at, updated_at
    `;

    const { rows } = await db.query(query, [title, content, summary, status, author_id, published_at]);
    return rows[0];
  },
};

module.exports = diaryModel;
