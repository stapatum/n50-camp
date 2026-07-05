import type { APIRoute } from "astro";
import { getMedia, getMediaMeta, getMediaVariant } from "../../../lib/db";

// node:sqlite blobs are Uint8Arrays over plain ArrayBuffers; the lib types
// are just too loose (ArrayBufferLike) for Response's BodyInit
const blobResponse = (data: Uint8Array, size: number, mime: string) =>
  new Response(data as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(size),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });

// Public media endpoint: /media/<id>/<filename>. The id addresses the blob,
// the filename keeps pasted HTML readable and names downloads. `?w=<width>`
// serves the pre-generated webp variant of that width. A media id's bytes
// never change (re-upload = new id), so responses are immutable.
export const GET: APIRoute = ({ params, url }) => {
  const id = Number(params.id);
  const requestedWidth = url.searchParams.get("w");

  if (requestedWidth !== null) {
    const meta = getMediaMeta(id);
    if (!meta || meta.filename !== params.filename) {
      return new Response(null, { status: 404 });
    }
    const variant = getMediaVariant(id, Number(requestedWidth));
    if (!variant) return new Response(null, { status: 404 });
    return blobResponse(variant.data, variant.size, "image/webp");
  }

  const item = getMedia(id);
  if (!item || item.filename !== params.filename) {
    return new Response(null, { status: 404 });
  }
  return blobResponse(item.data, item.size, item.mime);
};
