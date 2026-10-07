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
  9. sealed-trail/v1 money-trails replay end-to-end: run + bank +
     receipt PDAs, every venue PDA (band/duel/dark/ladder/bounty),
     run field binding, venue field binding (incl. ladder LEG runs
     decoded independently and dark forfeit sums recomputed from
     DarkPosition bytes), settlements replayed against the DECODED
     Run.correct — not the card's claim.
 10. sealed-board/v1 — the leaderboard card — replays in full: every
     modelrec/scorelog PDA re-derived, aggregates + pairwise matrix +
     Wilson-95 LCB ranking recomputed from the embedded receipts, and
     every receipt bound to its decoded ScoreLog account bytes AND the
     run's decoded Run.correct.
"""

import base64
import copy
import hashlib
import json
import math
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

    for card_path in sorted((ROOT / "docs" / "evidence" / "trails").glob("*.json")):
        if card_path.name == "index.json":
            continue
        card = json.loads(card_path.read_text())
        name = card_path.name
        ok &= check(f"{name}: kind", card.get("kind") == "sealed-trail/v1")
        ok &= check(f"{name}: snapshot binding",
                    card.get("snapshotSha256") == snap_hash, snap_hash[:16] + "…")
        spid = card["programs"]["sealed"]
        mpid = card["programs"]["market"]
        r = card["run"]
        ok &= check(f"{name}: run PDA",
                    b58encode_check(pda([b"run", b58decode(r["benchmark"]), u64le(r["index"])], spid) or b"", r["pk"]),
                    "[run, bank, u64le(index)]")
        if card.get("bank"):
            b = card["bank"]
            ok &= check(f"{name}: bank PDA",
                        b58encode_check(pda([b"benchmark", b58decode(b["authority"]),
                                             struct.pack("<I", int(b["id"]))], spid) or b"", b["pk"]))
        if card.get("receipt"):
            ok &= check(f"{name}: receipt PDA",
                        b58encode_check(pda([b"scorelog", b58decode(r["pk"])], spid) or b"",
                                        card["receipt"]["pk"]),
                        "[scorelog, run]")

        # run binding — decode the Run's raw bytes, not the card's claims.
        raw = find_account(SNAP["sealed"], r["pk"], disc("Run"))
        dr = decode_run(raw) if raw else None
        ok &= check(f"{name}: run binding",
                    dr is not None and dr["correct"] == r["correct"]
                    and dr["status"] == r["status"] and dr["runner"] == r["runner"]
                    and dr["modelId"] == r["modelId"] and dr["benchmark"] == r["benchmark"]
                    and dr["postReveal"] == bool(r["postReveal"]),
                    "correct · status · runner · model · bank · post_reveal unpacked")

        v_ok, v_n = 0, 0
        for v in card["venues"]:
            v_n += 1
            s = v["seeds"]
            seeds = ([b"market", b58decode(s["run"]), u64le(s["salt"])] if v["kind"] == "band"
                     else [b"duel", b58decode(s["runA"]), b58decode(s["runB"]), u64le(s["salt"])] if v["kind"] == "duel"
                     else [b"dark", b58decode(s["run"]), u64le(s["salt"])] if v["kind"] == "dark"
                     else [b"ladder", b58decode(s["firstLeg"]), u64le(s["salt"])] if v["kind"] == "ladder"
                     else [b"bounty", b58decode(s["bank"]), b58decode(s["sponsor"]), u64le(s["salt"])])
            if not b58encode_check(pda(seeds, mpid) or b"", v["pk"]):
                continue
            vtype = {"band": "Market", "duel": "Market", "dark": "DarkMarket",
                     "ladder": "Ladder", "bounty": "Bounty"}[v["kind"]]
            raw = find_account(SNAP["market"], v["pk"], disc(vtype))
            if raw is None:
                continue
            if v["kind"] in ("band", "duel"):
                a = decode_market(raw)
                seed_ok = (a["run"] == s.get("run", s.get("runA"))
                           and str(a["salt"]) == str(s["salt"])
                           and (v["kind"] != "duel" or a["runB"] == s["runB"]))
                money_ok = a["totals"] == [int(x) for x in v["totals"]]
                score_ok = (a["status"] == v["status"]
                            and (a["status"] != 1 or (a["resolvedScore"] == v["resolvedScore"]
                                 and a["outcome"] == v["outcome"])))
            elif v["kind"] == "dark":
                a = decode_dark_market(raw)
                seed_ok = a["run"] == s["run"] and str(a["salt"]) == str(s["salt"])
                forfeit = sum(p["amount"] for p in dark_positions(SNAP["market"], v["pk"]))
                money_ok = (a["poolTotal"] == int(v["poolTotal"]) and a["winTotal"] == int(v["winTotal"])
                            and a["revealedCount"] == v["revealedCount"] and a["tallied"] == bool(v["tallied"])
                            and forfeit == int(v["forfeitTotal"]))
                score_ok = a["status"] == v["status"] and (a["status"] != 1 or a["resolvedScore"] == v["resolvedScore"])
            elif v["kind"] == "ladder":
                a = decode_ladder(raw)
                seed_ok = (a["legs"][0] == s["firstLeg"] and str(a["salt"]) == str(s["salt"])
                           and a["legs"][v["legIndex"]] == r["pk"])
                money_ok = a["totals"] == [int(x) for x in v["totals"]]
                score_ok = (a["status"] == v["status"] and a["legCount"] == v["legCount"]
                            and (a["status"] != 1 or a["resultMask"] == v["resultMask"]))
                # every leg's run fields bound to its own decoded account
                for leg in v.get("legs", []):
                    lr = find_account(SNAP["sealed"], leg["pk"], disc("Run"))
                    ld = decode_run(lr) if lr else None
                    money_ok = money_ok and ld is not None and ld["correct"] == leg["correct"] \
                        and ld["status"] == leg["status"] and ld["benchmark"] == leg["benchmark"] \
                        and ld["index"] == leg["index"]
            else:
                a = decode_bounty(raw)
                seed_ok = (a["bank"] == s["bank"] and a["sponsor"] == s["sponsor"]
                           and str(a["salt"]) == str(s["salt"]))
                money_ok = a["amount"] == int(v["amount"])
                score_ok = (a["status"] == v["status"] and a["threshold"] == v["threshold"]
                            and (a["status"] != 1 or (a["winningScore"] == v["winningScore"]
                                 and a["winnerRun"] == v["winnerRun"])))
            if seed_ok and money_ok and score_ok:
                v_ok += 1
        ok &= check(f"{name}: venue binding", v_ok == v_n,
                    f"{v_ok}/{v_n} venue PDAs + account fields bound (incl. leg runs)")

        # settlement replay — against the DECODED score, not the card's
        resolved = [v for v in card["venues"] if v["status"] == 1]
        s_ok = sum(
            1 for v in resolved
            if (v["resolvedScore"] if v["kind"] in ("band", "dark")
                else (v["resolvedScore"] >> 16 if v["side"] == "a" else v["resolvedScore"] & 0xffff) if v["kind"] == "duel"
                else v["winningScore"] if v["kind"] == "bounty"
                else v["legs"][v["legIndex"]]["correct"]) == (dr["correct"] if dr else -1))
        ok &= check(f"{name}: settlements from decoded Run.correct",
                    s_ok == len(resolved), f"{s_ok}/{len(resolved)} replayed")
        pools = sum(sum(v["totals"]) if v.get("totals") else int(v.get("poolTotal") or 0)
                    for v in card["venues"])
        vd = card["verdict"]
        ok &= check(f"{name}: verdict summary",
                    vd["venuesTotal"] == v_n and vd["resolvedVenues"] == len(resolved)
                    and vd["poolsLamports"] == pools
                    and vd["scoreMismatches"] == len(resolved) - s_ok,
                    f"{pools} lamports · {len(resolved)}/{v_n} resolved · 0 mismatch")

    # --- sealed-board/v1 — the leaderboard card ---------------------------
    # Re-derive every record/receipt PDA, replay the aggregates bit-exact,
    # rebuild the shared-bank pairwise matrix and the Wilson ranking, then
    # bind every embedded receipt to its decoded ScoreLog + Run bytes.
    for card_path in sorted((ROOT / "docs" / "evidence").glob("board*.json")):
        card = json.loads(card_path.read_text())
        name = card_path.name
        if card.get("kind") != "sealed-board/v1":
            continue
        ok &= check(f"{name}: kind", True)
        spid = card["programs"]["sealed"]

        id_ok = all(
            hashlib.sha256(m["modelId"].encode()).hexdigest() == m["record"]["modelHash"]
            and b58encode_check(
                pda([b"modelrec", hashlib.sha256(m["modelId"].encode()).digest()], spid) or b"",
                m["recordPk"])
            for m in card["models"])
        ok &= check(f"{name}: record identity", id_ok,
                    f"{len(card['models'])} record PDAs = [modelrec, sha256(modelId)]")

        r_n = sum(len(m["receipts"]) for m in card["models"])
        rid_ok = all(
            b58encode_check(pda([b"scorelog", b58decode(l["run"])], spid) or b"", l["pk"])
            and l["modelRecord"] == m["recordPk"]
            for m in card["models"] for l in m["receipts"])
        ok &= check(f"{name}: receipt identity", rid_ok,
                    f"{r_n} receipt PDAs = [scorelog, run] bound to their record")

        ag_ok = True
        for m in card["models"]:
            correct = sum(l["correct"] for l in m["receipts"])
            items = sum(l["items"] for l in m["receipts"])
            row = next((r for r in card["ranking"] if r["recordPk"] == m["recordPk"]), None)
            if (correct != m["record"]["totalCorrect"] or items != m["record"]["totalItems"]
                    or len(m["receipts"]) != m["record"]["runsScored"] or row is None
                    or row["aggregate"]["correct"] != correct or row["aggregate"]["items"] != items
                    or row["aggregate"]["runs"] != len(m["receipts"])):
                ag_ok = False
        ok &= check(f"{name}: aggregates", ag_ok,
                    "record totals + ranking rows replay bit-exact from embedded receipts")

        # pairwise — shared-bank join, per-pair delta + verdict, W-L-T tallies
        by_bank = {m["recordPk"]: {} for m in card["models"]}
        for m in card["models"]:
            for l in m["receipts"]:
                e = by_bank[m["recordPk"]].setdefault(l["benchmark"], [0, 0])
                e[0] += l["correct"]; e[1] += l["items"]
        stats = {m["recordPk"]: dict(wins=0, losses=0, ties=0, rankedPairs=0,
                                     sharedBanks=0, ppDelta=0.0) for m in card["models"]}
        rebuilt = []
        for i, A in enumerate(card["models"]):
            for B in card["models"][i + 1:]:
                a, b = by_bank[A["recordPk"]], by_bank[B["recordPk"]]
                shared = [k for k in a if k in b]
                if not shared:
                    continue
                pa = sum(a[k][0] for k in shared) / max(1, sum(a[k][1] for k in shared))
                pb = sum(b[k][0] for k in shared) / max(1, sum(b[k][1] for k in shared))
                d = round(100 * (pa - pb), 4)
                sa, sb = stats[A["recordPk"]], stats[B["recordPk"]]
                sa["rankedPairs"] += 1; sb["rankedPairs"] += 1
                sa["sharedBanks"] += len(shared); sb["sharedBanks"] += len(shared)
                sa["ppDelta"] = round(sa["ppDelta"] + d, 4); sb["ppDelta"] = round(sb["ppDelta"] - d, 4)
                verdict = "a" if pa > pb else "b" if pb > pa else "tie"
                if verdict == "a": sa["wins"] += 1; sb["losses"] += 1
                elif verdict == "b": sb["wins"] += 1; sa["losses"] += 1
                else: sa["ties"] += 1; sb["ties"] += 1
                flip = A["modelId"] > B["modelId"]
                rebuilt.append({
                    "a": B["modelId"] if flip else A["modelId"],
                    "b": A["modelId"] if flip else B["modelId"],
                    "shared": len(shared),
                    "deltaPp": -d if flip else d,
                    "verdict": ("b" if verdict == "a" else "a" if verdict == "b" else "tie") if flip else verdict,
                })
        pair_sort = lambda x: (x["a"], x["b"])
        mine = sorted(rebuilt, key=pair_sort)
        theirs = sorted(card["pairs"], key=pair_sort)
        pairs_ok = (len(mine) == len(theirs) and all(
            x["a"] == y["a"] and x["b"] == y["b"] and x["shared"] == y["shared"]
            and x["verdict"] == y["verdict"] and abs(x["deltaPp"] - y["deltaPp"]) < 0.001
            for x, y in zip(mine, theirs)))
        ok &= check(f"{name}: pairwise verdicts", pairs_ok,
                    f"{len(rebuilt)} ranked pairs — shared banks, deltas, verdicts recomputed")
        stat_ok = True
        for m in card["models"]:
            s = stats[m["recordPk"]]
            p = next((r["pairwise"] for r in card["ranking"] if r["recordPk"] == m["recordPk"]), None)
            if (p is None or s["wins"] != p["wins"] or s["losses"] != p["losses"]
                    or s["ties"] != p["ties"] or s["rankedPairs"] != p["rankedPairs"]
                    or s["sharedBanks"] != p["sharedBanks"] or abs(s["ppDelta"] - p["ppDelta"]) > 0.001):
                stat_ok = False
        ok &= check(f"{name}: pairwise tallies", stat_ok,
                    "per-model W-L-T, ranked pairs, shared banks, ΣΔpp re-derived equal")

        # ranking — Wilson-95 LCB order recomputed
        order = sorted(
            ((m["recordPk"], stats[m["recordPk"]]) for m in card["models"]),
            key=lambda t: (-wilson_lcb(t[1]["wins"] + t[1]["ties"] / 2, t[1]["rankedPairs"]),
                           -t[1]["wins"], -t[1]["ppDelta"]))
        rank_ok = True
        for i, r in enumerate(card["ranking"]):
            pk, s = order[i] if i < len(order) else (None, None)
            lcb = round(wilson_lcb(s["wins"] + s["ties"] / 2, s["rankedPairs"]), 4) if s else -1
            if (r["recordPk"] != pk or r["rank"] != i + 1
                    or abs(r["pairwise"]["lcb"] - lcb) > 0.001):
                rank_ok = False
        ok &= check(f"{name}: ranking", rank_ok,
                    f"Wilson-95 LCB order re-derived — #1 {card['ranking'][0]['modelId']}, "
                    f"{len(card['ranking'])} rows")

        # snapshot binding — every receipt equals its decoded ScoreLog
        # account AND the run's MPC-written Run.correct.
        b_n, b_bad = 0, 0
        for m in card["models"]:
            for l in m["receipts"]:
                b_n += 1
                raw = find_account(SNAP["sealed"], l["pk"], disc("ScoreLog"))
                sl = decode_scorelog(raw) if raw else None
                rr = find_account(SNAP["sealed"], l["run"], disc("Run"))
                dr = decode_run(rr) if rr else None
                if (sl is None or dr is None
                        or sl["run"] != l["run"] or sl["benchmark"] != l["benchmark"]
                        or sl["modelRecord"] != m["recordPk"]
                        or sl["correct"] != l["correct"] or sl["items"] != l["items"]
                        or sl["vouched"] != l["vouched"] or sl["postReveal"] != l["postReveal"]
                        or sl["recordedAt"] != l["recordedAt"] or dr["correct"] != l["correct"]):
                    b_bad += 1
        ok &= check(f"{name}: snapshot binding", b_bad == 0,
                    f"{b_n} receipts equal their ScoreLog bytes; every score == decoded Run.correct")

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
def disc(name: str) -> bytes:
    # Anchor's rule: sha256("account:" + Name)[:8] — derived, not a table.
    return sha256(b"account:" + name.encode())[:8]


DISC = {
    "bounty": disc("Bounty"),
    "shareGrant": disc("ShareGrant"),
    "position": disc("Position"),
    "darkPosition": disc("DarkPosition"),
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
    # (revealed = the BUCKET index; 255 = never revealed)
    return {
        "market": b58encode(d[8:40]), "bettor": b58encode(d[40:72]),
        "amount": int.from_bytes(d[73:81], "little"),
        "commitment": d[81:113].hex(),
        "revealed": d[113],
    }


def dark_positions(section, market_b58):
    """All unrevealed dark positions on a venue — the forfeit pool."""
    out = []
    for a in section:
        d = base64.b64decode(a["data"])
        if d[:8] == DISC["darkPosition"] and d[113] == 255:
            p = decode_dark_position(d)
            if p["market"] == market_b58:
                out.append(p)
    return out


def decode_scorelog(d):
    # disc8 run32 model_record32 benchmark32 correct u32 items u32
    # recorded_by32 recorded_at i64 vouched u8 post_reveal u8 bump
    return {
        "run": b58encode(d[8:40]), "modelRecord": b58encode(d[40:72]),
        "benchmark": b58encode(d[72:104]),
        "correct": int.from_bytes(d[104:108], "little"),
        "items": int.from_bytes(d[108:112], "little"),
        "recordedBy": b58encode(d[112:144]),
        "recordedAt": int.from_bytes(d[144:152], "little", signed=True),
        "vouched": d[152], "postReveal": d[153],
    }


def wilson_lcb(correct, items, z=1.96):
    """Wilson score-interval lower bound, percent — mirrors gate.ts."""
    if items <= 0:
        return 0.0
    p = correct / items
    z2 = z * z
    denom = 1 + z2 / items
    centre = p + z2 / (2 * items)
    margin = z * math.sqrt((p * (1 - p) + z2 / (4 * items)) / items)
    return 100 * (centre - margin) / denom


def decode_run(d):
    # disc8 benchmark32 runner32 index u64 bump status chunkCount u16
    # pending u64 scored u64 correct u32 created i64 finalized i64
    # harness32 outputs32 modelId str tail-flags…
    ml = int.from_bytes(d[184:188], "little")
    tail = 188 + ml
    post = False
    if tail + 9 <= len(d):
        tail += 9   # attested u8 + attestedAt i64
    if tail + 8 <= len(d):
        tail += 8   # pendingSince
    if tail + 8 <= len(d):
        tail += 8   # firstPendingAt
    if tail + 8 <= len(d):
        tail += 8   # everQueuedMask
    if tail + 8 <= len(d):
        tail += 8   # allQueuedAt
    if tail + 1 <= len(d):
        post = d[tail] != 0
    return {
        "benchmark": b58encode(d[8:40]), "runner": b58encode(d[40:72]),
        "index": int.from_bytes(d[72:80], "little"),
        "status": d[81],
        "correct": int.from_bytes(d[100:104], "little"),
        "modelId": d[188:188 + ml].decode(),
        "postReveal": post,
    }


def decode_market(d):
    # disc8 authority32 run32 benchmark32 runIndex u64 salt u64 n u8
    # edges[7]u32 bump status outcome totals[8]u64 resolvedScore u32
    # created/resolved i64 runB32 fee tail…
    return {
        "authority": b58encode(d[8:40]), "run": b58encode(d[40:72]),
        "benchmark": b58encode(d[72:104]),
        "salt": int.from_bytes(d[112:120], "little"),
        "status": d[150], "outcome": d[151],
        "totals": [int.from_bytes(d[152 + 8 * i:160 + 8 * i], "little") for i in range(8)],
        "resolvedScore": int.from_bytes(d[216:220], "little"),
        "runB": b58encode(d[236:268]) if len(d) >= 268 else None,
    }


def decode_dark_market(d):
    # disc8 authority32 run32 benchmark32 runIndex u64 salt u64 n u8
    # edges[7]u32 bump status outcome pool u64 winTotal u64
    # revealedCount u32 resolvedScore u32 ts i64×4 fee tail tallied u8
    return {
        "authority": b58encode(d[8:40]), "run": b58encode(d[40:72]),
        "salt": int.from_bytes(d[112:120], "little"),
        "status": d[150], "outcome": d[151],
        "poolTotal": int.from_bytes(d[152:160], "little"),
        "winTotal": int.from_bytes(d[160:168], "little"),
        "revealedCount": int.from_bytes(d[168:172], "little"),
        "resolvedScore": int.from_bytes(d[172:176], "little"),
        "tallied": len(d) > 234 and d[234] == 1,
    }


def decode_ladder(d):
    # disc8 authority32 benchmark32 legs[8]×32 legCount u8 salt u64
    # bump status resultMask u8 resolvedScore u32 totals[8]u64 …
    return {
        "authority": b58encode(d[8:40]),
        "legs": [b58encode(d[72 + 32 * i:104 + 32 * i]) for i in range(8)],
        "legCount": d[328],
        "salt": int.from_bytes(d[329:337], "little"),
        "status": d[338], "resultMask": d[339],
        "resolvedScore": int.from_bytes(d[340:344], "little"),
        "totals": [int.from_bytes(d[344 + 8 * i:352 + 8 * i], "little") for i in range(8)],
    }


def tamper_demo():
    """--tamper: forge each committed card, run the real checks, show the catch.

    Inverted assertions — every forgery MUST fail a named check, or the
    demo itself fails (the verifier would have accepted its own lie).
    """
    global SNAP
    SNAP = json.loads((ROOT / "web" / "snapshot.json").read_text())
    msec = SNAP["market"]
    all_ok = True
    print("sealed-fingerprint/v1 — forgery lab (the verifier catches its own lies)")

    # 1. bounty theft — rewrite the winning score below the payout's reality
    card = json.loads((ROOT / "docs/evidence/bounties/claimed-20of32.json").read_text())
    forged = copy.deepcopy(card)
    forged["bounty"]["winningScore"] = 4  # real account says 20
    raw = find_account(msec, forged["bounty"]["pk"], DISC["bounty"])
    dec = decode_bounty(raw) if raw else None
    caught = dec is None or dec["winningScore"] != forged["bounty"]["winningScore"]
    all_ok &= check("bounty theft (winningScore 20→4)", caught,
                    'forgery dies at "account binding"' if caught else "FORGERY PASSED")

    # 2. stake inflation — double a dark position's bet
    card = json.loads((ROOT / "docs/evidence/positions/sealed-dark.json").read_text())
    forged = copy.deepcopy(card)
    forged["stake"]["amount"] = str(int(forged["stake"]["amount"]) * 2)
    raw = find_account(msec, forged["position"]["pk"], DISC["darkPosition"])
    dec = decode_dark_position(raw) if raw else None
    caught = dec is None or str(dec["amount"]) != forged["stake"]["amount"]
    all_ok &= check("stake inflation (amount ×2)", caught,
                    'forgery dies at "account binding"' if caught else "FORGERY PASSED")

    # 3. grant redirect — point the disclosure at a different viewer
    card = json.loads((ROOT / "docs/evidence/grants/sealed-priv-first.json").read_text())
    forged = copy.deepcopy(card)
    g = forged["grant"]["seeds"]
    forged["grant"]["seeds"] = dict(g)
    forged["grant"]["seeds"]["viewer"] = b58encode(bytes([7] * 32))  # someone else
    s = forged["grant"]["seeds"]
    derived = pda([b"grant", b58decode(s["bank"]),
                   struct.pack("<H", int(s["chunkIndex"])),
                   bytes([int(s["part"])]), b58decode(s["viewer"])],
                  forged["programs"]["sealed"])
    caught = derived is None or derived != b58decode(forged["grant"]["pk"])
    all_ok &= check("viewer redirect (regrant to [7;32])", caught,
                    'forgery dies at "grant PDA"' if caught else "FORGERY PASSED")

    # 4. trail money rewrite — inflate a dark venue's escrow; the decoded
    #    DarkMarket bytes disagree no matter how consistent the card is.
    card = json.loads((ROOT / "docs/evidence/trails/qwen3b-ladder-deadheat.json").read_text())
    forged = copy.deepcopy(card)
    v = next(x for x in forged["venues"] if x["kind"] == "dark")
    v["poolTotal"] = int(v["poolTotal"]) + 1
    raw = find_account(msec, v["pk"], disc("DarkMarket"))
    a = decode_dark_market(raw) if raw else None
    caught = a is None or a["poolTotal"] != int(v["poolTotal"])
    all_ok &= check("settled-money rewrite (poolTotal +1)", caught,
                    'forgery dies at "venue binding"' if caught else "FORGERY PASSED")

    # 5. score substitution — the classic oracle attack: rewrite the MPC's
    #    correct count. The decoded Run bytes hold the real one.
    forged = copy.deepcopy(card)
    forged["run"]["correct"] = forged["run"]["correct"] + 1
    raw = find_account(SNAP["sealed"], forged["run"]["pk"], disc("Run"))
    dr = decode_run(raw) if raw else None
    caught = dr is None or dr["correct"] != forged["run"]["correct"]
    all_ok &= check("oracle substitution (correct +1)", caught,
                    'forgery dies at "run binding"' if caught else "FORGERY PASSED")

    # 6. leaderboard inflation — bump a receipt's score on the flagship
    #    board card. The decoded ScoreLog bytes disagree (snapshot binding)
    #    AND the record's totals no longer replay (aggregates).
    card = json.loads((ROOT / "docs/evidence/board.json").read_text())
    forged = copy.deepcopy(card)
    l = forged["models"][0]["receipts"][0]
    l["correct"] += 1
    raw = find_account(SNAP["sealed"], l["pk"], disc("ScoreLog"))
    sl = decode_scorelog(raw) if raw else None
    recompute = sum(x["correct"] for x in forged["models"][0]["receipts"])
    caught = (sl is None or sl["correct"] != l["correct"]
              or recompute != forged["models"][0]["record"]["totalCorrect"])
    all_ok &= check("leaderboard inflation (receipt correct +1)", caught,
                    'forgery dies at "snapshot binding" AND "aggregates"'
                    if caught else "FORGERY PASSED")

    print("\n" + ("ALL FORGERIES CAUGHT — the Python verifier rejects its own lies"
                  if all_ok else "FORGERY LAB FAILED — a forged card verified"))
    return all_ok


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--tamper":
        sys.exit(0 if tamper_demo() else 1)
    main()
