#!/usr/bin/env bash
# Uploads a release zip to the Chrome Web Store and submits it for review, with the Chrome Web
# Store API v2 and a Google Cloud service account (docs/STORE-POLICY.md → Publishing).
#
# Usage: publish-to-chrome-web-store.sh <zip>
# Environment (GitHub secrets):
#   CWS_PUBLISHER_ID         Developer Dashboard → Account → Publisher ID
#   CWS_ITEM_ID              the extension's item id (shown on its dashboard page)
#   CWS_SERVICE_ACCOUNT_KEY  the service account's JSON key (the account is added in the
#                            dashboard's Account section)
# Without them it prints a notice and exits 0, so releases work before the store is set up.
set -euo pipefail

zip=${1:?usage: $0 <zip>}
if [ -z "${CWS_PUBLISHER_ID:-}" ] || [ -z "${CWS_ITEM_ID:-}" ] || [ -z "${CWS_SERVICE_ACCOUNT_KEY:-}" ]; then
  echo "::notice::Chrome Web Store secrets are not set; the release was not sent to the store."
  exit 0
fi

api=${CWS_API_BASE:-https://chromewebstore.googleapis.com} # overridable only for testing against a fake server
item="publishers/$CWS_PUBLISHER_ID/items/$CWS_ITEM_ID"
scope=https://www.googleapis.com/auth/chromewebstore

# ---- access token: a JWT signed with the service account's key, exchanged at Google's token URL
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
email=$(jq -r .client_email <<<"$CWS_SERVICE_ACCOUNT_KEY")
token_uri=$(jq -r '.token_uri // "https://oauth2.googleapis.com/token"' <<<"$CWS_SERVICE_ACCOUNT_KEY")
key_file=$(mktemp)
trap 'rm -f "$key_file"' EXIT
jq -r .private_key <<<"$CWS_SERVICE_ACCOUNT_KEY" >"$key_file"
now=$(date +%s)
header=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
claims=$(jq -cn --arg iss "$email" --arg scope "$scope" --arg aud "$token_uri" --argjson iat "$now" \
  '{iss: $iss, scope: $scope, aud: $aud, iat: $iat, exp: ($iat + 600)}' | b64url)
signature=$(printf '%s.%s' "$header" "$claims" | openssl dgst -sha256 -sign "$key_file" -binary | b64url)
token=$(curl -sS --fail-with-body "$token_uri" \
  -d grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer \
  -d "assertion=$header.$claims.$signature" | jq -r .access_token)
echo "::add-mask::$token"
auth=(-H "Authorization: Bearer $token")

# A call to the store API: prints the store's answer, and on an HTTP error shows it as the error
# (`set -e` would otherwise end the script before the answer is printed).
call() {
  local what=$1 body
  shift
  if ! body=$(curl -sS --fail-with-body "${auth[@]}" "$@"); then
    echo "$body" >&2
    echo "::error::The Chrome Web Store refused the $what: $(jq -r '.error.message // empty' <<<"$body" 2>/dev/null || true)" >&2
    exit 1
  fi
  printf '%s' "$body"
}

# ---- upload the package, and wait while the store is still processing it
echo "Uploading $zip to $item"
upload=$(call upload -X POST -T "$zip" "$api/upload/v2/$item:upload")
echo "$upload"
state=$(jq -r .uploadState <<<"$upload")
for _ in $(seq 1 30); do
  [ "$state" = IN_PROGRESS ] || [ "$state" = UPLOAD_IN_PROGRESS ] || break
  sleep 10
  status=$(call "status request" "$api/v2/$item:fetchStatus")
  state=$(jq -r '.lastAsyncUploadState // "IN_PROGRESS"' <<<"$status")
  echo "upload state: $state"
done
if [ "$state" != SUCCEEDED ]; then
  echo "::error::The Chrome Web Store did not accept the package (upload state: $state)."
  exit 1
fi

# ---- submit it for review; once approved it goes live with the item's visibility (for a private
# item: only its testers)
publish=$(call "submission for review" -X POST "$api/v2/$item:publish")
echo "$publish"
echo "::notice::Submitted to the Chrome Web Store for review (state: $(jq -r .state <<<"$publish"))."
