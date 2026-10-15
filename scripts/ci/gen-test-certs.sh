#!/usr/bin/env bash
# Generates a THROWAWAY certificate set for the TLS integration tests (never for real use):
#   ca.crt / ca.key          trusted test CA
#   untrusted-ca.crt         an unrelated CA that did not sign the server certificate
#   server.crt / server.key  server certificate for localhost + 127.0.0.1, signed by ca.crt
# Usage: scripts/ci/gen-test-certs.sh <empty-output-dir>
set -euo pipefail
out="${1:?usage: gen-test-certs.sh <output-dir>}"
mkdir -p "$out"
cd "$out"
umask 077

ca() { # <name>
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$1.key" -out "$1.crt" -days 2 -subj "/CN=petra-test-$1" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
}
ca ca
ca untrusted-ca

openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=localhost" 2>/dev/null
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 2 -extfile server.ext 2>/dev/null
rm -f server.csr server.ext ca.srl untrusted-ca.key
chmod 644 ca.crt untrusted-ca.crt server.crt
echo "certificates written to $out"
