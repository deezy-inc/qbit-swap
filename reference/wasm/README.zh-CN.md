[English](README.md) · **简体中文**

# WASM SLH-DSA signer

浏览器 swap 客户端中较为特殊的部分——Qbit 的后量子签名——被编译为 WebAssembly。
客户端所需的其他一切（P2MR/BIP-341 sighash、tx 序列化、bech32m、用于 BTC 支路的 secp256k1/ECDSA）
都很常规，用 JS 实现；而这一部分则必须是随仓库附带的
`libbitcoinpqc`（SLH-DSA-SHA2-128s-bounded30），以便与链逐字节一致。

## Build
需要 Emscripten（`emsdk`）。在本目录下，在已 source `emsdk_env.sh` 的情况下：
```sh
# compiles the vendored libbitcoinpqc (portable sha2 only; x86/arm SHA files excluded) + pqc_wasm.c
# -> pqc_signer.js (glue) + pqc_signer.wasm (~44 KB)
# see the emcc invocation used to produce these (documented in build.sh)
```
导出：`pqc_keygen(random_data128 -> pk32, sk64)`、`pqc_sign(sk64, msg -> sig)`、`pqc_verify`，
以及大小访问器。

## Validation (`node test.js`)
- `keygen(0x20×128)` 复现出黄金公钥 `ff39b4ff…571e`（即 p2mr 见证向量密钥）。
- `pqc_sign` 的输出与原生的 `../pqcsign` **逐字节一致**——SLH-DSA 是
  确定性的，而原生签名已被节点接受，因此逐字节相同 ⇒ 节点可接受。
- `pqc_verify` 接受有效签名，并拒绝被篡改的签名。

## End-to-end (`../wasm_claim_e2e.py`)
构建一个真实的 p2mr HTLC claim，用**这个 WASM 签名器**对 P2MR sighash 签名，并将其广播到
从源码构建的节点——该节点接受了它，且该 claim 在链上揭示了 preimage。
证明浏览器签名路径能够对真实节点正常工作。
