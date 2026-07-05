import type { APIRoute } from "astro";
import { getPage, getMedia, listMedia, listNavLinks, listPages } from "../../lib/db";
import { buildZip } from "../../lib/zip";

// Export the current CMS state as a ZIP that mirrors the /seed layout:
//   config.json   — nav links (top + bottom, page-linked entries as pageSlug)
//   pages/*.html  — each page with `---\ntitle: …\n---\n` frontmatter + body
//   images/*      — media blobs under their original filename
// Dropping the unzipped contents into /seed reproduces the DB exactly, so this
// doubles as a backup: re-seed into a fresh database and you're back.
export const GET: APIRoute = async () => {
  const encoder = new TextEncoder();
  const entries: { name: string; data: Uint8Array }[] = [];

  // 1. config.json — nav links in the same shape seed/config.json uses
  const nav = [...listNavLinks("top"), ...listNavLinks("bottom")].map((l) => {
    const entry: { label: string; url: string; placement: string; pageSlug?: string } = {
      label: l.label,
      url: l.url,
      placement: l.placement,
    };
    if (l.page_id) {
      const page = getPage(l.page_id);
      if (page) entry.pageSlug = page.slug;
    }
    return entry;
  });
  entries.push({
    name: "config.json",
    data: encoder.encode(JSON.stringify({ nav }, null, 2) + "\n"),
  });

  // 2. pages — frontmatter + body, named by slug
  for (const p of listPages()) {
    const full = getPage(p.id);
    if (!full) continue;
    const content = `---\ntitle: ${full.title}\n---\n${full.html}`;
    entries.push({ name: `pages/${full.slug}.html`, data: encoder.encode(content) });
  }

  // 3. images — raw blobs under their original filename
  for (const m of listMedia()) {
    const full = getMedia(m.id);
    if (!full) continue;
    entries.push({ name: `images/${full.filename}`, data: full.data });
  }

  const zip = buildZip(entries);
  return new Response(zip as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="n50-camp-seed.zip"',
    },
  });
};
