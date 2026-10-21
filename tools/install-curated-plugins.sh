#!/usr/bin/env bash
# Download and install explicitly selected, catalog-verified plugin archives.
#
# The catalog and every artifact are fetched from the same full Git commit.
# This script intentionally does not start, stop, or configure DeepSeek Harness.

set -euo pipefail
IFS=$'\n\t'
umask 077

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
readonly REPOSITORY_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)"
readonly LOCAL_CATALOG="$REPOSITORY_ROOT/distribution/plugins/catalog.json"
readonly RAW_BASE="https://raw.githubusercontent.com/lisihao/deepseek-solar-harness"
readonly DEFAULT_DSH_CLI="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:
  tools/install-curated-plugins.sh --list
  tools/install-curated-plugins.sh --ref <40-hex-git-commit> --list
  tools/install-curated-plugins.sh --ref <40-hex-git-commit> <package-id> [<package-id>...]

The --list form without --ref reads the checked-in catalog. With --ref it
downloads the catalog at that immutable commit; neither form checks the app or
installs a package. Installation requires an explicit immutable commit and one
or more package ids. The script never installs every catalog entry automatically.

Environment:
  DSH_HOME  Harness home to update (default: $HOME/.dsh)
  DSH_CLI   Absolute path to the official dsh CLI
USAGE
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

process_must_be_stopped() {
  local label="$1"
  local pattern="$2"
  local status
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    die "$label appears to be active; quit it yourself before changing the desktop profile"
  else
    status=$?
    if [ "$status" -ne 1 ]; then
      die "could not inspect processes while checking $label (pgrep exited $status)"
    fi
  fi
}

verify_file() {
  local path="$1"
  local expected_sha="$2"
  local expected_size="$3"
  local actual_sha
  local actual_size
  actual_size="$(wc -c < "$path" | tr -d '[:space:]')"
  [ "$actual_size" = "$expected_size" ] || die "downloaded file size differs for $(basename "$path")"
  actual_sha="$(shasum -a 256 "$path" | awk '{print $1}')"
  [ "$actual_sha" = "$expected_sha" ] || die "downloaded file checksum differs for $(basename "$path")"
}

download_file() {
  local relative_path="$1"
  local destination="$2"
  curl --fail --location --silent --show-error --output "$destination" \
    "$RAW_BASE/$REF/distribution/plugins/$relative_path"
}

emit_install_plan() {
  local catalog_path="$1"
  local plan_path="$2"
  shift 2
  python3 - "$catalog_path" "$plan_path" "$@" <<'PY'
import json
import re
import sys

catalog_path, plan_path, *requested = sys.argv[1:]
sha_re = re.compile(r"^[0-9a-f]{64}$")
path_re = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")
id_re = re.compile(r"^[a-z0-9][a-z0-9-]*$")
max_part_size = 40 * 1024 * 1024

def fail(message):
    raise SystemExit(f"catalog error: {message}")

try:
    with open(catalog_path, encoding="utf-8") as stream:
        catalog = json.load(stream)
except (OSError, json.JSONDecodeError) as error:
    fail(f"cannot read catalog: {error}")

if not isinstance(catalog, dict) or catalog.get("formatVersion") != 1:
    fail("formatVersion must be 1")
packages = catalog.get("packages")
if not isinstance(packages, list):
    fail("packages must be an array")
if not requested:
    fail("at least one package id is required")
if len(set(requested)) != len(requested):
    fail("package ids must not repeat")

by_id = {}
licenses = {}
for package in packages:
    if not isinstance(package, dict):
        fail("every package must be an object")
    package_id = package.get("id")
    if not isinstance(package_id, str) or not id_re.fullmatch(package_id):
        fail("every package needs a lowercase package id safe for a cache filename")
    if package_id in by_id:
        fail(f"duplicate package id {package_id!r}")
    name = package.get("name")
    if not isinstance(name, str) or not name:
        fail(f"{package_id}: name is missing")
    dependencies = package.get("requiredPackageIds")
    if not isinstance(dependencies, list) or not all(isinstance(item, str) for item in dependencies):
        fail(f"{package_id}: requiredPackageIds must be an array of strings")
    artifact = package.get("artifact")
    if not isinstance(artifact, dict):
        fail(f"{package_id}: artifact is missing")
    has_file = "file" in artifact
    has_parts = "parts" in artifact
    if has_file == has_parts:
        fail(f"{package_id}: artifact must have exactly one of file or parts")
    if not isinstance(artifact.get("sha256"), str) or not sha_re.fullmatch(artifact["sha256"]):
        fail(f"{package_id}: artifact sha256 is invalid")
    if isinstance(artifact.get("size"), bool) or not isinstance(artifact.get("size"), int) or artifact["size"] < 0:
        fail(f"{package_id}: artifact size is invalid")
    entries = [artifact] if has_file else artifact.get("parts")
    if not isinstance(entries, list):
        entries = [artifact]
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            fail(f"{package_id}: artifact entry {index} is invalid")
        path = entry.get("file")
        if not isinstance(path, str) or not path_re.fullmatch(path) or ".." in path.split("/"):
            fail(f"{package_id}: artifact entry {index} has an unsafe path")
        if not isinstance(entry.get("sha256"), str) or not sha_re.fullmatch(entry["sha256"]):
            fail(f"{package_id}: artifact entry {index} has an invalid sha256")
        if isinstance(entry.get("size"), bool) or not isinstance(entry.get("size"), int) or entry["size"] < 0:
            fail(f"{package_id}: artifact entry {index} has an invalid size")
        if has_parts:
            if not path.endswith(f".part{index:02d}"):
                fail(f"{package_id}: artifact part {index} has a non-deterministic name")
            if entry["size"] > max_part_size:
                fail(f"{package_id}: artifact part {index} exceeds {max_part_size} bytes")
    license_data = package.get("license")
    if not isinstance(license_data, dict):
        fail(f"{package_id}: license is missing")
    license_file = license_data.get("licenseFile")
    if not isinstance(license_file, str) or not license_file:
        fail(f"{package_id}: licenseFile is invalid")
    if not license_file.startswith("package/"):
        if not path_re.fullmatch(license_file) or ".." in license_file.split("/"):
            fail(f"{package_id}: licenseFile has an unsafe path")
        license_sha = license_data.get("sha256")
        license_size = license_data.get("size")
        if not isinstance(license_sha, str) or not sha_re.fullmatch(license_sha):
            fail(f"{package_id}: sidecar license sha256 is invalid")
        if isinstance(license_size, bool) or not isinstance(license_size, int) or license_size < 0:
            fail(f"{package_id}: sidecar license size is invalid")
        entry = {"file": license_file, "sha256": license_sha, "size": license_size}
        previous = licenses.get(license_file)
        if previous is not None and previous != entry:
            fail(f"{package_id}: sidecar license metadata conflicts for {license_file!r}")
        licenses[license_file] = entry
    by_id[package_id] = package

for package_id in requested:
    if package_id not in by_id:
        fail(f"unknown package id {package_id!r}")

ordered = []
visiting = set()
visited = set()
def visit(package_id):
    if package_id in visited:
        return
    if package_id in visiting:
        fail(f"requiredPackageIds cycle at {package_id!r}")
    visiting.add(package_id)
    for dependency in by_id[package_id]["requiredPackageIds"]:
        if dependency not in by_id:
            fail(f"{package_id}: required package {dependency!r} is not in the catalog")
        visit(dependency)
    visiting.remove(package_id)
    visited.add(package_id)
    ordered.append(by_id[package_id])

for package_id in requested:
    visit(package_id)

selected_licenses = {}
for package in ordered:
    license_file = package["license"]["licenseFile"]
    if not license_file.startswith("package/"):
        selected_licenses[license_file] = licenses[license_file]

with open(plan_path, "w", encoding="utf-8") as stream:
    json.dump(
        {
            "packages": [
                {"id": package["id"], "name": package["name"], "artifact": package["artifact"]}
                for package in ordered
            ],
            "licenses": [selected_licenses[path] for path in sorted(selected_licenses)],
        },
        stream,
        separators=(",", ":"),
    )
PY
}

emit_download_entries() {
  python3 - "$1" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    plan = json.load(stream)
for package in plan["packages"]:
    artifact = package["artifact"]
    if "file" in artifact:
        print("\t".join(("file", package["id"], "0", artifact["file"], artifact["sha256"], str(artifact["size"]))))
    else:
        for index, part in enumerate(artifact["parts"]):
            print("\t".join(("part", package["id"], str(index), part["file"], part["sha256"], str(part["size"]))))
PY
}

emit_multipart_packages() {
  python3 - "$1" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    plan = json.load(stream)
for package in plan["packages"]:
    artifact = package["artifact"]
    if "parts" in artifact:
        print("\t".join((package["id"], artifact["sha256"], str(artifact["size"]), str(len(artifact["parts"])))))
PY
}

emit_package_ids() {
  python3 - "$1" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    plan = json.load(stream)
for package in plan["packages"]:
    print(package["id"])
PY
}

emit_license_entries() {
  python3 - "$1" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    plan = json.load(stream)
for license_data in plan.get("licenses", []):
    print("\t".join((license_data["file"], license_data["sha256"], str(license_data["size"]))))
PY
}

promote_verified_file() {
  local source_path="$1"
  local destination_path="$2"
  local expected_sha="$3"
  local expected_size="$4"
  local staging_path
  if [ -e "$destination_path" ]; then
    [ -f "$destination_path" ] || die "cached path is not a regular file: $destination_path"
    verify_file "$destination_path" "$expected_sha" "$expected_size"
    return
  fi
  mkdir -p "$(dirname -- "$destination_path")"
  staging_path="$destination_path.pending-$$"
  [ ! -e "$staging_path" ] || die "cache staging path already exists: $staging_path"
  cp -p "$source_path" "$staging_path"
  verify_file "$staging_path" "$expected_sha" "$expected_size"
  mv "$staging_path" "$destination_path"
}

cache_catalog() {
  local source_path="$1"
  local destination_path="$2"
  if [ -e "$destination_path" ]; then
    cmp -s "$source_path" "$destination_path" || die "cached catalog differs for immutable ref $REF"
    return
  fi
  mkdir -p "$(dirname -- "$destination_path")"
  cp -p "$source_path" "$destination_path"
}

list_packages() {
  python3 - "$1" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    catalog = json.load(stream)
if not isinstance(catalog, dict) or catalog.get("formatVersion") != 1:
    raise SystemExit("catalog error: formatVersion must be 1")
packages = catalog.get("packages")
if not isinstance(packages, list):
    raise SystemExit("catalog error: packages must be an array")
for package in packages:
    if not isinstance(package, dict):
        raise SystemExit("catalog error: every package must be an object")
    package_id = package.get("id")
    name = package.get("name")
    version = package.get("version")
    if not all(isinstance(value, str) and value for value in (package_id, name, version)):
        raise SystemExit("catalog error: package id, name, and version are required")
    print(f"{package_id}\t{name}\t{version}")
PY
}

MODE="install"
REF=""
SELECTED=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --list)
      [ "$MODE" = "install" ] || die "--list may be specified only once"
      MODE="list"
      shift
      ;;
    --ref)
      [ "$#" -ge 2 ] || die "--ref requires a full 40-character commit"
      [ -z "$REF" ] || die "--ref may be specified only once"
      REF="$2"
      shift 2
      ;;
    --)
      shift
      while [ "$#" -gt 0 ]; do
        SELECTED+=("$1")
        shift
      done
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      SELECTED+=("$1")
      shift
      ;;
  esac
done

require_command python3
if [ "$MODE" = "list" ]; then
  [ "${#SELECTED[@]}" -eq 0 ] || die "--list cannot be combined with package ids"
  if [ -n "$REF" ]; then
    [[ "$REF" =~ ^[0-9a-f]{40}$ ]] || die "--ref must be a lowercase 40-character commit SHA"
    require_command curl
    require_command mktemp
    LIST_TEMP_ROOT="$(mktemp -d -t dsh-curated-list)"
    trap 'rm -rf "$LIST_TEMP_ROOT"' EXIT HUP INT TERM
    LIST_CATALOG="$LIST_TEMP_ROOT/catalog.json"
    curl --fail --location --silent --show-error --output "$LIST_CATALOG" \
      "$RAW_BASE/$REF/distribution/plugins/catalog.json"
    list_packages "$LIST_CATALOG"
  else
    [ -f "$LOCAL_CATALOG" ] || die "checked-in catalog is missing; use --ref <40-hex-git-commit> --list"
    list_packages "$LOCAL_CATALOG"
  fi
  exit 0
fi

[ -n "$REF" ] || die "installation requires --ref <40-hex-git-commit>"
[[ "$REF" =~ ^[0-9a-f]{40}$ ]] || die "--ref must be a lowercase 40-character commit SHA"
[ "${#SELECTED[@]}" -gt 0 ] || die "installation requires at least one explicit package id"

[ "$(uname -s)" = "Darwin" ] || die "this curated installer supports macOS only"
[ "$(uname -m)" = "arm64" ] || die "this curated installer supports macOS arm64 only"
require_command curl
require_command shasum
require_command wc
require_command awk
require_command tr
require_command mktemp
require_command pgrep
require_command cmp
require_command cut

DSH_HOME="${DSH_HOME:-"$HOME/.dsh"}"
case "$DSH_HOME" in
  /*) ;;
  *) die "DSH_HOME must be an absolute path" ;;
esac
PROFILE_DIR="$DSH_HOME/profiles/desktop"
[ -f "$PROFILE_DIR/package.json" ] || die "desktop profile package.json is missing: $PROFILE_DIR/package.json"

DSH_CLI="${DSH_CLI:-"$DEFAULT_DSH_CLI"}"
case "$DSH_CLI" in
  /*) ;;
  *) die "DSH_CLI must be an absolute path" ;;
esac
[ -x "$DSH_CLI" ] || die "official dsh CLI is not executable: $DSH_CLI"

assert_target_processes_stopped() {
  process_must_be_stopped \
    "DeepSeek Harness application" \
    "/Applications/DeepSeek Harness\\.app/Contents/"
  process_must_be_stopped \
    "Solar Native Resident daemon" \
    "dsh-solar-native-resident/lib/daemon\\.js.*--root"
}

assert_target_processes_stopped

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-curated-plugins.XXXXXX")"
cleanup() {
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT HUP INT TERM
DOWNLOAD_DIR="$TEMP_ROOT/downloads"
PLAN_PATH="$TEMP_ROOT/plan.json"
MAP_PATH="$TEMP_ROOT/artifacts.tsv"
STABLE_MAP_PATH="$TEMP_ROOT/stable-artifacts.tsv"
LICENSE_DOWNLOAD_DIR="$TEMP_ROOT/licenses"
mkdir -p "$DOWNLOAD_DIR"

CATALOG_PATH="$TEMP_ROOT/catalog.json"
curl --fail --location --silent --show-error --output "$CATALOG_PATH" \
  "$RAW_BASE/$REF/distribution/plugins/catalog.json"
emit_install_plan "$CATALOG_PATH" "$PLAN_PATH" "${SELECTED[@]}"

while IFS=$'\t' read -r kind package_id part_index relative_path expected_sha expected_size; do
  [ -n "$kind" ] || continue
  case "$kind" in
    file)
      destination="$DOWNLOAD_DIR/$package_id.tgz"
      download_file "$relative_path" "$destination"
      verify_file "$destination" "$expected_sha" "$expected_size"
      printf '%s\t%s\n' "$package_id" "$destination" >> "$MAP_PATH"
      ;;
    part)
      package_parts_dir="$DOWNLOAD_DIR/$package_id"
      mkdir -p "$package_parts_dir"
      destination="$package_parts_dir/$part_index.part"
      download_file "$relative_path" "$destination"
      verify_file "$destination" "$expected_sha" "$expected_size"
      ;;
    *)
      die "catalog plan has an unknown artifact kind: $kind"
      ;;
  esac
done < <(emit_download_entries "$PLAN_PATH")

while IFS=$'\t' read -r package_id expected_sha expected_size part_count; do
  [ -n "$package_id" ] || continue
  destination="$DOWNLOAD_DIR/$package_id.tgz"
  : > "$destination"
  part_index=0
  while [ "$part_index" -lt "$part_count" ]; do
    part_path="$DOWNLOAD_DIR/$package_id/$part_index.part"
    [ -f "$part_path" ] || die "catalog plan is missing downloaded part $part_index for $package_id"
    cat "$part_path" >> "$destination"
    part_index=$((part_index + 1))
  done
  verify_file "$destination" "$expected_sha" "$expected_size"
  printf '%s\t%s\n' "$package_id" "$destination" >> "$MAP_PATH"
done < <(emit_multipart_packages "$PLAN_PATH")

CACHE_ROOT="$DSH_HOME/artifacts/curated/$REF"
cache_catalog "$CATALOG_PATH" "$CACHE_ROOT/catalog.json"

while IFS=$'\t' read -r license_path expected_sha expected_size; do
  [ -n "$license_path" ] || continue
  downloaded_license="$LICENSE_DOWNLOAD_DIR/$license_path"
  mkdir -p "$(dirname -- "$downloaded_license")"
  download_file "$license_path" "$downloaded_license"
  verify_file "$downloaded_license" "$expected_sha" "$expected_size"
  promote_verified_file \
    "$downloaded_license" \
    "$CACHE_ROOT/licenses/$license_path" \
    "$expected_sha" \
    "$expected_size"
done < <(emit_license_entries "$PLAN_PATH")

while IFS= read -r package_id; do
  [ -n "$package_id" ] || continue
  temporary_artifact="$(awk -F '\t' -v expected_id="$package_id" '$1 == expected_id { print $2; exit }' "$MAP_PATH")"
  [ -n "$temporary_artifact" ] || die "verified artifact is missing for $package_id"
  expected_artifact="$(python3 - "$PLAN_PATH" "$package_id" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    plan = json.load(stream)
for package in plan["packages"]:
    if package["id"] == sys.argv[2]:
        artifact = package["artifact"]
        print("\t".join((artifact["sha256"], str(artifact["size"]))))
        break
else:
    raise SystemExit("package is missing from the installation plan")
PY
)"
  expected_sha="$(printf '%s\n' "$expected_artifact" | cut -f 1)"
  expected_size="$(printf '%s\n' "$expected_artifact" | cut -f 2)"
  stable_artifact="$CACHE_ROOT/$package_id.tgz"
  promote_verified_file "$temporary_artifact" "$stable_artifact" "$expected_sha" "$expected_size"
  printf '%s\t%s\n' "$package_id" "$stable_artifact" >> "$STABLE_MAP_PATH"
done < <(emit_package_ids "$PLAN_PATH")

assert_target_processes_stopped
BACKUP_ROOT="$DSH_HOME/solar/curated-installer/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$BACKUP_ROOT"
BACKUP_RECEIPT="$BACKUP_ROOT/receipt.tsv"
printf 'path\tstatus\n' > "$BACKUP_RECEIPT"
for profile_file in \
  package.json \
  pnpm-lock.yaml \
  pnpm-workspace.yaml \
  cordis.yml \
  cordis.patch.yml \
  compatibility.json
do
  source_path="$PROFILE_DIR/$profile_file"
  if [ -f "$source_path" ]; then
    destination="$BACKUP_ROOT/$profile_file"
    mkdir -p "$(dirname -- "$destination")"
    cp -p "$source_path" "$destination"
    printf '%s\tcopied\n' "$profile_file" >> "$BACKUP_RECEIPT"
  else
    printf '%s\tabsent\n' "$profile_file" >> "$BACKUP_RECEIPT"
  fi
done
printf 'Backed up desktop profile configuration to %s\n' "$BACKUP_ROOT"

while IFS= read -r package_id; do
  [ -n "$package_id" ] || continue
  artifact_path="$(awk -F '\t' -v expected_id="$package_id" '$1 == expected_id { print $2; exit }' "$STABLE_MAP_PATH")"
  [ -n "$artifact_path" ] || die "verified artifact is missing for $package_id"
  assert_target_processes_stopped
  DSH_HOME="$DSH_HOME" "$DSH_CLI" plugin --profile desktop add "$artifact_path"
  printf 'Installed requested curated package %s\n' "$package_id"
done < <(emit_package_ids "$PLAN_PATH")
