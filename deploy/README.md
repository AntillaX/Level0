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

## Updating the code later

```bash
cd /opt/level0
sudo git pull
sudo npm ci --omit=dev      # only if package-lock changed
sudo systemctl restart level0
```

If only `public/` changed, restarting isn't strictly required since
the server serves static assets with `Cache-Control: no-store`, but
restarting is harmless.

## Logs

```bash
sudo journalctl -u level0 -f       # live logs
sudo journalctl -u level0 -n 200   # last 200 lines
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
