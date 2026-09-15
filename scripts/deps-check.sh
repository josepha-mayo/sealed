#!/usr/bin/env bash
# Print the resolved versions of the JS deps that must agree (anchor <-> web3.js <-> arcium client).
cd "$(dirname "$0")/.."
node -e 'const p=require("@anchor-lang/core/package.json"); console.log("@anchor-lang/core", p.version, p.dependencies["@solana/web3.js"])'
node -e 'console.log("@solana/web3.js (hoisted)", require("@solana/web3.js/package.json").version)'
node -e 'const p=require("@arcium-hq/client/package.json"); console.log("@arcium-hq/client", p.version, JSON.stringify(p.dependencies))'
for d in node_modules/@anchor-lang/core/node_modules/@solana/web3.js node_modules/@arcium-hq/client/node_modules/@solana/web3.js; do
  [ -f "$d/package.json" ] && node -e "console.log('nested $d', require('./$d/package.json').version)"
done
true
