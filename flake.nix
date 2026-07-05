{
  description = "n50-camp — the event site (tent viewer), server-rendered by Astro on Node and run as a hardened systemd service";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      # Overlay that adds both packages to pkgs.
      overlays.default = final: prev: {
        # The server-rendered website. `astro build` with the @astrojs/node
        # adapter (standalone mode) emits a self-contained Node server in
        # dist/server/entry.mjs plus static assets in dist/client/. Pages are
        # rendered per-request, so they can use request-time data (e.g. the
        # current date for time-based features) — the site still ships zero
        # client JavaScript. We keep dist/ and a production-only node_modules/
        # (the bundle imports a few deps — astro's runtime helpers, unstorage,
        # etc. — as externals at runtime).
        n50-camp = final.buildNpmPackage {
          pname = "n50-camp";
          version = "0.3.0";

          # Flakes copy the git tree, so node_modules/, dist/ and .astro/ (all
          # gitignored) are excluded automatically.
          src = ./.;

          npmDepsHash = "sha256-NC9HObvVcE7UGrBGCSSTfdK47t70LXWYJ7sLx3GEiP4=";

          # Fully offline, deterministic build.
          env.ASTRO_TELEMETRY_DISABLED = "1";

          # This is a server app, not an npm library: skip the default
          # `npm pack` install. After `npm run build`, drop the devDependencies
          # and ship the rendered output together with the runtime node_modules.
          dontNpmInstall = true;
          installPhase = ''
            runHook preInstall

            npm prune --omit=dev

            mkdir -p "$out/lib/n50-camp"
            cp -r dist node_modules package.json "$out/lib/n50-camp/"

            runHook postInstall
          '';

          meta = {
            description = "Server-rendered n50-camp event website (Astro + Node)";
            platforms = lib.platforms.all;
          };
        };

        # A thin launcher for the standalone Astro/Node server. The built app is
        # baked in, so it always serves exactly the n50-camp site. The Astro
        # Node adapter reads HOST/PORT from the environment; we expose them under
        # the N50_CAMP_* names with sensible defaults. Real filesystem isolation
        # is added by the NixOS module's systemd sandbox.
        n50-camp-server = final.writeShellApplication {
          name = "n50-camp-server";
          runtimeInputs = [ final.nodejs ];
          text = ''
            export HOST="''${N50_CAMP_HOST:-::}"
            export PORT="''${N50_CAMP_PORT:-8080}"
            export NODE_ENV=production
            # CMS admin password, provisioned as a systemd credential so it
            # never lands in the nix store or the unit environment. Without it
            # the CMS admin area fails closed (404) and the site runs normally.
            if [ -n "''${CREDENTIALS_DIRECTORY:-}" ] && [ -r "''${CREDENTIALS_DIRECTORY}/admin-password" ]; then
              N50_CAMP_ADMIN_PASSWORD="$(< "''${CREDENTIALS_DIRECTORY}/admin-password")"
              export N50_CAMP_ADMIN_PASSWORD
            fi
            exec node "${final.n50-camp}/lib/n50-camp/dist/server/entry.mjs" "$@"
          '';
        };
      };

      packages = forAllSystems (
        pkgs:
        let
          ext = pkgs.extend self.overlays.default;
        in
        {
          inherit (ext) n50-camp n50-camp-server;
          default = ext.n50-camp-server;
        }
      );

      # NixOS module: applies the overlay and runs the server as a hardened,
      # sandboxed systemd service.
      nixosModules.default =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        let
          cfg = config.services.n50-camp;
          isLoopback = builtins.elem cfg.host [
            "127.0.0.1"
            "::1"
            "localhost"
          ];
        in
        {
          options.services.n50-camp = {
            enable = lib.mkEnableOption "the n50-camp event website server";

            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.stdenv.hostPlatform.system}.n50-camp-server;
              defaultText = lib.literalExpression "n50-camp.packages.<system>.n50-camp-server";
              description = "The server package to run.";
            };

            host = lib.mkOption {
              type = lib.types.str;
              default = "::";
              example = "127.0.0.1";
              description = "Address to bind to. Defaults to all interfaces (IPv4 + IPv6).";
            };

            port = lib.mkOption {
              type = lib.types.port;
              default = 8080;
              description = "TCP port to listen on.";
            };

            openFirewall = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = "Open {option}`port` in the firewall.";
            };

            adminPasswordFile = lib.mkOption {
              type = lib.types.nullOr lib.types.path;
              default = null;
              example = "/run/secrets/n50-camp-admin-password";
              description = ''
                File containing the CMS admin password (e.g. an agenix/sops
                secret). Must not point into the world-readable nix store.
                When null, the CMS admin area is disabled (fails closed with
                404) and the site otherwise runs normally.
              '';
            };
          };

          config = lib.mkIf cfg.enable {
            assertions = [
              {
                assertion = cfg.port >= 1024;
                message = ''
                  services.n50-camp: ports below 1024 are not supported — the
                  sandbox drops all capabilities and runs in a private user
                  namespace, so CAP_NET_BIND_SERVICE cannot take effect. Bind
                  to an unprivileged port and put a reverse proxy in front.
                '';
              }
            ];

            networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];

            systemd.services.n50-camp = {
              description = "n50-camp event website (Astro/Node SSR)";
              wantedBy = [ "multi-user.target" ];
              after = [ "network.target" ];

              # The service is chrooted into an empty tmpfs holding only the
              # bind-mounted (read-only) nix store closure of the server, with
              # private /dev, /proc, /sys and a private user namespace. It
              # cannot even *read* the rest of the system — the host's /etc,
              # /var, other store paths etc. simply don't exist in its mount
              # namespace. Verified by the flake's `checks.<system>.vm` test.
              confinement.enable = true;
              # the launcher's shebang points into the store; nothing needs /bin/sh
              confinement.binSh = null;

              environment = {
                N50_CAMP_HOST = cfg.host;
                N50_CAMP_PORT = toString cfg.port;
                # CMS content (pages + uploaded media) lives in one SQLite
                # file (plus transient WAL sidecars in the same directory)
                # under the service's state directory.
                N50_CAMP_DB = "/var/lib/n50-camp/cms.db";
                TMPDIR = "/tmp";
              };

              serviceConfig = {
                ExecStart = lib.getExe cfg.package;
                Restart = "on-failure";

                # Run as a transient, unprivileged user.
                DynamicUser = true;

                # The CMS admin password enters the process via a systemd
                # credential (not the nix store, not Environment= which leaks
                # through `systemctl show`).
                LoadCredential = lib.optional (
                  cfg.adminPasswordFile != null
                ) "admin-password:${cfg.adminPasswordFile}";

                # Filesystem: on top of the confinement chroot, everything is
                # mounted read-only; the only writable places are the private
                # /tmp and /var/lib/n50-camp for the CMS database and its WAL
                # sidecars (created and owned via StateDirectory, kept private
                # by the UMask). Both writable mounts are noexec — nothing an
                # attacker writes can be executed from disk.
                StateDirectory = "n50-camp";
                ProtectSystem = "strict";
                ProtectHome = true;
                PrivateTmp = true;
                PrivateDevices = true;
                ProtectProc = "invisible";
                ProcSubset = "pid";
                NoExecPaths = [ "/" ];
                ExecPaths = [ "/nix/store" ];
                UMask = "0077";

                # Privilege / namespace lockdown.
                NoNewPrivileges = true;
                RestrictNamespaces = true;
                LockPersonality = true;
                # NB: no MemoryDenyWriteExecute — V8's JIT needs writable+
                # executable mappings, so it is incompatible with Node.
                RestrictRealtime = true;
                RestrictSUIDSGID = true;
                ProtectControlGroups = true;
                ProtectKernelTunables = true;
                ProtectKernelModules = true;
                ProtectKernelLogs = true;
                ProtectClock = true;
                ProtectHostname = true;
                RemoveIPC = true;

                # Networking: HTTP over IP only, and the only bindable socket
                # is the configured port. When bound to loopback (the reverse
                # proxy setup), peers are additionally pinned to localhost —
                # a compromised process can then neither reach out to nor be
                # reached from anywhere else over IP (no exfiltration, no
                # lateral movement).
                RestrictAddressFamilies = [
                  "AF_INET"
                  "AF_INET6"
                ];
                SocketBindDeny = [ "any" ];
                SocketBindAllow = [ "tcp:${toString cfg.port}" ];
                IPAddressDeny = lib.mkIf isLoopback [ "any" ];
                IPAddressAllow = lib.mkIf isLoopback [ "localhost" ];

                # Drop all capabilities. Privileged ports are rejected by the
                # assertion above, so none are ever needed.
                CapabilityBoundingSet = [ ];

                # Resource containment: a runaway or abused process must not
                # starve the rest of the host.
                MemoryHigh = "512M";
                MemoryMax = "1G";
                TasksMax = 64;

                # Syscall allow-list. Kept broad enough for the V8/libuv runtime
                # (no ~@resources filter, which trips up the GC/threadpool).
                # ~@privileged also denies @mount, so the InaccessiblePaths /
                # bind-mount setup of the chroot cannot be undone from inside.
                SystemCallArchitectures = "native";
                SystemCallFilter = [
                  "@system-service"
                  "~@privileged"
                ];
              };
            };
          };
        };

      # VM test: boots a NixOS machine with the module enabled and verifies
      # both that the site + CMS work end-to-end under the sandbox and that
      # the sandbox actually contains the process (host filesystem invisible,
      # everything read-only except the state directory, writable mounts
      # noexec, password not leaked). Run via `nix flake check` or
      # `nix build .#checks.x86_64-linux.vm`.
      checks = forAllSystems (
        pkgs:
        lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          vm = pkgs.testers.runNixOSTest {
            name = "n50-camp";

            nodes.machine = {
              imports = [ self.nixosModules.default ];
              services.n50-camp = {
                enable = true;
                host = "127.0.0.1";
                port = 8080;
                adminPasswordFile = "/etc/n50-camp-test-password";
              };
              # world-readable, but it's a throwaway VM test password
              environment.etc."n50-camp-test-password".text = "vmtestpw";
              environment.systemPackages = [ pkgs.curl pkgs.unzip ];
            };

            testScript = ''
              base = "http://127.0.0.1:8080"
              auth = "-u admin:vmtestpw -H 'Origin: http://127.0.0.1:8080'"

              machine.wait_for_unit("n50-camp.service")
              machine.wait_for_open_port(8080)

              with subtest("site is served"):
                  # grep without -q so it reads to EOF: -q closes the pipe on
                  # first match, and under the driver's pipefail curl then dies
                  # with SIGPIPE (exit 23) even though the content was served
                  machine.succeed("curl -sf " + base + "/ | grep N50CAMP > /dev/null")

              with subtest("home page content is CMS-managed"):
                  # the home page's <main> body is seeded from the DB; editing it
                  # through the admin changes what / serves
                  home_id = machine.succeed(
                      "curl -sf " + auth + " " + base + "/admin"
                      + " | grep -oE '/admin/edit/[0-9]+\">/index' | grep -oE '[0-9]+'"
                  ).strip()
                  machine.succeed(
                      "curl -sf -X POST " + auth
                      + " --data-urlencode action=save --data-urlencode title=Home"
                      + " --data-urlencode slug=index"
                      + " --data-urlencode 'html=<p>edited home</p>'"
                      + " --data-urlencode published=on " + base + "/admin/edit/" + home_id
                  )
                  machine.succeed("curl -sf " + base + "/ | grep 'edited home' > /dev/null")
                  # the home page must never appear in the footer nav
                  machine.fail("curl -sf " + base + "/ | grep -oE '<a href=\"/\">'")

              with subtest("admin requires basic auth"):
                  status = machine.succeed(
                      "curl -s -o /dev/null -w '%{http_code}' " + base + "/admin"
                  ).strip()
                  assert status == "401", "expected 401, got " + status
                  machine.fail("curl -sf -u admin:wrong " + base + "/admin -o /dev/null")
                  machine.succeed("curl -sf -u admin:vmtestpw " + base + "/admin -o /dev/null")

              with subtest("seeded built-in pages are served"):
                  machine.succeed("curl -sf " + base + "/codeofconduct | grep 'Code Of Conduct' > /dev/null")
                  machine.succeed("curl -sf " + base + "/packliste | grep 'Packliste' > /dev/null")
                  # a seeded page with images: the <img src="/media/..."> must resolve
                  img_url = machine.succeed(
                      "curl -sf " + base + "/anreise"
                      + " | grep -oE '/media/[0-9]+/anreise\\.jpeg' | head -1"
                  ).strip()
                  assert img_url, "anreise page did not contain a seeded image"
                  machine.succeed("curl -sf " + base + img_url + " -o /dev/null")

              with subtest("image upload + sharp variants work in the sandbox"):
                  # 600x10 px png; wide enough to trigger the 480px webp variant
                  machine.succeed(
                      "echo iVBORw0KGgoAAAANSUhEUgAAAlgAAAAKCAIAAADn3bdeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAhUlEQVR4nO3bUQkAIAxF0WW4Wcxi/yiWEPzwwALI4cFQt2ltRYAAAQIE+rUdzPMTKAIECBAgkEYoBAQIECBAIDdCISBAgAABAnkaFQICBAgQIJA/QiEgQIAAAQIZlhECAgQIECCQqVEhIECAAAECWZ8QAgIECBAgkD1CISBAgAABAt1rhwfxAEkTiSVcYAAAAABJRU5ErkJggg== | base64 -d > /tmp/upload.png"
                  )
                  machine.succeed(
                      "curl -sf -X POST " + auth
                      + " -F 'file=@/tmp/upload.png;type=image/png' " + base + "/admin/media"
                  )
                  # seed images take the first media IDs, so look up the uploaded
                  # one by filename from the admin media listing
                  media_url = machine.succeed(
                      "curl -sf " + auth + " " + base + "/admin/media"
                      + " | grep -oE '/media/[0-9]+/upload\\.png' | head -1"
                  ).strip()
                  assert media_url, "uploaded image not found in media listing"
                  machine.succeed("curl -sf " + base + media_url + " -o /dev/null")
                  machine.succeed(
                      "curl -sfD - '" + base + media_url + "?w=480' -o /dev/null"
                      + " | grep -i 'content-type: image/webp' > /dev/null"
                  )

              with subtest("CMS lifecycle works under the sandbox"):
                  # seed pages take the first page IDs, so extract the new page's
                  # ID from the 303 redirect instead of hardcoding /admin/edit/1
                  edit_url = machine.succeed(
                      "curl -s -X POST " + auth
                      + " --data 'title=VM&slug=vmtest' " + base + "/admin"
                      + " -o /dev/null -w '%{redirect_url}'"
                  ).strip()
                  page_id = edit_url.rsplit("/edit/", 1)[-1]
                  assert page_id, "create redirect did not contain an edit URL: " + edit_url
                  machine.succeed(
                      "curl -sf -X POST " + auth
                      + " --data-urlencode action=save --data-urlencode title=VM"
                      + " --data-urlencode slug=vmtest"
                      + " --data-urlencode 'html=<p>sandboxed</p>'"
                      + " --data-urlencode published=1 " + base + "/admin/edit/" + page_id
                  )
                  machine.succeed("curl -sf " + base + "/vmtest | grep sandboxed > /dev/null")
                  machine.succeed("test -f /var/lib/n50-camp/cms.db")

              with subtest("admin-editable nav links (top + bottom) work"):
                  # seeded top links appear in the header
                  machine.succeed("curl -sf " + base + "/ | grep 'CfP' > /dev/null")
                  machine.succeed("curl -sf " + base + "/ | grep 'Tickets' > /dev/null")
                  # seeded bottom links appear in the footer
                  machine.succeed("curl -sf " + base + "/ | grep 'Datenschutzerklärung' > /dev/null")
                  machine.succeed("curl -sf " + base + "/ | grep 'Code Of Conduct' > /dev/null")
                  # add a top link through the admin nav UI
                  machine.succeed(
                      "curl -sf -X POST " + auth
                      + " --data-urlencode action=create"
                      + " --data-urlencode label=Testlink"
                      + " --data-urlencode url=/vmtest"
                      + " --data-urlencode placement=top " + base + "/admin/nav"
                  )
                  machine.succeed("curl -sf " + base + "/ | grep 'Testlink' > /dev/null")
                  # reorder: move the new link up — it should now precede Tickets
                  nav_id = machine.succeed(
                      "curl -sf " + auth + " " + base + "/admin/nav"
                      + " | grep -B2 'Testlink'"
                      + " | grep -oE 'value=\"[0-9]+\"' | grep -oE '[0-9]+' | head -1"
                  ).strip()
                  assert nav_id, "could not find Testlink id in admin nav page"
                  machine.succeed(
                      "curl -sf -X POST " + auth
                      + " --data-urlencode action=up"
                      + " --data-urlencode id=" + nav_id + " " + base + "/admin/nav"
                  )
                  html = machine.succeed("curl -sf " + base + "/")
                  assert html.index("Testlink") < html.index("Netzwerk"), "nav reorder had no effect"
                  # delete the test link
                  machine.succeed(
                      "curl -sf -X POST " + auth
                      + " --data-urlencode action=delete"
                      + " --data-urlencode id=" + nav_id + " " + base + "/admin/nav"
                  )
                  machine.fail("curl -sf " + base + "/ | grep Testlink")
                  # page editor checkbox: add vmtest to the bottom nav
                  machine.succeed(
                      "curl -sf -X POST " + auth
                      + " --data-urlencode action=save"
                      + " --data-urlencode title=VM"
                      + " --data-urlencode slug=vmtest"
                      + " --data-urlencode 'html=<p>sandboxed</p>'"
                      + " --data-urlencode published=1"
                      + " --data-urlencode show_in_bottom_nav=on " + base + "/admin/edit/" + page_id
                  )
                  machine.succeed("curl -sf " + base + "/ | grep '>VM<' > /dev/null")
                  # uncheck: remove from bottom nav
                  machine.succeed(
                      "curl -sf -X POST " + auth
                      + " --data-urlencode action=save"
                      + " --data-urlencode title=VM"
                      + " --data-urlencode slug=vmtest"
                      + " --data-urlencode 'html=<p>sandboxed</p>'"
                      + " --data-urlencode published=1 " + base + "/admin/edit/" + page_id
                  )
                  # VM should no longer appear as a footer link on the home page
                  # (the home page content is "edited home", so ">VM<" only
                  # appears if the footer nav link is still present)
                  machine.fail("curl -sf " + base + "/ | grep '>VM<'")

              with subtest("admin export produces a valid zip of the DB state"):
                  # download the export and check it's a real zip with the
                  # expected seed-shaped contents
                  machine.succeed(
                      "curl -sf " + auth + " " + base + "/admin/export -o /tmp/export.zip"
                  )
                  machine.succeed("test -s /tmp/export.zip")
                  # zip magic bytes (PK\x03\x04)
                  machine.succeed("head -c 4 /tmp/export.zip | grep -q 'PK'")
                  out = machine.succeed(
                      "unzip -l /tmp/export.zip"
                  )
                  assert "config.json" in out, "export missing config.json"
                  assert "pages/index.html" in out, "export missing a page"
                  assert "images/anreise.jpeg" in out, "export missing an image"
                  # config.json round-trips with the nav shape the seed uses
                  cfg = machine.succeed("unzip -p /tmp/export.zip config.json")
                  assert '"placement": "top"' in cfg, "config.json missing top nav"
                  assert '"pageSlug": "lageplan"' in cfg, "config.json missing pageSlug"

              # Probe the mount namespace of the running service. Only the app
              # closure exists inside the chroot, so the probes run through its
              # bash and use nothing but shell builtins.
              pid = machine.succeed(
                  "systemctl show -p MainPID --value n50-camp.service"
              ).strip()
              ns = "nsenter -t " + pid + " -m ${pkgs.runtimeShell} -c "

              with subtest("host filesystem is invisible inside the sandbox"):
                  # /root and /home exist as empty inaccessible stubs
                  # (ProtectHome), so probe for actual host content instead
                  machine.succeed("echo topsecret > /root/host-secret")
                  machine.fail(ns + "'test -e /etc/passwd'")
                  machine.fail(ns + "'test -e /root/host-secret'")
                  machine.fail(ns + "': < /root/host-secret'")
                  machine.fail(ns + "'shopt -s nullglob dotglob; set -- /home/* /root/*; [ $# -gt 0 ]'")
                  visible = int(machine.succeed(ns + "'set -- /nix/store/*; echo $#'").strip())
                  host_paths = int(machine.succeed("ls /nix/store | wc -l").strip())
                  assert visible < host_paths / 2, (
                      "sandbox sees " + str(visible) + " of " + str(host_paths) + " store paths"
                  )

              with subtest("read-only everywhere except state dir and /tmp"):
                  machine.fail(ns + "'echo pwned > /pwned'")
                  machine.fail(ns + "'echo pwned > /nix/store/pwned'")
                  machine.succeed(ns + "'echo ok > /tmp/scratch'")
                  machine.succeed(ns + "'echo ok > /var/lib/n50-camp/writetest'")

              with subtest("writable mounts are noexec"):
                  mountinfo = machine.succeed("cat /proc/" + pid + "/mountinfo")
                  state = [l for l in mountinfo.splitlines() if " /var/lib/n50-camp " in l]
                  assert state and "noexec" in state[0], "state dir not noexec: " + repr(state)

              with subtest("password does not leak into the unit environment"):
                  machine.fail("systemctl show n50-camp.service -p Environment | grep -i pass")

              with subtest("sandbox options are active"):
                  out = machine.succeed(
                      "systemctl show n50-camp.service"
                      + " -p PrivateUsers -p NoNewPrivileges -p RootDirectory"
                  )
                  assert "PrivateUsers=yes" in out, out
                  assert "NoNewPrivileges=yes" in out, out
                  assert "RootDirectory=/run/confinement/n50-camp.service" in out, out

              with subtest("data survives a service restart"):
                  machine.systemctl("restart n50-camp.service")
                  machine.wait_for_open_port(8080)
                  machine.succeed("curl -sf " + base + "/vmtest | grep sandboxed > /dev/null")
                  # seed pages survive and aren't duplicated by reseed
                  machine.succeed("curl -sf " + base + "/codeofconduct | grep 'Code Of Conduct' > /dev/null")
                  # top + bottom nav links persist across restart (one-time seed doesn't duplicate)
                  machine.succeed("curl -sf " + base + "/ | grep 'CfP' > /dev/null")
                  machine.succeed("curl -sf " + base + "/ | grep 'Datenschutzerklärung' > /dev/null")
            '';
          };
        }
      );

      formatter = forAllSystems (pkgs: pkgs.nixfmt-rfc-style);

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs
          ];
        };
      });
    };
}
