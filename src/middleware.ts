// Single-admin auth via HTTP Basic Auth. The password is read from the
// environment once at server start; the browser handles the credential prompt,
// so there is no login page, no cookie and no session state at all. Mutations
// are still CSRF-safe because Astro's default checkOrigin rejects cross-origin
// form POSTs in server output.
import { defineMiddleware } from "astro:middleware";
import { createHash, timingSafeEqual } from "node:crypto";
import { getPageBySlug, RESERVED_SLUGS } from "./lib/db";

const password = process.env.N50_CAMP_ADMIN_PASSWORD ?? "";
// no password configured → the whole admin area fails closed (middleware 404s)
const adminEnabled = password.length > 0;

// hash both sides to equal length, then compare in constant time
const sha = (s: string) => createHash("sha256").update(s).digest();
const safeEq = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

// any username is accepted — there is only one admin password
const isAuthed = (request: Request) => {
  if (!adminEnabled) return false;
  const header = request.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("basic ")) return false;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString();
  const colon = decoded.indexOf(":");
  if (colon === -1) return false;
  return safeEq(decoded.slice(colon + 1), password);
};

// Dynamic CMS pages ([slug].astro) are draft-gated here so the page handler
// can stay a pure renderer. Middleware runs before routing, so we replicate
// the [slug] route's reach: single-segment paths not claimed by a static
// route. Astro's static routes (/, /admin/*, /media/*, /404) always outrank
// [slug], and RESERVED_SLUGS covers the ones that don't start with /admin or
// /media. "/" is skipped entirely — index.astro owns it and ignores the
// published flag (the home page always renders).
const DYNAMIC_PATH = /^\/[^/]+$/;

export const onRequest = defineMiddleware((ctx, next) => {
  const path = ctx.url.pathname;

  if (path === "/admin" || path.startsWith("/admin/")) {
    // no admin password configured → pretend the admin area doesn't exist
    if (!adminEnabled) return new Response(null, { status: 404 });
    if (!isAuthed(ctx.request)) {
      return new Response("Authentication required", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="N50CAMP Admin", charset="UTF-8"' },
      });
    }
    return next();
  }

  // Draft gate for dynamic CMS pages. Static routes outrank [slug], so a
  // reserved slug here means a static handler will (or won't) render it —
  // leave it alone. "/" is reserved for index.astro and skipped.
  if (path === "/" || !DYNAMIC_PATH.test(path)) return next();
  const slug = path.slice(1);
  if (RESERVED_SLUGS.has(slug)) return next();

  const page = getPageBySlug(slug);
  if (!page) return next(); // [slug].astro returns the 404
  // Unpublished drafts are only visible to the authenticated admin — to
  // everyone else the page simply doesn't exist yet.
  if (!page.published && !isAuthed(ctx.request)) {
    return new Response(null, { status: 404 });
  }
  // Hand the fetched page to [slug].astro so it doesn't re-query.
  ctx.locals.page = page;
  return next();
});
