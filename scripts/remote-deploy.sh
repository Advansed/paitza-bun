#!/bin/bash
# Remote side for paitza-bun deploy on paitza.com
# Invoked via: printf %s <b64> | base64 -d | bash -s -- setup|publish
set -euo pipefail

APP_DIR="${HOME}/paitza-bun"
STAGING="${HOME}/paitza-bun-staging"
SERVICE_NAME="paitza-bun"
MODE="${1:-setup}"

have_sudo() {
  sudo -n true 2>/dev/null
}

ensure_bun() {
  export PATH="${HOME}/.bun/bin:${PATH}"
  if command -v bun >/dev/null 2>&1; then
    echo "BUN_OK $(command -v bun) ($(bun --version))"
    return 0
  fi
  echo "BUN_MISSING — устанавливаю…"
  curl -fsSL https://bun.sh/install | bash
  export PATH="${HOME}/.bun/bin:${PATH}"
  if ! command -v bun >/dev/null 2>&1; then
    echo "Не удалось установить bun"
    exit 1
  fi
  echo "BUN_INSTALLED $(bun --version)"
}

bun_bin() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return
  fi
  if [ -x "${HOME}/.bun/bin/bun" ]; then
    echo "${HOME}/.bun/bin/bun"
    return
  fi
  echo "bun"
}

write_systemd_unit() {
  local bun
  bun="$(bun_bin)"
  local unit_body
  # PATH нужен: `bun run start` снова вызывает bun из скрипта package.json
  unit_body=$(cat <<EOF
[Unit]
Description=paitza-bun API
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=PATH=${HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-${APP_DIR}/.env
ExecStart=${bun} ${APP_DIR}/src/index.ts
Restart=always
RestartSec=3
User=ubuntu
Group=ubuntu

[Install]
WantedBy=multi-user.target
EOF
)

  # Не enable, если уже крутится PM2 — иначе unit будет биться за :3030
  local pm2_running=0
  if command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null | grep -q '"status":"online"'; then
    pm2_running=1
  fi

  if have_sudo; then
    echo "${unit_body}" | sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null
    sudo systemctl daemon-reload
    if [ "${pm2_running}" = "0" ]; then
      sudo systemctl enable "${SERVICE_NAME}.service"
    else
      sudo systemctl disable "${SERVICE_NAME}.service" 2>/dev/null || true
      sudo systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true
      echo "SYSTEMD_DISABLED (pm2 online)"
    fi
    echo "SYSTEMD_OK /etc/systemd/system/${SERVICE_NAME}.service"
    return 0
  fi

  mkdir -p "${HOME}/.config/systemd/user"
  echo "${unit_body}" | sed "s|^User=ubuntu$||; s|^Group=ubuntu$||" >"${HOME}/.config/systemd/user/${SERVICE_NAME}.service"
  systemctl --user daemon-reload || true
  if [ "${pm2_running}" = "0" ]; then
    systemctl --user enable "${SERVICE_NAME}.service" || true
    if have_sudo; then
      sudo loginctl enable-linger ubuntu || true
    fi
  fi
  echo "SYSTEMD_USER_OK ${HOME}/.config/systemd/user/${SERVICE_NAME}.service"
}

restart_service() {
  export PATH="${HOME}/.bun/bin:${PATH}"

  # PM2 часто уже держит :3030 — сначала его (иначе systemd получит EADDRINUSE)
  if command -v pm2 >/dev/null 2>&1; then
    local pm2_name=""
    for candidate in "${SERVICE_NAME}" paitza index; do
      if pm2 describe "${candidate}" >/dev/null 2>&1; then
        pm2_name="${candidate}"
        break
      fi
    done
    if [ -z "${pm2_name}" ] && pm2 jlist 2>/dev/null | grep -q '"name"'; then
      pm2_name="$(pm2 jlist 2>/dev/null | bun -e '
        const apps = JSON.parse(await Bun.stdin.text());
        const hit = apps.find((a) => String(a.pm2_env?.pm_cwd || "").includes("paitza-bun"));
        if (hit) process.stdout.write(hit.name);
      ' 2>/dev/null || true)"
    fi
    if [ -n "${pm2_name}" ]; then
      if have_sudo; then
        sudo systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true
      fi
      systemctl --user stop "${SERVICE_NAME}.service" 2>/dev/null || true
      pm2 restart "${pm2_name}"
      pm2 save || true
      echo "RESTARTED pm2 ${pm2_name}"
      return 0
    fi
  fi

  if have_sudo && systemctl list-unit-files "${SERVICE_NAME}.service" 2>/dev/null | grep -q "${SERVICE_NAME}"; then
    sudo systemctl restart "${SERVICE_NAME}.service"
    sudo systemctl --no-pager --full status "${SERVICE_NAME}.service" | head -20 || true
    echo "RESTARTED systemd ${SERVICE_NAME}"
    return 0
  fi

  if systemctl --user list-unit-files "${SERVICE_NAME}.service" 2>/dev/null | grep -q "${SERVICE_NAME}"; then
    systemctl --user restart "${SERVICE_NAME}.service"
    systemctl --user --no-pager --full status "${SERVICE_NAME}.service" | head -20 || true
    echo "RESTARTED systemd --user ${SERVICE_NAME}"
    return 0
  fi

  # Fallback: kill previous bun process for this app and start in background
  pkill -f "${APP_DIR}/src/index" 2>/dev/null || true
  pkill -f "bun.*${APP_DIR}" 2>/dev/null || true
  sleep 1
  mkdir -p "${APP_DIR}/logs"
  (
    cd "${APP_DIR}"
    nohup "$(bun_bin)" "${APP_DIR}/src/index.ts" >>"${APP_DIR}/logs/app.log" 2>&1 &
    echo $! >"${APP_DIR}/logs/app.pid"
  )
  echo "RESTARTED nohup pid=$(cat "${APP_DIR}/logs/app.pid" 2>/dev/null || echo '?')"
}

sync_staging_to_app() {
  if [ ! -d "${STAGING}" ]; then
    echo "MISSING staging ${STAGING}"
    exit 1
  fi
  mkdir -p "${APP_DIR}"

  # Preserve server .env
  local env_backup=""
  if [ -f "${APP_DIR}/.env" ]; then
    env_backup="$(mktemp)"
    cp -a "${APP_DIR}/.env" "${env_backup}"
  fi

  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude '.env' \
      --exclude '.env.*' \
      --exclude 'node_modules' \
      --exclude 'logs' \
      --exclude '.git' \
      "${STAGING}/" "${APP_DIR}/"
  else
    # crude fallback without deleting extras
    cp -a "${STAGING}/." "${APP_DIR}/"
  fi

  if [ -n "${env_backup}" ] && [ -f "${env_backup}" ]; then
    cp -a "${env_backup}" "${APP_DIR}/.env"
    rm -f "${env_backup}"
    echo "ENV_PRESERVED"
  elif [ ! -f "${APP_DIR}/.env" ]; then
    echo "WARN: нет ${APP_DIR}/.env — создайте вручную на сервере"
  fi
}

install_and_generate() {
  export PATH="${HOME}/.bun/bin:${PATH}"
  cd "${APP_DIR}"
  ensure_bun

  if [ -f bun.lockb ] || [ -f bun.lock ]; then
    bun install --frozen-lockfile || bun install
  elif [ -f package-lock.json ]; then
    bun install
  else
    bun install
  fi

  echo "PRISMA_GENERATE…"
  bunx prisma generate
  echo "PRISMA_OK"

  # Опционально: PAITZA_DB_PUSH=1 npm run deploy — накатить схему (currency и т.п.)
  if [ "${PAITZA_DB_PUSH:-0}" = "1" ]; then
    echo "PRISMA_DB_PUSH…"
    bunx prisma db push
    echo "PRISMA_DB_PUSH_OK"
  fi
}

case "${MODE}" in
  setup)
    ensure_bun
    mkdir -p "${APP_DIR}"
    write_systemd_unit
    echo "SETUP_DONE ${APP_DIR}"
    ;;
  publish)
    ensure_bun
    sync_staging_to_app
    install_and_generate
    write_systemd_unit
    restart_service
    echo "PUBLISH_DONE ${APP_DIR}"
    ;;
  *)
    echo "usage: $0 setup|publish"
    exit 1
    ;;
esac
