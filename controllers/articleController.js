// controllers/articleController.js
const articleModel = require("@models/articleModel");
const { stripHtml } = require("string-strip-html");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");
const { articleConfig } = require("../config");
const { logger, withRequestContext } = require("../logger");

const uploadsRoot = path.join(__dirname, "..", "uploads", "articles");
const contentDir = path.join(uploadsRoot, "content");
const contentTmpDir = path.join(contentDir, "tmp");
const headerDir = path.join(uploadsRoot, "headers");
const thumbDir = path.join(uploadsRoot, "thumbnails");
const TEMP_IMAGE_TTL_MS = articleConfig.tempImageTtlMs; // 24h 过期（可用 env 覆盖）
const CLEAN_INTERVAL_MS = articleConfig.cleanupIntervalMs; // 每 6h 清理（可用 env 覆盖）

// 目录创建与输入标准化
const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalizeArrayInput = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

ensureDir(contentDir);
ensureDir(contentTmpDir);
ensureDir(headerDir);
ensureDir(thumbDir);

const safeUnlink = async (filePath) => {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // ignore
  }
};

const LOCAL_UPLOAD_MAPPINGS = [
  { prefix: "/uploads/articles/content/tmp/", dir: contentTmpDir },
  { prefix: "/uploads/articles/content/", dir: contentDir },
  { prefix: "/uploads/articles/headers/", dir: headerDir },
  { prefix: "/uploads/articles/thumbnails/", dir: thumbDir },
];

const resolveLocalUploadFilePathFromUrl = (url) => {
  if (!url || typeof url !== "string") return null;

  for (const mapping of LOCAL_UPLOAD_MAPPINGS) {
    const idx = url.indexOf(mapping.prefix);
    if (idx === -1) continue;

    const rawTail = url.slice(idx + mapping.prefix.length);
    const cleanTail = rawTail.split(/[?#]/)[0];
    const filename = path.basename(cleanTail);
    if (!filename) return null;

    return path.join(mapping.dir, filename);
  }

  return null;
};

const collectUploadFilenamesFromText = (text, prefix) => {
  const results = new Set();
  if (!text || typeof text !== "string") return results;

  const regex = new RegExp(`${escapeRegExp(prefix)}([^"'\\s)<>]+)`, "g");
  let match;
  while ((match = regex.exec(text)) !== null) {
    const raw = (match[1] || "").split(/[?#]/)[0];
    const filename = path.basename(raw);
    if (filename) results.add(filename);
  }

  return results;
};

const getArticleImageRefs = ({ content = "", header_image_url = null, thumbnail_url = null } = {}) => {
  const tmpFilenames = collectUploadFilenamesFromText(content, "/uploads/articles/content/tmp/");

  // Match "/uploads/articles/content/<file>" but exclude the tmp subdir to avoid ambiguity.
  const contentFilenames = new Set();
  if (content && typeof content === "string") {
    const regex = new RegExp(`${escapeRegExp("/uploads/articles/content/")}(?!tmp/)([^\"'\\s)<>]+)`, "g");
    let match;
    while ((match = regex.exec(content)) !== null) {
      const raw = (match[1] || "").split(/[?#]/)[0];
      const filename = path.basename(raw);
      if (filename) contentFilenames.add(filename);
    }
  }

  return {
    headerUrl: header_image_url,
    thumbnailUrl: thumbnail_url,
    contentFilenames,
    tmpFilenames,
  };
};

const cleanupUploadUrlsIfUnreferenced = async (urls = [], { excludeArticleId = null } = {}) => {
  const uniqueUrls = Array.from(new Set((Array.isArray(urls) ? urls : []).filter(Boolean)));
  if (!uniqueUrls.length) return;

  await Promise.allSettled(
    uniqueUrls.map(async (url) => {
      try {
        const referenced = await articleModel.isUploadUrlReferenced(url, excludeArticleId);
        if (referenced) return;

        const filePath = resolveLocalUploadFilePathFromUrl(url);
        if (!filePath) return;

        await safeUnlink(filePath);
      } catch {
        // best-effort cleanup
      }
    })
  );
};

const processHeaderAndThumbnail = async (file) => {
  const ext = ".webp";
  const base = path.basename(file.filename, path.extname(file.filename));
  const headerFilename = `${base}-header${ext}`;
  const thumbFilename = `${base}-thumb${ext}`;

  const headerFilePath = path.join(headerDir, headerFilename);
  const thumbFilePath = path.join(thumbDir, thumbFilename);

  try {
    await sharp(file.path)
      .resize({
        width: 2560,
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toFile(headerFilePath);

    await sharp(file.path).resize({ width: 400 }).webp({ quality: 80 }).toFile(thumbFilePath);

    return {
      headerUrl: `/uploads/articles/headers/${headerFilename}`,
      thumbnailUrl: `/uploads/articles/thumbnails/${thumbFilename}`,
    };
  } catch (error) {
    await safeUnlink(headerFilePath);
    await safeUnlink(thumbFilePath);
    throw error;
  } finally {
    await safeUnlink(file.path);
  }
};

// Move temporary content images into the public content directory and rewrite their URLs.
const promoteTempContentImages = (html = "", rawKeys = []) => {
  const uniqueKeys = Array.from(
    new Set((Array.isArray(rawKeys) ? rawKeys : []).filter(Boolean).map((k) => path.basename(k)))
  );
  if (!uniqueKeys.length) return { normalizedContent: html, promoted: [] };

  ensureDir(contentDir);
  let normalizedContent = html;
  const promoted = [];

  uniqueKeys.forEach((key) => {
    const tmpPath = path.join(contentTmpDir, key);
    const finalPath = path.join(contentDir, key);
    if (fs.existsSync(tmpPath)) {
      fs.renameSync(tmpPath, finalPath);
      promoted.push(key);
    }
    const tmpUrl = `/uploads/articles/content/tmp/${key}`;
    const finalUrl = `/uploads/articles/content/${key}`;
    normalizedContent = normalizedContent.replace(new RegExp(escapeRegExp(tmpUrl), "g"), finalUrl);
  });

  return { normalizedContent, promoted };
};

// 定期删除过期的临时正文图片
const cleanupStaleTempContentImages = () => {
  ensureDir(contentTmpDir);
  const now = Date.now();
  fs.readdir(contentTmpDir, (err, files = []) => {
    if (err) {
      logger.warn("article_temp_cleanup_read_failed", { error: err });
      return;
    }
    files.forEach((file) => {
      const fullPath = path.join(contentTmpDir, file);
      fs.stat(fullPath, (statErr, stats) => {
        if (statErr) return;
        if (now - stats.mtimeMs > TEMP_IMAGE_TTL_MS) {
          fs.unlink(fullPath, () => {});
        }
      });
    });
  });
};

cleanupStaleTempContentImages();
setInterval(cleanupStaleTempContentImages, CLEAN_INTERVAL_MS);

const articleController = {
  // 获取所有已发布的文章列表
  async getAllPublishedArticles(req, res) {
    try {
      const { topTag, subTag, year, month, search, page, limit } = req.query;

      const filters = {};
      if (topTag) filters.topTag = topTag;
      if (subTag) filters.subTag = subTag;
      if (year) filters.year = parseInt(year, 10);
      if (month) filters.month = parseInt(month, 10);
      if (search) filters.search = search.trim();

      const pageNum = parseInt(page, 10) || 1;
      const limitNum = parseInt(limit, 10) || 10;

      const result = await articleModel.findPublished({
        filters,
        page: pageNum,
        limit: limitNum,
      });

      res.status(200).json(result);
    } catch (error) {
      logger.error("article_list_published_failed", withRequestContext(req, { error }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async getPublishedArticleById(req, res) {
    try {
      const { id } = req.params;
      const article = await articleModel.findPublishedById(id);

      if (!article) {
        return res.status(404).json({ error: "Article not found" });
      }

      res.status(200).json(article);
    } catch (error) {
      logger.error("article_get_published_failed", withRequestContext(req, { error, articleId: req.params.id }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async getAllArticlesAdmin(req, res) {
    try {
      const { search, page, limit } = req.query;
      const result = await articleModel.findAllAdmin({
        searchQuery: search,
        page: parseInt(page, 10) || 1,
        limit: parseInt(limit, 10) || 10,
      });
      res.status(200).json(result);
    } catch (error) {
      logger.error("article_list_admin_failed", withRequestContext(req, { error }));
      res.status(500).json({ error: "服务器内部错误" });
    }
  },

  async uploadContentImage(req, res) {
    try {
      if (!req.file) return res.status(400).json({ error: "未收到图片文件" });

      const outputDir = contentTmpDir;
      fs.mkdirSync(outputDir, { recursive: true });

      const base = path.basename(req.file.filename, path.extname(req.file.filename));
      const outputName = `${base}-body.webp`;
      const outputPath = path.join(outputDir, outputName);

      await sharp(req.file.path)
        .resize({ width: 1920, withoutEnlargement: true })
        .webp({ quality: 85 })
        .toFile(outputPath);

      fs.unlink(req.file.path, () => {});
      res.status(201).json({
        url: `/uploads/articles/content/tmp/${outputName}`,
        key: outputName,
        isTemp: true,
      });
    } catch (error) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      logger.error("article_upload_content_image_failed", withRequestContext(req, { error }));
      res.status(500).json({ error: "图片上传失败" });
    }
  },

  async createArticle(req, res) {
    try {
      const { title, content, status, tag_ids, content_image_keys } = req.body;

      if (!title || !content || !status) {
        return res.status(400).json({ error: "标题、内容和状态是必填项" });
      }
      if (status !== "published" && status !== "draft") {
        return res.status(400).json({ error: "无效的状态值" });
      }

      const tagIdsArray = normalizeArrayInput(tag_ids);
      const contentImageKeys = normalizeArrayInput(content_image_keys);
      const { normalizedContent } = promoteTempContentImages(content, contentImageKeys);

      const author_id = req.user.id;
      const summary = stripHtml(normalizedContent).result.substring(0, 200);

      let header_image_url = null;
      let thumbnail_url = null;

      const file = req.file;
      if (file) {
        const processed = await processHeaderAndThumbnail(file);
        header_image_url = processed.headerUrl;
        thumbnail_url = processed.thumbnailUrl;
      }

      const articleData = {
        title,
        content: normalizedContent,
        summary,
        thumbnail_url,
        header_image_url,
        status,
        author_id,
        published_at: status === "published" ? new Date() : null,
        tag_ids: tagIdsArray,
      };

      const newArticle = await articleModel.create(articleData);

      res.status(201).json({ message: "文章创建成功", article: newArticle });
    } catch (error) {
      logger.error("article_create_failed", withRequestContext(req, { error }));
      res.status(500).json({ error: "创建文章失败，服务器内部错误" });
    }
  },

  async getArticleByIdAdmin(req, res) {
    try {
      const { id } = req.params;
      const article = await articleModel.findByIdAdmin(id);

      if (!article) {
        return res.status(404).json({ error: "找不到指定的文章" });
      }

      res.status(200).json(article);
    } catch (error) {
      logger.error("article_get_admin_failed", withRequestContext(req, { error, articleId: req.params.id }));
      res.status(500).json({ error: "服务器内部错误" });
    }
  },

  async updateArticle(req, res) {
    try {
      const { id } = req.params;
      const { title, content, status, content_image_keys } = req.body;

      if (!title || !content || !status) {
        return res.status(400).json({ error: "标题、内容和状态是必填项" });
      }

      let tagIdsArray = normalizeArrayInput(req.body.tag_ids);
      const contentImageKeys = normalizeArrayInput(content_image_keys);

      const existingArticle = await articleModel.findByIdAdmin(id);
      if (!existingArticle) {
        return res.status(404).json({ error: "找不到要更新的文章" });
      }

      const existingRefs = getArticleImageRefs(existingArticle);
      const { normalizedContent, promoted } = promoteTempContentImages(content, contentImageKeys);
      const summary = stripHtml(normalizedContent).result.substring(0, 200);
      let header_image_url = req.body.header_image_url || existingArticle.header_image_url || null;
      let thumbnail_url = req.body.thumbnail_url || existingArticle.thumbnail_url || null;

      if (req.file) {
        const processed = await processHeaderAndThumbnail(req.file);
        header_image_url = processed.headerUrl;
        thumbnail_url = processed.thumbnailUrl;
      }

      const nextRefs = getArticleImageRefs({ content: normalizedContent, header_image_url, thumbnail_url });
      const urlsToCleanup = [];

      if (existingRefs.headerUrl && existingRefs.headerUrl !== header_image_url) {
        urlsToCleanup.push(existingRefs.headerUrl);
      }
      if (existingRefs.thumbnailUrl && existingRefs.thumbnailUrl !== thumbnail_url) {
        urlsToCleanup.push(existingRefs.thumbnailUrl);
      }

      existingRefs.contentFilenames.forEach((filename) => {
        if (!nextRefs.contentFilenames.has(filename)) {
          urlsToCleanup.push(`/uploads/articles/content/${filename}`);
        }
      });

      existingRefs.tmpFilenames.forEach((filename) => {
        if (!nextRefs.tmpFilenames.has(filename)) {
          urlsToCleanup.push(`/uploads/articles/content/tmp/${filename}`);
        }
      });

      const promotedOrphans = (Array.isArray(promoted) ? promoted : [])
        .filter((filename) => filename && !nextRefs.contentFilenames.has(filename))
        .map((filename) => `/uploads/articles/content/${filename}`);

      const articleData = {
        title,
        content: normalizedContent,
        summary,
        thumbnail_url,
        header_image_url,
        status,
        published_at:
          status === "published" && existingArticle.status !== "published" ? new Date() : existingArticle.published_at,
        tag_ids: tagIdsArray,
      };

      const updatedArticle = await articleModel.update(id, articleData);
      await cleanupUploadUrlsIfUnreferenced([...urlsToCleanup, ...promotedOrphans], { excludeArticleId: id });
      res.status(200).json({ message: "文章更新成功", article: updatedArticle });
    } catch (error) {
      logger.error("article_update_failed", withRequestContext(req, { error, articleId: req.params.id }));
      res.status(500).json({ error: "更新文章失败，服务器内部错误" });
    }
  },

  async deleteArticle(req, res) {
    try {
      const { id } = req.params;
      const existingArticle = await articleModel.findByIdAdmin(id);
      const existingRefs = existingArticle ? getArticleImageRefs(existingArticle) : null;
      const deletedCount = await articleModel.remove(id);

      if (deletedCount === 0) {
        return res.status(404).json({ error: "找不到要删除的文章" });
      }

      if (existingRefs) {
        const urlsToCleanup = [];
        if (existingRefs.headerUrl) urlsToCleanup.push(existingRefs.headerUrl);
        if (existingRefs.thumbnailUrl) urlsToCleanup.push(existingRefs.thumbnailUrl);
        existingRefs.contentFilenames.forEach((filename) => urlsToCleanup.push(`/uploads/articles/content/${filename}`));
        existingRefs.tmpFilenames.forEach((filename) => urlsToCleanup.push(`/uploads/articles/content/tmp/${filename}`));
        await cleanupUploadUrlsIfUnreferenced(urlsToCleanup);
      }

      res.status(204).send();
    } catch (error) {
      logger.error("article_delete_failed", withRequestContext(req, { error, articleId: req.params.id }));
      res.status(500).json({ error: "删除文章失败，服务器内部错误" });
    }
  },
};

module.exports = articleController;
