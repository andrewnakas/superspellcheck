#!/usr/bin/env bash
# Download public spelling-error corpora used for evaluation (not redistributed).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data
base=https://www.dcs.bbk.ac.uk/~ROGER
for f in missp.dat aspell.dat wikipedia.dat holbrook-missp.dat; do
  [ -s "data/$f" ] || curl -sSL -o "data/$f" "$base/$f"
done
# Clean prose for false-positive and in-context tests (public domain, Peter Norvig's corpus)
[ -s data/big.txt ] || curl -sSL -o data/big.txt https://norvig.com/big.txt
echo "corpora ready in bench/data"
