const tagModel = require("@models/tagModel");
const { logger, withRequestContext } = require("../logger");

const tagController = {
  // 获取所有标签并构造成层级结构
  async getAllTags(req, res) {
    try {
      const tags = await tagModel.findAll();

      // 1. 为每个标签补上 articleCount 字段
      const tagsWithCount = await Promise.all(
        tags.map(async (tag) => {
          const articleCount = await tagModel.getArticleCountByTagId(tag.id);
          return {
            id: tag.id,
            name: tag.name,
            parent_id: tag.parent_id,
            articleCount, // 这里就是最终前端用的字段名
          };
        })
      );

      // 2. 转成层级结构
      const tagsMap = new Map();
      const topTags = [];

      tagsWithCount.forEach((tag) => {
        tagsMap.set(tag.id, { ...tag, subTags: [] });
        if (tag.parent_id === null) {
          topTags.push(tagsMap.get(tag.id));
        }
      });

      tagsWithCount.forEach((tag) => {
        if (tag.parent_id !== null && tagsMap.has(tag.parent_id)) {
          const parentTag = tagsMap.get(tag.parent_id);
          parentTag.subTags.push(tagsMap.get(tag.id));
        }
      });

      res.status(200).json(topTags);
    } catch (error) {
      logger.error("tag_list_failed", withRequestContext(req, { error }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  // (后台管理) 创建一个新标签
  async createTag(req, res) {
    try {
      const { name, parent_id } = req.body;
      if (!name) {
        return res.status(400).json({ error: "标签名称不能为空" });
      }
      const newTag = await tagModel.create({ name, parent_id });
      res.status(201).json(newTag);
    } catch (error) {
      // 捕获数据库的唯一性约束错误
      if (error.code === "23505") {
        // '23505' 是 PostgreSQL 中 unique_violation 的错误码
        return res.status(409).json({ error: "同一分类下已存在同名标签" });
      }
      logger.error("tag_create_failed", withRequestContext(req, { error }));
      res.status(500).json({ error: "创建标签失败" });
    }
  },

  // (后台管理) 更新一个标签
  async updateTag(req, res) {
    try {
      const { id } = req.params;
      const { name } = req.body;
      if (!name) {
        return res.status(400).json({ error: "标签名称不能为空" });
      }
      const updatedTag = await tagModel.update(id, { name });
      if (!updatedTag) {
        return res.status(404).json({ error: "找不到要更新的标签" });
      }
      res.status(200).json(updatedTag);
    } catch (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "同一分类下已存在同名标签" });
      }
      logger.error("tag_update_failed", withRequestContext(req, { error, tagId: req.params.id }));
      res.status(500).json({ error: "更新标签失败" });
    }
  },

  // (后台管理) 删除一个标签
  async deleteTag(req, res) {
    try {
      const { id } = req.params;

      // 1. 在删除前，检查标签的使用情况
      const articleCount = await tagModel.getArticleCountByTagId(id);
      if (articleCount > 0) {
        // 如果标签仍在使用，返回 409 Conflict 状态码
        return res.status(409).json({
          error: `无法删除该标签，因为它正被 ${articleCount} 篇文章使用。`,
        });
      }

      // 2. 如果未使用，则执行删除
      const deletedCount = await tagModel.remove(id);
      if (deletedCount === 0) {
        return res.status(404).json({ error: "找不到要删除的标签" });
      }

      res.status(204).send();
    } catch (error) {
      logger.error("tag_delete_failed", withRequestContext(req, { error, tagId: req.params.id }));
      res.status(500).json({ error: "删除标签失败" });
    }
  },
};

module.exports = tagController;
