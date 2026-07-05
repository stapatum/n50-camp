# n50.camp

n50.camp website. The site ships zero client JavaScript\* — the hero, the camera fly-in and the reveals are all pure CSS.

\*on chromium-based browsers; Firefox needs a polyfill

## Run

```sh
# With npm installed
npm run dev
# Without npm installed
nix shell nixpkgs#nodejs --command sh -c "npm install && npm run dev"
```

See flake.nix for an example on how to package and run this.

## Deploy

Add `nixosModules.default` exported by the flake to your nixos configuration and enable the service:

```nix
services.n50-camp = {
  enable = true;
  host = "[::1]";
  port = 4324;
  # optional: enables the CMS admin area. Point at a secret file
  # (agenix/sops-nix), never at a path in the nix store.
  adminPasswordFile = "/run/secrets/n50-camp-admin-password";
}
```

CMS content lives in `/var/lib/n50-camp/cms.db` (systemd `StateDirectory`) —
that one file is the complete backup surface, images included.

Uploaded images are optimized server-side (via `sharp`) at upload time:
intrinsic dimensions are recorded and downscaled WebP variants are stored
alongside the original in the database. Any `<img src="/media/…">` in page
HTML is rewritten at render time with `width`/`height`, a `srcset` of those
variants (served from `/media/<id>/<name>?w=<width>`), and lazy loading — the
equivalent of Astro's `<Image>`, but working on raw HTML strings and without
the request-time fetches the sandbox forbids. SVGs and GIFs are served
untouched.
