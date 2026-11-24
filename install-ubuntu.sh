#!/usr/bin/env bash
set -Eeuo pipefail

APP_ID="zemsky-circle"
INSTALL_ROOT="/opt/zemsky-circle"
APP_DIR="/opt/zemsky-circle/app"
CONFIG_DIR="/etc/zemsky-circle"
ENV_FILE="/etc/zemsky-circle/compose.env"
REPO_FILE="/etc/zemsky-circle/repository-url"
DEFAULT_REPO_URL="https://github.com/HACKYASHER/zemsky-circle.git"
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MODE=""
SITE_DOMAIN=""
APP_HTTP_PORT=""
ACCESS_MODE=""
PROXY_KIND=""
PROXY_HTTPS_READY=0
SSH_PORT_FROM_SESSION=""
ORIGINAL_ARGS=("$@")

usage() {
  cat <<'HELP'
Установщик онлайн-игры «Земский круг» для Ubuntu/Debian.

Запуск:
  sudo bash install-ubuntu.sh          меню установки, обновления и удаления
  sudo bash install-ubuntu.sh --install
  sudo bash install-ubuntu.sh --update
  sudo bash install-ubuntu.sh --status
  sudo bash install-ubuntu.sh --remove
HELP
}

while (($#)); do
  case "$1" in
    --install) MODE="install" ;;
    --update) MODE="update" ;;
    --status) MODE="status" ;;
    --remove) MODE="remove" ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Неизвестный параметр: $1"; usage; exit 2 ;;
  esac
  shift
done

if [[ -n "${SSH_CONNECTION:-}" ]]; then
  read -r _ssh_client _ssh_client_port _ssh_server _ssh_server_port <<< "$SSH_CONNECTION"
  [[ "${_ssh_server_port:-}" =~ ^[0-9]+$ ]] && SSH_PORT_FROM_SESSION="$_ssh_server_port"
fi

if ((EUID != 0)); then
  command -v sudo >/dev/null 2>&1 || { echo "Для установки нужны права администратора (sudo)."; exit 1; }
  exec sudo env "INSTALL_SSH_PORT=${SSH_PORT_FROM_SESSION:-}" bash "$0" "${ORIGINAL_ARGS[@]}"
fi
SSH_PORT_FROM_SESSION="${INSTALL_SSH_PORT:-${SSH_PORT_FROM_SESSION:-}}"

trap 'rc=$?; echo; echo "Установщик завершился с ошибкой (код $rc). Проверьте сообщение выше."; exit "$rc"' ERR

if [[ "$MODE" == "install" || "$MODE" == "update" || "$MODE" == "remove" || -z "$MODE" ]] &&
    [[ ! -t 0 ]]; then
  echo "Для установки, настройки и удаления нужен интерактивный терминал."
  exit 2
fi

ask() {
  local prompt="$1" default="$2" answer
  read -r -p "$prompt [$default]: " answer
  printf '%s' "${answer:-$default}"
}

confirm() {
  local prompt="$1" default="${2:-y}" answer
  if [[ "$default" == "y" ]]; then
    read -r -p "$prompt [Y/n]: " answer
    [[ ! "$answer" =~ ^[Nn]$ ]]
  else
    read -r -p "$prompt [y/N]: " answer
    [[ "$answer" =~ ^[Yy]$ ]]
  fi
}

check_os() {
  [[ -r /etc/os-release ]] || { echo "Не удалось определить систему."; exit 1; }
  . /etc/os-release
  case "$ID" in
    ubuntu|debian) ;;
    *) echo "Поддерживаются Ubuntu и Debian. Обнаружена система: ${PRETTY_NAME:-$ID}"; exit 1 ;;
  esac
}

install_base_tools() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl git gnupg iproute2 ufw
}

docker_ready() {
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1
}

install_docker() {
  if docker_ready; then
    echo "Docker и Compose уже установлены."
  else
    echo "Устанавливаю Docker из официального репозитория."
    . /etc/os-release
    local distro="$ID" codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
    [[ -n "$codename" ]] || { echo "Не удалось определить кодовое имя выпуска ОС."; exit 1; }
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/$distro/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/$distro
Suites: $codename
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  systemctl enable --now docker
  docker info >/dev/null
}

own_caddy_running() {
  command -v docker >/dev/null 2>&1 || return 1
  docker ps --filter "label=com.docker.compose.project=$APP_ID" \
    --filter "label=com.docker.compose.service=caddy" --format '{{.ID}}' 2>/dev/null | grep -q .
}

port_rows() {
  local proto="$1" port="$2"
  if [[ "$proto" == "tcp" ]]; then
    ss -H -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ (p "$") {print}'
  else
    ss -H -lunp 2>/dev/null | awk -v p=":$port" '$4 ~ (p "$") {print}'
  fi
}

docker_port_rows() {
  local port="$1"
  command -v docker >/dev/null 2>&1 || return 1
  docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null |
    awk -v needle=":$port->" 'index($0, needle) {print "Docker: " $0}'
}

host_tcp_port_busy() {
  local port="$1"
  if port_rows tcp "$port" | grep -q .; then return 0; fi
  docker_port_rows "$port" | grep -q .
}

port_is_free() {
  local port="$1"
  ! host_tcp_port_busy "$port"
}

show_web_port_owners() {
  local found=0 row
  for spec in "tcp 80" "tcp 443"; do
    read -r proto port <<< "$spec"
    while IFS= read -r row; do
      [[ -n "$row" ]] || continue
      found=1
      printf '  %s/%s: %s\n' "$port" "$proto" "$row"
    done < <(port_rows "$proto" "$port")
    if [[ "$proto" == "tcp" ]]; then
      while IFS= read -r row; do
        [[ -n "$row" ]] || continue
        found=1
        printf '  %s/%s: %s\n' "$port" "$proto" "$row"
      done < <(docker_port_rows "$port" || true)
    fi
  done
  if ((found == 0)); then echo "  Порты 80/tcp и 443/tcp свободны."; fi
  return "$found"
}

choose_app_port() {
  local candidate address port
  declare -A used=()
  while IFS= read -r address; do
    port="${address##*:}"
    [[ "$port" =~ ^[0-9]+$ ]] && used["$port"]=1
  done < <(ss -H -ltn 2>/dev/null | awk '{print $4}')
  if docker_ready; then
    while IFS= read -r port; do
      [[ "$port" =~ ^[0-9]+$ ]] && used["$port"]=1
    done < <(docker ps --format '{{.Ports}}' |
      tr ', ' '\n\n' | sed -nE 's/^.*:([0-9]+)->.*$/\1/p')
  fi
  for ((candidate=18300; candidate<=65535; candidate++)); do
    if [[ -z "${used[$candidate]:-}" ]]; then APP_HTTP_PORT="$candidate"; return; fi
  done
  for ((candidate=1024; candidate<18300; candidate++)); do
    if [[ -z "${used[$candidate]:-}" ]]; then APP_HTTP_PORT="$candidate"; return; fi
  done
  echo "Не нашёл свободный TCP/UDP-порт выше 1023. Освободите порт и повторите установку."
  exit 1
}

valid_domain() {
  [[ "$1" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]
}

get_repo_url() {
  local current=""
  if [[ -s "$REPO_FILE" ]]; then
    current="$(cat "$REPO_FILE")"
  elif git -C "$SOURCE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    current="$(git -C "$SOURCE_DIR" remote get-url origin 2>/dev/null || true)"
  fi
  current="${current:-$DEFAULT_REPO_URL}"
  while :; do
    REPO_URL="$(ask "GitHub-репозиторий для установки и обновлений" "$current")"
    if [[ "$REPO_URL" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(\.git)?$ ]]; then break; fi
    echo "Нужен адрес GitHub в формате https://github.com/владелец/проект.git"
  done
}

sync_repository() {
  install -d -m 0755 "$INSTALL_ROOT"
  install -d -m 0755 "$CONFIG_DIR"
  if [[ -e "$APP_DIR" && ! -d "$APP_DIR/.git" ]]; then
    echo "$APP_DIR существует, но это не Git-копия. Ничего не перезаписываю."
    echo "Переместите эту папку вручную или удалите её, затем повторите запуск."
    exit 1
  fi
  if [[ -d "$APP_DIR/.git" ]]; then
    git -C "$APP_DIR" remote set-url origin "$REPO_URL"
    GIT_TERMINAL_PROMPT=0 git -C "$APP_DIR" pull --ff-only
  else
    GIT_TERMINAL_PROMPT=0 git clone "$REPO_URL" "$APP_DIR"
  fi
  [[ -f "$APP_DIR/compose.yaml" && -f "$APP_DIR/Dockerfile" ]] || {
    echo "В выбранном репозитории не найдены compose.yaml и Dockerfile."
    exit 1
  }
  printf '%s\n' "$REPO_URL" > "$REPO_FILE"
  chmod 0600 "$REPO_FILE"
}

check_dns() {
  local domain="$1" public_ip="" dns_a="" dns_aaaa="" public_v6=""
  public_ip="$(curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  public_v6="$(curl -6fsS --max-time 5 https://api64.ipify.org 2>/dev/null || true)"
  dns_a="$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
  dns_aaaa="$(getent ahostsv6 "$domain" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
  echo "Проверка DNS для $domain:"
  echo "  A:    ${dns_a:-не найдено}"
  echo "  AAAA: ${dns_aaaa:-не найдено}"
  [[ -n "$public_ip" ]] && echo "  IPv4 сервера: $public_ip"
  [[ -n "$public_v6" ]] && echo "  IPv6 сервера: $public_v6"
  if [[ -z "$dns_a" && -z "$dns_aaaa" ]]; then
    echo "Домен пока не разрешается в IP-адрес. Игра установится, но доступ появится после настройки DNS."
    confirm "Продолжить установку" y || exit 1
  elif [[ -n "$public_ip" && "$dns_a" != *"$public_ip"* ]]; then
    echo "A-запись домена не совпадает с IPv4 сервера."
    confirm "Продолжить и проверить DNS позже" y || exit 1
  elif [[ -n "$dns_aaaa" && ( -z "$public_v6" || "$dns_aaaa" != *"$public_v6"* ) ]]; then
    echo "Есть AAAA-запись, которая может вести на другой сервер и мешать HTTPS."
    confirm "Продолжить; при необходимости исправьте или удалите AAAA-запись" y || exit 1
  fi
}

configure_firewall() {
  local status="unknown" ssh_port="${SSH_PORT_FROM_SESSION:-22}"
  if [[ -z "$SSH_PORT_FROM_SESSION" ]]; then
    ssh_port="$(ask "Порт SSH, который нужно сохранить при включении firewall" "22")"
  fi
  [[ "$ssh_port" =~ ^[0-9]+$ ]] || { echo "Некорректный порт SSH."; exit 1; }
  status="$(ufw status 2>/dev/null | head -n1 || true)"
  if [[ "$status" == "Status: active" ]]; then
    case "$ACCESS_MODE" in
      caddy|proxy) ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null ;;
      direct) ufw allow "$APP_HTTP_PORT/tcp" >/dev/null ;;
    esac
    echo "В UFW разрешены подключения к игровому порту и веб-портам."
  else
    echo "UFW сейчас не активен."
    if confirm "Включить UFW, сохранив SSH-доступ через порт $ssh_port" n; then
      ufw allow "$ssh_port/tcp" >/dev/null
      case "$ACCESS_MODE" in
        caddy|proxy) ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null ;;
        direct) ufw allow "$APP_HTTP_PORT/tcp" >/dev/null ;;
      esac
      ufw --force enable
    else
      echo "UFW оставлен без изменений. Если используется облачный firewall, откройте игровой порт там."
    fi
  fi
}

write_proxy_examples() {
  install -d -m 0755 "$CONFIG_DIR"
  cat > "$CONFIG_DIR/reverse-proxy.caddy" <<EOF
$SITE_DOMAIN {
  encode zstd gzip
  reverse_proxy 127.0.0.1:$APP_HTTP_PORT
}
EOF
  cat > "$CONFIG_DIR/reverse-proxy.nginx.conf" <<EOF
server {
    listen 80;
    server_name $SITE_DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:$APP_HTTP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
EOF
}

integrate_host_caddy() {
  local main="/etc/caddy/Caddyfile" sites="/etc/caddy/sites-enabled"
  local backup="/etc/caddy/Caddyfile.zemsky-backup"
  local site_backup="$CONFIG_DIR/caddy-site.backup" had_site=0
  local import_line="import /etc/caddy/sites-enabled/zemsky-circle.caddy"
  [[ -x "$(command -v caddy 2>/dev/null || true)" ]] || return 1
  systemctl is-active --quiet caddy || return 1
  [[ -f "$main" ]] || return 1
  install -d -m 0755 "$sites"
  cp -a "$main" "$backup"
  if [[ -e "$sites/zemsky-circle.caddy" ]]; then
    cp -a "$sites/zemsky-circle.caddy" "$site_backup"
    had_site=1
  fi
  cp "$CONFIG_DIR/reverse-proxy.caddy" "$sites/zemsky-circle.caddy"
  if ! grep -Fq "$import_line" "$main"; then
    printf '\n# Added by zemsky-circle installer\n%s\n' "$import_line" >> "$main"
  fi
  if caddy validate --config "$main" --adapter caddyfile >/dev/null 2>&1 && systemctl reload caddy; then
    PROXY_HTTPS_READY=1
    echo "Домен подключён к работающему Caddy. Он запросит сертификат автоматически."
    return 0
  fi
  cp -a "$backup" "$main"
  if ((had_site == 1)); then
    cp -a "$site_backup" "$sites/zemsky-circle.caddy"
  else
    rm -f "$sites/zemsky-circle.caddy"
  fi
  systemctl reload caddy >/dev/null 2>&1 || true
  echo "Автоподключение Caddy не прошло проверку; исходная конфигурация восстановлена."
  return 1
}

integrate_host_nginx() {
  local sites="/etc/nginx/sites-available" enabled="/etc/nginx/sites-enabled"
  local target="" link="" backup="" email="" had_target=0
  command -v nginx >/dev/null 2>&1 || return 1
  systemctl is-active --quiet nginx || return 1
  if [[ -d "$sites" && -d "$enabled" ]]; then
    target="$sites/zemsky-circle"
    link="$enabled/zemsky-circle"
  elif [[ -d /etc/nginx/conf.d ]]; then
    target="/etc/nginx/conf.d/zemsky-circle.conf"
    link="$target"
  else
    return 1
  fi
  if [[ -e "$target" ]]; then
    grep -Fq '# Managed by zemsky-circle installer' "$target" || {
      echo "Файл $target уже существует и не принадлежит установщику."
      return 1
    }
    cp -a "$target" "$CONFIG_DIR/nginx-site.backup"
    had_target=1
  fi
  if [[ "$link" != "$target" && -e "$link" && ! -L "$link" ]]; then
    echo "Файл $link уже существует; не буду его заменять."
    return 1
  fi
  if [[ "$link" != "$target" && -L "$link" && "$(readlink -f "$link")" != "$target" ]]; then
    echo "Ссылка $link уже ведёт на другую конфигурацию; не буду её менять."
    return 1
  fi
  if nginx -T 2>/dev/null | grep -Fq "server_name $SITE_DOMAIN" &&
      ! grep -Fq "server_name $SITE_DOMAIN" "$target" 2>/dev/null; then
    echo "В Nginx уже настроен домен $SITE_DOMAIN. Оставляю его без изменений."
    return 1
  fi

  write_nginx_site() {
    local tls="$1"
    {
      echo "# Managed by zemsky-circle installer"
      if [[ "$tls" == "yes" ]]; then
        cat <<EOF
server {
    listen 80;
    server_name $SITE_DOMAIN;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type text/plain;
    }
    location / { return 301 https://\$host\$request_uri; }
}
server {
    listen 443 ssl;
    server_name $SITE_DOMAIN;
    ssl_certificate /etc/letsencrypt/live/$SITE_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$SITE_DOMAIN/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:$APP_HTTP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
EOF
      else
        cat <<EOF
server {
    listen 80;
    server_name $SITE_DOMAIN;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type text/plain;
    }
    location / {
        proxy_pass http://127.0.0.1:$APP_HTTP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
EOF
      fi
    } > "$target"
  }

  if [[ "$link" != "$target" && ! -e "$link" ]]; then
    ln -s "$target" "$link"
  fi
  install -d -m 0755 /var/www/letsencrypt/.well-known/acme-challenge
  write_nginx_site no
  if ! nginx -t >/dev/null 2>&1 || ! systemctl reload nginx; then
    if ((had_target == 1)); then cp -a "$CONFIG_DIR/nginx-site.backup" "$target"; else rm -f "$target"; fi
    [[ "$link" == "$target" ]] || [[ ! -L "$link" ]] || rm -f "$link"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true
    echo "Nginx не принял новую конфигурацию; исходные файлы восстановлены."
    return 1
  fi
  echo "Домен направлен на игру через существующий Nginx."
  if ! command -v certbot >/dev/null 2>&1; then
    apt-get install -y certbot
  fi
  read -r -p "Почта для напоминаний Let's Encrypt (можно оставить пустой): " email
  if [[ -n "$email" ]]; then
    certbot certonly --webroot -w /var/www/letsencrypt -d "$SITE_DOMAIN" \
      --non-interactive --agree-tos --keep-until-expiring --email "$email" || {
        echo "Сертификат пока не получен. HTTP-доступ работает; проверьте DNS и доступность порта 80."
        return 0
      }
  else
    certbot certonly --webroot -w /var/www/letsencrypt -d "$SITE_DOMAIN" \
      --non-interactive --agree-tos --keep-until-expiring --register-unsafely-without-email || {
        echo "Сертификат пока не получен. HTTP-доступ работает; проверьте DNS и доступность порта 80."
        return 0
      }
  fi
  write_nginx_site yes
  if nginx -t >/dev/null 2>&1 && systemctl reload nginx; then
    PROXY_HTTPS_READY=1
    echo "Для Nginx включён HTTPS; Certbot будет обновлять сертификат автоматически."
    return 0
  fi
  write_nginx_site no
  nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true
  echo "Сертификат получен, но Nginx не принял HTTPS-конфигурацию. Оставил рабочий HTTP-вариант."
  return 0
}

remove_host_proxy_config() {
  if [[ -f /etc/caddy/sites-enabled/zemsky-circle.caddy ]]; then
    if [[ -f /etc/caddy/Caddyfile ]]; then
      sed -i '/^# Added by zemsky-circle installer$/,+1d' /etc/caddy/Caddyfile
      sed -i '\|^import /etc/caddy/sites-enabled/zemsky-circle.caddy$|d' /etc/caddy/Caddyfile
    fi
    rm -f /etc/caddy/sites-enabled/zemsky-circle.caddy
    systemctl reload caddy >/dev/null 2>&1 || true
  fi
  if [[ -L /etc/nginx/sites-enabled/zemsky-circle ]] &&
      [[ "$(readlink -f /etc/nginx/sites-enabled/zemsky-circle)" == "/etc/nginx/sites-available/zemsky-circle" ]]; then
    rm -f /etc/nginx/sites-enabled/zemsky-circle
    nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true
  fi
  if [[ -f /etc/nginx/sites-available/zemsky-circle ]] &&
      grep -Fq '# Managed by zemsky-circle installer' /etc/nginx/sites-available/zemsky-circle; then
    rm -f /etc/nginx/sites-available/zemsky-circle
  fi
  if [[ -f /etc/nginx/conf.d/zemsky-circle.conf ]] &&
      grep -Fq '# Managed by zemsky-circle installer' /etc/nginx/conf.d/zemsky-circle.conf; then
    rm -f /etc/nginx/conf.d/zemsky-circle.conf
    nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true
  fi
}

install_or_update() {
  check_os
  install_base_tools
  get_repo_url
  SITE_DOMAIN="$(sed -n 's/^SITE_DOMAIN=//p' "$ENV_FILE" 2>/dev/null | head -n1 || true)"
  if ! valid_domain "$SITE_DOMAIN"; then
    while :; do
      SITE_DOMAIN="$(ask "Домен игры (например, game.domain.com)" "")"
      valid_domain "$SITE_DOMAIN" && break
      echo "Введите домен с точкой, например game.domain.com."
    done
  else
    SITE_DOMAIN="$(ask "Домен игры" "$SITE_DOMAIN")"
    valid_domain "$SITE_DOMAIN" || { echo "Некорректный домен."; exit 1; }
  fi

  local web_free=0 saved_mode=""
  saved_mode="$(sed -n 's/^ACCESS_MODE=//p' "$ENV_FILE" 2>/dev/null | head -n1 || true)"
  if own_caddy_running; then
    echo "Порты 80/443 уже принадлежат Caddy этой игры."
  else
    show_web_port_owners || web_free=1
  fi
  if ((web_free == 1)) && ! own_caddy_running; then
    echo "80/443 заняты. Не буду останавливать существующие сайты."
    ACCESS_MODE="$(ask "Режим доступа: direct — домен:порт; proxy — существующий веб-сервер" "${saved_mode:-direct}")"
    [[ "$ACCESS_MODE" == "proxy" || "$ACCESS_MODE" == "direct" ]] || {
      echo "Выберите direct или proxy."; exit 1;
    }
  else
    ACCESS_MODE="$(ask "Режим доступа: caddy — HTTPS на 80/443; direct — свободный порт; proxy — существующий сервер" "${saved_mode:-caddy}")"
    [[ "$ACCESS_MODE" == "caddy" || "$ACCESS_MODE" == "direct" || "$ACCESS_MODE" == "proxy" ]] || {
      echo "Выберите caddy, direct или proxy."; exit 1;
    }
  fi

  local oldport="" app_running=0
  if [[ -s "$ENV_FILE" ]]; then
    oldport="$(sed -n 's/^APP_HTTP_PORT=//p' "$ENV_FILE" | head -n1 || true)"
  fi
  if docker_ready &&
      docker ps --filter "label=com.docker.compose.project=$APP_ID" \
        --filter "label=com.docker.compose.service=app" --format '{{.ID}}' | grep -q .; then
    app_running=1
  fi
  if [[ "$oldport" =~ ^[0-9]+$ ]] &&
      { ((app_running == 1)) || port_is_free "$oldport"; }; then
    APP_HTTP_PORT="$oldport"
  else
    choose_app_port
  fi
  if [[ "$saved_mode" == "proxy" && "$ACCESS_MODE" != "proxy" ]]; then
    remove_host_proxy_config
  fi
  if [[ "$ACCESS_MODE" == "caddy" ]]; then
    if [[ "$web_free" == "1" ]] && ! own_caddy_running; then
      echo "Caddy нельзя запустить: порт 80 или 443 уже занят."
      exit 1
    fi
    APP_BIND_ADDRESS="127.0.0.1"
  elif [[ "$ACCESS_MODE" == "proxy" ]]; then
    APP_BIND_ADDRESS="127.0.0.1"
  else
    APP_BIND_ADDRESS="0.0.0.0"
  fi

  check_dns "$SITE_DOMAIN"
  install_docker
  configure_firewall
  sync_repository
  install -d -m 0755 "$CONFIG_DIR"
  cat > "$ENV_FILE" <<EOF
SITE_DOMAIN=$SITE_DOMAIN
APP_HTTP_PORT=$APP_HTTP_PORT
APP_BIND_ADDRESS=$APP_BIND_ADDRESS
ACCESS_MODE=$ACCESS_MODE
TRUST_PROXY=$([[ "$ACCESS_MODE" == "direct" ]] && printf '0' || printf '1')
MAX_ROOMS=50
MAX_ROOMS_PER_IP=3
ROOM_IDLE_HOURS=4
EOF
  chmod 0600 "$ENV_FILE"
  if [[ "$ACCESS_MODE" == "caddy" ]]; then
    docker compose --env-file "$ENV_FILE" --profile standalone -f "$APP_DIR/compose.yaml" pull caddy gateway
    docker compose --env-file "$ENV_FILE" --profile standalone -f "$APP_DIR/compose.yaml" up -d --build
  else
    if own_caddy_running; then
      docker compose --env-file "$ENV_FILE" --profile standalone -f "$APP_DIR/compose.yaml" stop caddy || true
      docker compose --env-file "$ENV_FILE" --profile standalone -f "$APP_DIR/compose.yaml" rm -f caddy || true
    fi
    docker compose --env-file "$ENV_FILE" -f "$APP_DIR/compose.yaml" up -d --build app gateway
  fi
  local gateway_address
  gateway_address="$(docker compose --env-file "$ENV_FILE" -f "$APP_DIR/compose.yaml" port gateway 8080 2>/dev/null || true)"
  if [[ -z "$gateway_address" ]]; then
    echo "Docker не опубликовал порт $APP_HTTP_PORT через gateway. Проверьте сеть и конфигурацию Compose." >&2
    docker compose --env-file "$ENV_FILE" -f "$APP_DIR/compose.yaml" logs --tail=40 gateway >&2 || true
    exit 1
  fi
  if ! curl -fsS --max-time 5 "http://127.0.0.1:$APP_HTTP_PORT/health" >/dev/null; then
    echo "Порт опубликован ($gateway_address), но проверка игры не прошла." >&2
    docker compose --env-file "$ENV_FILE" -f "$APP_DIR/compose.yaml" logs --tail=40 app gateway >&2 || true
    exit 1
  fi
  echo "Проверка игрового порта пройдена: $gateway_address"
  if [[ "$ACCESS_MODE" == "proxy" ]]; then
    write_proxy_examples
    if ! integrate_host_caddy && ! integrate_host_nginx; then
      echo
      echo "Для существующего прокси создан пример настройки:"
      echo "  Caddy: $CONFIG_DIR/reverse-proxy.caddy"
      echo "  Nginx: $CONFIG_DIR/reverse-proxy.nginx.conf"
      echo "Подключите подходящий файл к существующему прокси. Caddy автоматически запрашивает HTTPS; для Nginx можно добавить сертификат Certbot."
    fi
  fi
  echo
  echo "Установка завершена."
  case "$ACCESS_MODE" in
    caddy) echo "Адрес: https://$SITE_DOMAIN" ;;
    direct) echo "Адрес: http://$SITE_DOMAIN:$APP_HTTP_PORT (HTTP; для HTTPS подключите существующий прокси)" ;;
    proxy)
      if ((PROXY_HTTPS_READY == 1)); then
        echo "Адрес: https://$SITE_DOMAIN"
      else
        echo "Приложение доступно локально на порту $APP_HTTP_PORT."
        echo "Подключите подготовленную конфигурацию прокси, чтобы открыть https://$SITE_DOMAIN."
      fi
      ;;
  esac
  echo "Игровой порт: $APP_HTTP_PORT/tcp"
  echo "Статус: sudo bash $APP_DIR/install-ubuntu.sh --status"
  echo "Обновление: sudo bash $APP_DIR/install-ubuntu.sh --update"
}

show_status() {
  if ! docker_ready; then echo "Docker ещё не установлен."; return 0; fi
  if [[ -f "$ENV_FILE" && -d "$APP_DIR" ]]; then
    docker compose --env-file "$ENV_FILE" -f "$APP_DIR/compose.yaml" ps -a
    local domain port mode
    domain="$(sed -n 's/^SITE_DOMAIN=//p' "$ENV_FILE" | head -n1 || true)"
    port="$(sed -n 's/^APP_HTTP_PORT=//p' "$ENV_FILE" | head -n1 || true)"
    mode="$(sed -n 's/^APP_BIND_ADDRESS=//p' "$ENV_FILE" | head -n1 || true)"
    echo "Домен: ${domain:-не настроен}"
    echo "Порт приложения: ${port:-не настроен} (привязка: ${mode:-?})"
    docker ps --filter "label=com.docker.compose.project=$APP_ID" --format 'Порт контейнера: {{.Names}} {{.Ports}}'
  else
    echo "Игра ещё не установлена."
  fi
  echo "Занято на хосте:"
  show_web_port_owners || true
}

remove_installation() {
  if [[ ! -f "$ENV_FILE" || ! -f "$APP_DIR/compose.yaml" ]]; then
    echo "Установка игры не найдена."; return 0
  fi
  echo "Выберите вариант удаления:"
  echo "  1) Удалить контейнеры, оставить сохранения и настройки для будущей установки"
  echo "  2) Удалить контейнеры, сохранения и настройки; системный сертификат прокси оставить"
  local choice
  choice="$(ask "Ваш выбор" "1")"
  [[ "$choice" == "1" || "$choice" == "2" ]] || { echo "Отменено."; return 0; }
  if [[ "$choice" == "2" ]]; then
    local word
    word="$(ask "Для полного удаления введите УДАЛИТЬ" "")"
    [[ "$word" == "УДАЛИТЬ" ]] || { echo "Отменено."; return 0; }
  fi
  if docker_ready; then
    if [[ "$choice" == "2" ]]; then
      docker compose --env-file "$ENV_FILE" --profile standalone -f "$APP_DIR/compose.yaml" down -v --remove-orphans || true
    else
      docker compose --env-file "$ENV_FILE" --profile standalone -f "$APP_DIR/compose.yaml" down --remove-orphans || true
    fi
  fi
  remove_host_proxy_config
  if [[ "$choice" == "2" ]]; then
    case "$(realpath -m "$INSTALL_ROOT")" in
      /opt/zemsky-circle) rm -rf -- "$INSTALL_ROOT" ;;
      *) echo "Путь установки не прошёл проверку; файлы оставлены."; return 1 ;;
    esac
    rm -rf -- "$CONFIG_DIR"
    rm -f -- "$REPO_FILE"
    echo "Игра, сохранения и настройки удалены. Docker и UFW оставлены для других приложений."
  else
    echo "Контейнеры удалены, данные и настройки сохранены."
  fi
}

if [[ -z "$MODE" ]]; then
  echo "Земский круг — управление установкой"
  echo "  1) Установить или обновить"
  echo "  2) Показать статус"
  echo "  3) Удалить игру"
  echo "  0) Выход"
  read -r -p "Выберите действие: " choice
  case "$choice" in
    1) MODE="install" ;;
    2) MODE="status" ;;
    3) MODE="remove" ;;
    0) exit 0 ;;
    *) echo "Неизвестный выбор."; exit 2 ;;
  esac
fi

case "$MODE" in
  install|update) install_or_update ;;
  status) show_status ;;
  remove) remove_installation ;;
esac
