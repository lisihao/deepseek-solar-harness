#!/usr/bin/env bash

set -euo pipefail
IFS=$'\n\t'

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)"
INSTALLER="$ROOT/tools/install-curated-plugins.sh"
TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/curated-installer-test.XXXXXX")"

FIXTURE="$TEMP_ROOT/fixture"
FAKE_BIN="$TEMP_ROOT/bin"
DSH_HOME="$TEMP_ROOT/dsh-home"
EVENTS="$TEMP_ROOT/events.log"
CLI_LOG="$TEMP_ROOT/cli.log"
HOME_FIXTURE="$TEMP_ROOT/home"
CUSTOM_APP_BUNDLE="$HOME_FIXTURE/Applications/DeepSeek Harness.app"
CUSTOM_APP_CLI="$CUSTOM_APP_BUNDLE/Contents/Resources/runtime/cli/bin/dsh"
CUSTOM_APP_COMM="$CUSTOM_APP_BUNDLE/Contents/MacOS/DeepSeek Harness"
CUSTOM_APP_PID=""
mkdir -p "$FIXTURE" "$FAKE_BIN" "$DSH_HOME/profiles/desktop"
printf '{"fixture":true}\n' > "$DSH_HOME/profiles/desktop/package.json"

cleanup() {
  if [ -n "${CUSTOM_APP_PID:-}" ]; then
    kill "$CUSTOM_APP_PID" 2>/dev/null || true
    wait "$CUSTOM_APP_PID" 2>/dev/null || true
  fi
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT HUP INT TERM

cat > "$FAKE_BIN/uname" <<'SH'
#!/usr/bin/env bash
case "$1" in
  -s) printf 'Darwin\n' ;;
  -m) printf 'arm64\n' ;;
  *) exit 2 ;;
esac
SH
chmod +x "$FAKE_BIN/uname"
cat > "$FAKE_BIN/pgrep" <<'SH'
#!/usr/bin/env bash
exit 1
SH
cat > "$FAKE_BIN/ps" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ -n "${CURATED_TEST_RUNNING_APP_PID:-}" ] && kill -0 "$CURATED_TEST_RUNNING_APP_PID" 2>/dev/null; then
  printf '%s %s\n' "$CURATED_TEST_RUNNING_APP_PID" "$CURATED_TEST_APP_COMM"
fi
SH
cat > "$FAKE_BIN/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      output="$2"
      shift 2
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
[ -n "$output" ]
relative_path="${url#*/distribution/plugins/}"
[ "$relative_path" != "$url" ]
printf 'curl:%s\n' "$relative_path" >> "$CURATED_TEST_EVENTS"
cp "$CURATED_TEST_FIXTURE/$relative_path" "$output"
SH
cat > "$FAKE_BIN/dsh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
last=""
for argument in "$@"; do
  last="$argument"
done
printf 'cli:%s\n' "$(basename "$last")" >> "$CURATED_TEST_EVENTS"
printf '%s\n' "$last" >> "$CURATED_TEST_CLI_LOG"
SH
chmod +x "$FAKE_BIN/pgrep" "$FAKE_BIN/ps" "$FAKE_BIN/curl" "$FAKE_BIN/dsh"

printf 'resident archive' > "$FIXTURE/resident.tgz"
printf 'collaboration archive' > "$FIXTURE/collaboration.tgz"
printf 'web-' > "$FIXTURE/web.tgz.part00"
printf 'archive' > "$FIXTURE/web.tgz.part01"
cat "$FIXTURE/web.tgz.part00" "$FIXTURE/web.tgz.part01" > "$FIXTURE/web.tgz"
printf 'MIT License fixture\n' > "$FIXTURE/LICENSE-Solar.txt"

resident_sha="$(shasum -a 256 "$FIXTURE/resident.tgz" | awk '{print $1}')"
resident_size="$(wc -c < "$FIXTURE/resident.tgz" | tr -d '[:space:]')"
collaboration_sha="$(shasum -a 256 "$FIXTURE/collaboration.tgz" | awk '{print $1}')"
collaboration_size="$(wc -c < "$FIXTURE/collaboration.tgz" | tr -d '[:space:]')"
web_part00_sha="$(shasum -a 256 "$FIXTURE/web.tgz.part00" | awk '{print $1}')"
web_part00_size="$(wc -c < "$FIXTURE/web.tgz.part00" | tr -d '[:space:]')"
web_part01_sha="$(shasum -a 256 "$FIXTURE/web.tgz.part01" | awk '{print $1}')"
web_part01_size="$(wc -c < "$FIXTURE/web.tgz.part01" | tr -d '[:space:]')"
web_sha="$(shasum -a 256 "$FIXTURE/web.tgz" | awk '{print $1}')"
web_size="$(wc -c < "$FIXTURE/web.tgz" | tr -d '[:space:]')"
license_sha="$(shasum -a 256 "$FIXTURE/LICENSE-Solar.txt" | awk '{print $1}')"
license_size="$(wc -c < "$FIXTURE/LICENSE-Solar.txt" | tr -d '[:space:]')"

python3 - \
  "$FIXTURE/catalog.json" \
  "$resident_sha" "$resident_size" \
  "$collaboration_sha" "$collaboration_size" \
  "$web_part00_sha" "$web_part00_size" \
  "$web_part01_sha" "$web_part01_size" \
  "$web_sha" "$web_size" \
  "$license_sha" "$license_size" <<'PY'
import json
import sys

(
    path,
    resident_sha, resident_size,
    collaboration_sha, collaboration_size,
    part0_sha, part0_size,
    part1_sha, part1_size,
    web_sha, web_size,
    license_sha, license_size,
) = sys.argv[1:]
catalog = {
    "formatVersion": 1,
    "packages": [
        {
            "id": "resident",
            "name": "resident",
            "version": "0.0.0",
            "requiredPackageIds": [],
            "license": {
                "licenseFile": "LICENSE-Solar.txt",
                "sha256": license_sha,
                "size": int(license_size),
            },
            "artifact": {
                "file": "resident.tgz",
                "sha256": resident_sha,
                "size": int(resident_size),
            },
        },
        {
            "id": "collaboration",
            "name": "collaboration",
            "version": "0.0.0",
            "requiredPackageIds": ["resident"],
            "license": {
                "licenseFile": "LICENSE-Solar.txt",
                "sha256": license_sha,
                "size": int(license_size),
            },
            "artifact": {
                "file": "collaboration.tgz",
                "sha256": collaboration_sha,
                "size": int(collaboration_size),
            },
        },
        {
            "id": "web",
            "name": "web",
            "version": "0.0.0",
            "requiredPackageIds": ["resident", "collaboration"],
            "license": {
                "licenseFile": "LICENSE-Solar.txt",
                "sha256": license_sha,
                "size": int(license_size),
            },
            "artifact": {
                "parts": [
                    {"file": "web.tgz.part00", "sha256": part0_sha, "size": int(part0_size)},
                    {"file": "web.tgz.part01", "sha256": part1_sha, "size": int(part1_size)},
                ],
                "sha256": web_sha,
                "size": int(web_size),
            },
        },
    ],
}
with open(path, "w", encoding="utf-8") as stream:
    json.dump(catalog, stream)
PY

STANDALONE_DIR="$TEMP_ROOT/standalone"
mkdir -p "$STANDALONE_DIR"
cp -p "$INSTALLER" "$STANDALONE_DIR/install-curated-plugins.sh"
: > "$EVENTS"
: > "$CLI_LOG"
remote_list="$(
  PATH="$FAKE_BIN:$PATH" \
  CURATED_TEST_EVENTS="$EVENTS" \
  CURATED_TEST_FIXTURE="$FIXTURE" \
  CURATED_TEST_CLI_LOG="$CLI_LOG" \
  "$STANDALONE_DIR/install-curated-plugins.sh" \
    --ref aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --list
)"
printf '%s\n' "$remote_list" | grep -q '^web'
[ ! -s "$CLI_LOG" ]
grep -q '^curl:catalog.json$' "$EVENTS"

: > "$EVENTS"
: > "$CLI_LOG"
PATH="$FAKE_BIN:$PATH" \
CURATED_TEST_EVENTS="$EVENTS" \
CURATED_TEST_FIXTURE="$FIXTURE" \
CURATED_TEST_CLI_LOG="$CLI_LOG" \
DSH_HOME="$DSH_HOME" \
DSH_CLI="$FAKE_BIN/dsh" \
"$INSTALLER" --ref aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa web

expected_order="$(printf 'resident.tgz\ncollaboration.tgz\nweb.tgz')"
actual_order="$(sed 's#.*/##' "$CLI_LOG")"
[ "$actual_order" = "$expected_order" ] || {
  printf 'unexpected CLI order:\n%s\n' "$actual_order" >&2
  exit 1
}
curl_count="$(grep -c '^curl:' "$EVENTS")"
first_cli_line="$(awk '/^cli:/{print NR; exit}' "$EVENTS")"
[ "$curl_count" -eq 6 ]
[ "$first_cli_line" -gt "$curl_count" ]
[ -n "$(find "$DSH_HOME/solar/curated-installer/backups" -name package.json -type f -print -quit)" ]
backup_receipt="$(find "$DSH_HOME/solar/curated-installer/backups" -name receipt.tsv -type f -print -quit)"
[ -n "$backup_receipt" ]
grep -Fqx "$(printf 'compatibility.json\tabsent')" "$backup_receipt"
for package_id in resident collaboration web; do
  cached_path="$DSH_HOME/artifacts/curated/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/$package_id.tgz"
  [ -f "$cached_path" ]
done
[ -f "$DSH_HOME/artifacts/curated/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/catalog.json" ]
[ -f "$DSH_HOME/artifacts/curated/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/licenses/LICENSE-Solar.txt" ]
while IFS= read -r installed_path; do
  [ -f "$installed_path" ]
  case "$installed_path" in
    "$DSH_HOME/artifacts/curated/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"*) ;;
    *)
      printf 'CLI received a non-stable artifact path: %s\n' "$installed_path" >&2
      exit 1
      ;;
  esac
done < "$CLI_LOG"

mkdir -p "$(dirname -- "$CUSTOM_APP_CLI")" "$(dirname -- "$CUSTOM_APP_COMM")"
cp -p "$FAKE_BIN/dsh" "$CUSTOM_APP_CLI"
ln -s "$(command -v sleep)" "$CUSTOM_APP_COMM"
"$CUSTOM_APP_COMM" 30 &
CUSTOM_APP_PID=$!
: > "$EVENTS"
: > "$CLI_LOG"
if PATH="$FAKE_BIN:$PATH" \
  CURATED_TEST_EVENTS="$EVENTS" \
  CURATED_TEST_FIXTURE="$FIXTURE" \
  CURATED_TEST_CLI_LOG="$CLI_LOG" \
  CURATED_TEST_RUNNING_APP_PID="$CUSTOM_APP_PID" \
  CURATED_TEST_APP_COMM="$CUSTOM_APP_COMM" \
  HOME="$HOME_FIXTURE" \
  DSH_HOME="$DSH_HOME" \
  DSH_CLI="$CUSTOM_APP_CLI" \
  "$INSTALLER" --ref aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa web \
  > "$TEMP_ROOT/running-custom-app.stdout" 2> "$TEMP_ROOT/running-custom-app.stderr"
then
  printf 'running custom DeepSeek Harness unexpectedly reached installation\n' >&2
  exit 1
fi
grep -q 'DeepSeek Harness application appears to be active' "$TEMP_ROOT/running-custom-app.stderr"
[ ! -s "$EVENTS" ]
[ ! -s "$CLI_LOG" ]
kill "$CUSTOM_APP_PID"
wait "$CUSTOM_APP_PID" 2>/dev/null || true
CUSTOM_APP_PID=""

: > "$EVENTS"
: > "$CLI_LOG"
printf 'good-bytes' > "$FIXTURE/expected.tgz"
printf 'bad--bytes' > "$FIXTURE/bad.tgz"
bad_expected_sha="$(shasum -a 256 "$FIXTURE/expected.tgz" | awk '{print $1}')"
bad_expected_size="$(wc -c < "$FIXTURE/expected.tgz" | tr -d '[:space:]')"
python3 - \
  "$FIXTURE/catalog.json" \
  "$bad_expected_sha" "$bad_expected_size" \
  "$license_sha" "$license_size" <<'PY'
import json
import sys

path, expected_sha, expected_size, license_sha, license_size = sys.argv[1:]
catalog = {
    "formatVersion": 1,
    "packages": [
        {
            "id": "bad",
            "name": "bad",
            "version": "0.0.0",
            "requiredPackageIds": [],
            "license": {
                "licenseFile": "LICENSE-Solar.txt",
                "sha256": license_sha,
                "size": int(license_size),
            },
            "artifact": {
                "file": "bad.tgz",
                "sha256": expected_sha,
                "size": int(expected_size),
            },
        }
    ],
}
with open(path, "w", encoding="utf-8") as stream:
    json.dump(catalog, stream)
PY

if PATH="$FAKE_BIN:$PATH" \
  CURATED_TEST_EVENTS="$EVENTS" \
  CURATED_TEST_FIXTURE="$FIXTURE" \
  CURATED_TEST_CLI_LOG="$CLI_LOG" \
  DSH_HOME="$DSH_HOME" \
  DSH_CLI="$FAKE_BIN/dsh" \
  "$INSTALLER" --ref aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bad \
  > "$TEMP_ROOT/checksum.stdout" 2> "$TEMP_ROOT/checksum.stderr"
then
  printf 'checksum mismatch unexpectedly installed a package\n' >&2
  exit 1
fi
grep -q 'checksum differs' "$TEMP_ROOT/checksum.stderr"
[ ! -s "$CLI_LOG" ]

: > "$EVENTS"
: > "$CLI_LOG"
MISSING_HOME="$TEMP_ROOT/missing-home"
if PATH="$FAKE_BIN:$PATH" \
  CURATED_TEST_EVENTS="$EVENTS" \
  CURATED_TEST_FIXTURE="$FIXTURE" \
  CURATED_TEST_CLI_LOG="$CLI_LOG" \
  DSH_HOME="$MISSING_HOME" \
  DSH_CLI="$FAKE_BIN/dsh" \
  "$INSTALLER" --ref aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bad \
  > "$TEMP_ROOT/missing-profile.stdout" 2> "$TEMP_ROOT/missing-profile.stderr"
then
  printf 'missing profile unexpectedly reached installation\n' >&2
  exit 1
fi
grep -q 'desktop profile package.json is missing' "$TEMP_ROOT/missing-profile.stderr"
[ ! -s "$EVENTS" ]
[ ! -s "$CLI_LOG" ]

printf 'ok: curated installer supports standalone immutable listing, caches stable bytes before CLI use, orders dependencies, reconstructs parts, and rejects checksum or profile failures before CLI use\n'
