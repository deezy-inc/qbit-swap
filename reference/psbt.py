"""Minimal PSBT builder for a p2mr HTLC input — enough to exercise walletprocesspsbt.

Produces a PSBT (BIP-174) whose single input carries the witness UTXO and the p2mr leaf script
(PSBT_IN_P2MR_LEAF_SCRIPT), so a patched node can add its partial script-path signature
(PSBT_IN_P2MR_SCRIPT_SIG, surfaced by decodepsbt as `p2mr_script_path_sigs`).
"""
import base64
from txcodec import cs_enc

PSBT_MAGIC = b"psbt\xff"
PSBT_GLOBAL_UNSIGNED_TX = 0x00
PSBT_IN_WITNESS_UTXO = 0x01
PSBT_IN_P2MR_LEAF_SCRIPT = 0x1d
P2MR_LEAF_VERSION = 0xC0

def _kv(key: bytes, val: bytes) -> bytes:
    return cs_enc(len(key)) + key + cs_enc(len(val)) + val

def build_htlc_psbt(unsigned_tx_hex: str, htlc_value_sats: int, htlc_spk: bytes,
                    leaf: bytes, control_block: bytes = b"\xc1") -> str:
    out = bytearray(PSBT_MAGIC)
    # global map
    out += _kv(bytes([PSBT_GLOBAL_UNSIGNED_TX]), bytes.fromhex(unsigned_tx_hex))
    out += b"\x00"  # end global map
    # input 0 map
    witness_utxo = htlc_value_sats.to_bytes(8, "little") + cs_enc(len(htlc_spk)) + htlc_spk
    out += _kv(bytes([PSBT_IN_WITNESS_UTXO]), witness_utxo)
    out += _kv(bytes([PSBT_IN_P2MR_LEAF_SCRIPT]) + control_block, bytes([P2MR_LEAF_VERSION]) + leaf)
    out += b"\x00"  # end input map
    # output 0 map (empty)
    out += b"\x00"
    return base64.b64encode(bytes(out)).decode()
