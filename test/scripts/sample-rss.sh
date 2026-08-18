#!/usr/bin/env bash
# Epic presigned-media-upload — Task 004/020: lấy mẫu RSS (peak RAM) của process Breads-Be trong
# lúc chạy test/media-upload-bench.js. k6 chạy trong container/VU riêng, không truy cập được process
# server host, nên phải đo bằng script ngoài chạy song song (xem comment đầu media-upload-bench.js).
#
# Usage:
#   ./test/scripts/sample-rss.sh <PID> [interval_seconds]
#   # Chạy song song lúc k6 đang chạy, output ra stdout — redirect vào test/results/ khi dùng thật:
#   ./test/scripts/sample-rss.sh 12345 0.2 > test/results/$(date -u +%Y-%m-%dT%H-%M-%SZ)__media-bench-rss.log
#
# Dừng bằng Ctrl+C khi k6 chạy xong. Sau đó lấy giá trị lớn nhất trong log làm "peak RSS":
#   awk '{print $2}' <log-file> | sort -n | tail -1

set -euo pipefail

PID="${1:?Usage: sample-rss.sh <PID> [interval_seconds]}"
INTERVAL="${2:-0.5}"

echo "# timestamp_iso rss_kb (PID=$PID, interval=${INTERVAL}s)"
while kill -0 "$PID" 2>/dev/null; do
  ts="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
  rss="$(ps -o rss= -p "$PID" 2>/dev/null | tr -d ' ')"
  if [ -n "$rss" ]; then
    echo "$ts $rss"
  fi
  sleep "$INTERVAL"
done
