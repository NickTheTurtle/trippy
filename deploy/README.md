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

The repo is public, so clone it with no credential:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/NickTheTurtle/trippy.git
cd trippy
```

If the repo is ever made private again (or you deploy a private fork), set
`GITHUB_TOKEN` to a fine-grained GitHub PAT with Contents: Read-only on
`NickTheTurtle/trippy` (GitHub -> Settings -> Developer settings -> Fine-grained
tokens) before cloning, and the deploy scripts will use it automatically.

## 5. Set secrets and run the setup script

Secrets come from your shell environment at setup time and are written only to
`/etc/trippy.env` (root-only, chmod 600). Nothing is printed. Export what you
have; anything you leave out degrades gracefully (see "What each key does").

```bash
# export GITHUB_TOKEN='github_pat_...'      # only if the repo is private; public clones need none
export DOMAIN='trippy.dxu.info'             # omit to use the sslip.io fallback
export ACME_EMAIL='you@example.com'         # optional, Let's Encrypt notices

# Optional provider and mail secrets, plus production throttle settings:
export GOOGLE_SERVER_KEY='...'              # secret Places and Routes key; else OSM/OSRM fallbacks
export GOOGLE_MAPS_KEY='...'                # public browser Maps JavaScript key
# export GOOGLE_PLACES_KEY='...'            # deprecated fallback while migrating old deploys
export MAIL_FROM='trips@trippy.dxu.info'    # turns on email verification
export AWS_ACCESS_KEY_ID='...'
export AWS_SECRET_ACCESS_KEY='...'
export SES_REGION='us-east-1'
# export RESEND_API_KEY='...'               # used only if the SES keys are absent
export TRIPPY_REGISTER_LIMIT='5'            # signups per IP before backoff
export TRIPPY_TRUSTED_PROXIES='1'           # Caddy sits one proxy hop in front of the API
# export TRIPPY_PROVIDER_LIMIT='60'         # paid provider calls per user before backoff
# export TRIPPY_PROVIDER_IP_LIMIT='240'     # paid provider calls per IP before backoff
# export TRIPPY_ROUTING_LIMIT='300'         # paid routing calls per user before fallback

sudo -E bash deploy/ec2-setup.sh
```

`sudo -E` preserves your exported variables. When it finishes it prints the app
URL. The first HTTPS request can take a few seconds while Caddy fetches the
certificate.

Re-runs rewrite `/etc/trippy.env` from scratch. Pass the complete set of
runtime variables every time, not only the value you are changing, or omitted
keys such as Google provider credentials and throttle settings are removed from
the service environment. A practical pattern is to keep the full deployment
environment in a root-owned file, for example `/root/trippy-deploy.env`, then
source it for every setup re-run:

```bash
set -a
source /root/trippy-deploy.env
set +a
sudo -E bash deploy/ec2-setup.sh
```

Keep secrets out of shell history and restrict that file to root.

If you set `MAIL_FROM` together with a `DOMAIN`, `APP_URL` in `/etc/trippy.env`
is set to your public HTTPS origin automatically, so emailed verification and
reset links point at the real site rather than localhost. Confirm it after the
run:

```bash
sudo grep APP_URL /etc/trippy.env
```

### Preflight: catch problems before they cost you

`ec2-setup.sh` runs `deploy/preflight.sh` automatically before it changes
anything, and aborts if a required check fails. You can also run it by hand
first (it changes nothing):

```bash
# export GITHUB_TOKEN='github_pat_...'  # only if the repo is private
export DOMAIN='trippy.dxu.info'      # omit for the sslip.io fallback
bash deploy/preflight.sh
```

It checks that `curl` is present, the repo is readable (with `GITHUB_TOKEN` if
set, anonymously against the public repo if not), there is enough disk and
memory (or that swap will be added), and, when a real `DOMAIN` is set, that its
DNS already points at this box. Each
failure names the exact fix. This matters most for **DNS and the security
group**: if `trippy.dxu.info` does not resolve here, or ports 80/443 are not
open, Let's Encrypt will fail, and repeated failures can rate-limit the hostname
for hours. To bypass preflight at your own risk: `export SKIP_PREFLIGHT=1`.

The external port probe is best effort: from the instance you often cannot test
your own inbound rules (AWS does not hairpin the self-connect), so a "could not
self-reach" line is usually harmless. The reliable way to prove 80/443 before
betting the real certificate on them is to rehearse against Let's Encrypt
**staging**, next.

### Rehearse TLS against Let's Encrypt staging

Staging has far higher rate limits, so you can retry freely while sorting out DNS
and the security group. Its certificates are not trusted by browsers, so this is
only a rehearsal:

```bash
export ACME_STAGING=1
sudo -E bash deploy/ec2-setup.sh
# Watch it obtain a staging cert without spending the real quota:
sudo journalctl -u caddy -f
# When issuance succeeds, switch back to real certificates:
unset ACME_STAGING
sudo -E bash deploy/ec2-setup.sh
sudo systemctl restart caddy
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

## First deploy, step by step: what you should see

The first run is the first real test of the whole path. Here is what normal
looks like at each stage, and what to do when a stage fails. The whole thing
takes roughly 5 to 10 minutes on a `t3.micro`/`t4g.micro`.

1. **Preflight** (`== Trippy preflight ==` ... `== Preflight passed. ==`). Every
   line should be `ok`. If it aborts, it names the fix. The two that bite first:
   - `DOMAIN ... does not resolve` or `resolves to X, not this box`: fix the A
     record and wait for TTL. Do not proceed; Let's Encrypt will fail.
   - `repo ... is not readable anonymously` (no token set): the repo may have
     been made private again, in which case set `GITHUB_TOKEN` to a fine-grained
     PAT with Contents: Read; otherwise the box has no network/DNS to GitHub.
   - `GitHub token ... (401/404)` (token set): the token is missing a scope,
     expired, or lacks access. Regenerate a fine-grained PAT with Contents: Read
     on the repo.

2. **APT installs** (`Installing base packages`, `Installing Node.js`,
   `Installing Caddy`). Ubuntu fetches Node, Caddy, git, and Litestream. Expect a
   minute or two of apt output. If apt fails on a lock, another
   `apt`/`unattended-upgrades` run is in progress; wait and re-run.

3. **Swap** (`Adding 2 GB swap ...`). On a box under 2 GB RAM it creates a 2 GB
   swapfile so the build does not OOM. On re-run it says `Swap OK` and moves on.

4. **Build** (`Building the web client`). `npm ci` then `npm run build`. This is
   the slowest stage and the most memory-hungry; on 1 GB RAM the swap from step 3
   is what keeps it alive. A silent kill here is almost always OOM: check
   `dmesg | grep -i oom`.

5. **Publish web** (`Publishing the web bundle to ...`). Copies the build into a
   release dir and flips the `current` symlink. Fast.

6. **systemd** (`Installing systemd service`, then the Litestream, backup,
   health, and monitor units). Services and timers are enabled and started. Check
   with `systemctl status trippy`.

7. **Caddy + TLS** (`Configuring Caddy for ...`, then the first HTTPS request is
   slow). Caddy fetches the certificate on first request.
   `sudo journalctl -u caddy -f` shows the ACME handshake. If it loops on a
   challenge failure, ports 80/443 are not open to the internet: fix the security
   group, and rehearse against staging (above) so you do not burn the real rate
   limit.

8. **Done** (`Deployment complete!`), then verify (section 6). All four curls
   should succeed. Then register in a browser.

### Re-running after a partial failure

`ec2-setup.sh` is idempotent: it creates users, directories, and units only if
absent, rewrites config files in place, and re-runs the build and publish. It is
safe to re-run after a failure at any stage. What a re-run does at each point:

- **Failed in preflight/apt/swap:** nothing durable changed; fix the named cause
  and re-run from the top.
- **Failed during build:** the old `current` symlink still points at the last
  good bundle (or nothing on a first ever run), so the site is unchanged. Re-run;
  it rebuilds and only then republishes.
- **Failed at TLS:** the app is already installed and serving on loopback; only
  the certificate is missing. Fix DNS or the security group and re-run, or just
  `sudo systemctl restart caddy` once the network path is open. Repeated failed
  issuance can rate-limit the hostname, so rehearse with `ACME_STAGING=1` first.
- **Re-running a fully working box:** harmless. It reinstalls the same packages,
  rebuilds, publishes a new release (pruning old ones to the last 5), and
  restarts the services. It never touches `/etc/trippy.env` or the database. The
  existing `/opt/trippy` checkout is owned by the `trippy` service user (the
  first run chowns it), while the script runs as root; the git fetch/reset on a
  re-run is therefore issued with a per-command `-c safe.directory=/opt/trippy`
  so git does not refuse the checkout as "dubious ownership". This exception is
  scoped to each git call and writes no persistent git config on the box.

---

## What each key does, and what happens without it

The server never crashes on a missing key; each feature simply degrades.

| Variable | Enables | Without it |
| --- | --- | --- |
| `GOOGLE_SERVER_KEY` | Server-side Google Places search, autocomplete, details, photos, and Routes travel times | Falls back to keyless OpenStreetMap / Photon search and OSRM routing; `/api/health` reports `"provider":"osm"` |
| `GOOGLE_PLACES_KEY` | Deprecated compatibility fallback for `GOOGLE_SERVER_KEY` | Existing deploys keep working during migration; new deploys should leave it unset |
| `GOOGLE_MAPS_KEY` | Public browser Maps JavaScript key for the interactive map | No interactive Google map; the Leaflet fallback still works |
| `MAIL_FROM` (+ SES or Resend creds) | Email verification and password reset | Registration completes instantly with no email step; password reset cannot send |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `SES_REGION` | Amazon SES as the mail provider (preferred) | Mail via Resend if that key is set, otherwise mail is off |
| `RESEND_API_KEY` | Resend as the mail provider | Used only when SES creds are absent |
| `APP_URL` | The origin used in emailed links | Defaults to `http://localhost:5174`, which is wrong in production, so set it |
| `TRIPPY_DB` | Database file path | Defaults to `/opt/trippy/data/app.db`; the setup script pins it to `/var/lib/trippy/app.db` |
| `PORT` | API loopback port | Defaults to `5175` |
| `TRIPPY_REGISTER_LIMIT` | Signups per client IP before exponential backoff | Defaults to `20` (loose, meant for the test suite); the setup script sets `5` |
| `TRIPPY_TRUSTED_PROXIES` | Number of trusted reverse proxy hops for `X-Forwarded-For` client IP parsing | Defaults to `0` in the app; the setup script sets `1` because Caddy sits directly in front of the API |
| `TRIPPY_PROVIDER_LIMIT` | Paid provider calls per user before exponential backoff | Defaults to `60` |
| `TRIPPY_PROVIDER_IP_LIMIT` | Paid provider calls per client IP before exponential backoff | Defaults to `240` |
| `TRIPPY_ROUTING_LIMIT` | Paid routing calls per user before fallback to the free path | Defaults to `300` |
| `NODE_ENV=production` | Secure cookie flag, disables dev CORS, skips the demo seed | Set by the setup script |
| `TRIPPY_OFFLINE_PROVIDERS` | Nothing. Set to `1` it *forbids* paid providers: all Google keys read as unset, search serves keyless OpenStreetMap / Photon, routing takes the straight-line estimate, and the FX refresh is skipped | Unset in production, which is what you want; the test harnesses set it for themselves |

Foreign-exchange rates use a keyless public endpoint, so there is no FX key to
set. All provider results are cached (`cache.ts`); the caches start cold on a
fresh box and warm up as people use the app.

### Why tests never use the paid provider

The browser suite sets `TRIPPY_OFFLINE_PROVIDERS=1` for the API server it starts
(`tests-e2e/playwright.config.ts`), so e2e runs use the keyless OpenStreetMap /
Photon provider and never Google. Unit runs get the same guarantee a different
way: `vitest.setup.ts` strips every Google key out of `process.env` and replaces
`fetch` with a function that throws, so a unit test cannot reach any network
service at all and the Google code paths are exercised against stubs.

Google Places and Routes are billed per request: a suite that calls them costs
money on every run, cannot be deterministic because the provider's answers change
under it, and couples CI to a third party's uptime. Both guards are set by the
harness rather than left to whoever is running it, because a developer machine
legitimately has live keys in `.env` and the failure mode of forgetting is silent
and expensive. Local hand-driven development still uses the real key; only
automated runs are pinned to OSM.

The flag is a refusal, not a preference: with it set, a code path that reaches
for Google throws `PaidProviderBlockedError` instead of quietly degrading, so an
accidental paid call fails visibly rather than serving OSM results under a
Google label.

### Clearing a poisoned provider cache

An empty search result is cached for ten minutes rather than the usual seven
days, because an empty array is also what a broken provider returns and a
week-long TTL turns a short outage into a week-long one. If stale empties do
need clearing (for example after an old build wrote some), do it without
touching the rest of the database:

```
sqlite3 /var/lib/trippy/app.db "DELETE FROM provider_cache WHERE key LIKE 'search|%' AND value = '[]';"
```

`clearEmptySearchCache()` in `@trippy/server/places` does exactly this and runs
once at startup, so a restart also clears them.

### Google key restriction and cost control

Use separate Google API keys for browser and server traffic. A key can have only
one restriction type, and mixing these roles forces the key to be unrestricted.

- `GOOGLE_MAPS_KEY` is public by design because it is delivered to the browser
  to load Maps JavaScript. Enable only the Maps JavaScript API and restrict the
  key by HTTP referrer, for example `https://trippy.dxu.info/*`.
- `GOOGLE_SERVER_KEY` is secret and must never be sent to the browser. Enable
  Places API (New) and Routes API, and restrict the key by the EC2 instance's
  public IP address.
- `GOOGLE_PLACES_KEY` is only a deprecated compatibility fallback for older
  deploy env files. Migrate `/etc/trippy.env` or `/root/trippy-deploy.env` to
  `GOOGLE_SERVER_KEY`, then remove `GOOGLE_PLACES_KEY`.

Before pointing real traffic at this box:

- Set a billing budget and alert in Google Cloud, and per-API daily quota caps
  on Places, Maps JavaScript, and Routes.
- Regenerate any key that was previously served publicly while unrestricted.

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
- Web bundle Caddy serves: `/var/www/trippy/current` (a symlink to the active
  release under `/var/www/trippy/releases/`; flipped atomically on each deploy)
- Caddy config: `/etc/caddy/Caddyfile`

### Update to the latest code

```bash
# export GITHUB_TOKEN='github_pat_...'  # only if the repo is private
sudo -E bash /opt/trippy/deploy/update.sh
```

This fetches, hard-resets to the target ref, reinstalls, rebuilds the web
client, and restarts the API. It does not touch `/etc/trippy.env` or the
database.

### Continuous deployment from GitHub Actions

The repository also has `.github/workflows/deploy.yml`, which deploys the tip of
`main` after the `CI` workflow completes successfully for a push to `main`. A
manual `workflow_dispatch` run from `main` redeploys the current tip. The action
does not use SSH and does not store AWS access keys. It uses GitHub OIDC to
assume an AWS IAM role, then calls AWS Systems Manager Run Command against the
EC2 instance:

```bash
bash /opt/trippy/deploy/update.sh
```

Run Command executes the shell document as root on Ubuntu, which is required by
`update.sh`. The script fetches `main`, runs `npm ci`, runs `npm run build`,
publishes the web bundle, and restarts `trippy.service`. The web client is
rebuilt on the instance on every deploy. On a host with about 1 GB RAM this is
slow and depends on swap, which `ec2-setup.sh` creates. That is acceptable for a
small site because the old bundle and API keep running during the slow phase,
but expect deploys to take several minutes. If builds start timing out or the
kernel kills Node for OOM, move the build to CI and copy an artifact instead of
building on the box.

The deploy workflow is intentionally configured to fail before contacting AWS if
the required repository settings are missing. That makes an early merge
harmless: no half deploy happens, and the Actions log names the missing setting.

#### One-time AWS IAM setup

Do these steps in the AWS account that owns the instance.

1. Create the GitHub OIDC provider in IAM:
   - Provider URL: `https://token.actions.githubusercontent.com`
   - Audience: `sts.amazonaws.com`

2. Create a deploy role for GitHub Actions. The trust policy must allow only
   this repository on the `main` branch to assume it.

   Verify the OIDC subject format before you create the policy. GitHub accounts
   and organizations can enable immutable unique IDs for OIDC subject claims
   from GitHub Settings -> Actions -> OIDC, either for the repository or at the
   owner/organization level. Do not assume which mode is active.

   With immutable IDs off, normal `push` runs and manual `workflow_dispatch`
   runs started from the `main` branch use this `sub` claim:

   ```text
   repo:NickTheTurtle/trippy:ref:refs/heads/main
   ```

   This repository currently has immutable IDs on, so GitHub sends the owner ID
   and repository ID in the subject:

   ```text
   repo:NickTheTurtle@12247846/trippy@1361960349:ref:refs/heads/main
   ```

   That exact prefix matters. A wildcard such as `repo:NickTheTurtle/trippy:*`
   does not match the immutable-ID form because the literal owner and repository
   segment is different.

   Trust policy:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "Federated": "arn:aws:iam::790873127952:oidc-provider/token.actions.githubusercontent.com"
         },
         "Action": "sts:AssumeRoleWithWebIdentity",
         "Condition": {
           "StringEquals": {
             "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
             "token.actions.githubusercontent.com:sub": "repo:NickTheTurtle@12247846/trippy@1361960349:ref:refs/heads/main"
           }
         }
       }
     ]
   }
   ```

   If you later attach a GitHub Environment to the deploy job, GitHub changes
   the `sub` claim to the environment form, for example
   `repo:NickTheTurtle/trippy:environment:production` or its immutable-ID
   equivalent. In that case update the trust policy and restrict that
   environment to the `main` branch in GitHub.

   If role assumption fails, the Actions log only says
   `Not authorized to perform sts:AssumeRoleWithWebIdentity`. That same error
   can mean a missing OIDC provider, a wrong audience, a misspelled role ARN, or
   a trust policy subject mismatch. AWS deliberately returns the same
   `AccessDenied` when the role ARN does not exist to prevent role enumeration.
   The definitive diagnostic is CloudTrail:

   1. Open CloudTrail -> Event history in the AWS account that owns the role.
   2. Select the region used by the STS endpoint for the failed workflow. STS
      events may appear in that endpoint's region rather than the instance
      region.
   3. Filter `Event name` to `AssumeRoleWithWebIdentity`.
   4. Open the failed event and read `userIdentity.userName`. That value is the
      actual GitHub OIDC `sub` claim that AWS evaluated.

3. Attach this least-privilege permission policy to the deploy role. Replace
   `<instance-id>` with the production EC2 instance ID, for example
   `i-0123456789abcdef0`.

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "SendDeployCommandToTrippyInstance",
         "Effect": "Allow",
         "Action": "ssm:SendCommand",
         "Resource": [
           "arn:aws:ec2:us-east-2:790873127952:instance/<instance-id>",
           "arn:aws:ssm:us-east-2::document/AWS-RunShellScript"
         ]
       },
       {
         "Sid": "ReadDeployCommandResult",
         "Effect": "Allow",
         "Action": "ssm:GetCommandInvocation",
         "Resource": "*"
       }
     ]
   }
   ```

   `ssm:SendCommand` is scoped to the one instance and the AWS managed
   `AWS-RunShellScript` document. `ssm:GetCommandInvocation` does not support
   resource-level permissions, so it must use `"Resource": "*"`.

4. Add the AWS managed policy `AmazonSSMManagedInstanceCore` to the existing
   EC2 instance role, `trippy-ec2`. The instance needs this policy so the SSM
   Agent can register as a managed node and receive the command. Without it, the
   agent logs `not authorized to perform: ssm:UpdateInstanceInformation`, and
   the instance never appears in Systems Manager Fleet Manager.

5. Verify the SSM Agent on Ubuntu:

   ```bash
   sudo systemctl status snap.amazon-ssm-agent.amazon-ssm-agent.service
   sudo snap services amazon-ssm-agent
   sudo tail -n 100 /var/log/amazon/ssm/amazon-ssm-agent.log
   ```

   If the service is missing on the AMI, install and start it using the current
   AWS Systems Manager Agent instructions for Ubuntu, then confirm the instance
   appears in Systems Manager Fleet Manager. On Ubuntu, the agent is a snap, so
   the unit is `snap.amazon-ssm-agent.amazon-ssm-agent.service`, not
   `amazon-ssm-agent`. After attaching `AmazonSSMManagedInstanceCore`, restart
   the snap instead of waiting for the agent's backoff sleep to expire:

   ```bash
   sudo snap restart amazon-ssm-agent
   ```

#### GitHub repository settings

Create these repository-level settings before expecting deploys to succeed:

| Type | Name | Value |
| --- | --- | --- |
| Variable | `AWS_REGION` | `us-east-2` |
| Variable | `EC2_INSTANCE_ID` | The production instance ID |
| Secret | `AWS_DEPLOY_ROLE_ARN` | The ARN of the deploy IAM role |

The workflow job does not declare an `environment:`, so environment-level
variables and secrets are not visible to it. Put these values in the repository
settings. If they are absent or created only on an environment, the deploy
workflow fails safely during configuration validation before contacting AWS.

#### Verifying continuous deployment

1. In AWS Systems Manager, confirm the instance is listed as a managed node and
   online.
2. In GitHub Actions, run the `Deploy` workflow manually from the `main` branch.
3. Watch the Actions log. It prints the SSM command status plus the remote
   stdout and stderr returned by Systems Manager.
4. Confirm the site after the workflow succeeds:

   ```bash
   curl -s https://trippy.dxu.info/api/health
   curl -sI https://trippy.dxu.info/
   ```

On normal pushes to `main`, the deploy workflow is triggered by the completed
`CI` workflow, not directly by the push. If either required CI job is red, the
deploy job exits without sending an SSM command.

#### Rollback or disable auto deploy

- Fast web rollback:

  ```bash
  sudo bash /opt/trippy/deploy/publish-web.sh --rollback
  ```

- Code rollback:

  ```bash
  export GIT_REF='<older-commit-sha-or-tag>'
  sudo -E bash /opt/trippy/deploy/update.sh
  ```

- Disable automatic deploys quickly: remove or rename the
  `AWS_DEPLOY_ROLE_ARN` secret, detach the deploy role policy, or disable the
  `Deploy` workflow in GitHub Actions. Removing the secret makes the workflow
  fail during configuration validation before any AWS call.

I do not recommend adding a GitHub Environment approval gate at first. Required
reviewers add a useful human stop before production, but they also remove the
main benefit requested here: commits that have already passed protected-branch
review and CI deploy without anyone SSHing or clicking another approval. If the
site grows or deploy risk increases, add a `production` environment with
required reviewers and update the OIDC trust policy as described above.

**Ordering and downtime.** The slow work (fetch, `npm ci`, build) runs first,
while the old bundle is still served and the old API still runs. Only the last
two steps are user-visible:

- **Web client: no downtime.** The freshly built bundle is copied into a new
  release directory and the `current` symlink is flipped with a single atomic
  rename, so Caddy never serves a half-written bundle.
- **API: a few seconds.** `systemctl restart trippy` restarts the single Node
  process (a `tsx` cold start), during which Caddy returns 502 for `/api/*`. The
  page itself keeps loading; in-flight API calls blip. Run deploys when a brief
  API interruption is acceptable.

A full zero-downtime API deploy would need two processes and a proxy switch.
That is more machinery than a single-box app warrants, so we keep one process
and accept a few seconds. If the build fails, nothing user-visible changed.

### Roll back

Two independent rollbacks, fast to slow:

**Web bundle only, no rebuild** (instant; flips the symlink to the previous
release):

```bash
sudo bash /opt/trippy/deploy/publish-web.sh --list       # see releases
sudo bash /opt/trippy/deploy/publish-web.sh --rollback   # flip to the previous one
```

**Code (API + web), by redeploying an older commit** (rebuilds):

```bash
# export GITHUB_TOKEN='github_pat_...'  # only if the repo is private
export GIT_REF='<older-commit-sha-or-tag>'
sudo -E bash /opt/trippy/deploy/update.sh
```

Pin `GIT_REF` to a tag or SHA you trust. To return to the tip, run `update.sh`
again with `GIT_REF=main` (the default). A rollback rebuilds from that ref; it
does not migrate the database backwards, and Trippy's migrations are additive,
so an older build reads a newer database fine as long as you did not rely on a
column only the newer build writes.

### Monitoring and alerting

The scripts install two on-box layers; the part that actually pages a human is
external and you set it up yourself (below). Be clear-eyed about the split: a
single box cannot reliably alert about its own death, so the on-box checks are
for self-healing and for leaving a trail in the journal, not for paging.

**On-box, installed for you:**

- **API watchdog** (`trippy-health.timer`, every minute). Curls
  `http://127.0.0.1:5175/api/health` on loopback and, after 3 consecutive
  failures, restarts `trippy.service`. This catches a *wedged* API (alive but
  not serving), which `Restart=on-failure` does not. It does **not** catch Caddy,
  TLS, DNS, or the box being gone.

  ```bash
  systemctl list-timers trippy-health.timer
  journalctl -t trippy-health
  ```

- **Resource + backup monitor** (`trippy-monitor.timer`, every 15 minutes).
  Warns on disk usage (80% warn, 90% critical) on the data and backup
  filesystems, on Litestream having stopped, and on stale backups (no local
  snapshot newer than 26 h, or no replicated S3 object newer than 60 min). It
  logs to the journal and exits non-zero on a problem, so it also shows up in
  `systemctl --failed`. Optionally set `ALERT_WEBHOOK_URL` (Slack/Discord/etc.)
  at setup time to have it POST a one-line alert.

  ```bash
  systemctl list-timers trippy-monitor.timer
  journalctl -t trippy-monitor
  systemctl start trippy-monitor.service   # run a check right now
  ```

- **journald is capped** (200 MB) by a drop-in the setup writes, so logs cannot
  fill the 20 GiB volume and corrupt SQLite writes.

**External uptime check (do this: it is the pager).** Recommended:
**UptimeRobot** free tier. It checks from outside your AWS account, so it catches
exactly what the on-box checks cannot: the box down, the AZ gone, TLS expired, a
security-group mistake.

1. Create a free UptimeRobot account.
2. Add monitor: **HTTP(s)**, URL `https://trippy.dxu.info/api/health`, interval 5
   minutes.
3. Advanced: alert when the response does **not** contain `"ok":true` (keyword
   monitor), so a 200 that is not actually healthy still alerts.
4. Add an alert contact: email is free; SMS/phone/push need their paid tier or
   use the free mobile app for push.

   Alternatives with real tradeoffs:
   - **Better Stack (Uptime)** free tier: nicer incident handling and a status
     page, 3-minute checks; more product than a hobby box needs.
   - **Healthchecks.io**: a **dead-man's switch**, not a poller. It does not
     check the site; it alerts when an expected ping stops. That is the right
     tool for *backup* freshness (below), less so for uptime.
   - **CloudWatch alarm on the EC2 instance status check**: no third party, but
     it only sees "instance/system impaired", not "the app returns errors", and
     wiring SNS email is more setup. Good as a second signal, weak as the only
     one.
   - **CloudWatch Synthetics canary**: closest to a real external check within
     AWS, but it costs a little and is overkill here.

**Backup freshness (the silent killer).** If Litestream stops replicating, you
find out during a restore, which is the worst possible moment. Two overlapping
guards:

- The on-box monitor already warns on a stale S3 object or missing snapshot.
- Better, a **dead-man's switch** that pages when backups stop: create a check at
  Healthchecks.io (free), set its period to just over a day, and pass its ping
  URL as `BACKUP_PING_URL` at setup time. `backup.sh` pings it on every
  successful run; if the daily backup stops, Healthchecks.io alerts you.

  ```bash
  export BACKUP_PING_URL='https://hc-ping.com/<your-uuid>'
  sudo -E bash deploy/ec2-setup.sh   # re-run to store it in /etc/trippy-monitor.env
  ```

### Backups and recovery

Trippy keeps everything in one SQLite file, so backups are the whole safety
story. There are four layers here, each covering a failure the one before it
does not:

| Layer | Protects against | Does not cover | RPO | RTO |
| --- | --- | --- | --- | --- |
| Litestream -> S3 (continuous) | Losing the volume, the instance, or the whole AZ; a bad delete you catch within the retention window | The S3 bucket itself being lost or the account being compromised | Seconds | 5 to 20 min (install app, `restore.sh`) |
| Daily snapshot (`backup.sh` + timer), copied to S3 | Same as above, plus a portable single-file copy anyone can restore without Litestream | Anything written since the last daily run | Up to 24 h | 5 to 20 min |
| EBS snapshots (DLM, see below) | Whole-volume loss and instance-level mistakes, at the block level | Sub-day granularity; app-consistent point-in-time | Up to 24 h | 20 to 60 min (new volume/instance) |
| Separate data volume, delete-on-termination off | Terminating the instance taking the database with it | Volume corruption or an AZ loss (still need the S3 layers) | n/a | Minutes (reattach) |

The honest summary: **Litestream is the one that matters** for "the box is
gone." The daily snapshot is the independent belt to its braces (a bug or a bad
config in Litestream should not cost you everything). EBS protection is a
block-level backstop you set up in the AWS console. None of these protects
against the S3 bucket itself being deleted, so turn on **bucket versioning** and
lock down who can delete (below).

`/var/lib/trippy/app.db` is real data. Nothing in these scripts ever deletes or
rebuilds it; `restore.sh` moves the current file aside rather than overwriting
it.

#### The snapshot layer

```bash
# Hot backup, safe while the service runs. Writes a consistent, standalone,
# gzipped snapshot to /var/backups/trippy, integrity-checks it, uploads it to
# S3 if configured, and prunes local snapshots older than 14 days.
sudo bash /opt/trippy/deploy/backup.sh
```

`backup.sh` uses SQLite's own online `.backup`, which folds the WAL into a
single file. If you ever copy the database by hand instead, you must copy all
three files together, `app.db`, `app.db-wal`, and `app.db-shm`: in WAL mode the
committed state is split across them, and copying `app.db` alone silently loses
whatever is still in the WAL. The script's `--raw` mode does this correctly.
For manual runs, `backup.sh` sources `/etc/litestream.env` and
`/etc/trippy-monitor.env` itself when they exist, matching the timer so the
optional S3 upload and backup dead-man ping behave the same way.

`ec2-setup.sh` installs a **systemd timer** (`trippy-backup.timer`) that runs it
daily at 04:15. Check it:

```bash
systemctl list-timers trippy-backup.timer
journalctl -u trippy-backup.service --no-pager | tail
```

#### The Litestream layer (continuous S3 replication)

Litestream streams the WAL to S3 continuously and can restore to any second
within its retention window (7 days as configured). `ec2-setup.sh` installs and
starts it **only if you set an S3 bucket**; without one it skips cleanly and the
deploy still succeeds. It runs as its own hardened `litestream.service`, as the
`trippy` service user (it only needs to read the database and write its shadow
WAL inside `/var/lib/trippy`, so it does not need root).

Turn it on by exporting the bucket before setup (or re-running setup later):

```bash
export LITESTREAM_S3_BUCKET='my-trippy-backups'
export LITESTREAM_S3_REGION='us-east-1'
export LITESTREAM_S3_PREFIX='trippy/app.db'   # optional; this is the default
sudo -E bash deploy/ec2-setup.sh
```

Config lives in `/etc/litestream.yml`; it holds **no secret** and no hardcoded
bucket. Bucket, region and prefix are `${ENV}` references expanded at runtime
from `/etc/litestream.env` (root-only). Verify replication is actually flowing:

> **Manual Litestream commands must source `/etc/litestream.env`.** The
> `litestream.service` unit gets those values from systemd's
> `EnvironmentFile=/etc/litestream.env`, but a pasted shell command does not.
> If you run bare `litestream ... -config /etc/litestream.yml`, the config's
> `${LITESTREAM_S3_BUCKET}`, `${LITESTREAM_S3_PREFIX}`, and
> `${LITESTREAM_S3_REGION}` references expand empty and Litestream fails with
> `bucket required for s3 replica`.

```bash
sudo systemctl status litestream
sudo journalctl -u litestream -f          # look for periodic "write wal" lines
sudo bash -c 'set -a; . /etc/litestream.env; set +a; litestream snapshots -config /etc/litestream.yml /var/lib/trippy/app.db'
aws s3 ls s3://my-trippy-backups/trippy/app.db/ --recursive | tail
```

The repo also includes a small helper that sources the env file, adds the
standard config flag, preserves Litestream's exit code, and fails clearly if
`/etc/litestream.env` or `/etc/litestream.yml` is missing:

```bash
sudo bash /opt/trippy/deploy/litestream-cli.sh snapshots /var/lib/trippy/app.db
```

#### Credentials: use an IAM role, and keep it separate from SES

Prefer an **EC2 instance role** so there are no long-lived keys on the box at
all. Create it once in the console:

1. IAM -> Policies -> Create policy, JSON tab, paste the policy below (edit the
   bucket name and prefix), name it `trippy-litestream-s3`.
2. IAM -> Roles -> Create role -> AWS service -> EC2, attach that policy, name
   the role `trippy-backup`.
3. EC2 -> your instance -> Actions -> Security -> Modify IAM role -> attach
   `trippy-backup`. No reboot needed.

With the role attached, set only `LITESTREAM_S3_BUCKET`/`_REGION`/`_PREFIX` and
leave the keys unset; Litestream and the AWS CLI both pick the role up from
instance metadata.

If you genuinely cannot use a role, set **dedicated** keys instead:

```bash
export LITESTREAM_ACCESS_KEY_ID='...'
export LITESTREAM_SECRET_ACCESS_KEY='...'
```

**Do not reuse the app's `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`.** Those are
the SES mail credentials, and they want a completely different, minimal policy
(`ses:SendEmail`), not S3 write. Mixing them would hand your mail key S3
permissions or your backup key mail permissions, both of which are wrong. The
scripts keep them apart on purpose: Litestream and `backup.sh` read the distinct
`LITESTREAM_*` names (which Litestream supports natively), the `trippy-backup`
timer loads only `/etc/litestream.env` and never `/etc/trippy.env`, and
`backup.sh` maps the dedicated keys into the CLI's `AWS_*` names for the one
upload call so the SES keys never leak into the backup path.

**Least-privilege IAM policy** for the backup principal (role or user). Scope it
to the one bucket and prefix; replace both names:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TrippyBackupBucketList",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::my-trippy-backups",
      "Condition": {
        "StringLike": { "s3:prefix": ["trippy/app.db/*"] }
      }
    },
    {
      "Sid": "TrippyBackupObjectRW",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::my-trippy-backups/trippy/app.db/*"
    }
  ]
}
```

`DeleteObject` is needed because Litestream enforces its own retention by
deleting expired WAL segments. If you would rather Litestream never deletes, you
can drop `DeleteObject` and delegate expiry to an S3 lifecycle rule instead, but
then set `retention` in `/etc/litestream.yml` to a very large value so it does
not try.

#### Recommended S3 bucket settings

- **Block all public access** (the default; keep it).
- **Versioning: on.** This is what protects you if a bad actor or a bug deletes
  or overwrites objects: prior versions remain.
- **Lifecycle rule**, e.g. keep current snapshots 30 days, expire noncurrent
  versions after 30 days, and abort incomplete multipart uploads after 7 days,
  so versioning does not grow unbounded.
- Same region as the instance to avoid cross-region transfer cost; add
  cross-region replication only if you want AZ/region-loss protection for the
  backups themselves.

#### Restore

`restore.sh` is the tested, safe path. It restores to a temp file, integrity-
checks it there, moves the current database aside (never deletes it), swaps the
verified copy in, fixes ownership, and restarts the service. It prints the plan
and asks for confirmation first.

```bash
# From the continuous replica, latest state:
sudo bash /opt/trippy/deploy/restore.sh --from-litestream

# From the continuous replica, a point in time (RFC3339, UTC):
sudo bash /opt/trippy/deploy/restore.sh --from-litestream --timestamp 2026-09-15T04:00:00Z

# From a gzipped daily snapshot (local, or one you pulled back from S3):
sudo bash /opt/trippy/deploy/restore.sh --from-snapshot /var/backups/trippy/app-YYYYMMDD-HHMMSS.db.gz
```

Add `--yes` to skip the prompt in automation. To pull a snapshot back from S3
first: `aws s3 cp s3://my-trippy-backups/trippy/app.db/snapshots/app-....db.gz .`

#### An untested backup is not a backup: the drill

Run this monthly. It restores real backup data into a **scratch path**, verifies
it, and touches nothing in production:

```bash
# Rehearse the Litestream restore into a throwaway file:
sudo bash /opt/trippy/deploy/restore.sh --from-litestream --output /tmp/trippy-drill.db
# It prints an integrity check (expect "ok") and per-table row counts.
# Sanity-check a couple against the live database:
sqlite3 /var/lib/trippy/app.db 'SELECT count(*) FROM users;'
sqlite3 /tmp/trippy-drill.db   'SELECT count(*) FROM users;'
# Clean up:
rm -f /tmp/trippy-drill.db
```

If the row counts match and the integrity check passes, the backup path works.
If `restore.sh --output` errors or the counts are zero, fix it now, before you
need it for real.

#### EBS-level protection (do this in the console, not in these scripts)

These are account-level actions against your AWS resources, so they are
documented, not automated.

**1. EBS snapshot policy via Data Lifecycle Manager (DLM).** EC2 -> Elastic
Block Store -> Lifecycle Manager -> Create lifecycle policy -> EBS snapshot
policy. Target the volume by a tag (tag the data volume, e.g. `Backup=trippy`),
schedule daily, retain e.g. 7 to 14 snapshots. This is a block-level backstop:
it is crash-consistent, not application-consistent, so treat it as a last resort
behind the SQLite-aware layers above.

**2. Stop the instance from taking the database with it.** By default the root
EBS volume has **delete-on-termination = true**, so terminating the instance
deletes `/var/lib/trippy` with it. Two options, in increasing order of safety:

- *Quick:* turn delete-on-termination **off** for the root volume (EC2 ->
  instance -> Storage -> the volume, or via `aws ec2
  modify-instance-attribute --block-device-mappings ...`). The volume then
  survives termination. Tradeoff: the database still shares the root volume, so
  a rebuild means detaching and reattaching the whole root disk, which is
  awkward.

- *Better: put `/var/lib/trippy` on its own EBS volume.* It survives instance
  termination, and you can detach it and reattach it to a replacement instance
  in minutes. Steps (adjust the device name; Nitro instances expose NVMe as
  `/dev/nvme1n1`):

  ```bash
  # After creating and attaching, say, a 10 GiB gp3 volume in the console:
  lsblk                                   # find the new device, e.g. /dev/nvme1n1
  sudo mkfs.ext4 -L trippy-data /dev/nvme1n1
  sudo systemctl stop trippy litestream
  sudo mkdir -p /mnt/trippy-new
  sudo mount /dev/nvme1n1 /mnt/trippy-new
  sudo rsync -aHAX /var/lib/trippy/ /mnt/trippy-new/   # copy existing data across
  sudo umount /mnt/trippy-new
  # Mount it at /var/lib/trippy and make it survive reboots via fstab (by-UUID,
  # so a changing device name does not break the mount):
  UUID=$(sudo blkid -s UUID -o value /dev/nvme1n1)
  echo "UUID=${UUID}  /var/lib/trippy  ext4  defaults,nofail  0  2" | sudo tee -a /etc/fstab
  sudo mount -a
  sudo chown -R trippy:trippy /var/lib/trippy
  sudo systemctl start trippy litestream
  ```

  Set delete-on-termination = false on this data volume too (it defaults to
  false for volumes you attach after launch, but confirm it). `nofail` keeps the
  box bootable if the volume is ever missing. The tradeoff is a little more setup
  and a second volume to pay for; the payoff is that terminating or replacing the
  instance no longer risks the data.

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

- **`Not authorized to perform sts:AssumeRoleWithWebIdentity`:** AWS rejected
  the GitHub OIDC token before any SSM command ran. Check the OIDC provider URL,
  audience, role ARN spelling, and especially the trust policy `sub` claim. If
  immutable IDs are enabled in GitHub OIDC settings, the subject is
  `repo:OWNER@<owner-id>/REPO@<repo-id>:ref:refs/heads/main`, not
  `repo:OWNER/REPO:ref:refs/heads/main`, and `repo:OWNER/REPO:*` will not match.
  To see the real subject, open CloudTrail Event history in the relevant STS
  endpoint region, filter `Event name` to `AssumeRoleWithWebIdentity`, and read
  `userIdentity.userName` on the failed event.

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
- **Place search falls back to OSM or routing falls back to OSRM:** set
  `GOOGLE_SERVER_KEY` and confirm Places API (New) and Routes API are enabled.
- **Registration never sends an email:** mail is not configured, or `MAIL_FROM`
  is on a domain the provider has not verified. Check
  `sudo journalctl -u trippy | grep -i mail`.
- **`fatal: detected dubious ownership in repository at '/opt/trippy'`:** you are
  running an older `ec2-setup.sh`/`update.sh` that invoked git as root against
  the checkout after it had been chowned to the `trippy` service user. Current
  scripts scope a `-c safe.directory=/opt/trippy` to each git call and no longer
  hit this. To unblock a box stuck on the old script right now, run the update
  once with the same scoped exception:
  ```bash
  sudo git -c safe.directory=/opt/trippy -C /opt/trippy fetch --depth 1 origin main
  sudo git -c safe.directory=/opt/trippy -C /opt/trippy reset --hard origin/main
  ```
  then re-run `sudo -E bash /opt/trippy/deploy/ec2-setup.sh` (or `update.sh`),
  which now carries the fix. Do not add a global `safe.directory` to root's git
  config; the scoped form leaves no persistent state on the box.
