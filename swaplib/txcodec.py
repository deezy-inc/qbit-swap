"""Minimal BIP-144 segwit transaction codec (parse + serialize with witnesses)."""

class _R:
    def __init__(s, b): s.b, s.i = b, 0
    def take(s, n): v = s.b[s.i:s.i+n]; s.i += n; return v
    def u(s, n): return int.from_bytes(s.take(n), "little")
    def cs(s):
        x = s.u(1)
        if x < 0xfd: return x
        if x == 0xfd: return s.u(2)
        if x == 0xfe: return s.u(4)
        return s.u(8)

def cs_enc(n):
    if n < 0xfd: return bytes([n])
    if n <= 0xffff: return b"\xfd" + n.to_bytes(2, "little")
    if n <= 0xffffffff: return b"\xfe" + n.to_bytes(4, "little")
    return b"\xff" + n.to_bytes(8, "little")

def parse_tx(hexstr):
    r = _R(bytes.fromhex(hexstr))
    version = r.u(4)
    segwit = False
    if r.b[r.i] == 0x00 and r.b[r.i+1] == 0x01:
        r.take(2); segwit = True
    vin = []
    for _ in range(r.cs()):
        prevout = r.take(32); vout = r.u(4)
        script = r.take(r.cs()); seq = r.u(4)
        vin.append([prevout, vout, script, seq])
    vout_ = []
    for _ in range(r.cs()):
        val = r.u(8); spk = r.take(r.cs())
        vout_.append([val, spk])
    wit = [[] for _ in vin]
    if segwit:
        for k in range(len(vin)):
            wit[k] = [r.take(r.cs()) for _ in range(r.cs())]
    locktime = r.u(4)
    return {"version": version, "vin": vin, "vout": vout_, "wit": wit, "locktime": locktime}

def serialize_tx(t):
    o = t["version"].to_bytes(4, "little") + b"\x00\x01"
    o += cs_enc(len(t["vin"]))
    for prevout, vout, script, seq in t["vin"]:
        o += prevout + vout.to_bytes(4, "little") + cs_enc(len(script)) + script + seq.to_bytes(4, "little")
    o += cs_enc(len(t["vout"]))
    for val, spk in t["vout"]:
        o += val.to_bytes(8, "little") + cs_enc(len(spk)) + spk
    for stack in t["wit"]:
        o += cs_enc(len(stack))
        for item in stack:
            o += cs_enc(len(item)) + item
    o += t["locktime"].to_bytes(4, "little")
    return o.hex()
