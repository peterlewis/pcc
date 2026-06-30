#!/usr/bin/env python3
"""Native test for clock-chrony-bridge: struct layout, offset math, NMEA parsing,
fix-gating and dedupe — verified by decoding what arrives at a mock chrony SOCK.
Run:  python3 test_bridge.py
"""
import argparse
import importlib.util
import os
import socket
import struct
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("bridge", os.path.join(HERE, "clock-chrony-bridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

fails = 0


def check(name, cond):
    global fails
    print(f"  {'ok  ' if cond else 'FAIL'} {name}")
    if not cond:
        fails += 1


def nmea(body: str) -> str:
    ck = 0
    for c in body:
        ck ^= ord(c)
    return f"${body}*{ck:02X}"


def decode_sample(buf: bytes):
    s = bridge.SockSample.from_buffer_copy(buf)
    tv = s.tv.tv_sec + s.tv.tv_usec / 1e6
    return tv, s.offset, s.pulse, s.leap, s.magic


def main():
    tmp = tempfile.mkdtemp()
    sock_path = os.path.join(tmp, "chrony.sock")
    mock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    mock.bind(sock_path)               # bind BEFORE the bridge connects
    mock.settimeout(0.5)

    args = argparse.Namespace(sock=sock_path, offset=0.0, require_pps=False, verbose=False)
    br = bridge.Bridge(args)

    def feed(line, recv_t):
        br.handle_line(line, recv_t)

    def drain():
        out = []
        while True:
            try:
                out.append(mock.recv(256))
            except socket.timeout:
                return out

    # struct size contract: 40 bytes on any 64-bit-time_t platform (incl. 32-bit Pi OS)
    check("SockSample is 40 bytes (64-bit time_t layout)", ctypes_sizeof() == 40)

    # 1) valid $PMTXTS with a fix -> one sample, exact time reconstruction
    E = 1_900_000_000          # ~2030, passes plausibility gate
    line = nmea(f"PMTXTS,42,{E},0,87,79999,0,112,33,7")   # flags 7 -> data_valid set
    feed(line, E + 0.250)      # simulate 250 ms GPS->host latency
    pkts = drain()
    check("valid PMTXTS -> exactly 1 datagram", len(pkts) == 1)
    if pkts:
        tv, offset, pulse, leap, magic = decode_sample(pkts[0])
        check("magic is 'SOCK'", magic == bridge.MAGIC)
        check("pulse == 0 (in-band time sample)", pulse == 0)
        check("leap == 0", leap == 0)
        check("offset reflects 250 ms latency (~-0.25 s)", abs(offset - (-0.250)) < 1e-4)
        check("tv + offset reconstructs the GPS second exactly", abs((tv + offset) - E) < 1e-4)

    # 2) same second again -> deduped (no new datagram)
    feed(nmea(f"PMTXTS,43,{E},0,90,79999,0,112,33,7"), E + 0.251)
    check("duplicate second is deduped", len(drain()) == 0)

    # 3) next second -> a new sample
    feed(nmea(f"PMTXTS,44,{E+1},0,90,79999,0,112,33,7"), E + 1.250)
    check("next second -> new datagram", len(drain()) == 1)

    # 4) no-fix PMTXTS (flags bit0 clear, e.g. 6) -> rejected
    feed(nmea(f"PMTXTS,45,{E+2},0,90,79999,0,112,33,6"), E + 2.250)
    check("no-fix PMTXTS rejected", len(drain()) == 0)

    # 5) corrupted checksum -> rejected
    bad = nmea(f"PMTXTS,46,{E+3},0,90,79999,0,112,33,7")[:-1] + "0"
    feed(bad, E + 3.250)
    check("bad checksum rejected", len(drain()) == 0)

    # 6) RMC fallback parses and reconstructs UTC
    #    2030-01-01 00:00:05 UTC  -> unix 1893456005
    rmc = nmea("GPRMC,000005.00,A,5128.00,N,00007.00,W,0.0,0.0,010130,,,A")
    rmc_unix = 1893456005
    feed(rmc, rmc_unix + 0.300)
    pkts = drain()
    check("valid RMC -> 1 datagram", len(pkts) == 1)
    if pkts:
        tv, offset, *_ = decode_sample(pkts[0])
        check("RMC reconstructs the UTC second", abs((tv + offset) - rmc_unix) < 1e-3)

    # 7) void RMC (status V) -> rejected
    feed(nmea("GPRMC,000007.00,V,,,,,,,010130,,,N"), rmc_unix + 2.3)
    check("void RMC rejected", len(drain()) == 0)

    # 8) implausible year -> rejected
    feed(nmea("PMTXTS,1,100,0,1,79999,0,1,20,7"), 100 + 0.1)
    check("implausible reference rejected", len(drain()) == 0)

    mock.close()
    print(f"\n{'ALL PASS' if not fails else str(fails) + ' FAILED'}  (struct size = {ctypes_sizeof()} bytes)")
    return 1 if fails else 0


def ctypes_sizeof():
    import ctypes
    return ctypes.sizeof(bridge.SockSample)


if __name__ == "__main__":
    raise SystemExit(main())
