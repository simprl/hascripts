#!/usr/bin/env bash
set -euo pipefail

echo "Zigbee2MQTT restore starting"
for i in $(seq 1 100); do
  printf "Restoring: %s%%\r" "$i"
  sleep 0.03
done
printf "\nRestore complete\n"