#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") <keycloak_url> <realm> [admin_username] [admin_password]

Examples:
  $(basename "$0") http://localhost:30080 Test
  KEYCLOAK_ADMIN_PASSWORD=changeme $(basename "$0") http://localhost:30080 Test admin

Environment variables:
  KEYCLOAK_ADMIN_USERNAME        Default admin username (fallback if arg #3 is omitted)
  KEYCLOAK_ADMIN_PASSWORD        Default admin password (fallback if arg #4 is omitted)
  CLOUD_MANAGER_CLIENT_SECRET    Secret for cloud-manager-service (default: change-me)
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -lt 2 ]]; then
  usage
  exit 1
fi

KEYCLOAK_URL="${1%/}"
REALM="$2"
ADMIN_USERNAME="${3:-${KEYCLOAK_ADMIN_USERNAME:-admin}}"
ADMIN_PASSWORD="${4:-${KEYCLOAK_ADMIN_PASSWORD:-}}"
CLOUD_MANAGER_CLIENT_SECRET="${CLOUD_MANAGER_CLIENT_SECRET:-i6cZGJ8t88fYbhmOvhmH2uq14Lsuf0dr}"

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required" >&2
  exit 1
fi

if [[ -z "$ADMIN_PASSWORD" ]]; then
  echo "Error: admin password is required (arg #4 or KEYCLOAK_ADMIN_PASSWORD)" >&2
  exit 1
fi

log() {
  echo "[keycloak-setup] $*"
}

get_admin_token() {
  local token
  token=$(curl -sS -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "client_id=admin-cli" \
    -d "username=$ADMIN_USERNAME" \
    -d "password=$ADMIN_PASSWORD" \
    -d "grant_type=password" | jq -r '.access_token // empty')

  if [[ -z "$token" ]]; then
    echo "Error: failed to get admin token. Check URL/credentials." >&2
    exit 1
  fi

  printf '%s' "$token"
}

realm_exists() {
  local token="$1"
  curl -sS -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $token" \
    "$KEYCLOAK_URL/admin/realms/$REALM" | grep -q '^200$'
}

client_exists() {
  local token="$1"
  local client_id="$2"

  local count
  count=$(curl -sS \
    -H "Authorization: Bearer $token" \
    "$KEYCLOAK_URL/admin/realms/$REALM/clients?clientId=$client_id" | jq 'length')

  [[ "$count" -gt 0 ]]
}

create_realm_if_missing() {
  local token="$1"
  if realm_exists "$token"; then
    log "Realm '$REALM' already exists"
    return
  fi

  log "Creating realm '$REALM'"
  curl -sS -X POST "$KEYCLOAK_URL/admin/realms" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "{\"realm\":\"$REALM\",\"enabled\":true}" >/dev/null
}

create_kubernetes_idp_if_missing() {
  local token="$1"
  local alias="kubernetes"

  local code
  code=$(curl -sS -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $token" \
    "$KEYCLOAK_URL/admin/realms/$REALM/identity-provider/instances/$alias")

  if [[ "$code" == "200" ]]; then
    log "Identity Provider '$alias' already exists"
    return
  fi

  log "Creating Identity Provider '$alias'"
  curl -sS -X POST "$KEYCLOAK_URL/admin/realms/$REALM/identity-provider/instances" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d '{
      "alias": "kubernetes",
      "providerId": "kubernetes",
      "enabled": true,
      "config": {
        "allowCreate": "true",
        "issuer": "https://kubernetes.default.svc.cluster.local"
      }
    }' >/dev/null
}

create_federated_client_if_missing() {
  local token="$1"
  local client_id="$2"

  if client_exists "$token" "$client_id"; then
    log "Client '$client_id' already exists"
    return
  fi

  log "Creating federated client '$client_id'"
  curl -sS -X POST "$KEYCLOAK_URL/admin/realms/$REALM/clients" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "{
      \"clientId\": \"$client_id\",
      \"enabled\": true,
      \"publicClient\": false,
      \"serviceAccountsEnabled\": true,
      \"clientAuthenticatorType\": \"federated-jwt\",
      \"attributes\": {
        \"jwt.credential.issuer\": \"kubernetes\",
        \"jwt.credential.sub\": \"$client_id\"
      }
    }" >/dev/null
}

create_secret_client_if_missing() {
  local token="$1"
  local client_id="cloud-manager-service"

  if client_exists "$token" "$client_id"; then
    log "Client '$client_id' already exists"
    return
  fi

  log "Creating secret client '$client_id'"
  curl -sS -X POST "$KEYCLOAK_URL/admin/realms/$REALM/clients" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "{
      \"clientId\": \"$client_id\",
      \"secret\": \"$CLOUD_MANAGER_CLIENT_SECRET\",
      \"enabled\": true,
      \"publicClient\": false,
      \"serviceAccountsEnabled\": true,
      \"clientAuthenticatorType\": \"client-secret\"
    }" >/dev/null
}

main() {
  log "Target Keycloak URL: $KEYCLOAK_URL"
  log "Target Realm: $REALM"

  local admin_token
  admin_token=$(get_admin_token)
  log "Admin token acquired"

  create_realm_if_missing "$admin_token"
  create_kubernetes_idp_if_missing "$admin_token"

  create_federated_client_if_missing "$admin_token" "system:serviceaccount:dev-file-manage-team:sa-file-service"
  create_federated_client_if_missing "$admin_token" "system:serviceaccount:dev-operator-team:sa-operator-service"
  create_secret_client_if_missing "$admin_token"

  log "Setup complete"
}

main
