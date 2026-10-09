#!/usr/bin/env bash
# Equiply – Installation & Update auf einem Debian/Ubuntu-Server
#
#   Mit eigener Domain + automatischem HTTPS (empfohlen):
#     sudo bash deploy/install.sh equiply.meinverein.de
#
#   Ohne Domain (nur HTTP über http://SERVER-IP:3000):
#     sudo bash deploy/install.sh
#
# Erneut ausführen = Update. Konfiguration und Datenbank bleiben erhalten.
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR=/opt/equiply
DATA_DIR=/var/lib/equiply
ENV_FILE=/etc/equiply/equiply.env
SERVICE_USER=equiply
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

info() { echo -e "\n\033[1;34m==> $*\033[0m"; }
fail() { echo -e "\033[1;31mFehler: $*\033[0m" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Bitte als root ausführen (sudo bash deploy/install.sh ...)."
command -v apt-get >/dev/null || fail "Dieses Skript unterstützt nur Debian/Ubuntu (apt)."
[[ -f "$SRC_DIR/server.js" ]] || fail "server.js nicht gefunden – Skript aus dem Equiply-Ordner heraus starten."

export DEBIAN_FRONTEND=noninteractive

info "Systempakete installieren"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg rsync sqlite3 >/dev/null

info "Node.js prüfen"
if ! command -v node >/dev/null || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=12)?0:1)'; then
    echo "Installiere Node.js 22 LTS ..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
fi
echo "Node.js $(node -v)"

info "Benutzer und Ordner anlegen"
id "$SERVICE_USER" &>/dev/null || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 750 "$DATA_DIR" "$DATA_DIR/backups"
install -d -m 755 "$APP_DIR"
install -d -m 750 -g "$SERVICE_USER" /etc/equiply

info "Programmdateien nach $APP_DIR kopieren"
rsync -a --delete \
    --exclude .git --exclude node_modules --exclude data --exclude .env --exclude '*.db*' --exclude test \
    "$SRC_DIR/" "$APP_DIR/"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
chown -R root:root "$APP_DIR"   # Code gehört root, der Dienst kann ihn nur lesen

if [[ -n "$DOMAIN" ]]; then HOST=127.0.0.1; else HOST=0.0.0.0; fi

NEW_SUPERADMIN_PW=""
if [[ ! -f "$ENV_FILE" ]]; then
    info "Konfiguration erzeugen ($ENV_FILE)"
    NEW_SUPERADMIN_PW="$(openssl rand -base64 18 2>/dev/null || node -e "console.log(require('crypto').randomBytes(18).toString('base64'))")"
    cat > "$ENV_FILE" <<EOF
PORT=3000
HOST=$HOST
DB_PATH=$DATA_DIR/equiply.db
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
JWT_EXPIRES_IN=24h
SUPERADMIN_USER=superadmin
SUPERADMIN_PASSWORD=$NEW_SUPERADMIN_PW
EOF
else
    echo "Bestehende Konfiguration bleibt erhalten."
    sed -i "s/^HOST=.*/HOST=$HOST/" "$ENV_FILE"
    grep -q '^HOST=' "$ENV_FILE" || echo "HOST=$HOST" >> "$ENV_FILE"
fi
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

info "Systemdienst einrichten"
cat > /etc/systemd/system/equiply.service <<EOF
[Unit]
Description=Equiply
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=NODE_ENV=production
ExecStart=$(command -v node) $APP_DIR/server.js
Restart=on-failure
RestartSec=3

# Absicherung
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable equiply >/dev/null 2>&1
systemctl restart equiply

info "Tägliches Datenbank-Backup einrichten ($DATA_DIR/backups, 14 Tage)"
cat > /etc/cron.daily/equiply-backup <<EOF
#!/bin/sh
[ -f $DATA_DIR/equiply.db ] || exit 0
sqlite3 $DATA_DIR/equiply.db ".backup '$DATA_DIR/backups/equiply-\$(date +%F).db'"
chown $SERVICE_USER:$SERVICE_USER $DATA_DIR/backups/*.db
find $DATA_DIR/backups -name 'equiply-*.db' -mtime +14 -delete
EOF
chmod 755 /etc/cron.daily/equiply-backup

if [[ -n "$DOMAIN" ]]; then
    info "Caddy (Webserver mit automatischem HTTPS) für $DOMAIN einrichten"
    if ! command -v caddy >/dev/null; then
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
        apt-get update -qq
        apt-get install -y -qq caddy >/dev/null
    fi
    install -d /etc/caddy/conf.d
    cat > /etc/caddy/conf.d/equiply.caddy <<EOF
$DOMAIN {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}
EOF
    # Standard-Caddyfile (Platzhalterseite) durch einen Import ersetzen, eigene Caddyfiles nur ergänzen
    if [[ ! -f /etc/caddy/Caddyfile ]] || grep -q '/usr/share/caddy' /etc/caddy/Caddyfile; then
        echo 'import /etc/caddy/conf.d/*.caddy' > /etc/caddy/Caddyfile
    elif ! grep -q 'conf.d/\*.caddy' /etc/caddy/Caddyfile; then
        echo 'import /etc/caddy/conf.d/*.caddy' >> /etc/caddy/Caddyfile
    fi
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
    systemctl enable caddy >/dev/null 2>&1
    systemctl reload caddy 2>/dev/null || systemctl restart caddy
fi

if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
    info "Firewall (ufw) freigeben"
    if [[ -n "$DOMAIN" ]]; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; else ufw allow 3000/tcp >/dev/null; fi
fi

sleep 2
systemctl is-active --quiet equiply || { journalctl -u equiply -n 30 --no-pager; fail "Dienst startet nicht (Log siehe oben)."; }

info "Fertig!"
if [[ -n "$DOMAIN" ]]; then
    echo "Equiply läuft unter:  https://$DOMAIN"
    echo "(Die Domain muss per DNS-A-Eintrag auf diesen Server zeigen, dann holt Caddy das Zertifikat automatisch.)"
else
    IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    echo "Equiply läuft unter:  http://${IP:-SERVER-IP}:3000"
    echo "Hinweis: ohne Domain gibt es kein HTTPS – Passwörter gehen unverschlüsselt übers Netz."
fi
if [[ -n "$NEW_SUPERADMIN_PW" ]]; then
    echo
    echo "Superadmin-Zugang (im Login-Fenster 5x schnell auf den Schriftzug \"Equiply.\" klicken):"
    echo "   Benutzer: superadmin"
    echo "   Passwort: $NEW_SUPERADMIN_PW"
    echo "   (steht auch in $ENV_FILE)"
fi
echo
echo "Nützliche Befehle:"
echo "   systemctl status equiply      Status"
echo "   journalctl -u equiply -f      Live-Log"
echo "   nano $ENV_FILE   Konfiguration (danach: systemctl restart equiply)"
