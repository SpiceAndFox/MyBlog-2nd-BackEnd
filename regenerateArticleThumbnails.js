#!/usr/bin/env node
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const sharp = require("sharp");

require("module-alias/register");

dotenv.config({ path: path.join(__dirname, ".env") });

const db = require("./db");
const articleModel = require("@models/articleModel");

const uploadsRoot = path.join(__dirname, "uploads", "articles");
const headerDir = path.join(uploadsRoot, "headers");
const thumbDir = path.join(uploadsRoot, "thumbnails");

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw || !raw.startsWith("--")) continue;

    const key = raw.slice(2).trim();
    const next = argv[i + 1];
    if (next !== undefined && !String(next).startsWith("--")) {
      parsed[key] = next;
      i += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function toSafeFilenameStem(value, fallback = "image") {
  const stem = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stem || fallback;
}

function resolveHeaderPath(url) {
  if (!url || typeof url !== "string") return null;

  const prefix = "/uploads/articles/headers/";
  const index = url.indexOf(prefix);
  if (index === -1) return null;

  const rawTail = url.slice(index + prefix.length);
  const filename = path.basename(rawTail.split(/[?#]/)[0]);
  if (!filename) return null;

  return path.join(headerDir, filename);
}

async function regenerateThumbnail(article) {
  const headerFilePath = resolveHeaderPath(article.header_image_url);
  if (!headerFilePath) return { id: article.id, status: "skipped", reason: "unsupported-header-url" };

  try {
    await fs.promises.access(headerFilePath, fs.constants.R_OK);
  } catch {
    return { id: article.id, status: "skipped", reason: "header-file-missing" };
  }

  const headerStem = path.basename(headerFilePath, path.extname(headerFilePath));
  const baseStem = headerStem.endsWith("-header") ? headerStem.slice(0, -"-header".length) : headerStem;
  const thumbFilename = `${toSafeFilenameStem(baseStem, `article-${article.id}`)}-thumb.webp`;
  const thumbFilePath = path.join(thumbDir, thumbFilename);
  const thumbnailUrl = `/uploads/articles/thumbnails/${thumbFilename}`;

  await fs.promises.mkdir(thumbDir, { recursive: true });
  await sharp(headerFilePath)
    .resize({ width: 400, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(thumbFilePath);
  await articleModel.updateThumbnailUrl(article.id, thumbnailUrl);

  return { id: article.id, status: "updated", thumbnailUrl };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const limit = Number.parseInt(String(args.limit || 200), 10) || 200;
  const dryRun = Boolean(args["dry-run"] || args.dryRun);
  const articles = await articleModel.findArticlesMissingThumbnails({ limit });

  if (!articles.length) {
    console.log("No articles need thumbnail regeneration.");
    return;
  }

  if (dryRun) {
    console.log(`dry-run: would regenerate ${articles.length} article thumbnails`);
    console.log(articles.map((article) => article.id).join(", "));
    return;
  }

  let updated = 0;
  let skipped = 0;
  for (const article of articles) {
    const result = await regenerateThumbnail(article);
    if (result.status === "updated") updated += 1;
    else skipped += 1;
    console.log(result);
  }

  console.log("done:", { updated, skipped, total: articles.length });
}

main()
  .catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    db.end();
  });
