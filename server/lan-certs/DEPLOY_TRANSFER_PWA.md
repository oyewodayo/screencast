# Deploying `transfer.briefcast.app` (Briefcast Transfer Pro PWA + Phone-to-Phone)

This guide covers deploying the standalone **Briefcast Transfer Pro PWA** and its lightweight
**WebRTC Phone-to-Phone signaling WebSocket** (`/p2p/ws`) onto the exact same VPS process
(`briefcast-lan-certs` on `127.0.0.1:8787`) and Cloudflare Tunnel (`briefcast-lan-tunnel`) that
already issue Briefcast's LAN HTTPS certificates.

> **Privacy note:** Zero file bytes ever pass through the VPS. `/p2p/ws` only exchanges tiny JSON
> WebRTC SDP/ICE handshakes between phones sharing the same public Wi-Fi IP or a 6-digit room
> code. All file transfers stream directly **Phone ↔ Phone** (DTLS-encrypted WebRTC DataChannel)
> or **Phone ↔ PC** (direct LAN HTTPS).

---

## Release Checklist (Run When Pushing & Tagging `v0.1.8`)

1. **Push `v0.1.8` changes to Git** so the VPS can pull the updated `server/lan-certs` and
   `src-tauri/src/services/phone_transfer_*` files.
2. **SSH into your Contabo VPS** as `briefcastlan`:
   ```sh
   ssh briefcastlan@<your-vps-ip>
   ```
3. **Pull, test, build, and install the updated binary**:
   ```sh
   cd ~/screencast
   git pull
   cd server/lan-certs
   cargo test
   cargo build --release
   install -m 755 target/release/briefcast-lan-certs ~/bin/briefcast-lan-certs
   sudo systemctl restart briefcast-lan-certs
   ```
   *(If you deploy by copying only `server/lan-certs` instead of cloning the full repo, copy the
   `phone_transfer_*` assets from `src-tauri/src/services/` into `server/lan-certs/pwa/` first —
   `build.rs` automatically reads from `../../src-tauri/src/services/` inside the repo or `./pwa/`
   when built standalone.)*

4. **Check service logs** to confirm clean startup:
   ```sh
   tail -n 30 ~/logs/certs.log
   ```
   You should see `API listening on 127.0.0.1:8787` with no errors.

5. **Add the Cloudflare Tunnel Public Hostname**:
   - Open **Cloudflare Zero Trust › Networks › Tunnels › `briefcast-lan-tunnel` › Public Hostname › Add a public hostname**:
     - **Subdomain**: `transfer`
     - **Domain**: `briefcast.app` *(if you use `briefcast.space` or another domain instead, set the GitHub Actions repository variable `BRIEFCAST_TRANSFER_PWA_URL=https://transfer.<your-domain>` before tagging the release)*
     - **Service Type**: `HTTP`
     - **URL**: `127.0.0.1:8787`
   - Save hostname. Cloudflare automatically creates the DNS record, SSL certificate, and WebSocket proxy.

6. **Verify live endpoints**:
   ```sh
   curl -i https://transfer.briefcast.app/health
   # Expected: HTTP/2 200  ...  ok

   curl -I https://transfer.briefcast.app/manifest.webmanifest
   # Expected: HTTP/2 200  content-type: application/manifest+json
   ```

7. **Quick End-to-End Smoke Test on Two Phones**:
   - Open `https://transfer.briefcast.app` on Phone A and Phone B (both on Wi-Fi) → tap **Install** → switch to **Phone to Phone** → both phones appear automatically on the Nearby Radar → send a photo/video and verify Accept/Progress/Save.
   - Put Phone B on 4G/5G → tap **Create 6-digit room code** on Phone A → enter the code on Phone B → verify direct P2P transfer across networks.
   - Close Briefcast Desktop completely → reopen the installed **Briefcast Transfer** app on your phone → verify it launches immediately offline (<600ms), and **Phone to Phone**, **Offline Outbox**, **Offline Voice-Over**, and **Teleprompter** all work.
   - Open Briefcast Desktop → scan the Transfer QR code → verify the phone auto-migrates to `https://transfer.briefcast.app` and connects directly over LAN HTTPS to your PC.

---

## Rollback

If anything ever goes wrong on the VPS:
- Removing the `transfer.briefcast.app` Public Hostname in Cloudflare Tunnel immediately reverts
  phones to staying on their local PC LAN HTTPS address (`https://192-168-…`), because the phone
  page only migrates to `transfer.briefcast.app` after `/ping` responds `200 ok`.
