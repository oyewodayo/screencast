# briefcast-lan-certs

Gives every Briefcast install its own trusted HTTPS certificate, so "Transfer to phone" runs
encrypted with no browser warning. The app side is `src-tauri/src/services/lan_tls.rs`; the design
is explained at the top of `src/main.rs`.

In short: this service is the authoritative DNS server for one zone (e.g. `lan.withbriefs.com`)
where `192-168-1-5.<install>.lan.withbriefs.com` resolves to `192.168.1.5`, and it turns each
install's certificate request into a Let's Encrypt wildcard certificate for
`*.<install>.lan.withbriefs.com`. Each install's private key stays on that PC.

## Before you start: which domain

Using a subdomain of `withbriefs.com` works, but a **separate cheap domain is safer**:
- Anyone can register a Briefcast install and get a certificate under this zone. A page served on
  `x.<install>.lan.withbriefs.com` can set cookies for all of `.withbriefs.com`, where the Briefs
  accounts live.
- Let's Encrypt's limit of 50 new certificates per week counts per registered domain, so this
  would compete with the site's own certificates.

The steps are identical either way; just substitute the domain.

## 1. Cloudflare DNS (the parent zone)

In the Cloudflare dashboard for the domain, add two records:

| Type | Name     | Content                    | Proxy status        |
|------|----------|----------------------------|---------------------|
| A    | `ns-lan` | the VPS's public IPv4      | **DNS only** (grey) |
| NS   | `lan`    | `ns-lan.withbriefs.com`    | -                   |

The A record must be grey-clouded: Cloudflare's proxy only carries HTTP, not DNS.

## 2. Build and install on the Contabo VPS

```sh
# once: a Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source ~/.cargo/env

# copy this folder to the VPS (scp/git), then:
cd lan-certs
cargo test
cargo build --release
sudo install -m 755 target/release/briefcast-lan-certs /usr/local/bin/

sudo cp deploy/briefcast-lan-certs.env.example /etc/briefcast-lan-certs.env
sudo nano /etc/briefcast-lan-certs.env      # set LAN_DNS_BIND to the VPS public IP, check the zone
sudo cp deploy/briefcast-lan-certs.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now briefcast-lan-certs
journalctl -u briefcast-lan-certs -f
```

Open DNS in the firewall (Contabo has no external firewall by default; this is for ufw):

```sh
sudo ufw allow 53/udp
sudo ufw allow 53/tcp
```

## 3. nginx

Add `deploy/nginx-location.conf` inside the existing `withbriefs.com` server block, then
`sudo nginx -t && sudo systemctl reload nginx`. The API is now at
`https://withbriefs.com/briefcast-lan/`.

## 4. Check it

From any computer:

```sh
dig +short 192-168-1-5.abcdefabcdef.lan.withbriefs.com     # -> 192.168.1.5
dig +short 8-8-8-8.abcdefabcdef.lan.withbriefs.com         # -> nothing (public IPs are refused)
curl https://withbriefs.com/briefcast-lan/v1/health        # -> ok
```

Then run Briefcast with the service configured (PowerShell):

```powershell
$env:BRIEFCAST_LAN_TLS_API = "https://withbriefs.com/briefcast-lan"
npm run tauri dev
```

Open Transfer to phone once. The app log should show `LAN TLS: got a certificate`. With
`LAN_ACME=staging` the certificate is a test one that phones don't trust, so phones correctly stay
on HTTP. That already proves the whole issuing path works.

## 5. Go live

Set `LAN_ACME=production` in `/etc/briefcast-lan-certs.env`, then
`sudo systemctl restart briefcast-lan-certs`. On the desktop, delete the test certificate so a real
one is fetched: `%APPDATA%\com.withbriefs.briefcast\lan_tls\`. Scanning the QR code now lands the
phone on `https://192-168-…` with a padlock.

For release builds, set the GitHub Actions variable `BRIEFCAST_LAN_TLS_API` (see
`.github/workflows/release.yml`).

## Limits and fallbacks

- **Capacity:** Let's Encrypt allows 50 *new* certificates per registered domain per 7 days,
  refilling one every ~3.4 hours. Renewals of the same name are exempt, so the service only counts
  an install's first certificate against `LAN_WEEKLY_CAP` (default 45). The app also only asks
  once a phone has actually been paired. Installs over the cap get a `Retry-After`, wait their
  turn, and keep transferring over plain HTTP until then.
- **Raising it:** file Let's Encrypt's rate-limit adjustment request
  (https://isrg.formstack.com/forms/rate_limit_adjustment_request) well before launch. It takes a
  few weeks and is intended for integrations like this one. Then raise `LAN_WEEKLY_CAP` to match.
  The Public Suffix List is *not* a route: it rejects entries whose purpose is getting around
  rate limits.
- **Fallback:** the phone page only switches to HTTPS after checking that the name resolves and
  connects from the phone, so routers with DNS-rebinding protection and hotspots with no internet
  keep working over plain HTTP.
- **Back up** `/var/lib/briefcast-lan-certs` (the install registry and the ACME account).
