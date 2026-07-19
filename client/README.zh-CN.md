[English](README.md) · **简体中文**

# qbit-swap client library (JS)

原子兑换客户端中与运行环境无关的核心部分——浏览器 Web 应用和任何无界面做市 **bot**（Node）
所使用的都是这同一份代码。纯粹的兑换加密与交易构造；没有 UI，也不对网络做任何假设。

- **Qbit 分支（后量子）：** p2mr HTLC 叶子、P2MR/BIP-341 签名哈希，通过 `../wasm` 中的 WASM
  模块进行 SLH-DSA 签名。
- **Bitcoin 分支：** P2WSH 哈希时间锁合约（HTLC）、BIP-143 签名哈希、ECDSA（`@noble/secp256k1`）。

链上访问（注资 / 监听 / 抗重组确认 / 广播）以及交易双方之间的中继都位于调用方——浏览器与协调器
通信，而 bot 使用它自己的节点 RPC。本库只负责构造与签名。

## Validation (all against regtest nodes built from `main`)
- `node test.js` —— p2mr 叶子根、bech32m 地址以及 P2MR 签名哈希均与黄金测试向量匹配。
- `node claim_e2e.js` —— 一笔完全在 JS 中构造并签名（WASM SLH-DSA）的 p2mr HTLC 领取交易被
  qbit 节点接受；原像在链上被揭示。
- `node btc_e2e.js` —— 一笔 P2WSH HTLC 领取交易和一笔受 CLTV 约束的退款交易被 bitcoind 接受。

## Notes
- ECDSA 签名必须向 noble 传入 `{ prehash: false }`，使其对原始的 BIP-143 摘要（bitcoin
  double-SHA256）进行签名，而不是 `sha256(digest)`。
- WASM 签名器通过 `signer.js` 加载；在浏览器构建中，同一个 Emscripten 模块以
  `ENVIRONMENT=web` 加载。
