#!/bin/sh
# One-time root setup for running briefcast-lan-certs under its own unprivileged user, with no
# nginx and nothing shared with other sites on this server. Run as root:
#
#     sh root-once.sh '<ssh public key allowed to log in as briefcastlan>'
#
# Self-contained (the unit files are inside), so it can be pasted into a root shell as is.
#
# After this, everything else (building, configuring, upgrading, restarting) is done as
# briefcastlan. Root is only needed again to change the two unit files.
set -eu

U=briefcastlan
H=/home/$U
# Defaults to the deploying PC's key.
KEY=${1:-'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGrXio8c8dguPTT06PAjs2tsbrZ8skxDlCtmTNwmztpH oyewodayo@gmail.com'}

[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }

# The user: no password, no sudo beyond the restart rule below.
id "$U" >/dev/null 2>&1 || adduser --disabled-password --gecos "Briefcast LAN certificates" "$U"
install -d -m 700 -o "$U" -g "$U" "$H/.ssh" "$H/bin" "$H/data" "$H/logs"
if [ -n "$KEY" ]; then
    touch "$H/.ssh/authorized_keys"
    grep -qxF "$KEY" "$H/.ssh/authorized_keys" || echo "$KEY" >> "$H/.ssh/authorized_keys"
    chown "$U:$U" "$H/.ssh/authorized_keys"; chmod 600 "$H/.ssh/authorized_keys"
fi

# A C compiler for the crypto crate. Rust itself is installed per user (rustup), not system-wide.
command -v cc >/dev/null 2>&1 || { apt-get update && apt-get install -y build-essential pkg-config; }

# The two services. They run as briefcastlan; root only owns the unit files.
cat > /etc/systemd/system/briefcast-lan-certs.service <<'EOF'
[Unit]
Description=Briefcast LAN certificates (DNS + ACME for phone transfer HTTPS)
After=network-online.target
Wants=network-online.target

[Service]
User=briefcastlan
Group=briefcastlan
EnvironmentFile=/home/briefcastlan/briefcast-lan-certs.env
ExecStart=/home/briefcastlan/bin/briefcast-lan-certs
Restart=always
RestartSec=3
StandardOutput=append:/home/briefcastlan/logs/certs.log
StandardError=append:/home/briefcastlan/logs/certs.log

# Unprivileged, but allowed to bind port 53. Can write only its data and log folders.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/briefcastlan/data /home/briefcastlan/logs
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/briefcast-lan-tunnel.service <<'EOF'
[Unit]
Description=Cloudflare Tunnel for the Briefcast LAN certificate API (certs.briefcast.space -> 127.0.0.1:8787)
After=network-online.target
Wants=network-online.target

[Service]
User=briefcastlan
Group=briefcastlan
# TUNNEL_TOKEN=... from the Cloudflare dashboard (Zero Trust > Networks > Tunnels).
EnvironmentFile=/home/briefcastlan/tunnel.env
ExecStart=/home/briefcastlan/bin/cloudflared tunnel --no-autoupdate run
Restart=always
RestartSec=5
StandardOutput=append:/home/briefcastlan/logs/tunnel.log
StandardError=append:/home/briefcastlan/logs/tunnel.log

NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/briefcastlan/logs
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable briefcast-lan-certs briefcast-lan-tunnel

# Lets briefcastlan restart/stop only its own two services - nothing else.
cat > /etc/sudoers.d/briefcastlan <<'EOF'
briefcastlan ALL=(root) NOPASSWD: /usr/bin/systemctl restart briefcast-lan-certs, /usr/bin/systemctl stop briefcast-lan-certs, /usr/bin/systemctl restart briefcast-lan-tunnel, /usr/bin/systemctl stop briefcast-lan-tunnel
EOF
chmod 440 /etc/sudoers.d/briefcastlan
visudo -cf /etc/sudoers.d/briefcastlan

# DNS has to be reachable from the internet on port 53.
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw allow 53/udp && ufw allow 53/tcp
fi

echo
echo "Anything already on port 53 (must be nothing but systemd-resolved on 127.0.0.53/54):"
ss -lntup | awk '$5 ~ /:53$/' || true
echo
echo "Done. Now log in as $U."
