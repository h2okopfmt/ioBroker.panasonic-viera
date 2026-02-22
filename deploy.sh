#!/bin/bash
# Deploy Panasonic Viera adapter to ioBroker Docker container on graw
HOST="graw@graw"
CONTAINER="iobroker"
DEST="/opt/iobroker/node_modules/iobroker.panasonic-viera"
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Deploying to $HOST ($CONTAINER)..."

ssh "$HOST" "mkdir -p /tmp/panasonic-viera/lib /tmp/panasonic-viera/admin"

scp -q "$DIR/main.js" "$HOST:/tmp/panasonic-viera/main.js"
scp -q "$DIR/lib/viera-client.js" "$HOST:/tmp/panasonic-viera/lib/viera-client.js"
scp -q "$DIR/admin/jsonConfig.json" "$HOST:/tmp/panasonic-viera/admin/jsonConfig.json"
scp -q "$DIR/io-package.json" "$HOST:/tmp/panasonic-viera/io-package.json"
scp -q "$DIR/package.json" "$HOST:/tmp/panasonic-viera/package.json"

ssh "$HOST" "docker cp /tmp/panasonic-viera/main.js $CONTAINER:$DEST/main.js && \
docker cp /tmp/panasonic-viera/lib/viera-client.js $CONTAINER:$DEST/lib/viera-client.js && \
docker cp /tmp/panasonic-viera/admin/jsonConfig.json $CONTAINER:$DEST/admin/jsonConfig.json && \
docker cp /tmp/panasonic-viera/io-package.json $CONTAINER:$DEST/io-package.json && \
docker cp /tmp/panasonic-viera/package.json $CONTAINER:$DEST/package.json && \
docker exec $CONTAINER iobroker restart panasonic-viera && \
rm -rf /tmp/panasonic-viera && \
echo 'Done! Adapter restarted.'"
