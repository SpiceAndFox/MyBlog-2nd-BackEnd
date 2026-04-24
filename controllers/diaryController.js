const diaryModel = require("@models/diaryModel");
const { stripHtml } = require("string-strip-html");
const path = require("path");
const fs = require("fs");
const { logger, withRequestContext } = require("../logger");

const uploadsRoot = path.join(__dirname, "..", "uploads", "articles");
const contentDir = path.join(uploadsRoot, "content");
const contentTmpDir = path.join(contentDir, "tmp");

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

const promoteTempContentImages = (html = "", rawKeys = []) => {
  const uniqueKeys = Array.from(
    new Set((Array.isArray(rawKeys) ? rawKeys : []).filter(Boolean).map((key) => path.basename(key)))
  );
  if (!uniqueKeys.length) return html;

  ensureDir(contentDir);
  let normalizedContent = html;

  uniqueKeys.forEach((key) => {
    const tmpPath = path.join(contentTmpDir, key);
    const finalPath = path.join(contentDir, key);
    if (fs.existsSync(tmpPath)) {
      fs.renameSync(tmpPath, finalPath);
    }

    const tmpUrl = `/uploads/articles/content/tmp/${key}`;
    const finalUrl = `/uploads/articles/content/${key}`;
    normalizedContent = normalizedContent.replace(new RegExp(escapeRegExp(tmpUrl), "g"), finalUrl);
  });

  return normalizedContent;
};

const parsePositiveInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const diaryController = {
  async getCurrentUserDiaries(req, res) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const { year, month, page, limit } = req.query;
      const filters = {};
      if (year) filters.year = parseInt(year, 10);
      if (month) filters.month = parseInt(month, 10);

      const result = await diaryModel.findByAuthor({
        authorId: userId,
        filters,
        page: parsePositiveInt(page, 1),
        limit: parsePositiveInt(limit, 10),
      });

      res.status(200).json(result);
    } catch (error) {
      logger.error("diary_list_current_user_failed", withRequestContext(req, { error }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async getCurrentUserDiaryById(req, res) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const diary = await diaryModel.findByIdForAuthor(req.params.id, userId);
      if (!diary) return res.status(404).json({ error: "Diary not found" });

      res.status(200).json(diary);
    } catch (error) {
      logger.error("diary_get_current_user_failed", withRequestContext(req, { error, diaryId: req.params.id }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async createDiary(req, res) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const { title, content, status = "published", content_image_keys } = req.body;
      if (!title || !content) {
        return res.status(400).json({ error: "标题和内容不能为空" });
      }
      if (status !== "published" && status !== "draft") {
        return res.status(400).json({ error: "无效的状态值" });
      }

      const contentImageKeys = normalizeArrayInput(content_image_keys);
      const normalizedContent = promoteTempContentImages(content, contentImageKeys);
      const summary = stripHtml(normalizedContent).result.substring(0, 200);

      const diary = await diaryModel.create({
        title: title.trim(),
        content: normalizedContent,
        summary,
        status,
        author_id: userId,
        published_at: status === "published" ? new Date() : null,
      });

      res.status(201).json({ message: "日记创建成功", diary });
    } catch (error) {
      logger.error("diary_create_failed", withRequestContext(req, { error }));
      res.status(500).json({ error: "创建日记失败" });
    }
  },
};

module.exports = diaryController;
