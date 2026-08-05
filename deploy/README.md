# Deploy — Level 0 on platformvv.com

Deploys alongside Platform and Auction on the same DigitalOcean droplet.

## What this adds

- A new Node service on **port 3200** (binds to `127.0.0.1`)
- A new nginx `/level0/` route
- A new tile on the landing hub (deployed from the Auction repo's
  `deploy/hub/index.html`)

## One-time setup on the droplet

SSH into the droplet, then:

```bash
# 1. Clone the repo into /opt
sudo git clone https://github.com/AntillaX/Level0.git /opt/level0
cd /opt/level0
sudo npm ci --omit=dev

# 2. Install the systemd unit
sudo cp deploy/level0.service /etc/systemd/system/level0.service
sudo systemctl daemon-reload
sudo systemctl enable --now level0
sudo systemctl status level0   # should show "active (running)"

# 3. Add the nginx route
#    Open the existing site config:
sudo nano /etc/nginx/sites-available/vv
#    Paste the contents of deploy/nginx-snippet.conf inside the
#    server { ... } block, next to the /auction/ block.

# 4. Test & reload nginx
sudo nginx -t && sudo systemctl reload nginx

# 5. Refresh the landing hub (from the Auction repo)
sudo cp /opt/auction/deploy/hub/index.html /var/www/vv/index.html
```

Visit https://platformvv.com — there should be a third tile, **Level 0**.
Click in, create a game, share the 4-letter code with a friend.

## Auto-deploy

Once enabled, anything merged to `main` is live within about two
minutes, without anyone touching the droplet.

A systemd timer runs `deploy/deploy.sh` every two minutes and the
script decides whether there's anything to do:

- **No new commits** — exits immediately. It does *not* restart the
  service, so a quiet tick costs a few KB and nothing else.
- **A game is in progress** — defers and tries again next tick. Rooms
  live in memory, so restarting mid-tournament would destroy it. After
  45 minutes of waiting it deploys anyway, so a table left open
  overnight can't block a deploy forever.
- **`package-lock.json` changed** — reinstalls dependencies first.

"In progress" comes from `GET /api/status` on the local port, which
reports room and player counts only.

### Enabling it

Doable entirely from a phone via the DigitalOcean web console
(**Droplets → your droplet → Access → Launch Droplet Console**):

```bash
cd /opt/level0
sudo git pull                      # get deploy.sh + the timer units
sudo cp deploy/level0-autodeploy.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now level0-autodeploy.timer
```

Check it:

```bash
systemctl list-timers level0-autodeploy   # next run time
sudo systemctl start level0-autodeploy    # force a check right now
journalctl -u level0-autodeploy -n 30     # what it did
```

### Turning it off

```bash
sudo systemctl disable --now level0-autodeploy.timer
```

Deploys go back to being manual, with the same script.

### Tuning

Environment overrides on the service unit
(`sudo systemctl edit level0-autodeploy`):

- `DEPLOY_DEFER_LIMIT_MIN` — how long to wait out a live game (45)
- `LEVEL0_PORT` — where to ask about status (3200)

## Updating by hand

Always available, whether or not the timer is enabled:

```bash
/opt/level0/deploy/deploy.sh
```

It fast-forwards `/opt/level0` to the latest `main`, reinstalls
dependencies only if `package-lock.json` changed in the pull, restarts
`level0.service`, and verifies the service came back up.

## Logs

```bash
sudo journalctl -u level0 -f              # live app logs
sudo journalctl -u level0 -n 200          # last 200 lines
sudo journalctl -u level0-autodeploy -f   # what auto-deploy is doing
```

## Layout reminder

```
/opt/level0/                ← cloned from github.com/AntillaX/Level0
  server.js
  server/
  public/

/etc/systemd/system/
  level0.service            ← copied from deploy/level0.service

/etc/nginx/sites-available/vv
  ... existing /auction/ block ...
  ... existing /platform/ block ...
  ... new /level0/ block from deploy/nginx-snippet.conf ...
```

## Ports

- `8080` — Platform relay
- `3100` — Auction
- **`3200` — Level 0 (new)**

All bound to `127.0.0.1`, proxied through nginx.
