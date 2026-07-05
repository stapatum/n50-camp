// CMS storage: a single SQLite file accessed through Node's built-in
// node:sqlite module — no native npm dependency, which keeps the offline
// buildNpmPackage in flake.nix working. DatabaseSync is synchronous; with
// prepared statements and this data volume each call is microseconds.
//
// The module opens the database at import time. A misconfigured N50_CAMP_DB
// path therefore crashes the server at boot (fail fast, surfaced by systemd)
// instead of producing a half-working site.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.N50_CAMP_DB ?? "./data/cms.db";
// dev convenience so `npm run dev` works out of the box; in production the
// directory is provisioned by systemd (StateDirectory=n50-camp)
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS pages (
    id          INTEGER PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    title       TEXT NOT NULL,
    html        TEXT NOT NULL DEFAULT '',
    published   INTEGER NOT NULL DEFAULT 0,
    provisioned INTEGER NOT NULL DEFAULT 0,
    edited      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  CREATE TABLE IF NOT EXISTS media (
    id         INTEGER PRIMARY KEY,
    filename   TEXT NOT NULL,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    data       BLOB NOT NULL,
    width      INTEGER,
    height     INTEGER,
    provisioned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  CREATE TABLE IF NOT EXISTS media_variants (
    id       INTEGER PRIMARY KEY,
    media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    width    INTEGER NOT NULL,
    size     INTEGER NOT NULL,
    data     BLOB NOT NULL,
    UNIQUE (media_id, width)
  );

  CREATE TABLE IF NOT EXISTS nav_links (
    id          INTEGER PRIMARY KEY,
    label       TEXT NOT NULL,
    url         TEXT NOT NULL,
    placement   TEXT NOT NULL DEFAULT 'top',
    position    REAL NOT NULL,
    page_id     INTEGER REFERENCES pages(id) ON DELETE CASCADE,
    provisioned INTEGER NOT NULL DEFAULT 0,
    edited      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_nav_placement ON nav_links(placement);
  CREATE INDEX IF NOT EXISTS idx_nav_page ON nav_links(page_id);
`);

// ── migrations for existing databases ──────────────────────────────────────
// Earlier versions of the schema lacked `placement`/`page_id` on nav_links,
// and `pages` had a `show_in_nav` column that is now replaced by nav_links
// rows. Add the new columns in place; the old pages column is left as a
// harmless orphan (SQLite can't drop it before 3.35, and even then ALTER
// TABLE DROP COLUMN is fiddly in WAL mode).
{
  const navCols = db.prepare("PRAGMA table_info(nav_links)").all() as { name: string }[];
  if (!navCols.some((c) => c.name === "placement")) {
    db.exec("ALTER TABLE nav_links ADD COLUMN placement TEXT NOT NULL DEFAULT 'top'");
  }
  if (!navCols.some((c) => c.name === "page_id")) {
    db.exec("ALTER TABLE nav_links ADD COLUMN page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE");
  }
}

export interface Page {
  id: number;
  slug: string;
  title: string;
  html: string;
  published: number;
  provisioned: number;
  edited: number;
  created_at: string;
  updated_at: string;
}

interface MediaItem {
  id: number;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  created_at: string;
}

export interface NavLink {
  id: number;
  label: string;
  url: string;
  placement: "top" | "bottom";
  position: number;
  page_id: number | null;
  provisioned: number;
  edited: number;
  created_at: string;
  updated_at: string;
}

export type NavPlacement = "top" | "bottom";

// Slugs that must never be claimed by a CMS page: Astro's static routes
// always outrank the [slug] route, so a colliding page would silently never
// render. The seeded built-in pages (anreise, versorgung, …) are NOT
// reserved — they live in the database and render via [slug] like any other
// CMS page.
export const RESERVED_SLUGS = new Set([
  "",
  "index",
  "admin",
  "media",
  "404",
]);
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const stBySlugAny = db.prepare("SELECT * FROM pages WHERE slug = ?");
const stList = db.prepare(
  "SELECT id, slug, title, published, updated_at FROM pages ORDER BY slug",
);
const stById = db.prepare("SELECT * FROM pages WHERE id = ?");
const stCreate = db.prepare("INSERT INTO pages (slug, title) VALUES (?, ?)");
const stUpdate = db.prepare(`
  UPDATE pages SET slug = ?, title = ?, html = ?, published = ?,
    edited = CASE WHEN provisioned = 1 THEN 1 ELSE edited END,
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
  WHERE id = ?
`);
const stDelete = db.prepare("DELETE FROM pages WHERE id = ?");

const stMediaInsert = db.prepare(
  "INSERT INTO media (filename, mime, size, data, width, height) VALUES (?, ?, ?, ?, ?, ?)",
);
const stMediaGet = db.prepare("SELECT * FROM media WHERE id = ?");
// listings intentionally skip the blob columns — only metadata is needed
const stMediaList = db.prepare(
  "SELECT id, filename, mime, size, width, height, created_at FROM media ORDER BY id DESC",
);
const stMediaMeta = db.prepare(
  "SELECT id, filename, mime, size, width, height, created_at FROM media WHERE id = ?",
);
const stMediaDelete = db.prepare("DELETE FROM media WHERE id = ?");

const stVariantInsert = db.prepare(
  "INSERT INTO media_variants (media_id, width, size, data) VALUES (?, ?, ?, ?)",
);
const stVariantGet = db.prepare(
  "SELECT data, size FROM media_variants WHERE media_id = ? AND width = ?",
);
const stVariantWidths = db.prepare(
  "SELECT width FROM media_variants WHERE media_id = ? ORDER BY width",
);

const stNavList = db.prepare(
  "SELECT id, label, url, placement, position, page_id FROM nav_links WHERE placement = ? ORDER BY position",
);
const stNavCreate = db.prepare(
  "INSERT INTO nav_links (label, url, placement, position, page_id) VALUES (?, ?, ?, ?, ?)",
);
const stNavUpdate = db.prepare(`
  UPDATE nav_links SET label = ?, url = ?, edited = CASE WHEN provisioned = 1 THEN 1 ELSE edited END,
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
  WHERE id = ?
`);
const stNavDelete = db.prepare("DELETE FROM nav_links WHERE id = ?");
const stNavMaxPos = db.prepare(
  "SELECT COALESCE(MAX(position), 0) AS m FROM nav_links WHERE placement = ?",
);
const stNavSetPos = db.prepare(
  "UPDATE nav_links SET position = ?, edited = CASE WHEN provisioned = 1 THEN 1 ELSE edited END WHERE id = ?",
);
const stNavByPage = db.prepare(
  "SELECT id, placement FROM nav_links WHERE page_id = ? ORDER BY placement",
);
const stNavDeleteByPage = db.prepare(
  "DELETE FROM nav_links WHERE page_id = ? AND placement = ?",
);
const stNavUrlUpdate = db.prepare(
  "UPDATE nav_links SET url = ? WHERE page_id = ?",
);

export const getPageBySlug = (slug: string) =>
  stBySlugAny.get(slug) as unknown as Page | undefined;

export const listPages = () =>
  stList.all() as unknown as Omit<Page, "html" | "created_at">[];

export const getPage = (id: number) => stById.get(id) as unknown as Page | undefined;

export const createPage = (slug: string, title: string) =>
  Number(stCreate.run(slug, title).lastInsertRowid);

export const updatePage = (
  id: number,
  fields: Pick<Page, "slug" | "title" | "html" | "published"> & {
    showInTopNav: boolean;
    showInBottomNav: boolean;
  },
  prevSlug: string,
) => {
  stUpdate.run(fields.slug, fields.title, fields.html, fields.published, id);

  // If the slug changed, update the URL of any nav_links pointing at this page
  // so they don't dangle. The label is left alone — the admin may have
  // customised it in /admin/nav.
  if (fields.slug !== prevSlug) {
    stNavUrlUpdate.run(`/${fields.slug}`, id);
  }

  // Sync the page's nav_link membership for each placement. Checking a box
  // creates a nav_link at the end of its placement (if one doesn't already
  // exist); unchecking deletes it.
  for (const placement of ["top", "bottom"] as const) {
    const enabled = placement === "top" ? fields.showInTopNav : fields.showInBottomNav;
    const existing = (stNavByPage.all(id) as { id: number; placement: string }[]).find(
      (r) => r.placement === placement,
    );
    if (enabled && !existing) {
      const maxPos = (stNavMaxPos.get(placement) as { m: number }).m;
      stNavCreate.run(fields.title, `/${fields.slug}`, placement, maxPos + 1, id);
    } else if (!enabled && existing) {
      stNavDeleteByPage.run(id, placement);
    }
  }
};

export const deletePage = (id: number) => {
  stDelete.run(id);
};

export const insertMedia = (
  filename: string,
  mime: string,
  data: Uint8Array,
  width: number | null,
  height: number | null,
) => Number(stMediaInsert.run(filename, mime, data.byteLength, data, width, height).lastInsertRowid);

export const getMedia = (id: number) =>
  stMediaGet.get(id) as unknown as (MediaItem & { data: Uint8Array }) | undefined;

export const getMediaMeta = (id: number) => stMediaMeta.get(id) as unknown as MediaItem | undefined;

export const listMedia = () => stMediaList.all() as unknown as MediaItem[];

export const deleteMedia = (id: number) => {
  stMediaDelete.run(id);
};

export const insertMediaVariant = (mediaId: number, width: number, data: Uint8Array) => {
  stVariantInsert.run(mediaId, width, data.byteLength, data);
};

export const getMediaVariant = (mediaId: number, width: number) =>
  stVariantGet.get(mediaId, width) as unknown as { data: Uint8Array; size: number } | undefined;

const mediaVariantWidths = (mediaId: number) =>
  (stVariantWidths.all(mediaId) as unknown as { width: number }[]).map((r) => r.width);

// ── nav links ──────────────────────────────────────────────────────────────
// Admin-editable navigation for both the header (top) and the footer (bottom).
// A nav_link is either:
//   - page-linked (page_id set): created/destroyed from the page editor's
//     checkboxes; url and label start from the page's slug/title but the admin
//     can edit the label freely in /admin/nav.
//   - external (page_id NULL): a free-form label+url, managed only from
//     /admin/nav.
// `position` is per-placement; reorders re-pack to dense integers so future
// midpoints never run out of precision.

export const listNavLinks = (placement: NavPlacement) =>
  stNavList.all(placement) as unknown as Pick<
    NavLink,
    "id" | "label" | "url" | "placement" | "position" | "page_id"
  >[];

// Which placements a page currently appears in — drives the checkboxes in the
// page editor.
export const getPageNavPlacements = (pageId: number): Set<NavPlacement> => {
  const rows = stNavByPage.all(pageId) as { id: number; placement: string }[];
  return new Set(rows.filter((r) => r.placement === "top" || r.placement === "bottom").map((r) => r.placement as NavPlacement));
};

export const createNavLink = (label: string, url: string, placement: NavPlacement) => {
  const maxPos = (stNavMaxPos.get(placement) as { m: number }).m;
  return Number(stNavCreate.run(label, url, placement, maxPos + 1, null).lastInsertRowid);
};

export const updateNavLink = (id: number, label: string, url: string) => {
  stNavUpdate.run(label, url, id);
};

export const deleteNavLink = (id: number) => {
  stNavDelete.run(id);
};

// Swap two adjacent links by id within the same placement. After any reorder
// we re-pack positions to a dense 1,2,3,… sequence.
export const moveNavLink = (id: number, dir: -1 | 1) => {
  // Find the link to learn its placement, then list only that placement so
  // the swap and re-pack are scoped correctly.
  const all = db.prepare("SELECT placement FROM nav_links WHERE id = ?").get(id) as
    | { placement: string }
    | undefined;
  if (!all) return;
  const placement = all.placement as NavPlacement;
  const links = listNavLinks(placement);
  const idx = links.findIndex((l) => l.id === id);
  const swapWith = idx + dir;
  if (idx < 0 || swapWith < 0 || swapWith >= links.length) return;
  const reordered = [...links];
  [reordered[idx], reordered[swapWith]] = [reordered[swapWith], reordered[idx]];
  db.exec("BEGIN");
  try {
    reordered.forEach((l, i) => stNavSetPos.run(i + 1, l.id));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
};

// ── image processing ──────────────────────────────────────────────────────
// Server-side image optimization for CMS media — the equivalent of what
// Astro's <Image> emits, done at the media layer because CMS content is a raw
// HTML string that components can't run in (and the sandbox forbids the
// request-time fetches Astro's /_image endpoint would make).
//
// Upload time: probe dimensions and pre-generate downscaled WebP variants.
// Render time: rewrite <img src="/media/..."> tags with width/height,
// srcset/sizes and lazy loading. Costs nothing per request beyond two
// prepared statements per image.

// Mirror the explicit `widths`/`sizes` the hand-written pages pass to
// astro:assets' <Image>, so CMS content looks identical to the static pages.
// Astro filters the list to widths <= the intrinsic width; the original bytes
// stay reachable at the bare /media/<id>/<filename> URL (the `src` itself).
const VARIANT_WIDTHS = [320, 480, 640, 800, 1024, 1280, 1600];

// formats sharp downscales well; svg (vector) and gif (animation) are
// deliberately served untouched
const RASTER = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/tiff"]);

interface ProcessedImage {
  width: number | null;
  height: number | null;
  variants: { width: number; data: Uint8Array }[];
}

export async function processImage(data: Uint8Array, mime: string): Promise<ProcessedImage> {
  if (!RASTER.has(mime)) return { width: null, height: null, variants: [] };
  try {
    // dynamic import: a broken sharp build must only break uploads, not the site
    const sharp = (await import("sharp")).default;
    const meta = await sharp(data).metadata();
    if (!meta.width || !meta.height) return { width: null, height: null, variants: [] };
    // EXIF orientations 5-8 are rotated 90°: report the displayed dimensions
    const swapped = (meta.orientation ?? 1) >= 5;
    const width = swapped ? meta.height : meta.width;
    const height = swapped ? meta.width : meta.height;

    const variants = [];
    for (const w of VARIANT_WIDTHS.filter((w) => w <= width)) {
      const buf = await sharp(data).rotate().resize(w).webp({ quality: 80 }).toBuffer();
      variants.push({ width: w, data: new Uint8Array(buf) });
    }
    return { width, height, variants };
  } catch (err) {
    console.error("image processing failed, storing original only:", err);
    return { width: null, height: null, variants: [] };
  }
}

const IMG_TAG = /<img\b[^>]*>/gi;
const SRC_ATTR = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

// Rewrite <img> tags pointing at /media/<id>/... : add intrinsic dimensions
// (prevents layout shift), lazy loading, and a srcset of the pre-generated
// variants. Attributes the author wrote themselves are never overridden.
export function enhanceImages(html: string): string {
  return html.replace(IMG_TAG, (tag) => {
    const srcMatch = tag.match(SRC_ATTR);
    const src = srcMatch?.[1] ?? srcMatch?.[2];
    const idMatch = src?.match(/^\/media\/(\d+)\//);
    if (!src || !idMatch) return tag;
    const media = getMediaMeta(Number(idMatch[1]));
    if (!media) return tag;

    let out = tag;
    const addAttr = (name: string, value: string) => {
      if (!new RegExp(`\\s${name}\\s*=`, "i").test(out)) {
        out = out.replace(/^<img/i, `<img ${name}="${value}"`);
      }
    };

    if (media.width && media.height) {
      addAttr("width", String(media.width));
      addAttr("height", String(media.height));
    }
    addAttr("loading", "lazy");
    addAttr("decoding", "async");

    const widths = mediaVariantWidths(media.id);
    if (widths.length > 0 && media.width) {
      addAttr("srcset", widths.map((w) => `${src}?w=${w} ${w}w`).join(", "));
      addAttr("sizes", "(min-width: 700px) 640px, 100vw");
    }
    return out;
  });
}

// ── seeding ────────────────────────────────────────────────────────────────
// Idempotent seeding of built-in pages and their images into the CMS database
// at server start. The seed data lives in /seed/pages/*.html (with simple YAML
// frontmatter) and /seed/images/*. The files are bundled at build time via
// import.meta.glob — no filesystem access at runtime, which keeps the
// sandboxed NixOS deployment working without extra paths in the chroot.
//
// Reseed policy:
//   - page doesn't exist            → create it (provisioned=1, edited=0)
//   - page exists, provisioned,
//     not edited                    → overwrite title/html from seed
//   - page exists, provisioned,
//     edited                        → skip (preserve admin edits)
//   - page exists, not provisioned  → skip (user-created page)
//
// Images are seeded once and never re-processed — their media row ID is
// stable across restarts, so the URLs baked into page HTML stay valid.
// The seed is a top-level await so the server won't accept requests until
// seeding completes; on subsequent starts it's effectively a no-op.

// Vite inlines the page HTML as raw strings and the images as base64 data URIs
// at build time. No filesystem access at runtime. Paths are relative to this
// module (/src/lib/db.ts); the seed data lives outside src/ at /seed/.
const pageFiles = import.meta.glob("../../seed/pages/*.html", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const imageFiles = import.meta.glob("../../seed/images/*", {
  eager: true,
  query: "?inline",
  import: "default",
}) as Record<string, string>;

// Seed config (nav links). Bundled at build time via import.meta.glob so it
// stays available in the sandboxed deployment with no runtime filesystem access.
const configFiles = import.meta.glob("../../seed/config.json", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const seedConfig = JSON.parse(configFiles["../../seed/config.json"]) as {
  nav: { label: string; url: string; placement: NavPlacement; pageSlug?: string }[];
};

const basename = (p: string) => p.split("/").pop()!;

// Parse minimal YAML frontmatter (---\nkey: value\n---) from the top of a
// seed HTML file. Only `title` is recognised.
function parseFrontmatter(raw: string): {
  title: string;
  body: string;
} {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { title: basename(raw), body: raw };
  const yaml = m[1];
  const body = m[2];
  const title = yaml.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? "Untitled";
  return { title, body };
}

// Decode a data URI (data:<mime>;base64,<data>) into raw bytes + mime type.
function decodeDataUri(uri: string): { data: Uint8Array; mime: string } {
  const m = uri.match(/^data:([^;]+);base64,(.*)$/s);
  if (!m) throw new Error("expected base64 data URI, got: " + uri.slice(0, 40));
  return {
    mime: m[1],
    data: new Uint8Array(Buffer.from(m[2], "base64")),
  };
}

async function seedDatabase(): Promise<void> {
  const stGetSeedMedia = db.prepare(
    "SELECT id FROM media WHERE filename = ? AND provisioned = 1",
  );
  const stInsertSeedMedia = db.prepare(
    "INSERT INTO media (filename, mime, size, data, width, height, provisioned) VALUES (?, ?, ?, ?, ?, ?, 1)",
  );
  const stGetPage = db.prepare(
    "SELECT id, provisioned, edited FROM pages WHERE slug = ?",
  );
  const stInsertSeedPage = db.prepare(
    "INSERT INTO pages (slug, title, html, published, provisioned, edited) VALUES (?, ?, ?, 1, 1, 0)",
  );
  const stUpdateSeedPage = db.prepare(
    "UPDATE pages SET title = ?, html = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?",
  );
  const stGetPageIdBySlug = db.prepare("SELECT id FROM pages WHERE slug = ?");

  // 1. Seed images — each image is inserted once and reused by ID on reseed.
  const imageIds: Record<string, number> = {};
  for (const [path, dataUri] of Object.entries(imageFiles)) {
    const filename = basename(path);
    const existing = stGetSeedMedia.get(filename) as { id: number } | undefined;
    if (existing) {
      imageIds[filename] = existing.id;
      continue;
    }
    const { data, mime } = decodeDataUri(dataUri);
    const processed = await processImage(data, mime);
    const id = Number(
      stInsertSeedMedia.run(
        filename,
        mime,
        data.byteLength,
        data,
        processed.width,
        processed.height,
      ).lastInsertRowid,
    );
    for (const v of processed.variants) {
      insertMediaVariant(id, v.width, v.data);
    }
    imageIds[filename] = id;
  }

  // 2. Seed pages — substitute {{img:filename}} placeholders with real media URLs.
  const pageIds: Record<string, number> = {};
  for (const [path, raw] of Object.entries(pageFiles)) {
    const slug = basename(path).replace(/\.html$/, "");
    const { title, body } = parseFrontmatter(raw);
    const html = body.replace(/\{\{img:([^}]+)\}\}/g, (_, fname: string) => {
      const id = imageIds[fname.trim()];
      if (!id) return `{{img:${fname.trim()}}}`;
      return `/media/${id}/${fname.trim()}`;
    });

    const existing = stGetPage.get(slug) as
      | { id: number; provisioned: number; edited: number }
      | undefined;
    if (!existing) {
      stInsertSeedPage.run(slug, title, html);
    } else if (existing.provisioned && !existing.edited) {
      stUpdateSeedPage.run(title, html, existing.id);
    }
    // else: user-created or admin-edited → leave untouched
    pageIds[slug] = (stGetPageIdBySlug.get(slug) as { id: number }).id;
  }

  // 3. Seed nav links — run ONCE, when no provisioned nav links exist yet.
  //    Top and bottom nav share the same nav_links table (distinguished by
  //    `placement`). Page-linked entries (pageSlug) get their page_id set so
  //    the page editor checkboxes and slug-rename URL updates work.
  const stNavCount = db.prepare(
    "SELECT COUNT(*) AS c FROM nav_links WHERE provisioned = 1",
  );
  const navCount = (stNavCount.get() as { c: number }).c;
  if (navCount === 0) {
    const stInsertSeedNav = db.prepare(
      "INSERT INTO nav_links (label, url, placement, position, page_id, provisioned, edited) VALUES (?, ?, ?, ?, ?, 1, 0)",
    );
    // position is per-placement, so track a counter for each
    const pos: Record<NavPlacement, number> = { top: 0, bottom: 0 };
    for (const link of seedConfig.nav) {
      pos[link.placement]++;
      const pageId = link.pageSlug ? pageIds[link.pageSlug] ?? null : null;
      stInsertSeedNav.run(
        link.label,
        link.url,
        link.placement,
        pos[link.placement],
        pageId,
      );
    }
  }
}

await seedDatabase();
