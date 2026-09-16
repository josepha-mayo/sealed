#!/usr/bin/env bash
docker exec artifacts-arx-node-0-1 sh -c 'f=$(ls -t /usr/arx-node/logs/ | head -1); tail -30 "/usr/arx-node/logs/$f"'
