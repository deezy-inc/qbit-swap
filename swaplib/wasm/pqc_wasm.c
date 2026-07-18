/* Emscripten wrapper exposing the vendored libbitcoinpqc (SLH-DSA-SHA2-128s-bounded30) to JS. */
#include <libbitcoinpqc/slh_dsa.h>
#include <emscripten.h>
#include <stddef.h>

EMSCRIPTEN_KEEPALIVE int pqc_sig_size(void) { return SLH_DSA_SIGNATURE_SIZE; }
EMSCRIPTEN_KEEPALIVE int pqc_sk_size(void)  { return SLH_DSA_SECRET_KEY_SIZE; }
EMSCRIPTEN_KEEPALIVE int pqc_pk_size(void)  { return 32; }

/* random_data must be 128 bytes; writes pk(32) and sk(64). returns 0 on success. */
EMSCRIPTEN_KEEPALIVE int pqc_keygen(const unsigned char* random_data, unsigned char* pk, unsigned char* sk) {
    return slh_dsa_keygen(pk, sk, random_data, 128);
}
/* sk(64) + msg(msglen) -> sig; writes actual length to *siglen_out. returns 0 on success. */
EMSCRIPTEN_KEEPALIVE int pqc_sign(const unsigned char* sk, const unsigned char* msg, int msglen,
                                  unsigned char* sig, int* siglen_out) {
    size_t sl = SLH_DSA_SIGNATURE_SIZE;
    int r = slh_dsa_sign(sig, &sl, msg, (size_t)msglen, sk);
    *siglen_out = (int)sl;
    return r;
}
/* returns 0 if the signature is valid. */
EMSCRIPTEN_KEEPALIVE int pqc_verify(const unsigned char* sig, int siglen, const unsigned char* msg,
                                    int msglen, const unsigned char* pk) {
    return slh_dsa_verify(sig, (size_t)siglen, msg, (size_t)msglen, pk);
}
