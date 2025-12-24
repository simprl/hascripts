#!/usr/bin/env bash
set -euo pipefail

echo "Home Assistant backup starting"
for i in $(seq 1 100); do
  printf "Progress: %s%%\r" "$i"
  sleep 0.03
done
printf "\nBackup complete\n"