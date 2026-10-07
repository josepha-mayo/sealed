#!/usr/bin/env python3
"""Sealed — independent evidence verifier (stdlib-only Python).

This is deliberately a SECOND implementation: the TypeScript harness and
the in-browser verifier replay every check in full; this file proves the
evidence base is language-agnostic — no node_modules, no pip install,
no RPC. If this script and `chain fingerprint` agree on the BUNDLE ROOT,
the bundle is self-consistent under two independent implementations.

  python3 scripts/verify.py            # run from the repo root

Checks:
  1. every file pinned in docs/evidence/SHA256SUMS re-hashes clean
  2. every file pinned in web/MANIFEST re-hashes clean
  3. BUNDLE ROOT = sha256("sealed-fingerprint/v1\n" + evidenceRoot +
     "\n" + webRoot + "\n") — the same recipe as chain.ts
  4. the committed devnet anchor doc carries that root
  5. position PDAs re-derive from declared seeds: SHA256 over
     seeds || program_id || "ProgramDerivedAddress", rejected if the
     result lands on the ed25519 curve — the real Solana rule, not a
     lookup table. Both committed cards are checked (plain [position,
     venue, bettor] and dark [darkpos, venue, bettor, pos_salt]).
  6. bounty PDAs re-derive from [bounty, bank, sponsor, salt_u64le]
     @ the market program — the same off-curve rule, a third seed
     shape, checked on every committed sealed-bounty/v1 card.
  7. grant PDAs re-derive from [grant, bank, chunk_u16le, part_u8,
     viewer32] @ the sealed program — a fourth seed shape, and the
     viewer seed is raw x25519 bytes, not an ed25519 pubkey.
  8. account binding in Python too — the snapshot's raw account bytes
     are struct-unpacked HERE (discriminator + Bounty/ShareGrant/
     Position layouts), and every card field is compared against the
     bytes, not against TypeScript's decode. A decoder bug in
     snapshot.ts can no longer launder a forged card.
"""

import base64
import hashlib
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
B58I = {c: i for i, c in enumerate(B58)}


def b58decode(s: str) -> bytes:
    n = 0
    for c in s:
        n = n * 58 + B58I[c]
    out = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    pad = len(s) - len(s.lstrip("1"))
    return b"\x00" * pad + out


def sha256(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


# --- ed25519 point-on-curve check (the PDA rejection rule) ----------------
# Curve: -x^2 + y^2 = 1 + d x^2 y^2  over GF(p), p = 2^255 - 19.
# A compressed point is little-endian y with the x-sign bit in byte 31.
P = 2**255 - 19
D = (-121665 * pow(121666, P - 2, P)) % P
SQRT_M1 = pow(2, (P - 1) // 4, P)


def on_curve(pub: bytes) -> bool:
    # decompress: x^2 = (y^2 - 1) / (d y^2 + 1); the point exists iff a
    # square root of x^2 exists in GF(p) — the sqrt(-1) retry is part of
    # the real rule (RFC 8032 decoding).
    if len(pub) != 32:
        return False
    y = int.from_bytes(pub, "little") & ((1 << 255) - 1)
    if y >= P:
        return False
    xx = (y * y - 1) * pow(D * y * y + 1, P - 2, P) % P
    x = pow(xx, (P + 3) // 8, P)
    if (x * x - xx) % P != 0:
        x = x * SQRT_M1 % P
    return (x * x - xx) % P == 0


def pda(seeds, program_b58):
    # real Solana PDA derivation: SHA256(seeds || bump || program_id ||
    # "ProgramDerivedAddress"), bump tried 255..0 until the result lands
    # OFF the ed25519 curve (an on-curve point would have a private key).
    pid = b58decode(program_b58)
    for bump in range(255, -1, -1):
        h = hashlib.sha256()
        for s in seeds:
            h.update(s)
        h.update(bytes([bump]))
        h.update(pid)
        h.update(b"ProgramDerivedAddress")
        digest = h.digest()
        if not on_curve(digest):
            return digest
    return None


def u64le(n) -> bytes:
    return struct.pack("<Q", int(n))


def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
    return ok


def rehash(manifest_path, base_dir):
    total, bad = 0, []
    for line in manifest_path.read_text().splitlines():
        if not line.strip():
            continue
        want, rel = line.split("  ", 1)
        rel = rel.lstrip("./")
        total += 1
        got = hashlib.sha256((base_dir / rel).read_bytes()).hexdigest()
        if got != want:
            bad.append(rel)
    return total, bad


def manifest_root(manifest_path):
    # the sub-root IS the sha256 of the manifest file's raw bytes —
    # the same recipe as chainFingerprint's shaFile().
    return sha256(manifest_path.read_bytes()).hex()


def main():
    ok = True
    global SNAP
    SNAP = json.loads((ROOT / "web" / "snapshot.json").read_text())

    print("sealed-fingerprint/v1 — Python re-verification (zero deps)")
    sums = ROOT / "docs" / "evidence" / "SHA256SUMS"
    man = ROOT / "web" / "MANIFEST"

    n1, bad1 = rehash(sums, ROOT / "docs" / "evidence")
    ok &= check("evidence re-hash", not bad1, f"{n1 - len(bad1)}/{n1} files match"
                + (f" — differ: {bad1[:3]}" if bad1 else ""))
    n2, bad2 = rehash(man, ROOT / "web")
    ok &= check("web re-hash", not bad2, f"{n2 - len(bad2)}/{n2} files match"
                + (f" — differ: {bad2[:3]}" if bad2 else ""))

    eroot = manifest_root(sums)
    wroot = manifest_root(man)
    root = hashlib.sha256(
        f"sealed-fingerprint/v1\n{eroot}\n{wroot}\n".encode()).hexdigest()
    print(f"  BUNDLE ROOT       {root}")

    anchor = json.loads((ROOT / "docs" / "evidence-anchor.json").read_text())
    ok &= check("anchor doc carries this root", anchor.get("bundleRoot") == root,
                f"memo tx {anchor.get('signature', '?')[:16]}… · slot {anchor.get('slot')}"
                if anchor.get("bundleRoot") == root else f"anchor has {anchor.get('bundleRoot', '?')[:16]}…")

    snap_hash = hashlib.sha256((ROOT / "web" / "snapshot.json").read_bytes()).hexdigest()

    for card_path in sorted((ROOT / "docs" / "evidence" / "positions").glob("*.json")):
        if card_path.name == "index.json":
            continue
        card = json.loads(card_path.read_text())
        ok &= check(f"{card_path.name}: kind",
                    card.get("kind") == "sealed-position/v1")
        ok &= check(f"{card_path.name}: snapshot binding",
                    card.get("snapshotSha256") == snap_hash,
                    snap_hash[:16] + "…")
        mpid = card["programs"]["market"]
        seeds = card["position"]["seeds"]
        if card["position"]["account"] == "dark":
            raw = [b"darkpos", b58decode(seeds["venue"]),
                   b58decode(seeds["bettor"]), u64le(seeds["posSalt"])]
        else:
            raw = [b"position", b58decode(seeds["venue"]),
                   b58decode(seeds["bettor"])]
        derived = pda(raw, mpid)
        ok &= check(f"{card_path.name}: position PDA",
                    derived is not None and b58encode_check(derived, card["position"]["pk"]),
                    "re-derived from declared seeds, off-curve as required")

        v = card["venue"]
        s = v["seeds"]
        if v["kind"] in ("band",):
            vs = [b"market", b58decode(s["run"]), u64le(s["salt"])]
        elif v["kind"] == "duel":
            vs = [b"duel", b58decode(s["runA"]), b58decode(s["runB"]), u64le(s["salt"])]
        elif v["kind"] == "dark":
            vs = [b"dark", b58decode(s["run"]), u64le(s["salt"])]
        elif v["kind"] == "ladder":
            vs = [b"ladder", b58decode(s["firstLeg"]), u64le(s["salt"])]
        else:
            vs = None
        if vs:
            vd = pda(vs, mpid)
            ok &= check(f"{card_path.name}: venue PDA ({v['kind']})",
                        vd is not None and b58encode_check(vd, v["pk"]))

        # account binding — decode the account bytes HERE and compare.
        msec = SNAP["market"]
        if card["position"]["account"] == "dark":
            raw = find_account(msec, card["position"]["pk"], DISC["darkPosition"])
            dec = decode_dark_position(raw) if raw else None
            ok &= check(f"{card_path.name}: account binding",
                        dec is not None and dec["market"] == card["position"]["seeds"]["venue"]
                        and dec["bettor"] == card["position"]["seeds"]["bettor"]
                        and str(dec["amount"]) == str(card["stake"]["amount"])
                        and dec["commitment"] == card["stake"]["commitment"]
                        and dec["revealed"] == card["stake"]["revealed"],
                        "dark position fields unpacked from account bytes")
        else:
            raw = find_account(msec, card["position"]["pk"], DISC["position"])
            dec = decode_position(raw) if raw else None
            ok &= check(f"{card_path.name}: account binding",
                        dec is not None and dec["market"] == card["position"]["seeds"]["venue"]
                        and dec["bettor"] == card["position"]["seeds"]["bettor"]
                        and dec["amounts"] == [int(x) for x in card["stake"]["amounts"]],
                        "stake amounts unpacked from account bytes")

    for card_path in sorted((ROOT / "docs" / "evidence" / "bounties").glob("*.json")):
        if card_path.name == "index.json":
            continue
        card = json.loads(card_path.read_text())
        ok &= check(f"{card_path.name}: kind",
                    card.get("kind") == "sealed-bounty/v1")
        ok &= check(f"{card_path.name}: snapshot binding",
                    card.get("snapshotSha256") == snap_hash,
                    snap_hash[:16] + "…")
        s = card["bounty"]["seeds"]
        derived = pda([b"bounty", b58decode(s["bank"]),
                       b58decode(s["sponsor"]), u64le(s["salt"])],
                      card["programs"]["market"])
        ok &= check(f"{card_path.name}: bounty PDA",
                    derived is not None and b58encode_check(derived, card["bounty"]["pk"]),
                    "re-derived [bounty, bank, sponsor, salt], off-curve as required")
        raw = find_account(SNAP["market"], card["bounty"]["pk"], DISC["bounty"])
        dec = decode_bounty(raw) if raw else None
        if dec is not None:
            winner_ok = (card["bounty"]["status"] != 1) or (
                dec["winnerRun"] == card["bounty"]["winnerRun"]
                and dec["winningScore"] == card["bounty"]["winningScore"])
            ok &= check(f"{card_path.name}: account binding",
                        dec["sponsor"] == card["bounty"]["seeds"]["sponsor"]
                        and dec["bank"] == card["bounty"]["seeds"]["bank"]
                        and str(dec["salt"]) == str(card["bounty"]["seeds"]["salt"])
                        and dec["status"] == card["bounty"]["status"]
                        and dec["threshold"] == card["bounty"]["threshold"]
                        and str(dec["amount"]) == str(card["bounty"]["amount"])
                        and dec["createdAt"] == int(card["bounty"]["createdAt"])
                        and dec["deadline"] == int(card["bounty"]["deadline"])
                        and winner_ok,
                        "sponsor · bank · salt · status · threshold · amount · deadline · winner")
        else:
            ok &= check(f"{card_path.name}: account binding", False, "bounty not found in snapshot")

    for card_path in sorted((ROOT / "docs" / "evidence" / "grants").glob("*.json")):
        if card_path.name == "index.json":
            continue
        card = json.loads(card_path.read_text())
        ok &= check(f"{card_path.name}: kind",
                    card.get("kind") == "sealed-grant/v1")
        ok &= check(f"{card_path.name}: snapshot binding",
                    card.get("snapshotSha256") == snap_hash,
                    snap_hash[:16] + "…")
        s = card["grant"]["seeds"]
        derived = pda([b"grant", b58decode(s["bank"]),
                       struct.pack("<H", int(s["chunkIndex"])),
                       bytes([int(s["part"])]), b58decode(s["viewer"])],
                      card["programs"]["sealed"])
        ok &= check(f"{card_path.name}: grant PDA",
                    derived is not None and b58encode_check(derived, card["grant"]["pk"]),
                    "re-derived [grant, bank, chunk, part, viewer] — viewer is x25519")
        ok &= check(f"{card_path.name}: key echo",
                    card["grant"]["encryptionKey"] == card["grant"]["viewer"],
                    "encryption_key == viewer — the MPC bound output to the requested key")
        raw = find_account(SNAP["sealed"], card["grant"]["pk"], DISC["shareGrant"])
        dec = decode_share_grant(raw) if raw else None
        ok &= check(f"{card_path.name}: account binding",
                    dec is not None and dec["benchmark"] == card["grant"]["benchmark"]
                    and dec["chunkIndex"] == card["grant"]["chunkIndex"]
                    and dec["part"] == card["grant"]["part"]
                    and dec["viewer"] == card["grant"]["viewer"]
                    and dec["encryptionKey"] == card["grant"]["encryptionKey"]
                    and str(dec["nonce"]) == str(card["grant"]["nonce"])
                    and dec["ciphertexts"] == card["grant"]["ciphertexts"]
                    and dec["sharedAt"] == int(card["grant"]["sharedAt"]),
                    "all eight ShareGrant fields unpacked from account bytes")

    print(f"\n{'ALL VERIFIED' if ok else 'FAILED'} — independent Python replay "
          f"agrees on BUNDLE ROOT {root[:16]}…" if ok else "\nFAILED")
    sys.exit(0 if ok else 1)


def b58encode_check(digest: bytes, want_b58: str) -> bool:
    n = int.from_bytes(digest, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    pad = len(digest) - len(digest.lstrip(b"\x00"))
    return "1" * pad + out == want_b58


def b58encode(raw: bytes) -> str:
    n = int.from_bytes(raw, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    pad = len(raw) - len(raw.lstrip(b"\x00"))
    return "1" * pad + out


# --- independent account decoders -----------------------------------------
# The snapshot is raw {pubkey, data-b64}. These unpack Anchor layouts the
# same way the on-chain program does — a bug in snapshot.ts's decoder would
# show up here as a field mismatch, not propagate into a forged card.
DISC = {
    "bounty": bytes.fromhex("ed1069c61345f2ea"),
    "shareGrant": bytes.fromhex("a47067c1839cb4c0"),
    "position": bytes.fromhex("aabc8fe47a40f7d0"),
    "darkPosition": bytes.fromhex("d8c18faeae9d7715"),
}


def find_account(section, pubkey, disc):
    for a in section:
        if a["pubkey"] != pubkey:
            continue
        d = base64.b64decode(a["data"])
        if d[:8] == disc:
            return d
    return None


def decode_bounty(d):
    # disc8 sponsor32 bank32 salt u64 bump status threshold u32
    # amount u64 winnerRun32 winningScore u32 createdAt i64 deadline i64
    return {
        "sponsor": b58encode(d[8:40]), "bank": b58encode(d[40:72]),
        "salt": int.from_bytes(d[72:80], "little"),
        "status": d[81],
        "threshold": int.from_bytes(d[82:86], "little"),
        "amount": int.from_bytes(d[86:94], "little"),
        "winnerRun": b58encode(d[94:126]),
        "winningScore": int.from_bytes(d[126:130], "little"),
        "createdAt": int.from_bytes(d[130:138], "little", signed=True),
        "deadline": int.from_bytes(d[138:146], "little", signed=True),
    }


def decode_share_grant(d):
    # disc8 benchmark32 chunk u16 part u8 bump viewer32 encKey32
    # nonce u128 ciphertexts64 sharedAt i64
    return {
        "benchmark": b58encode(d[8:40]),
        "chunkIndex": int.from_bytes(d[40:42], "little"),
        "part": d[42],
        "viewer": b58encode(d[44:76]),
        "encryptionKey": b58encode(d[76:108]),
        "nonce": int.from_bytes(d[108:124], "little"),
        "ciphertexts": [b58encode(d[124:156]), b58encode(d[156:188])],
        "sharedAt": int.from_bytes(d[188:196], "little", signed=True),
    }


def decode_position(d):
    # disc8 market32 bettor32 bump amounts u64[8]
    return {
        "market": b58encode(d[8:40]), "bettor": b58encode(d[40:72]),
        "amounts": [int.from_bytes(d[73 + 8 * i:81 + 8 * i], "little") for i in range(8)],
    }


def decode_dark_position(d):
    # disc8 market32 bettor32 bump amount u64 commitment32 revealed u8
    return {
        "market": b58encode(d[8:40]), "bettor": b58encode(d[40:72]),
        "amount": int.from_bytes(d[73:81], "little"),
        "commitment": d[81:113].hex(),
        "revealed": d[113],
    }


if __name__ == "__main__":
    main()
