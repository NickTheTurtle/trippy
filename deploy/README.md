# Deploying Trippy to AWS EC2

Trippy is a long-lived Node API plus a static web client, and it stores
everything in a SQLite file on disk. That rules out serverless hosts (Lambda,
App Runner, Amplify): their filesystem is ephemeral, so the database would
vanish on every restart. A small always-on VM with a persistent disk is the
right fit. EC2's free tier covers this at roughly $0 for 12 months.

The shape we run:

```
Internet
  |
  |-- 80/443 --> EC2 security group --> Caddy (auto HTTPS via Let's Encrypt)
  |                 |-- /api/*  --> reverse_proxy 127.0.0.1:5175  (Hono API, Node)
  |                 |-- /*      --> static files from apps/web/dist (the built React app)
  |
  |-- 22 --------> SSH, restricted to your IP
```

Serving the built web client and the API from one hostname keeps everything
same-origin. That means no CORS and no third-party-cookie problems, and the
session cookie stays first-party. The web client already calls the API at the
relative path `/api`, so nothing about the client needs reconfiguring for this.

`ec2-setup.sh` does the whole first-time setup. `update.sh` redeploys. Both are
idempotent and never contain a secret.

---

## 1. Launch the instance

AWS Console -> EC2 -> Launch instance:

| Setting | Value |
| --- | --- |
| Name | `trippy` |
| AMI | Ubuntu Server 24.04 LTS |
| Instance type | `t4g.micro` (Arm, free-tier eligible), or `t3.micro` (x86) |
| Key pair | Create or select one so you can SSH in |
| Storage | 20 GiB gp3 (within the 30 GiB free-tier allowance) |

Both architectures work; the setup script detects what it is on. Arm
(`t4g.micro`) is cheaper after the free year.

Security group, inbound rules:

| Type | Port | Source |
| --- | --- | --- |
| SSH | 22 | My IP |
| HTTP | 80 | `0.0.0.0/0` and `::/0` |
| HTTPS | 443 | `0.0.0.0/0` and `::/0` |

Port 80 must be open: Caddy uses it for the Let's Encrypt challenge and to
redirect to HTTPS.

## 2. DNS for trippy.dxu.info

Before you run the setup script with a domain, point the name at the instance:

1. Copy the instance's public IPv4 address from the EC2 console.
2. In the DNS host for `dxu.info`, add an `A` record:
   - Name: `trippy`
   - Type: `A`
   - Value: the public IP
   - TTL: 300
3. Wait until `dig +short trippy.dxu.info` returns that IP. Let's Encrypt will
   not issue a certificate until it resolves.

No domain, or DNS not ready yet? Skip this and the script falls back to a free
`<public-ip>.sslip.io` hostname that still gets a real certificate. You can
re-run the script with `DOMAIN=trippy.dxu.info` once DNS is live.

## 3. Connect

```bash
ssh -i /path/to/key.pem ubuntu@<public-ip>
```

## 4. Get the code onto the box

The repo is private, so create a fine-grained GitHub PAT with Contents:
Read-only access to `NickTheTurtle/trippy` (GitHub -> Settings -> Developer
settings -> Fine-grained tokens), then:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/NickTheTurtle/trippy.git
# Username: NickTheTurtle
# Password: <paste the PAT>
cd trippy
```

## 5. Set secrets and run the setup script

Secrets come from your shell environment at setup time and are written only to
`/etc/trippy.env` (root-only, chmod 600). Nothing is printed. Export what you
have; anything you leave out degrades gracefully (see "What each key does").

```bash
export GITHUB_TOKEN='github_pat_...'        # required, to clone to /opt/trippy
export DOMAIN='trippy.dxu.info'             # omit to use the sslip.io fallback
export ACME_EMAIL='you@example.com'         # optional, Let's Encrypt notices

# Optional provider and mail secrets:
export GOOGLE_PLACES_KEY='...'              # richer place search; else keyless OSM
export GOOGLE_MAPS_KEY='...'                # map tiles + server-side routing
export MAIL_FROM='trips@trippy.dxu.info'    # turns on email verification
export AWS_ACCESS_KEY_ID='...'
export AWS_SECRET_ACCESS_KEY='...'
export SES_REGION='us-east-1'
# export RESEND_API_KEY='...'               # used only if the SES keys are absent
export TRIPPY_REGISTER_LIMIT='5'            # signups per IP before backoff

sudo -E bash deploy/ec2-setup.sh
```

`sudo -E` preserves your exported variables. When it finishes it prints the app
URL. The first HTTPS request can take a few seconds while Caddy fetches the
certificate.

If you set `MAIL_FROM` together with a `DOMAIN`, `APP_URL` in `/etc/trippy.env`
is set to your public HTTPS origin automatically, so emailed verification and
reset links point at the real site rather than localhost. Confirm it after the
run:

```bash
sudo grep APP_URL /etc/trippy.env
```

## 6. Verify the deploy

```bash
# API is up on loopback and talking to its database:
curl -s http://127.0.0.1:5175/api/health        # -> {"ok":true,"provider":"google"|"osm"}

# Public HTTPS path through Caddy:
curl -s https://trippy.dxu.info/api/health

# The web client is served as static files:
curl -sI https://trippy.dxu.info/               # -> 200, text/html

# Security headers are present:
curl -sI https://trippy.dxu.info/ | grep -i -E 'strict-transport|x-content-type|referrer|x-frame'
```

Then open `https://trippy.dxu.info` in a browser and register an account. On a
fresh box the database starts empty; the first registration creates the first
user.

---

## What each key does, and what happens without it

The server never crashes on a missing key; each feature simply degrades.

| Variable | Enables | Without it |
| --- | --- | --- |
| `GOOGLE_PLACES_KEY` | Google Places search and place photos | Falls back to keyless OpenStreetMap / Photon search; `/api/health` reports `"provider":"osm"` |
| `GOOGLE_MAPS_KEY` | The interactive map (browser) and server-side travel-time routing | No interactive Google map and no routing estimates; the rest of the app works |
| `MAIL_FROM` (+ SES or Resend creds) | Email verification and password reset | Registration completes instantly with no email step; password reset cannot send |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `SES_REGION` | Amazon SES as the mail provider (preferred) | Mail via Resend if that key is set, otherwise mail is off |
| `RESEND_API_KEY` | Resend as the mail provider | Used only when SES creds are absent |
| `APP_URL` | The origin used in emailed links | Defaults to `http://localhost:5174`, which is wrong in production, so set it |
| `TRIPPY_DB` | Database file path | Defaults to `/opt/trippy/data/app.db`; the setup script pins it to `/var/lib/trippy/app.db` |
| `PORT` | API loopback port | Defaults to `5175` |
| `TRIPPY_REGISTER_LIMIT` | Signups per client IP before exponential backoff | Defaults to `20` (loose, meant for the test suite); the setup script sets `5` |
| `NODE_ENV=production` | Secure cookie flag, disables dev CORS, skips the demo seed | Set by the setup script |

Foreign-exchange rates use a keyless public endpoint, so there is no FX key to
set. All provider results are cached (`cache.ts`); the caches start cold on a
fresh box and warm up as people use the app.

### Cost control for the paid keys

`GOOGLE_PLACES_KEY` and `GOOGLE_MAPS_KEY` bill per call. Before pointing real
traffic at this box:

- Set a billing budget and alert in Google Cloud, and per-API daily quota caps
  on Places, Maps JavaScript, and Routes.
- Restrict the keys. Note the awkward part: `GOOGLE_MAPS_KEY` is used both in
  the browser (Maps JavaScript, which wants an HTTP-referrer restriction) and
  on the server (Routes API, which wants an IP restriction). One key cannot be
  both. The clean fix is two keys: a referrer-restricted browser key for the
  map and a separate IP-restricted server key for routing. Until then, restrict
  the single key by enabled APIs and lean on the billing cap.

---

## Operating it

```bash
sudo systemctl status trippy      # service state
sudo journalctl -u trippy -f      # API logs (stdout/stderr)
sudo journalctl -u caddy -f       # Caddy / TLS logs
sudo systemctl restart trippy     # restart the API
sudo systemctl reload caddy       # reload after editing the Caddyfile
```

- App code: `/opt/trippy`
- Config and secrets: `/etc/trippy.env` (root-only)
- Database: `/var/lib/trippy/app.db` plus its `-wal` and `-shm` siblings
- Web bundle Caddy serves: `/opt/trippy/apps/web/dist`
- Caddy config: `/etc/caddy/Caddyfile`

### Update to the latest code

```bash
export GITHUB_TOKEN='github_pat_...'
sudo -E bash /opt/trippy/deploy/update.sh
```

This fetches, hard-resets to the target ref, reinstalls, rebuilds the web
client, and restarts the API. It does not touch `/etc/trippy.env` or the
database.

### Roll back

The box tracks a branch, so rolling back means redeploying an older commit:

```bash
export GITHUB_TOKEN='github_pat_...'
export GIT_REF='<older-commit-sha-or-tag>'
sudo -E bash /opt/trippy/deploy/update.sh
```

Pin `GIT_REF` to a tag or SHA you trust. To return to the tip, run `update.sh`
again with `GIT_REF=main` (the default). A rollback rebuilds from that ref; it
does not migrate the database backwards, and Trippy's migrations are additive,
so an older build reads a newer database fine as long as you did not rely on a
column only the newer build writes.

### Back up and restore

```bash
# Hot backup, safe while the service runs. Writes a consistent, standalone,
# gzipped snapshot to /var/backups/trippy and integrity-checks it.
sudo bash /opt/trippy/deploy/backup.sh
```

`backup.sh` uses SQLite's own online `.backup`, which folds the WAL into a
single file. If you ever copy the database by hand instead, you must copy all
three files together, `app.db`, `app.db-wal`, and `app.db-shm`: in WAL mode the
committed state is split across them, and copying `app.db` alone silently loses
whatever is still in the WAL. The script's `--raw` mode does this correctly.

Restore, scheduling (cron), and off-box durability (S3 sync or an EBS snapshot
policy) are documented at the end of `backup.sh` and printed when it runs.

---

## Things to know before you trust this in production

- **Single instance only, for now.** The login and signup throttle keeps its
  state in memory, per process. That means the limits reset every time you
  deploy, and they do not span more than one instance. Do not put this behind a
  load balancer with two boxes until that state moves to a shared store, or the
  throttle becomes trivially bypassable. One instance is the supported shape.

- **The API runs its TypeScript directly via `tsx`.** There is no compiled
  build for the API; the systemd unit runs `node --import tsx apps/api/src/index.ts`.
  Because of that, `tsx` and the workspace dev dependencies are needed at
  runtime, so both scripts do a full `npm ci`, never `npm ci --omit=dev`. If you
  want a leaner runtime later, compile the API to plain JS first; do not just
  drop dev dependencies, or the service will not start.

- **`apps/mobile` (Expo) is not deployed.** It has no build step here and is
  never served. Only `apps/web` is built and only `/api` is proxied.

- **No Content-Security-Policy yet.** The Caddyfile ships HSTS,
  `X-Content-Type-Options`, `Referrer-Policy`, and `X-Frame-Options`, but the
  CSP is left commented out. An over-tight CSP blanks the Google map and the
  place-photo cards. A candidate policy is in the Caddyfile; test it in a real
  browser (watch the console for blocked resources) before enabling it, then
  `sudo systemctl reload caddy`.

- **Client IP for throttling comes from `X-Forwarded-For`.** Caddy sets it and
  the app reads the first value. A determined caller can prepend a spoofed
  address to dodge the per-IP limit. The per-account limit still applies, and a
  single-instance box is not a high-value target, but tighten this (trust only
  Caddy's appended value) before scaling out.

- **The database starts empty and is created on first boot.** This was verified
  locally: a fresh `TRIPPY_DB` path produces all tables with zero rows and the
  API serves `/api/health` immediately. WAL mode and the `-wal`/`-shm` siblings
  live in `/var/lib/trippy` alongside `app.db`.

---

## Cost

- Free for 12 months on the free tier (750 instance-hours/month plus 30 GiB
  storage). One `t4g.micro`/`t3.micro` running 24/7 fits within the hours.
- After the free year, roughly $6 to $8/month for the instance plus the EBS
  volume.
- The Google keys bill separately, per call. See "Cost control" above.

## Troubleshooting

- **Build gets killed / hangs at "rendering chunks":** the box ran out of
  memory. The setup script adds a 2 GB swap file automatically on machines with
  under 2 GB RAM. If you are building by hand, add swap first:
  ```bash
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  ```
- **Certificate did not issue / site not secure:** confirm 80 and 443 are open
  and that `trippy.dxu.info` resolves to this box, then
  `sudo journalctl -u caddy -f` and `sudo systemctl reload caddy`.
- **502 from Caddy:** the API is not up. `sudo systemctl status trippy` and
  `sudo journalctl -u trippy -e`.
- **Map is blank but everything else works:** `GOOGLE_MAPS_KEY` is missing,
  restricted too tightly, or over quota.
- **Registration never sends an email:** mail is not configured, or `MAIL_FROM`
  is on a domain the provider has not verified. Check
  `sudo journalctl -u trippy | grep -i mail`.
