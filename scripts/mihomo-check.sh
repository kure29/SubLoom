#!/usr/bin/env bash
# 对 core 的全部 mihomo golden 输出（expected.mihomo.*）执行 `mihomo -t`。
# 用法：scripts/mihomo-check.sh <mihomo 可执行文件> [数据目录]
# 数据目录用于存放 GEOIP/GEOSITE 等数据文件，首次运行时由 mihomo 自动下载，所有文件共用。
set -euo pipefail

bin=${1:?usage: $0 <mihomo binary> [home dir]}
home=${2:-"${TMPDIR:-/tmp}/subloom-mihomo-home"}
root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$home"

mapfile -t files < <(find "$root/packages/core/test/fixtures" -name 'expected.mihomo.*' -type f | sort)
if [ "${#files[@]}" -eq 0 ]; then
  echo "no expected.mihomo.* files found" >&2
  exit 1
fi

"$bin" -v
failed=0
for f in "${files[@]}"; do
  rel=${f#"$root/"}
  if out=$("$bin" -d "$home" -t -f "$f" 2>&1); then
    echo "ok    $rel"
  else
    echo "FAIL  $rel"
    echo "$out" | grep -E 'level=(error|fatal)|test failed' | sed 's/^/      /' || echo "$out" | tail -5
    failed=$((failed + 1))
  fi
done

echo "${#files[@]} file(s), $failed failed"
[ "$failed" -eq 0 ]
