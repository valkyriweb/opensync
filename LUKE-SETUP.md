# Luke OpenSync setup

Purpose: make this OpenSync instance the central dashboard for Luke's agent sessions across devices, runtimes, harnesses, and action runners.

## Current state

- Local checkout: `~/Projects/personal/opensync`
- Upstream: `https://github.com/waynesutton/opensync`
- Build verified: `npm run build`
- Convex dev project created: team `luke-2e292`, project `opensync`, deployment `good-aardvark-553`.
- Frontend dev URL: `http://localhost:5173`.
- Secrets saved in 1Password item: `OpenSync self-host`.
- WorkOS AuthKit app exists; `http://localhost:5173/callback` is configured as a redirect URI.
- Auth fixed locally: WorkOS code exchange is routed through Vite proxy `/user_management -> https://api.workos.com`, and `AuthKitProvider` points at the current local origin via `apiHostname`/`port`/`https`.
- OpenSync API key generated, rotated after accidental page-text exposure, and saved in 1Password item `OpenSync self-host` as `opensync_api_key`.

## Convex hosting: cloud now → self-host on lue-kube (PLANNED)

**Status: deferred. Keep Convex on the cloud version for now.** The frontend is being
deployed to lue-kube at `opensync.bermont.digital` (tailnet-only, WorkOS-gated) while
`VITE_CONVEX_URL` still points at the managed deployment `good-aardvark-553.convex.cloud`.
Nothing about the cloud backend changes yet.

**Goal:** move the Convex backend itself off Convex Cloud and self-host it on lue-kube, to
match the "private self-host, not hosted" posture below and own the session data end-to-end.

**Migration checklist (do when ready — verify against https://docs.convex.dev/self-hosting first):**

1. Deploy the self-hosted Convex backend + dashboard to lue-kube (`ghcr.io/get-convex/convex-backend`
   + `convex-dashboard`), backed by Postgres (cluster PG or a dedicated instance) and a PVC for storage.
   Generate the instance/admin secret; store via Sealed Secret in the `opensync`/`convex` namespace.
2. Expose two origins the way Convex Cloud splits them: the API/WebSocket origin (the `.convex.cloud`
   equivalent, e.g. `convex.opensync.bermont.digital`) and the HTTP-actions/sync origin (the
   `.convex.site` equivalent the sync plugins POST to). Wire both through ingress-nginx + cert-manager.
3. Set backend env on the self-hosted deployment: `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, optional
   `OPENAI_API_KEY`. Confirm `convex/auth.config.ts` still validates WorkOS JWTs against the WorkOS JWKS.
4. Push schema + functions: `npx convex deploy` against the self-hosted URL with the admin key.
5. Migrate data: `npx convex export` from cloud → `npx convex import` into self-hosted. Plan a cutover
   window; this is the irreversible step — verify row counts and a few sessions before decommissioning.
6. Rebuild the frontend image with the new `VITE_CONVEX_URL` (+ matching `VITE_REDIRECT_URI`) and redeploy
   to lue-kube.
7. Repoint every sync client to the new URL + fresh `osk_` key: `~/.config/pi-opensync-plugin/config.json`
   (and `pi-opensync-plugin` fork), `codex-sync`, `claude-code-sync`. Regenerate API keys.
8. Verify ingestion end-to-end, then decommission the `good-aardvark-553` cloud deployment.

**Risks:** Convex self-hosting maturity + Postgres ops, export/import fidelity, sync-client cutover
(plugins go silent until repointed — the fork's circuit breaker keeps that from blocking turns), and
WorkOS JWKS reachability from in-cluster.

## What OpenSync is good for

OpenSync is a session/activity dashboard, not a runtime process monitor. We will use it as:

- canonical searchable transcript/session telemetry store
- eval export surface
- token/model/tool usage dashboard
- cross-CLI session lookup across Pi, Codex, Claude Code, Cursor/OpenCode if used

Runtime inventory and health still live in `my-pi/docs/pi-stack-inventory.md`, launchd/k8s, babysitter, Opik/SigNoz, and ClawSweeper.

## Credentials needed

### Convex

Create a Convex project from this repo or run:

```bash
npx convex dev
```

Set backend env:

```bash
npx convex env set WORKOS_API_KEY <workos_sk>
npx convex env set WORKOS_CLIENT_ID <workos_client_id>
# optional semantic search
npx convex env set OPENAI_API_KEY <openai_key>
```

### WorkOS

Create WorkOS AuthKit app and add redirects:

- `http://localhost:5173/callback`
- production URL later, e.g. `https://opensync.<domain>/callback`

### Frontend local env

Create `.env.local` or restore from 1Password item `OpenSync self-host`:

```bash
VITE_CONVEX_URL=https://good-aardvark-553.convex.cloud
VITE_WORKOS_CLIENT_ID=<from op item>
VITE_REDIRECT_URI=http://localhost:5173/callback
WORKOS_COOKIE_PASSWORD=<from op item>
```

Generate cookie password:

```bash
openssl rand -base64 32
```

## Run locally

Terminal 1:

```bash
npx convex dev
```

Terminal 2:

```bash
npm run dev
```

Open: `http://localhost:5173`

API key is already generated and saved in 1Password item `OpenSync self-host`. Plugins use this key.

## Always-on — now on lue-kube (launchd retired 2026-06-19)

The dashboard now runs on the lue-kube cluster at `https://opensync.bermont.digital`
(tailnet-only, WorkOS-gated, TLS via cert-manager). The old local launchd agent
(`com.luke.opensync-dashboard`, `vite` on `localhost:5173`) was **retired** — booted
out and its plist + launcher deleted (plist backed up to `/tmp`) — since the cluster
build serves the same cloud Convex backend. Historical local-agent details below.

- Agent label: `com.luke.opensync-dashboard`
- Plist: `~/Library/LaunchAgents/com.luke.opensync-dashboard.plist`
- Launcher: `~/.local/bin/opensync-dashboard.sh` (runs `vite --host 127.0.0.1 --port 5173 --strictPort`)
- Logs: `~/Library/Logs/opensync-dashboard.{out,err}.log`

Only the **frontend** is supervised. The Convex backend is cloud-hosted (`good-aardvark-553.convex.cloud`) and sync plugins post straight to the cloud, so `convex dev` is **not** needed for the dashboard to work — run it manually only when deploying/changing Convex functions.

Manage it:

```bash
launchctl kickstart -k gui/$(id -u)/com.luke.opensync-dashboard   # restart
launchctl bootout   gui/$(id -u)/com.luke.opensync-dashboard      # stop + unload
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.luke.opensync-dashboard.plist  # load
launchctl print     gui/$(id -u)/com.luke.opensync-dashboard | grep -E 'state|pid'        # status
```

## Ingestion rollout plan

**Status (2026-06-19): Phase 1 wired on the MacBook.** All three workstation harnesses sync:
`pi` (pi-opensync-plugin fork, `source=pi:macbook`), Claude Code (claude-code-sync hooks
hand-merged into `~/.claude/settings.json`), and Codex (codex-sync via launchd timer
`com.luke.codex-sync` — *not* `codex-sync setup`, which would clobber Codex's Computer-Use
`notify` slot). Grouping convention is **`source = harness:env`**; the `pi-opensync-plugin`
fork makes `source` configurable (`PI_OPENSYNC_SOURCE`/`OPENSYNC_SOURCE`), and `codex-sync` /
`claude-code-sync` get the same in Phase 2 (they hardcode it upstream). **Posture: metadata-only**
— `syncToolCalls=false` + `syncThinking=false` on all three. Remaining: Mac Mini (offline at
audit), and the lue-kube pods (openclaw/multica/paperclip/ClawSweeper) which need the redaction
filter below before tool-call sync. Full fleet matrix: `~/Projects/agent-scripts/RUNTIMES.md`
§ OpenSync session sync.

### Phase 1 — workstation session sync

Install/configure only after local dashboard + API key works.

#### Pi interactive on MacBook

Use `pi-opensync-plugin`, but do not enable thinking sync.

Config options:

```bash
export PI_OPENSYNC_CONVEX_URL=https://<deployment>.convex.cloud
export PI_OPENSYNC_API_KEY=osk_...
export PI_OPENSYNC_THINKING=false
export PI_OPENSYNC_TOOL_CALLS=true
```

Risk: plugin uploads prompts, assistant text, tool call args, and tool results. Keep hosted/private data posture in mind.

#### Codex CLI

```bash
npm install -g codex-sync
codex-sync login
codex-sync sync
```

Config is under `~/.config/codex-sync/config.json` in the package we inspected.

#### Claude Code

```bash
npm install -g claude-code-sync
claude-code-sync login
claude-code-sync sync
```

Config path in docs says `~/.claude-code-sync/config.json`; package also supports env vars.

### Phase 2 — headless runtimes / harnesses

Target runtimes from `my-pi/docs/pi-runtime-profiles.md`:

| Runtime | Strategy |
|---|---|
| MacBook Pi interactive | Pi plugin |
| Mac Mini Pi | Pi plugin with source/env tag once active |
| OpenClaw pi-harness | side-load/fork Pi plugin with harness metadata |
| ClawSweeper ARC runners / `my-pi-actions` | install Pi plugin or post direct `/sync/session` events from runner wrapper |
| paperclip pod | prefer direct server-side sync or pod profile plugin only after redaction policy |
| multica-runtime pod | prefer direct server-side sync or wrapper metadata sync |
| Claude Code | claude-code-sync |
| Codex | codex-sync |

### Phase 3 — metadata fork

OpenSync's schema accepts arbitrary `source` strings but does not first-class these fields yet:

- device / host
- environment: `macbook`, `mac-mini`, `lue-kube`, `bermont-kube`, `github-actions`
- harness: `pi`, `pi-harness`, `codex`, `claude-code`, `clawsweeper`, `paperclip`, `multica`
- git repo / SHA / branch
- GitHub workflow run id / URL
- OpenClaw session id
- Paperclip issue/run id

For Luke's use, fork OpenSync and add these fields to `sessions` plus filters in Sessions/Analytics. Until then, encode them in `source`, `projectName`, and title.

Recommended source naming before schema fork:

- `pi:macbook:interactive`
- `pi:mac-mini:pod`
- `pi:lue-kube:paperclip`
- `pi:lue-kube:multica`
- `pi:openclaw:harness`
- `pi:clawsweeper:actions`
- `codex:macbook`
- `claude-code:macbook`

## Security posture

Default to private self-host, not hosted OpenSync.

Do not enable thinking sync.

Tool calls/results can contain secrets or private repo data. For action runners and pods, prefer a forked/filtered sync client that redacts:

- env vars
- tokens/API keys
- `.env` contents
- 1Password/op output
- kube secrets
- SSH keys
- private customer content

## Next concrete steps

1. Create Convex project.
2. Create WorkOS AuthKit app and redirects.
3. Fill `.env.local`.
4. Run `npx convex dev` + `npm run dev`.
5. Sign in and generate `osk_...` API key.
6. Configure Pi plugin on MacBook only.
7. Verify sessions appear.
8. Fork plugin/backend metadata once baseline works.
