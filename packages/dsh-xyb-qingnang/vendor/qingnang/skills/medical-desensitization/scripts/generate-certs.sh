#!/usr/bin/env bash
set -euo pipefail

cert_dir="certificates"
cert_file="${cert_dir}/localhost.pem"
key_file="${cert_dir}/localhost-key.pem"

mkdir -p "${cert_dir}"

if command -v mkcert >/dev/null 2>&1; then
  mkcert -install
  mkcert -key-file "${key_file}" -cert-file "${cert_file}" localhost 127.0.0.1 ::1
else
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 365 \
    -keyout "${key_file}" \
    -out "${cert_file}" \
    -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1"
fi

printf 'Generated %s and %s\n' "${cert_file}" "${key_file}"
