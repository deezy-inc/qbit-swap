#!/usr/bin/env bash
# Build the WASM SLH-DSA signer. Requires emsdk (source emsdk_env.sh first).
# Set VENDOR to the libbitcoinpqc vendor dir (default: the one in qbit-stack/ops/vanity).
set -euo pipefail
VENDOR=${VENDOR:-$HOME/qbit-stack/ops/vanity/vendor/libbitcoinpqc}
CF="-O3 -DNDEBUG -DPARAMS=sphincs-sha2-128s-bounded30 -DCUSTOM_RANDOMBYTES=1 -DSPX_PRODUCTION_BUILD=1 \
    -DBITCOINPQC_FORSC_MAX_GRIND_ATTEMPTS=1835008 -DBITCOINPQC_WOTSC_MAX_COUNTER=65535 \
    -I$VENDOR/include -I$VENDOR/sphincsplus/ref"
# portable sha2 only -- the x86 (sha2_x86_shani) and arm (sha2_armv8_sha) files don't target WASM
REF=$VENDOR/sphincsplus/ref
SRC="$REF/address.c $REF/fors.c $REF/hash_sha2.c $REF/merkle.c $REF/sha2.c $REF/sign.c $REF/sign_stats.c \
     $REF/thash_sha2_simple.c $REF/utils.c $REF/utilsx1.c $REF/wots.c $REF/wotsx1.c $REF/randombytes_custom.c \
     $VENDOR/src/bitcoinpqc.c $VENDOR/src/slh_dsa/utils.c $VENDOR/src/slh_dsa/keygen.c \
     $VENDOR/src/slh_dsa/validate.c $VENDOR/src/slh_dsa/sign.c $VENDOR/src/slh_dsa/verify.c pqc_wasm.c"
emcc $CF $SRC \
  -s WASM=1 -s MODULARIZE=1 -s EXPORT_NAME=PQCModule \
  -s "EXPORTED_RUNTIME_METHODS=['ccall','cwrap','HEAPU8','HEAP32','getValue','setValue']" \
  -s "EXPORTED_FUNCTIONS=['_pqc_keygen','_pqc_sign','_pqc_verify','_pqc_sig_size','_pqc_sk_size','_pqc_pk_size','_malloc','_free']" \
  -s ALLOW_MEMORY_GROWTH=1 -s ENVIRONMENT=node,web -o pqc_signer.js
echo "built pqc_signer.js + pqc_signer.wasm"
