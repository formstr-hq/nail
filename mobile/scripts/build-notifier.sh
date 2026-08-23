#!/usr/bin/env bash
# Cross-compiles the `notifier` Rust crate for Android and generates its Kotlin
# bindings, dropping both into the app module. Invoked by Gradle (preBuild) and
# runnable by hand. Idempotent; outputs are git-ignored build artifacts.
#
#   mobile/android/app/src/main/jniLibs/<abi>/libnotifier.so   (the native lib)
#   mobile/android/app/src/main/java/uniffi/notifier/*.kt      (the bindings)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mobile="$(dirname "$here")"
repo="$(dirname "$mobile")"
crate="$repo/notifier"
jni="$mobile/android/app/src/main/jniLibs"
bindings="$mobile/android/app/src/main/java"

# Locate an NDK: honour ANDROID_NDK_HOME, else pick the highest version under
# the SDK so a fresh checkout builds without extra env.
if [[ -z "${ANDROID_NDK_HOME:-}" ]]; then
  sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
  if [[ -d "$sdk/ndk" ]]; then
    ANDROID_NDK_HOME="$sdk/ndk/$(ls "$sdk/ndk" | sort -V | tail -1)"
  fi
fi
export ANDROID_NDK_HOME
[[ -d "${ANDROID_NDK_HOME:-/nonexistent}" ]] || {
  echo "build-notifier: no Android NDK found (set ANDROID_NDK_HOME)" >&2
  exit 1
}
echo "build-notifier: NDK=$ANDROID_NDK_HOME"

# Run from the crate dir so cargo/cargo-ndk resolve its Cargo.toml regardless of
# the caller's working directory (Gradle invokes this from android/). Output
# paths are absolute, so the cd is safe.
cd "$crate"

# minSdk 23 must match variables.gradle. Defaults to all device ABIs
# Zapstore/Play serve; NOTIFIER_ABIS overrides for CI builds that only
# care about regular phones/tablets (arm64-v8a).
abis="${NOTIFIER_ABIS:-arm64-v8a armeabi-v7a x86_64}"
cargo_ndk_args=()
for abi in ${abis}; do
  cargo_ndk_args+=(-t "${abi}")
done
cargo ndk "${cargo_ndk_args[@]}" -P 23 -o "$jni" build --release

# Generate Kotlin from the freshly-built library (any ABI carries the metadata).
first_abi="${abis%% *}"
cargo run --quiet --bin uniffi-bindgen -- \
  generate \
  --library "$jni/${first_abi}/libnotifier.so" \
  --language kotlin \
  --out-dir "$bindings"

echo "build-notifier: done"
