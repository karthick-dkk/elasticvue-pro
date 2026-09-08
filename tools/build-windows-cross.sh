#!/usr/bin/env bash
# Cross-compile the Windows portable build on Linux (Ubuntu 24.04), without any Microsoft
# toolchain: target x86_64-pc-windows-gnu, linker mingw-w64, std built from source
# (-Zbuild-std) so no rust-std download from static.rust-lang.org is needed.
#
# Idempotent: every step checks before it downloads or rebuilds.
# Result: dist/ElasticVue-Pro-portable-win64.zip  (exe + WebView2Loader.dll + example YAML)
set -euo pipefail
cd "$(dirname "$0")/.."

need() { command -v "$1" >/dev/null || return 1; }
if ! need x86_64-w64-mingw32-gcc-posix; then
  sudo apt-get install -y gcc-mingw-w64-x86-64-posix g++-mingw-w64-x86-64-posix binutils-mingw-w64-x86-64
fi
need cargo || { echo "install rust (rustup) first"; exit 1; }

# 1. standard-library source at the exact commit of the installed rustc
COMMIT=$(rustc -vV | awk '/commit-hash/ {print $2}')
SYS=$(rustc --print sysroot)
LIB="$SYS/lib/rustlib/src/rust/library"
if [ ! -f "$LIB/Cargo.lock" ] || [ "$(cat "$LIB/.commit" 2>/dev/null)" != "$COMMIT" ]; then
  echo "fetching library/ at rustc commit $COMMIT"
  rm -rf /tmp/rust-src && git init -q /tmp/rust-src && cd /tmp/rust-src
  git remote add origin https://github.com/rust-lang/rust.git
  git sparse-checkout init --cone && git sparse-checkout set library
  git fetch --depth 1 origin "$COMMIT" && git checkout -q FETCH_HEAD
  BT=$(git ls-tree FETCH_HEAD library/backtrace | awk '{print $3}')
  rm -rf /tmp/bt && git init -q /tmp/bt && cd /tmp/bt
  git remote add origin https://github.com/rust-lang/backtrace-rs.git
  git fetch --depth 1 origin "$BT" && git checkout -q FETCH_HEAD && rm -rf .git
  rm -rf "$LIB" && mkdir -p "$(dirname "$LIB")" && cp -r /tmp/rust-src/library "$LIB"
  rm -rf "$LIB/backtrace" && cp -r /tmp/bt "$LIB/backtrace"
  echo "$COMMIT" > "$LIB/.commit"
  cd - >/dev/null
fi

# 2. build
export CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc-posix
export CXX_x86_64_pc_windows_gnu=x86_64-w64-mingw32-g++-posix
export AR_x86_64_pc_windows_gnu=x86_64-w64-mingw32-ar
export RUSTC_BOOTSTRAP=1
cargo build --release -Zbuild-std=std,panic_abort,panic_unwind --target x86_64-pc-windows-gnu -p elasticvue-pro

# 3. package
OUT=target/x86_64-pc-windows-gnu/release
LOADER=$(ls -d ~/.cargo/registry/src/*/webview2-com-sys-*/x64/WebView2Loader.dll | head -1)
VER=$(grep -m1 '^version' Cargo.toml | sed 's/.*"\(.*\)".*/\1/')
D=dist/ElasticVue-Pro-portable-win64
rm -rf "$D" && mkdir -p "$D"
cp "$OUT/elasticvue-pro.exe" "$LOADER" ui/clusters.example.yaml "$D/"
cp tools/PORTABLE-README.txt "$D/README.txt"
: > "$D/portable"                                   # marker: keep all data in .\data\
mkdir -p "$D/data" "$D/WebView2Runtime"
printf 'Unpack Microsoft WebView2 Fixed Version Runtime (x64) here - see ..\\README.txt. Not needed on Windows 10/11 or Server 2019+.\r\n' > "$D/WebView2Runtime/PUT-RUNTIME-HERE.txt"
printf 'created on first run\r\n' > "$D/data/README.txt"
( cd "$D" && sha256sum elasticvue-pro.exe WebView2Loader.dll > SHA256SUMS.txt )
( cd dist && rm -f "ElasticVue-Pro-${VER}-portable-win64.zip" && zip -qr "ElasticVue-Pro-${VER}-portable-win64.zip" ElasticVue-Pro-portable-win64 )
echo "built dist/ElasticVue-Pro-${VER}-portable-win64.zip"
