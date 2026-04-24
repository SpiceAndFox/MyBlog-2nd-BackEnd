const db = require("../db");
const { logger } = require("../logger");

const articleModel = {
  // 查找已发布的文章（带筛选和分页）
  async findPublished({ filters = {}, page = 1, limit = 10 }) {
    let query = `
      SELECT
        a.id, a.title, a.thumbnail_url, a.published_at, a.summary,
        jsonb_agg(DISTINCT jsonb_build_object('id', t.id, 'name', t.name, 'parent_id', t.parent_id))
          FILTER (WHERE t.id IS NOT NULL) as tags -- 使用 DISTINCT 和 FILTER 避免标签重复
      FROM articles a
      LEFT JOIN article_tags at ON a.id = at.article_id
      LEFT JOIN tags t ON at.tag_id = t.id
    `;

    // 动态构建筛选条件
    const whereClauses = ["a.status = $1"];
    const params = ["published"];
    let paramIndex = 2;

    if (filters.subTag && filters.topTag) {
      whereClauses.push(
        `EXISTS (
          SELECT 1
          FROM article_tags filter_at
          INNER JOIN tags child_tags ON child_tags.id = filter_at.tag_id
          INNER JOIN tags parent_tags ON parent_tags.id = child_tags.parent_id
          WHERE filter_at.article_id = a.id
            AND child_tags.name = $${paramIndex}
            AND parent_tags.name = $${paramIndex + 1}
        )`
      );
      params.push(filters.subTag, filters.topTag);
      paramIndex += 2;
    } else if (filters.subTag) {
      whereClauses.push(
        `EXISTS (
          SELECT 1
          FROM article_tags filter_at
          INNER JOIN tags child_tags ON child_tags.id = filter_at.tag_id
          WHERE filter_at.article_id = a.id
            AND child_tags.name = $${paramIndex}
            AND child_tags.parent_id IS NOT NULL
        )`
      );
      params.push(filters.subTag);
      paramIndex++;
    } else if (filters.topTag) {
      whereClauses.push(
        `EXISTS (
          SELECT 1
          FROM article_tags filter_at
          INNER JOIN tags top_tags ON top_tags.id = filter_at.tag_id
          WHERE filter_at.article_id = a.id
            AND top_tags.name = $${paramIndex}
            AND top_tags.parent_id IS NULL
        )`
      );
      params.push(filters.topTag);
      paramIndex++;
    }
    if (filters.year) {
      whereClauses.push(`EXTRACT(YEAR FROM a.published_at) = $${paramIndex}`);
      params.push(filters.year);
      paramIndex++;
    }
    if (filters.month) {
      whereClauses.push(`EXTRACT(MONTH FROM a.published_at) = $${paramIndex}`);
      params.push(filters.month);
      paramIndex++;
    }
    if (filters.search) {
      whereClauses.push(`(a.title ILIKE $${paramIndex} OR a.summary ILIKE $${paramIndex})`);
      params.push(`%${filters.search}%`);
      paramIndex++;
    }
    if (whereClauses.length > 0) {
      query += " WHERE " + whereClauses.join(" AND ");
    }

    query += " GROUP BY a.id ORDER BY a.published_at DESC";

    // --- 首先，计算总数 ---
    const countQuery = `SELECT count(*) FROM (${query}) AS count_subquery`;
    const totalResult = await db.query(countQuery, params);
    const totalArticles = parseInt(totalResult.rows[0].count, 10);
    const totalPages = Math.ceil(totalArticles / limit);

    // --- 然后，获取分页后的数据 ---
    const offset = (page - 1) * limit;
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const { rows: articles } = await db.query(query, params);

    return { articles, pagination: { total: totalArticles, page, limit, totalPages } };
  },

  // 根据ID查找单篇已发布的文章
  async findPublishedById(id) {
    const query = `
      SELECT
        a.id, a.title, a.content, a.header_image_url, a.published_at,
        u.username as author, -- 关联 users 表获取作者名
        jsonb_agg(DISTINCT jsonb_build_object('id', t.id, 'name', t.name, 'parent_id', t.parent_id))
          FILTER (WHERE t.id IS NOT NULL) as tags
      FROM articles a
      LEFT JOIN users u ON a.author_id = u.id -- JOIN users 表
      LEFT JOIN article_tags at ON a.id = at.article_id
      LEFT JOIN tags t ON at.tag_id = t.id
      WHERE a.id = $1 AND a.status = 'published' -- 关键筛选条件
      GROUP BY a.id, u.username;
    `;
    const { rows } = await db.query(query, [id]);
    return rows[0]; // 如果找到，返回第一行记录；否则返回 undefined
  },

  // (后台管理) 查找所有文章，支持搜索和分页
  async findAllAdmin({ searchQuery = "", page = 1, limit = 10 }) {
    let query = `
      SELECT
        a.id, a.title, a.thumbnail_url, a.status, a.published_at, a.created_at,
        jsonb_agg(DISTINCT jsonb_build_object('name', t.name)) 
          FILTER (WHERE t.id IS NOT NULL) as tags
      FROM articles a
      LEFT JOIN article_tags at ON a.id = at.article_id
      LEFT JOIN tags t ON at.tag_id = t.id
    `;

    const params = [];
    let paramIndex = 1;
    const whereClauses = [];

    if (searchQuery) {
      // 使用 ILIKE 进行不区分大小写的模糊搜索
      whereClauses.push(`a.title ILIKE $${paramIndex}`);
      params.push(`%${searchQuery}%`);
      paramIndex++;
    }

    if (whereClauses.length > 0) {
      query += " WHERE " + whereClauses.join(" AND ");
    }

    query += " GROUP BY a.id ORDER BY a.created_at DESC";

    // 计算总数
    const totalQuery = `SELECT COUNT(*) FROM (${query}) AS subquery`;
    const totalResult = await db.query(totalQuery, params);
    const totalArticles = parseInt(totalResult.rows[0].count, 10);
    const totalPages = Math.ceil(totalArticles / limit);

    // 获取分页数据
    const offset = (page - 1) * limit;
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const { rows: articles } = await db.query(query, params);

    return {
      articles,
      pagination: { total: totalArticles, page, limit, totalPages },
    };
  },

  // (后台管理) 根据ID查找单篇文章，无论状态如何
  async findByIdAdmin(id) {
    const query = `
      SELECT
        a.id, a.title, a.content, a.thumbnail_url, a.header_image_url, a.status,
        -- 我们需要原始的标签ID数组，方便前端在编辑页中选中
        (SELECT jsonb_agg(at.tag_id) FROM article_tags at WHERE at.article_id = a.id) as tag_ids
      FROM articles a
      WHERE a.id = $1
      GROUP BY a.id;
    `;
    const { rows } = await db.query(query, [id]);

    // 如果没有找到文章，返回 null 或 undefined
    if (!rows[0]) {
      return null;
    }

    // 如果文章没有标签，tag_ids 可能是 null，我们将其标准化为空数组
    if (!rows[0].tag_ids) {
      rows[0].tag_ids = [];
    }

    return rows[0];
  },

  // (后台管理) 创建一篇新文章
  async create(articleData) {
    const {
      title,
      content,
      summary, // 我们将从控制器传入预先生成的摘要
      thumbnail_url,
      header_image_url,
      status,
      author_id,
      published_at,
      tag_ids, // 这是一个标签ID的数组, e.g., [1, 3, 5]
    } = articleData;

    // 从连接池获取一个客户端，用于事务处理
    const client = await db.getClient();

    try {
      // 开始事务
      await client.query("BEGIN");

      // 1. 插入文章到 articles 表
      const articleQuery = `
        INSERT INTO articles 
          (title, content, summary, thumbnail_url, header_image_url, status, author_id, published_at) 
        VALUES 
          ($1, $2, $3, $4, $5, $6, $7, $8) 
        RETURNING id;
      `;
      const articleParams = [title, content, summary, thumbnail_url, header_image_url, status, author_id, published_at];
      const articleResult = await client.query(articleQuery, articleParams);
      const newArticleId = articleResult.rows[0].id;

      // 2. 如果有关联的标签，则插入到 article_tags 表
      if (tag_ids && tag_ids.length > 0) {
        // 构建多行插入的查询语句
        let tagInsertQuery = "INSERT INTO article_tags (article_id, tag_id) VALUES ";
        const tagInsertParams = [];
        let paramIndex = 1;

        tag_ids.forEach((tagId, index) => {
          tagInsertQuery += `($${paramIndex}, $${paramIndex + 1})`;
          if (index < tag_ids.length - 1) {
            tagInsertQuery += ", ";
          }
          tagInsertParams.push(newArticleId, tagId);
          paramIndex += 2;
        });

        await client.query(tagInsertQuery, tagInsertParams);
      }

      // 提交事务
      await client.query("COMMIT");

      return { id: newArticleId, ...articleData };
    } catch (error) {
      // 如果任何一步出错，回滚所有操作
      await client.query("ROLLBACK");
      logger.error("article_create_transaction_failed", { error });
      // 抛出错误，让控制器去处理
      throw error;
    } finally {
      // 释放客户端回连接池
      client.release();
    }
  },

  // (后台管理) 更新一篇文章
  async update(id, articleData) {
    const { title, content, summary, thumbnail_url, header_image_url, status, published_at, tag_ids } = articleData;

    const client = await db.getClient();
    try {
      await client.query("BEGIN");

      // 1. 更新 articles 表本身
      const articleQuery = `
        UPDATE articles
        SET title = $1, content = $2, summary = $3, thumbnail_url = $4, header_image_url = $5, status = $6, published_at = $7, updated_at = NOW()
        WHERE id = $8
        RETURNING *;
      `;
      const articleParams = [title, content, summary, thumbnail_url, header_image_url, status, published_at, id];
      const { rows } = await client.query(articleQuery, articleParams);

      if (rows.length === 0) {
        throw new Error("Article not found for update");
      }

      // 2. 删除该文章所有旧的标签关联
      await client.query("DELETE FROM article_tags WHERE article_id = $1", [id]);

      // 3. 插入新的标签关联
      if (tag_ids && tag_ids.length > 0) {
        let tagInsertQuery = "INSERT INTO article_tags (article_id, tag_id) VALUES ";
        const tagInsertParams = [];
        let paramIndex = 1;

        tag_ids.forEach((tagId, index) => {
          tagInsertQuery += `($${paramIndex}, $${paramIndex + 1})`;
          if (index < tag_ids.length - 1) tagInsertQuery += ", ";
          tagInsertParams.push(id, tagId);
          paramIndex += 2;
        });
        await client.query(tagInsertQuery, tagInsertParams);
      }

      await client.query("COMMIT");
      return rows[0]; // 返回更新后的文章数据
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  // (后台管理) 删除一篇文章
  async remove(id) {
    const query = "DELETE FROM articles WHERE id = $1";
    // a.rowCount 是 pg 库返回的受影响行数
    const { rowCount } = await db.query(query, [id]);
    return rowCount;
  },

  async updateThumbnailUrl(id, thumbnailUrl) {
    const query = `
      UPDATE articles
      SET thumbnail_url = $1
      WHERE id = $2 AND (thumbnail_url IS NULL OR thumbnail_url = '')
      RETURNING thumbnail_url;
    `;
    const { rows } = await db.query(query, [thumbnailUrl, id]);
    return rows[0] || null;
  },

  async findArticlesMissingThumbnails({ limit = 100 } = {}) {
    const normalizedLimit = Math.max(1, Math.min(1000, Number.parseInt(String(limit), 10) || 100));
    const query = `
      SELECT id, header_image_url
      FROM articles
      WHERE header_image_url IS NOT NULL
        AND header_image_url <> ''
        AND (thumbnail_url IS NULL OR thumbnail_url = '')
      ORDER BY id
      LIMIT $1;
    `;
    const { rows } = await db.query(query, [normalizedLimit]);
    return rows;
  },

  // Check whether an uploaded URL is still referenced by any article (header/thumbnail/content).
  // excludeArticleId: used during updates to exclude the current article from the check.
  async isUploadUrlReferenced(url, excludeArticleId = null) {
    if (!url) return false;

    const likePattern = `%${url}%`;

    if (excludeArticleId !== null && excludeArticleId !== undefined && String(excludeArticleId).trim() !== "") {
      const query = `
        SELECT COUNT(*)::int AS count
        FROM articles
        WHERE id <> $3
          AND (header_image_url = $1 OR thumbnail_url = $1 OR content LIKE $2);
      `;
      const { rows } = await db.query(query, [url, likePattern, excludeArticleId]);
      return (rows[0]?.count || 0) > 0;
    }

    const query = `
      SELECT COUNT(*)::int AS count
      FROM articles
      WHERE header_image_url = $1 OR thumbnail_url = $1 OR content LIKE $2;
    `;
    const { rows } = await db.query(query, [url, likePattern]);
    return (rows[0]?.count || 0) > 0;
  },
};

module.exports = articleModel;
