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
     are struct-unpacked HERE (Anchor discriminators derived as
     sha256("account:"+Name)[:8]; Benchmark/Run/ScoreLog/ModelRecord/
     Reveal/ShareGrant/ItemChunk/PrivItemChunk on sealed, Market/
     DarkMarket/Ladder/Bounty/Position/DarkPosition on market), and
     every card field is compared against the bytes, not against
     TypeScript's decode. A decoder bug in snapshot.ts can no longer
     launder a forged card.
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
 11. sealed-match/v1 head-to-head cards (all 73 committed) and
     sealed-claim/v1 model cards (all 31) replay the same checks the
     TypeScript verifier runs — plus ScoreLog/Run account binding the
     TS path doesn't perform.
 12. sealed-tamper/v1 exhibits — the eleven committed forgeries are
     replayed through Python's decoders and MUST be rejected; a lie
     that verifies under the second implementation fails the audit.
 13. sealed-report/v1 — each narrated report's canonical claim-card
     sha256 recomputed (generatedAt/source excluded) and compared.
 14. sealed-policy/v1 — evalGate() ported line-for-line: vouchedOnly /
     noPostReveal scoping, no-evidence on empty scope, the minPct /
     minRuns / minItems / minWilsonPct check list — plus receipt↔
     ScoreLog multiset binding (deeper than the TS cert verifier).
 15. sealed-catalog/v1 — the artifact index proves itself: directory
     re-walk completeness, kind honesty per entry, and every declared
     sha256 re-pinned against SHA256SUMS.
 16. sealed-bank/v1 — the exam dossier: bank PDA, chunk-set PDAs with
     completeness + field binding, the items_root fold replayed in
     mint_order landing sequence (generated banks fold plaintext specs;
     private banks fold ciphertexts+nonces — the MPC commitment itself
     re-derived in stdlib Python), bank fields, run / reveal / grant /
     receipt surfaces all bound to decoded account bytes, and the
     snapshot-file hash.
 17. sealed-evidence-digest/v1 — buildDigestData() ported: snapshot
     hash, per-type counts, the full integrity replay (records bit-
     exact from ScoreLogs; every resolved venue's stored score vs
     decoded Run.correct — duel packing, ladder resultMask included),
     and the keeper board classification re-derived. Wall-clock `now`
     is used identically to chain.ts — every evidence window in the
     committed bundle is long past, so the board is stable.

Coverage: every committed artifact — all 12 JSON kinds (134 files) and
the 4 markdown reports — replays under this second implementation.

  python3 scripts/verify.py --tamper    # the forgery lab, re-run here
  python3 scripts/verify.py --decrypt   # Rescue+x25519 ported — the
                                        # demo delegate's ShareGrants
                                        # decrypt in stdlib Python, and
                                        # re-encryption reproduces the
                                        # committed ciphertext bytes
  python3 scripts/verify.py --check-anchor
                                        # the one networked mode: plain
                                        # JSON-RPC over urllib fetches the
                                        # devnet memo tx and proves the
                                        # ledger carries the claimed
                                        # BUNDLE ROOT — no Solana SDK
  python3 scripts/verify.py --rescore     # the MPC's own arithmetic in a
                                        # third language: plaintext →
                                        # answerHash → on-chain Reveals,
                                        # outputs → chunkOut merkle →
                                        # Run.outputs_root, independent
                                        # recount vs Run.correct — both
                                        # committed calibration artifacts
                                        # (runs found by root scan)
  python3 scripts/verify.py --card FILE   # a judge's own artifact: the
                                        # file's kind is detected, then
                                        # the SAME check block the
                                        # committed replay runs executes
                                        # against it — a forged card dies
                                        # at its named check
  python3 scripts/verify.py --remote      # zero-clone mode: mirrors every
                                        # manifest-pinned byte into a temp
                                        # dir — web/* from the hosted Pages
                                        # site (what a browser actually
                                        # gets), docs/evidence/* from raw
                                        # .githubusercontent — then runs
                                        # the same pass on THOSE bytes.
                                        # Composes: --remote --decrypt.
"""

import base64
import copy
import hashlib
import json
import math
import os
import re
import struct
import sys
import time
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


_CARD = None  # --card FILE: (path, kind) — the replay narrows to one file

WEB_BASE = "https://josepha-mayo.github.io/sealed"
RAW_BASE = "https://raw.githubusercontent.com/josepha-mayo/sealed/main"


def fetch_remote(web_base: str = WEB_BASE, raw_base: str = RAW_BASE) -> Path:
    """--remote: mirror every manifest-pinned byte into a temp dir and
    return it as a stand-in ROOT — the verifier then runs entirely on
    REMOTE bytes: web/* from the hosted Pages site (what a judge's
    browser actually downloads), docs/evidence/* from raw.githubusercontent
    (the repo tree). No clone, and nothing trusted but TLS."""
    import tempfile
    import urllib.request

    def get(url: str) -> bytes:
        err: Exception | None = None
        for attempt in range(3):
            try:
                with urllib.request.urlopen(url, timeout=60) as r:
                    return r.read()
            except Exception as e:  # flaky CDN read — retry, not trusted
                err = e
                time.sleep(1 + attempt)
        raise RuntimeError(f"fetch failed after 3 tries: {url}") from err

    tmp = Path(tempfile.mkdtemp(prefix="sealed-remote-"))
    man = get(f"{web_base}/MANIFEST")
    sums = get(f"{raw_base}/docs/evidence/SHA256SUMS")
    (tmp / "web").mkdir(parents=True)
    (tmp / "docs" / "evidence").mkdir(parents=True)
    (tmp / "web" / "MANIFEST").write_bytes(man)
    (tmp / "docs" / "evidence" / "SHA256SUMS").write_bytes(sums)

    jobs: list[tuple[str, Path]] = [
        (f"{raw_base}/docs/evidence-anchor.json", tmp / "docs" / "evidence-anchor.json")
    ]
    for line in man.decode().splitlines():
        if not line.strip():
            continue
        rel = line.split(None, 1)[1].lstrip("./")
        jobs.append((f"{web_base}/{rel}", tmp / "web" / rel))
    for line in sums.decode().splitlines():
        if not line.strip():
            continue
        rel = line.split(None, 1)[1].lstrip("./")
        jobs.append((f"{raw_base}/docs/evidence/{rel}", tmp / "docs" / "evidence" / rel))

    print(f"--remote: mirroring {len(jobs)} pinned file(s) "
          f"({web_base} + {raw_base}) …")
    for i, (url, dst) in enumerate(jobs, 1):
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(get(url))
        if i % 50 == 0 or i == len(jobs):
            print(f"          {i}/{len(jobs)}")
    print(f"          mirrored into {tmp} — running the full pass on served bytes")
    return tmp


def card_iter(dirpath, pattern="*.json", kind=None):
    """Normal mode: the committed glob. --card mode: only the judge's file,
    and only in the block that owns its kind — every other kind's block
    sees an empty list and skips."""
    if _CARD is None:
        return sorted(dirpath.glob(pattern))
    return [Path(_CARD[0])] if kind is not None and _CARD[1] == kind else []


def main():
    ok = True
    global SNAP
    SNAP = json.loads((ROOT / "web" / "snapshot.json").read_text())
    if _CARD is not None:
        print(f"sealed-fingerprint/v1 — single-card replay: {_CARD[0]}")
        print(f"detected kind: {_CARD[1]} — running that kind's full check"
              " block plus the bundle sweeps\n")

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

    for card_path in card_iter(ROOT / "docs" / "evidence" / "positions", kind="sealed-position/v1"):
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

    for card_path in card_iter(ROOT / "docs" / "evidence" / "bounties", kind="sealed-bounty/v1"):
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

    for card_path in card_iter(ROOT / "docs" / "evidence" / "grants", kind="sealed-grant/v1"):
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

    for card_path in card_iter(ROOT / "docs" / "evidence" / "trails", kind="sealed-trail/v1"):
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
    for card_path in card_iter(ROOT / "docs" / "evidence", "board*.json", "sealed-board/v1"):
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

    # --- sealed-match/v1 — head-to-head cards (the largest family) --------
    # Same replay as verifyMatchCard: every PDA re-derived, shared-bank
    # aggregates + bank wins + winner verdict recomputed — PLUS an account
    # binding the TS verifier doesn't run: every receipt field-checked
    # against its decoded ScoreLog bytes.
    mdir = ROOT / "docs" / "evidence" / "matches"
    if mdir.is_dir():
        m_n, m_bad = 0, 0
        for card_path in card_iter(mdir, kind="sealed-match/v1"):
            if card_path.name == "index.json":
                continue
            card = json.loads(card_path.read_text())
            if card.get("kind") != "sealed-match/v1":
                continue
            m_n += 1
            spid = card["programs"]["sealed"]
            try:
                ident = (
                    b58encode_check(pda([b"modelrec", bytes.fromhex(card["a"]["seeds"]["modelHash"])],
                                        spid) or b"", card["a"]["recordPk"])
                    and b58encode_check(pda([b"modelrec", bytes.fromhex(card["b"]["seeds"]["modelHash"])],
                                            spid) or b"", card["b"]["recordPk"]))
                banks_ok = all(
                    b58encode_check(pda([b"benchmark", b58decode(b["authority"]),
                                         struct.pack("<I", int(b["id"]))], spid) or b"", b["pk"])
                    for b in card["banks"])
                runs_ok = all(
                    b58encode_check(pda([b"run", b58decode(r["benchmark"]),
                                         u64le(r["index"])], spid) or b"", r["pk"])
                    for r in card["runs"])
                all_rec = card["receipts"]["a"] + card["receipts"]["b"]
                logs_ok = all(
                    b58encode_check(pda([b"scorelog", b58decode(l["run"])], spid) or b"", l["pk"])
                    for l in all_rec)
                # snapshot binding — receipt fields == decoded ScoreLog bytes
                bind_ok = True
                for l in all_rec:
                    raw = find_account(SNAP["sealed"], l["pk"], disc("ScoreLog"))
                    sl = decode_scorelog(raw) if raw else None
                    if (sl is None or sl["run"] != l["run"]
                            or sl["benchmark"] != l["benchmark"]
                            or sl["correct"] != l["correct"] or sl["items"] != l["items"]
                            or bool(sl["vouched"]) != bool(l["vouchedAtRecord"])
                            or bool(sl["postReveal"]) != bool(l["postReveal"])):
                        bind_ok = False
                bank_pks = {b["pk"] for b in card["banks"]}
                agg = {}
                for side in ("a", "b"):
                    m = {}
                    for l in card["receipts"][side]:
                        if l["benchmark"] not in bank_pks:
                            continue
                        e = m.setdefault(l["benchmark"], [0, 0])
                        e[0] += l["correct"]; e[1] += l["items"]
                    agg[side] = m
                shared = [k for k in agg["a"] if k in agg["b"]]
                pa_c = sum(e[0] for e in agg["a"].values()); pa_i = sum(e[1] for e in agg["a"].values())
                pb_c = sum(e[0] for e in agg["b"].values()); pb_i = sum(e[1] for e in agg["b"].values())
                wins = {"a": 0, "tie": 0, "b": 0}
                for k in shared:
                    pa = 100 * agg["a"][k][0] / agg["a"][k][1] if agg["a"][k][1] else 0
                    pb = 100 * agg["b"][k][0] / agg["b"][k][1] if agg["b"][k][1] else 0
                    wins["a" if pa > pb else "b" if pb > pa else "tie"] += 1
                v = card["verdict"]
                pctA = 100 * pa_c / pa_i if pa_i else 0
                pctB = 100 * pb_c / pb_i if pb_i else 0
                winner = "tie" if pctA == pctB else "a" if pctA > pctB else "b"
                replay_ok = (len(shared) == v["sharedBanks"]
                             and pa_c == v["pooledA"] and pa_i == v["pooledItemsA"]
                             and pb_c == v["pooledB"] and pb_i == v["pooledItemsB"]
                             and wins["a"] == v["bankWins"]["a"] and wins["tie"] == v["bankWins"]["tie"]
                             and wins["b"] == v["bankWins"]["b"]
                             and winner == v["winner"]
                             and abs(pctA - v["pctA"]) < 0.01 and abs(pctB - v["pctB"]) < 0.01)
                if not (ident and banks_ok and runs_ok and logs_ok and bind_ok and replay_ok):
                    m_bad += 1
            except Exception:
                m_bad += 1
        ok &= check("sealed-match/v1 cards", m_bad == 0,
                    f"{m_n - m_bad}/{m_n} head-to-head cards: PDAs re-derived, ScoreLog bytes "
                    f"bound, verdicts replayed")

    # --- sealed-claim/v1 — per-model claim cards --------------------------
    # Same replay as verifyClaimCard: record/run/bank/receipt/venue PDAs,
    # aggregates bit-exact, venues re-derived from Run.correct — PLUS raw
    # account binding on every embedded run and receipt (TS checks
    # consistency; Python checks the bytes).
    cdir = ROOT / "docs" / "evidence" / "claims"
    if cdir.is_dir():
        c_n, c_bad = 0, 0
        for card_path in card_iter(cdir, kind="sealed-claim/v1"):
            if card_path.name == "index.json":
                continue
            card = json.loads(card_path.read_text())
            if card.get("kind") != "sealed-claim/v1":
                continue
            c_n += 1
            spid = card["programs"]["sealed"]
            mpid = card["programs"]["market"]
            try:
                ident = b58encode_check(
                    pda([b"modelrec", bytes.fromhex(card["record"]["seeds"]["modelHash"])],
                        spid) or b"", card["record"]["pk"])
                run_by = {r["pk"]: r for r in card["runs"]}
                runs_ok = all(
                    b58encode_check(pda([b"run", b58decode(r["benchmark"]),
                                         u64le(r["index"])], spid) or b"", r["pk"])
                    for r in card["runs"])
                banks_ok = all(
                    b58encode_check(pda([b"benchmark", b58decode(b["authority"]),
                                         struct.pack("<I", int(b["id"]))], spid) or b"", b["pk"])
                    for b in card["banks"])
                logs_ok = all(
                    l["run"] in run_by
                    and b58encode_check(pda([b"scorelog", b58decode(l["run"])], spid) or b"", l["pk"])
                    for l in card["receipts"])
                venue_ok = True
                for v in card["venues"]:
                    seeds = ([b"market", b58decode(v["run"]), u64le(v["salt"])] if v["kind"] == "band"
                             else [b"duel", b58decode(v["run"]), b58decode(v["runB"]), u64le(v["salt"])] if v["kind"] == "duel"
                             else [b"dark", b58decode(v["run"]), u64le(v["salt"])] if v["kind"] == "dark"
                             else [b"ladder", b58decode(v["legs"][0]), u64le(v["salt"])] if v["kind"] == "ladder"
                             else [b"bounty", b58decode(v["bank"]), b58decode(v["sponsor"]), u64le(v["salt"])])
                    if not b58encode_check(pda(seeds, mpid) or b"", v["pk"]):
                        venue_ok = False
                tot_c = sum(l["correct"] for l in card["receipts"])
                tot_i = sum(l["items"] for l in card["receipts"])
                ag_ok = (tot_c == card["model"]["totalCorrect"] and tot_i == card["model"]["totalItems"]
                         and len(card["receipts"]) == card["model"]["runsScored"])
                # account binding — runs + receipts vs decoded bytes
                bind_ok = True
                for r in card["runs"]:
                    raw = find_account(SNAP["sealed"], r["pk"], disc("Run"))
                    dr = decode_run(raw) if raw else None
                    if (dr is None or dr["correct"] != r["correct"] or dr["status"] != r["status"]
                            or dr["runner"] != r["runner"] or dr["benchmark"] != r["benchmark"]
                            or dr["postReveal"] != bool(r["postReveal"])):
                        bind_ok = False
                for l in card["receipts"]:
                    raw = find_account(SNAP["sealed"], l["pk"], disc("ScoreLog"))
                    sl = decode_scorelog(raw) if raw else None
                    if (sl is None or sl["run"] != l["run"] or sl["benchmark"] != l["benchmark"]
                            or sl["correct"] != l["correct"] or sl["items"] != l["items"]
                            or bool(sl["vouched"]) != bool(l["vouched"])
                            or bool(sl["postReveal"]) != bool(l["postReveal"])):
                        bind_ok = False
                res_ok = True
                for v in card["venues"]:
                    if v["status"] != 1:
                        continue
                    if v["kind"] == "duel":
                        a, b = run_by.get(v["run"]), run_by.get(v["runB"])
                        if not a or not b or a["status"] != 1 or b["status"] != 1:
                            continue
                        packed = (a["correct"] << 16) | b["correct"]
                        expected = 0 if a["correct"] > b["correct"] else 1 if a["correct"] < b["correct"] else 2
                        res_ok &= v["resolvedScore"] == packed and v["outcome"] == expected
                    elif v["kind"] == "ladder":
                        legs = [run_by.get(p) for p in v["legs"]]
                        if any(r is None or r["status"] != 1 for r in legs):
                            continue
                        best = max(r["correct"] for r in legs)
                        mask = sum((1 << i) for i, r in enumerate(legs) if r["correct"] == best)
                        res_ok &= v["resolvedScore"] == best and v["resultMask"] == mask
                    elif v["kind"] == "bounty":
                        if not v.get("winnerRun"):
                            continue
                        w = run_by.get(v["winnerRun"])
                        if not w or w["status"] != 1:
                            continue
                        res_ok &= w["correct"] == v["winningScore"] and w["correct"] >= v["threshold"]
                    else:
                        r = run_by.get(v["run"])
                        if not r or r["status"] != 1:
                            continue
                        res_ok &= v["resolvedScore"] == r["correct"]
                if not (ident and runs_ok and banks_ok and logs_ok and venue_ok
                        and ag_ok and bind_ok and res_ok):
                    c_bad += 1
            except Exception:
                c_bad += 1
        ok &= check("sealed-claim/v1 cards", c_bad == 0,
                    f"{c_n - c_bad}/{c_n} model claims: every PDA re-derived, run + receipt "
                    f"bytes bound, venues replayed from Run.correct")

    # --- sealed-report/v1 — the narrated capability cards (.md) -----------
    # A report proves its numbers by committing to the claim card's
    # canonical sha256 (generatedAt/source excluded). Recompute it.
    rdir = ROOT / "docs" / "evidence" / "reports"
    if rdir.is_dir():
        for rpt in card_iter(rdir, "*.md", "sealed-report/v1"):
            txt = rpt.read_text()
            if "sealed-report/v1" not in txt:
                continue
            mm = re.search(r"claim-card content sha256 `([0-9a-f]{64})`", txt)
            model_m = re.search(r"# Capability report — (.+)", txt)
            claim = ROOT / "docs" / "evidence" / "claims" / f"{model_m.group(1).strip()}.json" if model_m else None
            ok_h = False
            if mm and claim and claim.exists():
                c = json.loads(claim.read_text())
                c.pop("generatedAt", None); c.pop("source", None)
                canon = json.dumps(c, sort_keys=True, separators=(",", ":")).encode()
                ok_h = hashlib.sha256(canon).hexdigest() == mm.group(1)
            ok &= check(f"{rpt.name}: claim-card binding", ok_h,
                        "report's numbers hash-commit to the replayed claim card"
                        if ok_h else "canonical hash mismatch or claim missing")

    # --- sealed-policy/v1 — gate certificates -----------------------------
    pdir = ROOT / "docs" / "evidence" / "policies"
    if pdir.is_dir():
        for card_path in card_iter(pdir, kind="sealed-policy/v1"):
            if card_path.name == "index.json":
                continue
            card = json.loads(card_path.read_text())
            if card.get("kind") != "sealed-policy/v1":
                continue
            name = card_path.name
            pol = card["policy"]
            ok &= check(f"{name}: kind", True)
            spid = card["programs"]["sealed"]
            # receipt ↔ ScoreLog binding surface: decoded snapshot receipts for
            # this cert's record set (bank-filtered like the cert's policy.bank)
            bank_arg = pol.get("bank")
            bank_pks = None
            if bank_arg:
                bank_pks = set()
                for a in SNAP["sealed"]:
                    d = base64.b64decode(a["data"])
                    if d[:8] != disc("Benchmark"):
                        continue
                    if a["pubkey"] == bank_arg or decode_benchmark(d)["name"] == bank_arg:
                        bank_pks.add(a["pubkey"])
            logs_by_rec = {}
            for a in SNAP["sealed"]:
                d = base64.b64decode(a["data"])
                if d[:8] != disc("ScoreLog"):
                    continue
                l = decode_scorelog(d)
                if bank_pks is not None and l["benchmark"] not in bank_pks:
                    continue
                logs_by_rec.setdefault(l["modelRecord"], []).append(
                    (l["correct"], l["items"], bool(l["vouched"]), bool(l["postReveal"])))
            npass, v_bad, r_bad = 0, 0, 0
            for m in card["models"]:
                ident = b58encode_check(
                    pda([b"modelrec", bytes.fromhex(m["seeds"]["modelHash"])], spid) or b"",
                    m["recordPk"])
                emb = sorted((r["correct"], r["items"], bool(r.get("vouchedAtRecord")),
                              bool(r.get("postReveal"))) for r in m["receipts"])
                if emb != sorted(logs_by_rec.get(m["recordPk"], [])):
                    r_bad += 1
                v = eval_gate(m["receipts"], pol)
                w = m["verdict"]
                if (not ident or bool(w["pass"]) != v["pass"] or w.get("reason") != v["reason"]
                        or abs(w.get("pct", -1) - v["pct"]) > 0.01
                        or w.get("runs") != v["runs"] or w.get("items") != v["items"]
                        or w.get("correct") != v["correct"]
                        or w.get("postRevealRuns") != v["postRevealRuns"]):
                    v_bad += 1
                npass += 1 if v["pass"] else 0
            s = card["summary"]
            recomp_fail = sum(1 for m in card["models"] if m["verdict"].get("reason") == "policy")
            recomp_ne = sum(1 for m in card["models"] if m["verdict"].get("reason") == "no-evidence")
            ok &= check(f"{name}: verdict replay", v_bad == 0,
                        f"{len(card['models'])} models — record PDAs + verdicts recomputed bit-exact")
            ok &= check(f"{name}: receipt binding", r_bad == 0,
                        "every embedded receipt multiset == decoded ScoreLog bytes"
                        + (f" (bank {bank_arg[:8]}…)" if bank_arg else ""))
            ok &= check(f"{name}: summary", s.get("records") == len(card["models"])
                        and s.get("pass") == npass
                        and s.get("fail") == recomp_fail
                        and s.get("noEvidence") == recomp_ne,
                        f"{s.get('records')} records · {s.get('pass')} pass · {s.get('fail')} fail · {s.get('noEvidence')} no-evidence")

    # --- sealed-catalog/v1 — the index proves itself -----------------------
    cat_path = Path(_CARD[0]) if _CARD and _CARD[1] == "sealed-catalog/v1" \
        else ROOT / "docs" / "evidence" / "artifacts.json"
    if cat_path.exists() and (_CARD is None or _CARD[1] == "sealed-catalog/v1"):
        card = json.loads(cat_path.read_text())
        if card.get("kind") == "sealed-catalog/v1":
            # completeness — the same walk the TypeScript scanner performs
            found = []
            for dp, _dn, fn in os.walk(ROOT / "docs" / "evidence"):
                for f in sorted(fn):
                    if not f.endswith((".json", ".md")) or f in ("index.json", "artifacts.json", "SHA256SUMS", "README.md"):
                        continue
                    full = Path(dp) / f
                    rel = full.relative_to(ROOT / "docs" / "evidence").as_posix()
                    try:
                        raw = full.read_text()
                        k = ("sealed-report/v1" if f.endswith(".md") and "sealed-report/v1" in raw
                             else None if f.endswith(".md") else json.loads(raw).get("kind"))
                    except Exception:
                        k = None
                    if k:
                        found.append(rel)
            listed = [a["path"] for a in card.get("artifacts", [])]
            ok &= check("artifacts.json: completeness",
                        sorted(found) == sorted(listed) and card.get("count") == len(listed),
                        f"{len(listed)} listed / {len(found)} found")
            # kind honesty + hash pinning vs SHA256SUMS
            sums = {}
            for line in (ROOT / "docs" / "evidence" / "SHA256SUMS").read_text().splitlines():
                if "  " in line:
                    h, p = line.split("  ", 1)
                    sums[p.lstrip("./")] = h
            k_bad = h_bad = 0
            for a in card.get("artifacts", []):
                full = ROOT / "docs" / "evidence" / a["path"]
                if not full.exists():
                    k_bad += 1
                    continue
                raw = full.read_text()
                actual = ("sealed-report/v1" if a["path"].endswith(".md") and "sealed-report/v1" in raw
                          else json.loads(raw).get("kind") if a["path"].endswith(".json") else None)
                if actual != a["kind"]:
                    k_bad += 1
                if sums.get(a["path"]) != hashlib.sha256(full.read_bytes()).hexdigest():
                    h_bad += 1
            ok &= check("artifacts.json: kind honesty + hash pinning",
                        k_bad == 0 and h_bad == 0,
                        f"{len(listed)} entries parse to their declared kind, every sha256 pinned")

    # --- sealed-bank/v1 — the exam dossier: fold + full surface ------------
    bdir = ROOT / "docs" / "evidence" / "banks"
    if bdir.is_dir():
        for card_path in card_iter(bdir, kind="sealed-bank/v1"):
            if card_path.name == "index.json":
                continue
            card = json.loads(card_path.read_text())
            if card.get("kind") != "sealed-bank/v1":
                continue
            name, spid = card_path.name, card["programs"]["sealed"]
            bank = card["bank"]
            ok &= check(f"{name}: bank PDA", b58encode_check(
                pda([b"benchmark", b58decode(bank["authority"]),
                     struct.pack("<I", int(bank["id"]))], spid) or b"", bank["pk"]),
                "[benchmark, authority, u32le(id)]")
            # [2] chunk set — PDAs + complete enumeration + field binding
            c_bad, bound = 0, 0
            for c in card["chunks"]["public"]:
                if not b58encode_check(
                        pda([b"items", b58decode(bank["pk"]), struct.pack("<H", c["index"])],
                            spid) or b"", c["pk"]):
                    c_bad += 1
            for c in card["chunks"]["private"]:
                if not b58encode_check(
                        pda([b"pitems", b58decode(bank["pk"]), struct.pack("<H", c["index"])],
                            spid) or b"", c["pk"]):
                    c_bad += 1
            real_i = {a["pubkey"]: base64.b64decode(a["data"]) for a in SNAP["sealed"]
                      if base64.b64decode(a["data"])[:8] == disc("ItemChunk")}
            real_p = {a["pubkey"]: base64.b64decode(a["data"]) for a in SNAP["sealed"]
                      if base64.b64decode(a["data"])[:8] == disc("PrivItemChunk")}
            on_bank_i = {k: v for k, v in real_i.items() if b58encode(v[8:40]) == bank["pk"]}
            on_bank_p = {k: v for k, v in real_p.items() if b58encode(v[8:40]) == bank["pk"]}
            card_set = {c["pk"] for c in card["chunks"]["public"] + card["chunks"]["private"]}
            complete = card_set == set(on_bank_i) | set(on_bank_p)
            for c in card["chunks"]["public"]:
                d = on_bank_i.get(c["pk"])
                if d is not None:
                    st = decode_item_chunk(d)
                    if st["index"] == c["index"] and st["partsWritten"] == c["partsWritten"] \
                            and st["mintOrder"] == c["mintOrder"]:
                        bound += 1
            for c in card["chunks"]["private"]:
                d = on_bank_p.get(c["pk"])
                if d is not None:
                    st = decode_priv_item_chunk(d)
                    if st["index"] == c["index"] and st["partsWritten"] == c["partsWritten"] \
                            and st["mintOrder"] == c["mintOrder"]:
                        bound += 1
            ok &= check(f"{name}: chunk set",
                        c_bad == 0 and complete
                        and bound == len(card["chunks"]["public"]) + len(card["chunks"]["private"]),
                        f"{len(card['chunks']['public'])} items + {len(card['chunks']['private'])} pitems "
                        f"PDAs re-derive · {bound} field-bound · complete")
            # [3] items_root fold — replayed from pinned chunk bytes in
            # mint_order landing sequence (generated folds spec bytes,
            # private folds ciphertexts+nonces; authored banks carry no
            # on-chain fold — the root binds to the account field only)
            foldable = card["chunks"]["public"] or card["chunks"]["private"]
            priv = not card["chunks"]["public"] and bool(card["chunks"]["private"])
            if not foldable:
                fold_ok, fold_msg = True, "authored bank — items_root is an externally-committed root; bound to account field"
            else:
                steps = []
                fold_ok, fold_msg = True, ""
                raw_all = {a["pubkey"]: base64.b64decode(a["data"]) for a in SNAP["sealed"]}
                for c in foldable:
                    buf = raw_all.get(c["pk"])
                    if buf is None:
                        fold_ok, fold_msg = False, f"chunk {c['pk'][:8]}… not in snapshot"
                        break
                    st = decode_priv_item_chunk(buf) if priv else decode_item_chunk(buf)
                    for part in range(4):
                        if not (st["partsWritten"] & (1 << part)):
                            continue
                        if priv:
                            enc = b"".join(st["ciphertexts"][part * 2 + k] for k in range(2)) \
                                  + st["nonces"][part].to_bytes(16, "little")
                        else:
                            enc = b"".join(bytes(st["specs"][part * 8 + k]) for k in range(8))
                        steps.append((st["mintOrder"][part], c["index"], part, enc))
                if fold_ok:
                    fold_root = b"\x00" * 32
                    for _seq, ci, part, enc in sorted(steps, key=lambda s: s[0]):
                        fold_root = (priv_items_fold(fold_root, ci, part, enc) if priv
                                     else gen_items_fold(fold_root, ci, part, enc))
                    got = fold_root.hex()
                    fold_ok = got == bank["itemsRoot"]
                    fold_msg = (f"{len(steps)} parts re-folded in landing order → {got[:12]}… "
                                + ("== items_root" if fold_ok else f"!= items_root {bank['itemsRoot'][:12]}…"))
            ok &= check(f"{name}: items_root fold", fold_ok, fold_msg)
            # [4] bank fields vs decoded Benchmark
            braw = find_account(SNAP["sealed"], bank["pk"], disc("Benchmark"))
            real = decode_benchmark(braw) if braw else None
            f_ok = bool(real) and all([
                real["authority"] == bank["authority"], str(real["id"]) == str(bank["id"]),
                real["name"] == bank["name"], str(real["kind"]) == str(bank["kind"]),
                str(real["chunkCount"]) == str(bank["chunkCount"]),
                str(real["chunksSealed"]) == str(bank["chunksSealed"]),
                real["itemsRoot"] == bank["itemsRoot"],
                str(real["feeLamports"]) == str(bank["feeLamports"]),
                str(real["runCount"]) == str(bank["runCount"]),
                str(real["revealCount"]) == str(bank["revealCount"]),
                str(real["createdAt"]) == str(bank["createdAt"]),
                str(real["status"]) == str(bank["status"])])
            ok &= check(f"{name}: bank fields", f_ok,
                        "authority · id · name · kind · counts · items_root · fee · status all equal the decoded account")
            # [5] run surface
            real_runs = {}
            for a in SNAP["sealed"]:
                d = base64.b64decode(a["data"])
                if d[:8] == disc("Run") and b58encode(d[8:40]) == bank["pk"]:
                    real_runs[a["pubkey"]] = decode_run(d)
            r_bad = 0 if len(real_runs) == len(card["runs"]) else 1
            for r in card["runs"]:
                if not b58encode_check(
                        pda([b"run", b58decode(bank["pk"]), u64le(r["index"])], spid) or b"", r["pk"]):
                    r_bad += 1
                    continue
                rr = real_runs.get(r["pk"])
                if not (rr and rr["index"] == r["index"] and rr["modelId"] == r["modelId"]
                        and rr["status"] == r["status"] and rr["correct"] == r["correct"]
                        and rr["postReveal"] == r["postReveal"]):
                    r_bad += 1
            ok &= check(f"{name}: run surface", r_bad == 0,
                        f"{len(card['runs'])} runs — PDAs re-derive · field-bound · complete")
            # [6] disclosure surface
            real_rev = sum(1 for a in SNAP["sealed"]
                           if base64.b64decode(a["data"])[:8] == disc("Reveal")
                           and b58encode(base64.b64decode(a["data"])[8:40]) == bank["pk"])
            real_gr = sum(1 for a in SNAP["sealed"]
                          if base64.b64decode(a["data"])[:8] == disc("ShareGrant")
                          and b58encode(base64.b64decode(a["data"])[8:40]) == bank["pk"])
            d_bad = (real_rev != len(card["reveals"])) + (real_gr != len(card["grants"]))
            for r in card["reveals"]:
                d_bad += 0 if b58encode_check(
                    pda([b"reveal", b58decode(bank["pk"]), struct.pack("<H", r["chunkIndex"]),
                         bytes([r["part"]])], spid) or b"", r["pk"]) else 1
            for g in card["grants"]:
                d_bad += 0 if b58encode_check(
                    pda([b"grant", b58decode(bank["pk"]), struct.pack("<H", g["chunkIndex"]),
                         bytes([g["part"]]), b58decode(g["viewer"])], spid) or b"", g["pk"]) else 1
            ok &= check(f"{name}: disclosure surface", d_bad == 0,
                        f"{len(card['reveals'])} reveals + {len(card['grants'])} grants — PDAs re-derive · counts complete")
            # [7] receipt surface
            real_logs = {}
            for a in SNAP["sealed"]:
                d = base64.b64decode(a["data"])
                if d[:8] == disc("ScoreLog") and b58encode(d[72:104]) == bank["pk"]:
                    real_logs[a["pubkey"]] = decode_scorelog(d)
            l_bad = 0 if len(real_logs) == len(card["receipts"]) else 1
            for l in card["receipts"]:
                r = real_logs.get(l["pk"])
                if not (r and r["run"] == l["run"] and r["modelRecord"] == l["modelRecord"]
                        and r["correct"] == l["correct"] and r["items"] == l["items"]
                        and r["vouched"] == l["vouched"] and r["postReveal"] == l["postReveal"]
                        and r["recordedAt"] == l["recordedAt"]):
                    l_bad += 1
            ok &= check(f"{name}: receipt surface", l_bad == 0,
                        f"{len(card['receipts'])} score receipts on this bank — field-bound · complete")
            # [8] snapshot binding
            snap_digest = hashlib.sha256((ROOT / "web" / "snapshot.json").read_bytes()).hexdigest()
            ok &= check(f"{name}: snapshot binding", snap_digest == card.get("snapshot"),
                        "sha256(snapshot.json) == card.snapshot")

    # --- sealed-evidence-digest/v1 — the whole-ledger verdict --------------
    dig_path = Path(_CARD[0]) if _CARD and _CARD[1] == "sealed-evidence-digest/v1" \
        else ROOT / "docs" / "evidence" / "digest.json"
    if dig_path.exists() and (_CARD is None or _CARD[1] == "sealed-evidence-digest/v1"):
        card = json.loads(dig_path.read_text())
        if card.get("kind") == "sealed-evidence-digest/v1":
            rebuilt = build_digest()
            snap_sha = hashlib.sha256((ROOT / "web" / "snapshot.json").read_bytes()).hexdigest()
            ok &= check("digest.json: snapshot binding",
                        card.get("snapshotSha256") == snap_sha,
                        "sha256(snapshot.json) matches the digest's bound bytes")
            diffs = [k for k in set(list(card) + list(rebuilt))
                     if k not in ("generatedAt", "source")
                     and card.get(k) != rebuilt.get(k)]
            ok &= check("digest.json: field replay", not diffs,
                        "counts, integrity rows, keeper board, bank + record ledgers — "
                        "all rebuilt from decoded account bytes"
                        if not diffs else f"field mismatch: {', '.join(sorted(diffs)[:5])}")
            integ = rebuilt["integrity"]
            ok &= check("digest.json: integrity verdicts",
                        integ["recordsBad"] == 0 and integ["resolutionsBad"] == 0,
                        f"{integ['recordsOk']} records bit-exact · "
                        f"{integ['resolutionsOk']} resolutions match Run.correct")

    # --- sealed-tamper/v1 — the committed lie exhibit ----------------------
    # Each exhibit carries a forged artifact; verifying it means the inner
    # card MUST be rejected by this implementation too. If a "forgery"
    # passes Python's checks the exhibit fails — the evidence base ships
    # proof of its own skepticism in a second language.
    tdir = ROOT / "docs" / "evidence" / "tamper"
    if tdir.is_dir():
        t_n, t_bad = 0, 0
        for card_path in card_iter(tdir, kind="sealed-tamper/v1"):
            if card_path.name == "index.json":
                continue
            e = json.loads(card_path.read_text())
            if e.get("kind") != "sealed-tamper/v1":
                continue
            t_n += 1
            if not forged_card_rejected(e.get("forged") or {}):
                t_bad += 1
        ok &= check("sealed-tamper/v1 exhibits", t_bad == 0,
                    f"{t_n - t_bad}/{t_n} committed forgeries rejected by Python's "
                    f"decoders + replays")

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


def eval_gate(receipts, pol):
    """evalGate() from gate.ts, ported line-for-line: vouchedOnly/noPostReveal
    select the evidence scope, runs==0 → no-evidence, then the check list
    (minPct/minRuns/minItems/minWilsonPct) decides pass|policy."""
    post = sum(1 for r in receipts if r.get("postReveal"))
    sel = [r for r in receipts if r.get("vouchedAtRecord")] if pol.get("vouchedOnly") else list(receipts)
    if pol.get("noPostReveal"):
        sel = [r for r in sel if not r.get("postReveal")]
    runs = len(sel)
    c = sum(r["correct"] for r in sel)
    it = sum(r["items"] for r in sel)
    pct = 100 * c / it if it else 0.0
    if runs == 0:
        return {"pass": False, "reason": "no-evidence", "runs": runs,
                "items": it, "correct": c, "pct": 0.0, "postRevealRuns": post}
    checks = []
    if pol.get("minPct") is not None:
        checks.append(pct >= float(pol["minPct"]))
    if pol.get("minRuns") is not None:
        checks.append(runs >= int(pol["minRuns"]))
    if pol.get("minItems") is not None:
        checks.append(it >= int(pol["minItems"]))
    if pol.get("minWilsonPct") is not None:
        checks.append(wilson_lcb(c, it) >= float(pol["minWilsonPct"]))
    ok = all(checks)
    return {"pass": ok, "reason": "pass" if ok else "policy", "runs": runs,
            "items": it, "correct": c, "pct": pct, "postRevealRuns": post}


def decode_benchmark(d):
    # disc8 authority32 id u32 bump status chunkCount u16 chunksSealed u16
    # itemsRoot32 feeLamports u64 runCount u64 createdAt i64 [kind u8] name-str
    o = 8
    authority = b58encode(d[o:o + 32]); o += 32
    bid = int.from_bytes(d[o:o + 4], "little"); o += 4
    status = d[o + 1]; o += 2
    chunk_count = int.from_bytes(d[o:o + 2], "little"); o += 2
    chunks_sealed = int.from_bytes(d[o:o + 2], "little"); o += 2
    items_root = d[o:o + 32].hex(); o += 32
    fee = int.from_bytes(d[o:o + 8], "little"); o += 8
    run_count = int.from_bytes(d[o:o + 8], "little"); o += 8
    created = int.from_bytes(d[o:o + 8], "little", signed=True); o += 8
    kind = 0
    nl_new = int.from_bytes(d[o + 1:o + 5], "little") if o + 5 <= len(d) else -1
    if o < len(d) and d[o] <= 2 and 0 <= nl_new <= 32 and o + 5 + nl_new <= len(d):
        kind = d[o]; o += 1
        nl = int.from_bytes(d[o:o + 4], "little"); o += 4
    else:
        nl = int.from_bytes(d[o:o + 4], "little") if o + 4 <= len(d) else 0
        o += 4
        if nl > 32 or o + nl > len(d):
            nl = 0
    name = d[o:o + nl].decode("utf-8", "replace")
    o += nl
    # tail (new layout): priv_viewer32 + mint_seq u16 + reveal_count u32 —
    # absent on pre-upgrade accounts.
    reveal_count = mint_seq = 0
    priv_viewer = "0" * 64
    if len(d) - o >= 38:
        priv_viewer = d[o:o + 32].hex(); o += 32
        mint_seq = int.from_bytes(d[o:o + 2], "little"); o += 2
        reveal_count = int.from_bytes(d[o:o + 4], "little"); o += 4
    return {"authority": authority, "id": bid, "status": status,
            "chunkCount": chunk_count, "chunksSealed": chunks_sealed,
            "itemsRoot": items_root, "feeLamports": fee, "runCount": run_count,
            "createdAt": created, "kind": kind, "name": name,
            "privViewer": priv_viewer, "mintSeq": mint_seq,
            "revealCount": reveal_count}


def decode_item_chunk(d):
    # disc8 benchmark32 index u16 bump parts_written  specs[32]×5B  mint_order[4]u16
    specs = [tuple(d[44 + i * 5:49 + i * 5]) for i in range(32)]
    mint_order = [int.from_bytes(d[204 + p * 2:206 + p * 2], "little") for p in range(4)]
    return {"index": int.from_bytes(d[40:42], "little"), "partsWritten": d[43],
            "specs": specs, "mintOrder": mint_order}


def decode_priv_item_chunk(d):
    # disc8 benchmark32 index u16 bump parts_written  encKey32  nonces[4]u128
    # ciphertexts[8]×32B  mint_order[4]u16
    nonces = [int.from_bytes(d[76 + p * 16:92 + p * 16], "little") for p in range(4)]
    cts = [d[140 + i * 32:172 + i * 32] for i in range(8)]
    mint_order = [int.from_bytes(d[396 + p * 2:398 + p * 2], "little") for p in range(4)]
    return {"index": int.from_bytes(d[40:42], "little"), "partsWritten": d[43],
            "nonces": nonces, "ciphertexts": cts, "mintOrder": mint_order}


def gen_items_fold(root, chunk_index, part, spec_bytes):
    # sha256("sealed/v1/genitems\0" ‖ root ‖ u16le(chunk) ‖ u8(part) ‖ specs)
    return sha256(b"sealed/v1/genitems\x00" + root
                  + struct.pack("<H", chunk_index) + bytes([part]) + spec_bytes)


def priv_items_fold(root, chunk_index, part, enc_bytes):
    return sha256(b"sealed/v1/privitems\x00" + root
                  + struct.pack("<H", chunk_index) + bytes([part]) + enc_bytes)


def decode_run(d):
    # disc8 benchmark32 runner32 index u64 bump status chunkCount u16
    # pending u64 scored u64 correct u32 created i64 finalized i64
    # harness32 outputs32 modelId str tail-flags…
    ml = int.from_bytes(d[184:188], "little")
    tail = 188 + ml
    post = False
    attested = 0
    first_pending_at = ever_queued_mask = all_queued_at = pending_since = 0
    if tail + 9 <= len(d):
        attested = d[tail]
        tail += 9   # attested u8 + attestedAt i64
    if tail + 8 <= len(d):
        pending_since = int.from_bytes(d[tail:tail + 8], "little", signed=True)
        tail += 8
    if tail + 8 <= len(d):
        first_pending_at = int.from_bytes(d[tail:tail + 8], "little", signed=True)
        tail += 8
    if tail + 8 <= len(d):
        ever_queued_mask = int.from_bytes(d[tail:tail + 8], "little")
        tail += 8
    if tail + 8 <= len(d):
        all_queued_at = int.from_bytes(d[tail:tail + 8], "little", signed=True)
        tail += 8
    if tail + 1 <= len(d):
        post = d[tail] != 0
    return {
        "benchmark": b58encode(d[8:40]), "runner": b58encode(d[40:72]),
        "index": int.from_bytes(d[72:80], "little"),
        "status": d[81],
        "scoredMask": int.from_bytes(d[92:100], "little"),
        "correct": int.from_bytes(d[100:104], "little"),
        "createdAt": int.from_bytes(d[104:112], "little", signed=True),
        "finalizedAt": int.from_bytes(d[112:120], "little", signed=True),
        "modelId": d[188:188 + ml].decode(),
        "attested": attested,
        "pendingSince": pending_since,
        "firstPendingAt": first_pending_at,
        "everQueuedMask": ever_queued_mask,
        "allQueuedAt": all_queued_at,
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
        "resolveBy": int.from_bytes(d[286:294], "little", signed=True) if len(d) >= 294 else 0,
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
        "revealUntil": int.from_bytes(d[200:208], "little", signed=True) if len(d) >= 208 else 0,
        "resolveBy": int.from_bytes(d[226:234], "little", signed=True) if len(d) >= 234 else 0,
        "tallied": len(d) > 234 and d[234] == 1,
    }


def decode_model_record(d):
    # disc8 model_hash32 model_id str runs_scored u32 total_correct u64
    # total_items u64 best_* …
    ml = int.from_bytes(d[40:44], "little")
    o = 44 + ml
    return {"modelId": d[44:o].decode(),
            "runsScored": int.from_bytes(d[o:o + 4], "little"),
            "totalCorrect": int.from_bytes(d[o + 4:o + 12], "little"),
            "totalItems": int.from_bytes(d[o + 12:o + 20], "little")}


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
        "resolveBy": int.from_bytes(d[442:450], "little", signed=True) if len(d) >= 450 else 0,
    }


HARD_CAP_SECS = 24 * 3600
NULL_PK = "1" * 32  # Pubkey::default


def _still_moving(r, now):
    return (r["status"] != 1
            and ((r["firstPendingAt"] and now <= r["firstPendingAt"] + HARD_CAP_SECS)
                 or (r["allQueuedAt"] and now <= r["allQueuedAt"] + HARD_CAP_SECS)))


def _proven(r, now):
    return (r["status"] == 1
            or (r["allQueuedAt"] and now > r["allQueuedAt"] + HARD_CAP_SECS
                and str(r["scoredMask"]) != "0"))


def classify_board(bounties, markets, ladders, runs, now):
    """board.ts classifyBoard — the keeper gates evaluated off decoded
    accounts: claimable / expired / live bounties, resolvable / expirable /
    tallyable venues, resolvableLadders, filling, settled."""
    board = {"claimable": [], "liveBounties": [], "expiredBounties": [],
             "claimedBounties": 0, "resolvable": [], "expirable": [],
             "tallyable": [], "resolvableLadders": [], "revealing": 0,
             "filling": 0, "settled": 0}
    runs_by_pk = {r["pubkey"]: r for r in runs}
    runs_by_bank = {}
    for r in runs:
        if _proven(r, now):
            runs_by_bank.setdefault(r["benchmark"], []).append(r)
    for b in bounties:
        if b["status"] != 0:
            board["claimedBounties"] += 1
            continue
        if now > b["deadline"]:
            board["expiredBounties"].append(b)
            continue
        q = sorted((r for r in runs_by_bank.get(b["bank"], [])
                    if r["correct"] >= b["threshold"] and r["createdAt"] >= b["createdAt"]
                    and r["runner"] != b["sponsor"] and not r["postReveal"]),
                   key=lambda r: -r["correct"])
        if q:
            board["claimable"].append({**b, "qualifyingRun": q[0]["pubkey"],
                                       "qualifyingScore": q[0]["correct"]})
        else:
            board["liveBounties"].append(b)
    for m in markets:
        if m["kind"] == "dark" and m["status"] == 1 and not m["tallied"]:
            if now > m.get("revealUntil", 0):
                board["tallyable"].append(m)
            else:
                board["revealing"] += 1
            continue
        if m["status"] != 0:
            board["settled"] += 1
            continue
        a = runs_by_pk.get(m["run"])
        b = runs_by_pk.get(m["runB"]) if m.get("runB") else None
        legs_done = (a and a["status"] == 1
                     and (m["kind"] != "duel" or (b and b["status"] == 1)))
        if legs_done:
            board["resolvable"].append(m)
            continue
        if (not a or (m["kind"] == "duel" and not b)
                or m["resolveBy"] == 0 or now <= m["resolveBy"]
                or _still_moving(a, now) or (b and _still_moving(b, now))):
            board["filling"] += 1
            continue
        settleable = _proven(a, now) and (_proven(b, now) if m["kind"] == "duel" else True)
        board["expirable"].append({**m, "expireOutcome": "settles" if settleable else "refunds"})
    for l in ladders:
        if l["status"] != 0:
            board["settled"] += 1
            continue
        legs = [runs_by_pk.get(pk) for pk in l["legs"]]
        if any(r is None or _still_moving(r, now) for r in legs):
            board["filling"] += 1
        else:
            board["resolvableLadders"].append(l)
    return board


def build_digest():
    """buildDigestData() ported — every digest field recomputed from decoded
    snapshot accounts (used to field-compare against the committed card)."""
    seal, mkt = {}, {}
    decoders_s = [("Benchmark", decode_benchmark), ("Run", decode_run),
                  ("ScoreLog", decode_scorelog), ("ModelRecord", decode_model_record),
                  ("Reveal", None), ("ShareGrant", decode_share_grant),
                  ("ItemChunk", decode_item_chunk), ("PrivItemChunk", decode_priv_item_chunk)]
    decoders_m = [("Market", decode_market), ("DarkMarket", decode_dark_market),
                  ("Ladder", decode_ladder), ("Bounty", decode_bounty),
                  ("Position", decode_position), ("DarkPosition", decode_dark_position)]
    for a in SNAP["sealed"]:
        d = base64.b64decode(a["data"])
        for name, fn in decoders_s:
            if d[:8] == disc(name):
                try:
                    seal.setdefault(name, []).append(
                        (a["pubkey"], fn(d) if fn else None))
                except Exception:
                    pass  # undecodable → snapOf's skip
                break
    for a in SNAP["market"]:
        d = base64.b64decode(a["data"])
        for name, fn in decoders_m:
            if d[:8] == disc(name):
                try:
                    mkt.setdefault(name, []).append(
                        (a["pubkey"], fn(d) if fn else None))
                except Exception:
                    pass
                break
    counts = {
        "banks": len(seal.get("Benchmark", [])), "runs": len(seal.get("Run", [])),
        "receipts": len(seal.get("ScoreLog", [])), "records": len(seal.get("ModelRecord", [])),
        "reveals": len(seal.get("Reveal", [])), "grants": len(seal.get("ShareGrant", [])),
        "itemChunks": len(seal.get("ItemChunk", [])), "privChunks": len(seal.get("PrivItemChunk", [])),
        "markets": len(mkt.get("Market", [])), "darkMarkets": len(mkt.get("DarkMarket", [])),
        "ladders": len(mkt.get("Ladder", [])), "bounties": len(mkt.get("Bounty", [])),
        "positions": len(mkt.get("Position", [])) + len(mkt.get("DarkPosition", [])),
    }
    # integrity.records — every ModelRecord replayed from its ScoreLogs
    logs_by_rec = {}
    for _pk, l in seal.get("ScoreLog", []):
        logs_by_rec.setdefault(l["modelRecord"], []).append(l)
    run_by_pk = {pk: r for pk, r in seal.get("Run", [])}
    correct_of = lambda pk: run_by_pk.get(pk, {}).get("correct", -1)
    rec_rows = []
    for pk, a in seal.get("ModelRecord", []):
        ls = logs_by_rec.get(pk, [])
        rc = sum(l["correct"] for l in ls)
        ri = sum(l["items"] for l in ls)
        okk = len(ls) == a["runsScored"] and rc == a["totalCorrect"] and ri == a["totalItems"]
        rec_rows.append({"pk": pk, "modelId": a["modelId"],
                         "stored": f"{a['totalCorrect']}/{a['totalItems']} over {a['runsScored']}",
                         "replayed": f"{rc}/{ri} over {len(ls)}", "ok": okk})
    venue_rows = []
    for pk, m in mkt.get("Market", []):
        if m["status"] != 1:
            continue
        duel = m["runB"] and m["runB"] != NULL_PK
        expected = (correct_of(m["run"]) << 16) | correct_of(m["runB"]) if duel else correct_of(m["run"])
        venue_rows.append({"venue": pk, "kind": "duel" if duel else "band",
                           "stored": m["resolvedScore"], "expected": expected,
                           "ok": m["resolvedScore"] == expected})
    for pk, dd in mkt.get("DarkMarket", []):
        if dd["status"] != 1:
            continue
        venue_rows.append({"venue": pk, "kind": "dark", "stored": dd["resolvedScore"],
                           "expected": correct_of(dd["run"]),
                           "ok": dd["resolvedScore"] == correct_of(dd["run"])})
    for pk, bb in mkt.get("Bounty", []):
        if bb["status"] != 1:
            continue
        venue_rows.append({"venue": pk, "kind": "bounty", "stored": bb["winningScore"],
                           "expected": correct_of(bb["winnerRun"]),
                           "ok": bb["winningScore"] == correct_of(bb["winnerRun"])})
    for pk, l in mkt.get("Ladder", []):
        if l["status"] != 1:
            continue
        legs = l["legs"][:l["legCount"]]
        scores = [correct_of(x) for x in legs]
        mx = max(scores)
        mask_ok = all((s == mx) == bool((l["resultMask"] >> i) & 1)
                      for i, s in enumerate(scores))
        venue_rows.append({"venue": pk, "kind": "ladder", "stored": l["resolvedScore"],
                           "expected": mx,
                           "ok": l["resolvedScore"] == mx and mask_ok})
    now = int(time.time())
    bruns = [{"pubkey": pk, "benchmark": r["benchmark"], "runner": r["runner"],
              "status": r["status"], "correct": r["correct"],
              "createdAt": r["createdAt"], "firstPendingAt": r["firstPendingAt"],
              "allQueuedAt": r["allQueuedAt"], "scoredMask": str(r["scoredMask"]),
              "postReveal": r["postReveal"]} for pk, r in seal.get("Run", [])]
    bbounties = [{"pubkey": pk, "sponsor": b["sponsor"], "bank": b["bank"],
                  "status": b["status"], "threshold": b["threshold"],
                  "amount": b["amount"], "createdAt": b["createdAt"],
                  "deadline": b["deadline"], "winnerRun": b["winnerRun"],
                  "winningScore": b["winningScore"]} for pk, b in mkt.get("Bounty", [])]
    bmarkets = ([{"pubkey": pk, "kind": "duel" if m["runB"] and m["runB"] != NULL_PK else "band",
                  "status": m["status"], "run": m["run"], "runB": m["runB"],
                  "resolveBy": m["resolveBy"]} for pk, m in mkt.get("Market", [])]
                + [{"pubkey": pk, "kind": "dark", "status": dd["status"], "run": dd["run"],
                    "resolveBy": dd["resolveBy"], "revealUntil": dd["revealUntil"],
                    "tallied": bool(dd["tallied"])} for pk, dd in mkt.get("DarkMarket", [])])
    bladders = [{"pubkey": pk, "status": l["status"],
                 "legs": l["legs"][:l["legCount"]], "resolveBy": l["resolveBy"]}
                for pk, l in mkt.get("Ladder", [])]
    board = classify_board(bbounties, bmarkets, bladders, bruns, now)
    keeper = {"actionable": (len(board["claimable"]) + len(board["resolvable"])
                             + len(board["resolvableLadders"]) + len(board["tallyable"])
                             + len(board["expirable"]) + len(board["expiredBounties"])),
              "settled": board["settled"], "filling": board["filling"],
              "claimable": board["claimable"], "resolvable": board["resolvable"],
              "resolvableLadders": board["resolvableLadders"],
              "tallyable": board["tallyable"], "expirable": board["expirable"],
              "expiredBounties": board["expiredBounties"]}
    return {
        "kind": "sealed-evidence-digest/v1",
        "snapshotSha256": hashlib.sha256(
            (ROOT / "web" / "snapshot.json").read_bytes()).hexdigest(),
        "programs": {"sealed": SNAP.get("meta", {}).get("programs", {}).get("sealed"),
                     "market": SNAP.get("meta", {}).get("programs", {}).get("market")},
        "epochs": SNAP.get("meta", {}).get("epochs"),
        "counts": counts,
        "integrity": {"recordsOk": sum(1 for r in rec_rows if r["ok"]),
                      "recordsBad": sum(1 for r in rec_rows if not r["ok"]),
                      "resolutionsOk": sum(1 for r in venue_rows if r["ok"]),
                      "resolutionsBad": sum(1 for r in venue_rows if not r["ok"]),
                      "records": rec_rows, "resolutions": venue_rows},
        "keeper": keeper,
        "banks": [{"pk": pk, "name": b["name"], "kind": b["kind"],
                   "items": b["chunkCount"] * 32, "runs": b["runCount"],
                   "reveals": b["revealCount"], "itemsRoot": b["itemsRoot"]}
                  for pk, b in seal.get("Benchmark", [])],
        "records": [{"pk": pk, "modelId": a["modelId"], "runsScored": a["runsScored"],
                     "totalCorrect": a["totalCorrect"], "totalItems": a["totalItems"]}
                    for pk, a in seal.get("ModelRecord", [])],
    }


def forged_card_rejected(f):
    """sealed-tamper/v1 helper: True if the inner forged card FAILS at least
    one real check under this implementation — the exhibit's whole claim.
    Reuses the same decoders/PDA math as the honest-card paths."""
    kind = f.get("kind")
    try:
        if kind == "sealed-board/v1":
            # receipt bytes + aggregates + pairwise order — any lie dies
            for m in f.get("models", []):
                for l in m.get("receipts", []):
                    raw = find_account(SNAP["sealed"], l["pk"], disc("ScoreLog"))
                    sl = decode_scorelog(raw) if raw else None
                    if (sl is None or sl["correct"] != l["correct"]
                            or bool(sl["vouched"]) != bool(l.get("vouched", 0))):
                        return True
                if sum(x["correct"] for x in m["receipts"]) != m["record"]["totalCorrect"]:
                    return True
            # Wilson order — swap-the-rank dies here
            by_bank = {m["recordPk"]: {} for m in f.get("models", [])}
            for m in f.get("models", []):
                for l in m.get("receipts", []):
                    e = by_bank[m["recordPk"]].setdefault(l["benchmark"], [0, 0])
                    e[0] += l["correct"]; e[1] += l["items"]
            stats = {m["recordPk"]: dict(wins=0, losses=0, ties=0, rankedPairs=0,
                                         sharedBanks=0, ppDelta=0.0) for m in f.get("models", [])}
            for i, A in enumerate(f.get("models", [])):
                for B in f.get("models", [])[i + 1:]:
                    a, b = by_bank[A["recordPk"]], by_bank[B["recordPk"]]
                    shared = [k for k in a if k in b]
                    if not shared:
                        continue
                    pa = sum(a[k][0] for k in shared) / max(1, sum(a[k][1] for k in shared))
                    pb = sum(b[k][0] for k in shared) / max(1, sum(b[k][1] for k in shared))
                    sa, sb = stats[A["recordPk"]], stats[B["recordPk"]]
                    sa["rankedPairs"] += 1; sb["rankedPairs"] += 1
                    if pa > pb: sa["wins"] += 1; sb["losses"] += 1
                    elif pb > pa: sb["wins"] += 1; sa["losses"] += 1
                    else: sa["ties"] += 1; sb["ties"] += 1
            order = sorted(stats.items(),
                           key=lambda t: (-wilson_lcb(t[1]["wins"] + t[1]["ties"] / 2,
                                                      t[1]["rankedPairs"]),
                                          -t[1]["wins"], -t[1]["ppDelta"]))
            for i, r in enumerate(f.get("ranking", [])):
                if i >= len(order) or r["recordPk"] != order[i][0]:
                    return True
            return False
        if kind == "sealed-bounty/v1":
            raw = find_account(SNAP["market"], f["bounty"]["pk"], DISC["bounty"])
            d = decode_bounty(raw) if raw else None
            if d is None:
                return True
            b = f["bounty"]
            if (d["status"] != b["status"] or d["threshold"] != b["threshold"]
                    or str(d["amount"]) != str(b["amount"])):
                return True
            if b["status"] == 1 and (d["winnerRun"] != b.get("winnerRun")
                                     or d["winningScore"] != b.get("winningScore")):
                return True
            return False
        if kind == "sealed-trail/v1":
            r = f["run"]
            raw = find_account(SNAP["sealed"], r["pk"], disc("Run"))
            dr = decode_run(raw) if raw else None
            if dr is None or dr["correct"] != r["correct"] or dr["status"] != r["status"]:
                return True
            msec = SNAP["market"]
            for v in f.get("venues", []):
                vtype = {"band": "Market", "duel": "Market", "dark": "DarkMarket",
                         "ladder": "Ladder", "bounty": "Bounty"}[v["kind"]]
                raw = find_account(msec, v["pk"], disc(vtype))
                if raw is None:
                    return True
                if v["kind"] in ("band", "duel"):
                    a = decode_market(raw)
                    if a["totals"] != [int(x) for x in v.get("totals", [])] or a["status"] != v["status"]:
                        return True
                elif v["kind"] == "dark":
                    a = decode_dark_market(raw)
                    if (a["poolTotal"] != int(v["poolTotal"]) or a["winTotal"] != int(v["winTotal"])
                            or a["tallied"] != bool(v["tallied"])):
                        return True
                elif v["kind"] == "ladder":
                    a = decode_ladder(raw)
                    if a["totals"] != [int(x) for x in v.get("totals", [])] or a["status"] != v["status"]:
                        return True
                else:
                    a = decode_bounty(raw)
                    if a["amount"] != int(v["amount"]) or a["status"] != v["status"]:
                        return True
            # settlement replay vs decoded score
            resolved = [v for v in f.get("venues", []) if v["status"] == 1]
            for v in resolved:
                got = (v["resolvedScore"] if v["kind"] in ("band", "dark")
                       else (v["resolvedScore"] >> 16 if v.get("side") == "a"
                             else v["resolvedScore"] & 0xffff) if v["kind"] == "duel"
                       else v["winningScore"] if v["kind"] == "bounty"
                       else v["legs"][v["legIndex"]]["correct"])
                if got != dr["correct"]:
                    return True
            return False
        if kind == "sealed-grant/v1":
            s = f["grant"]["seeds"]
            derived = pda([b"grant", b58decode(s["bank"]),
                           struct.pack("<H", int(s["chunkIndex"])),
                           bytes([int(s["part"])]), b58decode(s["viewer"])],
                          f["programs"]["sealed"])
            if derived is None or derived != b58decode(f["grant"]["pk"]):
                return True
            raw = find_account(SNAP["sealed"], f["grant"]["pk"], DISC["shareGrant"])
            d = decode_share_grant(raw) if raw else None
            if d is None or d["viewer"] != f["grant"]["viewer"]:
                return True
            return False
        if kind == "sealed-position/v1":
            msec = SNAP["market"]
            acct = f["position"]["account"]
            raw = find_account(msec, f["position"]["pk"],
                               DISC["darkPosition"] if acct == "dark" else DISC["position"])
            if raw is None:
                return True
            if acct == "dark":
                d = decode_dark_position(raw)
                if str(d["amount"]) != str(f["stake"]["amount"]):
                    return True
            else:
                d = decode_position(raw)
                if d["amounts"] != [int(x) for x in f["stake"]["amounts"]]:
                    return True
            return False
        if kind == "sealed-policy/v1":
            # gate replay: pass = pct >= minPct && runs >= minRuns
            pol = f.get("policy", {})
            s = f.get("summary", {})
            npass = 0
            for m in f.get("models", []):
                v = m["verdict"]
                c = sum(r["correct"] for r in m.get("receipts", []))
                it = sum(r["items"] for r in m.get("receipts", []))
                n = len(m.get("receipts", []))
                if pol.get("vouchedOnly"):
                    recs = [r for r in m["receipts"] if r.get("vouchedAtRecord")]
                    c = sum(r["correct"] for r in recs); it = sum(r["items"] for r in recs)
                    n = len(recs)
                pct = 100 * c / it if it else 0
                want = n >= int(pol.get("minRuns", 0)) and pct >= float(pol.get("minPct", 0))
                if pol.get("noPostReveal") and any(r.get("postReveal") for r in m.get("receipts", [])):
                    want = False
                if bool(v["pass"]) != want:
                    return True
                npass += 1 if want else 0
            if s.get("pass") is not None and s["pass"] != npass:
                return True
            return False
    except Exception:
        return True  # a malformed forgery is a rejected forgery
    return True  # unknown kind — we cannot bless it


# --- Rescue cipher + x25519 — the selective-disclosure port -----------------
# The SAME Rescue-Prime cipher the browser and harness decrypt ShareGrants
# with (web/vendor/rescue.mjs, vendored from @arcium-hq/client) — re-derived
# in stdlib Python: Fp = 2^255-19, SHAKE256-sampled constants, Cauchy MDS,
# m=5 CTR mode. The ct*/binSize machinery in the JS is constant-time armor;
# semantically it is signed modular arithmetic — plain % P reproduces it.

FP = 2 ** 255 - 19                       # CURVE25519_BASE_FIELD.ORDER
RESCUE_M = 5                             # cipher block size (field elements)


def _fadd(a, b):
    return (a + b) % FP


def _mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(len(b))) % FP
             for j in range(len(b[0]))] for i in range(len(a))]


def _mat_add(a, b):
    return [[(a[i][j] + b[i][j]) % FP for j in range(len(a[0]))]
            for i in range(len(a))]


def _mat_sub(a, b):
    return [[(a[i][j] - b[i][j]) % FP for j in range(len(a[0]))]
            for i in range(len(a))]


def _mat_pow(a, e):
    return [[pow(x, e, FP) for x in row] for row in a]


def _mat_det(a):
    # Gauss elimination over Fp — mirrors rescue.mjs Matrix.det(): pivot on
    # the first nonzero row, forward-eliminate the rest, drop the column.
    rows = [list(r) for r in a]
    det = 1
    for _ in range(len(rows)):
        lz = [r for r in rows if r[0] % FP == 0]
        nlz = [r for r in rows if r[0] % FP != 0]
        if not nlz:
            return 0
        piv = nlz.pop(0)
        det = det * piv[0] % FP
        inv = pow(piv[0], FP - 2, FP)
        norm = [v * inv % FP for v in piv]
        rows = ([[(v - r[0] * nv) % FP for v, nv in zip(r, norm)][1:]
                 for r in nlz]
                + [r[1:] for r in lz])
    return det


class _ShakeStream:
    """noble shake256.update(seed) + sequential .xof(buflen) — Python's
    shake_256.digest(n) returns the FIRST n bytes, so we extend lazily."""
    def __init__(self, seed: bytes, buflen: int = 48):
        self.h = hashlib.shake_256(seed)
        self.buflen = buflen
        self.i = 0
        self.buf = b""

    def next(self):
        if (self.i + 1) * self.buflen > len(self.buf):
            self.buf = self.h.digest((self.i + 64) * self.buflen)
        out = self.buf[self.i * self.buflen:(self.i + 1) * self.buflen]
        self.i += 1
        return int.from_bytes(out, "little") % FP


def _build_cauchy(n):
    return [[pow(i + j, FP - 2, FP) for j in range(1, n + 1)]
            for i in range(1, n + 1)]


def _rescue_alpha():
    p1 = FP - 1
    for a in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47):
        if p1 % a != 0:
            return a, pow(a, -1, p1)
    raise ValueError("no alpha")


def _nrounds_cipher(m):
    alpha = _rescue_alpha()[0]
    l0 = math.ceil((2 * 128) / ((m + 1) * (math.log2(FP) - math.log2(alpha - 1))))
    l1 = (math.ceil((128 + 2) / (4 * m)) if alpha == 3
          else math.ceil((128 + 3) / (5.5 * m)))
    return 2 * max(l0, l1, 5)


def _nrounds_hash(m, capacity):
    alpha = _rescue_alpha()[0]
    rate = m - capacity
    dcon = lambda n: int(0.5 * (alpha - 1) * m * (n - 1) + 2.0)
    v = lambda n: m * (n - 1) + rate
    target = 1 << 256
    l1 = 1
    while math.comb(v(l1) + dcon(l1), v(l1)) ** 2 <= target and l1 <= 23:
        l1 += 1
    return math.ceil(1.5 * max(5, l1))


def _vec(elems):
    return [[e % FP] for e in elems]


def _rescue_permutation(subkeys, state, alpha, alpha_inv, mds, mode):
    # rescue.mjs rescuePermutation — alternating alpha/alphaInv power rounds
    # with MDS + subkey inject. cipher: even→alphaInv, odd→alpha; hash flips.
    e_even, e_odd = ((alpha_inv, alpha) if mode == "cipher" else (alpha, alpha_inv))
    states = [_mat_add(state, subkeys[0])]
    for r in range(len(subkeys) - 1):
        s = _mat_pow(states[r], e_even if r % 2 == 0 else e_odd)
        states.append(_mat_add(_mat_mul(mds, s), subkeys[r + 1]))
    return states


class _RescueDescCipher:
    """Cipher-mode RescueDesc: m = len(key), constants from
    shake256('encrypt everything, compute anything'), round keys = the
    key-schedule permutation of the key vector."""
    def __init__(self, key):
        self.m = len(key)
        self.alpha, self.alpha_inv = _rescue_alpha()
        self.n = _nrounds_cipher(self.m)
        self.mds = _build_cauchy(self.m)
        stream = _ShakeStream(b"encrypt everything, compute anything")
        r_field = [stream.next() for _ in range(self.m * self.m + 2 * self.m)]
        mat = [r_field[i * self.m:(i + 1) * self.m] for i in range(self.m)]
        init = [[e] for e in r_field[self.m * self.m:self.m * self.m + self.m]]
        affine = [[e] for e in r_field[self.m * self.m + self.m:]]
        while _mat_det(mat) == 0:
            mat = [[stream.next() for _ in range(self.m)] for _ in range(self.m)]
        consts = [init]
        for r in range(2 * self.n):
            consts.append(_mat_add(_mat_mul(mat, consts[r]), affine))
        self.round_keys = _rescue_permutation(consts, _vec(key),
                                              self.alpha, self.alpha_inv,
                                              self.mds, "cipher")

    def permute(self, state_vec):
        return _rescue_permutation(self.round_keys, _vec(state_vec),
                                   self.alpha, self.alpha_inv,
                                   self.mds, "cipher")[-1]


class _RescuePrimeHash:
    """Hash-mode RescueDesc: m=12 rate=7 capacity=5, constants from
    shake256(f'Rescue-XLIX({P},{m},{cap},{security})'), digest length 5."""
    def __init__(self):
        self.m, self.rate, self.capacity = 12, 7, 5
        self.alpha, self.alpha_inv = _rescue_alpha()
        self.n = _nrounds_hash(self.m, self.capacity)
        self.mds = _build_cauchy(self.m)
        stream = _ShakeStream(f"Rescue-XLIX({FP},{self.m},{self.capacity},256)".encode())
        consts = [[[0] for _ in range(self.m)]]
        for r in range(2 * self.n):
            consts.append([[stream.next()] for _ in range(self.m)])
        self.subkeys = consts

    def permute(self, state):
        return _rescue_permutation(self.subkeys, state,
                                   self.alpha, self.alpha_inv,
                                   self.mds, "hash")[-1]

    def digest(self, message):
        padded = list(message) + [1]
        while len(padded) % self.rate:
            padded.append(0)
        state = [[0]] * self.m
        for r in range(len(padded) // self.rate):
            s = [[padded[r * self.rate + i]] for i in range(self.rate)] \
                + [[0]] * (self.m - self.rate)
            state = self.permute(_mat_add(state, s))
        return [state[i][0] for i in range(5)]


class RescueCipher:
    """rescue.mjs RescueCipher — CTR-mode Rescue over Fp25519, m=5."""
    def __init__(self, shared_secret: bytes):
        if len(shared_secret) != 32:
            raise ValueError("shared secret must be 32 bytes")
        ss = int.from_bytes(shared_secret, "little") % FP
        key = _RescuePrimeHash().digest([1, ss, RESCUE_M])
        self.desc = _RescueDescCipher(key)

    def decrypt(self, cts: list, nonce: bytes):
        if len(nonce) != 16:
            raise ValueError("nonce must be 16 bytes")
        fields = [int.from_bytes(c, "little") for c in cts]
        n_blocks = math.ceil(len(fields) / RESCUE_M)
        n0 = int.from_bytes(nonce, "little")
        out = []
        for i in range(n_blocks):
            ks = self.desc.permute([n0, i, 0, 0, 0])
            blk = fields[i * RESCUE_M:i * RESCUE_M + RESCUE_M]
            out.extend((c - ks[j][0]) % FP for j, c in enumerate(blk))
        return out

    def encrypt(self, fields, nonce: bytes):
        n_blocks = math.ceil(len(fields) / RESCUE_M)
        n0 = int.from_bytes(nonce, "little")
        out = []
        for i in range(n_blocks):
            ks = self.desc.permute([n0, i, 0, 0, 0])
            blk = fields[i * RESCUE_M:i * RESCUE_M + RESCUE_M]
            out.extend(((p + ks[j][0]) % FP).to_bytes(32, "little")
                       for j, p in enumerate(blk))
        return out


def x25519_shared(ed_secret32: bytes, peer_u: bytes) -> bytes:
    """noble: toMontgomerySecret = sha512(seed)[:32] (unclamped — the
    RFC7748 clamp is applied inside scalarMult), then the Montgomery
    ladder on curve25519."""
    h = hashlib.sha512(ed_secret32).digest()[:32]
    k = bytearray(h)
    k[0] &= 248
    k[31] &= 127
    k[31] |= 64
    scalar = int.from_bytes(k, "little")
    u = int.from_bytes(peer_u, "little") & (2 ** 255 - 1)
    x1, x2, z2, x3, z3, swap = u, 1, 0, u, 1, 0
    for t in reversed(range(255)):
        kt = (scalar >> t) & 1
        swap ^= kt
        if swap:
            x2, x3, z2, z3 = x3, x2, z3, z2
        swap = kt
        a = (x2 + z2) % FP
        aa = a * a % FP
        b = (x2 - z2) % FP
        bb = b * b % FP
        e = (aa - bb) % FP
        c = (x3 + z3) % FP
        dd = (x3 - z3) % FP
        da = dd * a % FP
        cb = c * b % FP
        x3 = (da + cb) ** 2 % FP
        z3 = x1 * ((da - cb) ** 2 % FP) % FP
        x2 = aa * bb % FP
        z2 = e * (aa + 121665 * e) % FP
    if swap:
        x2, x3, z2, z3 = x3, x2, z3, z2
    return (x2 * pow(z2, FP - 2, FP) % FP).to_bytes(32, "little")


def unpack_specs(fields):
    """Two packed field elements → 40 bytes → 8 item specs (a,b,c,op0,op1)."""
    if len(fields) != 2:
        raise ValueError(f"expected 2 packed fields, got {len(fields)}")
    bts = bytes((fields[i // 26] >> (8 * (i - (i // 26) * 26))) & 0xFF
                for i in range(40))
    specs = []
    for k in range(8):
        a, b, c, op0, op1 = bts[k * 5:k * 5 + 5]
        if a > 63 or b > 63 or c > 63 or op0 > 2 or op1 > 2:
            raise ValueError(f"spec {k} out of range")
        specs.append((a, b, c, op0, op1))
    return specs


def decrypt_demo():
    """--decrypt: the selective-disclosure proof in a THIRD language.
    web/demo-delegate.json holds a throwaway viewer key; every ShareGrant
    to it on the committed private bank decrypts here — then we RE-ENCRYPT
    the plaintext and require the bytes to equal the on-chain ciphertexts.
    A broken port cannot round-trip into the committed account bytes."""
    snap = json.loads((ROOT / "web" / "snapshot.json").read_text())
    demo = json.loads((ROOT / "web" / "demo-delegate.json").read_text())
    mxe = snap.get("meta", {}).get("mxe_x25519")
    if not mxe:
        print("FAIL snapshot.meta.mxe_x25519 missing")
        return False
    ok = True
    print("sealed-fingerprint/v1 — delegate decryption (stdlib Python Rescue+x25519)")
    secret = bytes(demo["secret_key"])
    shared = x25519_shared(secret[:32], bytes.fromhex(mxe))
    cipher = RescueCipher(shared)
    PINNED_BANK = "8HHm4HgAjSDMc1HWMBpsgY5LZ3saEEyZenM3KyitVAug"
    grants = []
    for a in snap["sealed"]:
        d = base64.b64decode(a["data"])
        if d[:8] != disc("ShareGrant"):
            continue
        g = decode_share_grant(d)
        if g["viewer"] == demo["viewer_x25519"]:
            grants.append({"pk": a["pubkey"], "raw": d, **g})
    grants.sort(key=lambda g: (g["benchmark"], g["chunkIndex"], g["part"]))
    specs_by_bank = {}
    for g in grants:
        nonce = g["raw"][108:124]
        cts = [g["raw"][124:156], g["raw"][156:188]]
        try:
            fields = cipher.decrypt(cts, nonce)
            specs = unpack_specs(fields)
            rt = cipher.encrypt(fields, nonce)
            rt_ok = rt[0] == cts[0] and rt[1] == cts[1]
        except Exception as e:
            ok &= check(f"grant {g['pk'][:12]}… decrypt", False, str(e))
            continue
        specs_by_bank.setdefault(g["benchmark"], []).extend(specs)
        ok &= check(f"grant {g['pk'][:12]}… decrypt + re-encrypt", rt_ok,
                    f"chunk {g['chunkIndex']} part {g['part']} → 8 valid specs; "
                    "re-encryption reproduces the on-chain ciphertext bytes"
                    if rt_ok else "re-encryption MISMATCH")
    OPS = ["+", "-", "*"]
    all_specs = specs_by_bank.get(PINNED_BANK, [])
    if all_specs:
        for s in all_specs[:4]:
            print(f"    spec: (({s[0]} {OPS[s[3]]} {s[1]}) {OPS[s[4]]} {s[2]})")
        digest = hashlib.sha256(
            json.dumps([{"a": s[0], "b": s[1], "c": s[2], "op0": s[3], "op1": s[4]}
                        for s in all_specs], separators=(",", ":")).encode()).hexdigest()
        # the pin from scripts/decrypt-grants-test.mjs — same specs, two languages
        ok &= check("spec digest pin",
                    digest == "af15a73ddac76e0abc96860349768c61013d7947057882e2cdddfd857dbbff22",
                    f"{len(all_specs)} specs on the sealed-priv bank · sha256 {digest[:16]}…"
                    + (" == pinned" if digest.startswith("af15a73d") else " MISMATCH"))
    total = sum(len(v) for v in specs_by_bank.values())
    print(f"{'DECRYPTED' if ok and grants else 'FAILED'} — {len(grants)} grants, "
          f"{total} item specs recovered keyless across {len(specs_by_bank)} bank(s)")
    return ok and bool(grants)


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


def rescore_demo():
    """--rescore: the MPC's own arithmetic recomputed in stdlib Python —
    mirrors scripts/rescore.mjs on the deliberately-public calibration
    bank, plus a second artifact for free (runs found by outputs_root
    scan, no pubkey argument needed).

    Custody chain replayed here, zero trust in the harness:
      plaintext answer (bank JSON)
        → answerHash = trunc64(sha256("sealed/v1/answer\\0" ‖ id ‖ idx ‖ canon))
        → Reveal.hashes on-chain (authority-declassified fingerprints)
      model output (artifact JSON)
        → outputHash u64s → chunkOutLeaf merkle → outputs_root
        → Run.outputs_root on-chain (committed BEFORE scoring)
      score_chunk (MPC) compared hash equality per position → Run.correct"""
    cal = ROOT / "docs" / "evidence" / "calibration"
    bench_pk = "CSnhf6QySv3BszDkJ47KGooUx86PBpLxxi2iDz42S8fp"
    ok = True
    snap = json.loads((ROOT / "web" / "snapshot.json").read_text())
    sect = snap["sealed"]
    prog = snap["meta"]["programs"]["sealed"]
    bank = json.loads((cal / "bank.json").read_text())
    arts = sorted(cal.glob("run-artifact*.json"))
    print("sealed-fingerprint/v1 — calibration rescore (stdlib Python port of rescore.mjs)")
    print(f"bank id={bank['benchmarkId']} items={len(bank['items'])}  "
          f"artifacts={len(arts)}")
    if not arts:
        return check("calibration artifacts", False, "run-artifact*.json missing")

    D_ANS = b"sealed/v1/answer\x00"
    D_ITEM = b"sealed/v1/item\x00"
    D_COUT = b"sealed/v1/chunkout\x00"
    D_NODE = b"\x01"
    trunc64 = lambda b: int.from_bytes(b[:8], "little")
    u32 = lambda n: struct.pack("<I", n)
    u16 = lambda n: struct.pack("<H", n)
    u64 = lambda n: struct.pack("<Q", n)
    ans_hash = lambda i, canon: trunc64(
        sha256(D_ANS + u32(bank["benchmarkId"]) + u32(i) + canon.encode()))
    item_leaf = lambda i, salt, prompt: sha256(
        D_ITEM + u32(bank["benchmarkId"]) + u32(i) + bytes.fromhex(salt) + prompt.encode())
    cout_leaf = lambda c, outs: sha256(
        D_COUT + u16(c) + b"".join(u64(o) for o in outs))

    def merkle_root(leaves):
        if not leaves:
            return b"\x00" * 32
        while len(leaves) > 1:
            leaves = [sha256(D_NODE + leaves[i] + leaves[min(i + 1, len(leaves) - 1)])
                      for i in range(0, len(leaves), 2)]
        return leaves[0]

    # layer 1 — plaintext → fingerprints
    bad_hash = sum(1 for it in bank["items"]
                   if ans_hash(it["index"], it["answer"]) != int(it["answerHash"]))
    ok &= check("answer fingerprints", bad_hash == 0,
                f"all {len(bank['items'])} answerHash values recompute from plaintext"
                if bad_hash == 0 else f"{bad_hash} mismatches")

    # layer 2 — items_root (salted prompt commitment) vs the decoded Benchmark
    root_file = merkle_root([item_leaf(it["index"], it["salt"], it["prompt"])
                             for it in bank["items"]]).hex()
    bench = decode_benchmark(find_account(sect, bench_pk, disc("Benchmark")))
    ok &= check("items_root", root_file == bank["itemsRoot"] == bench["itemsRoot"],
                f"{root_file[:16]}… == file == on-chain"
                if root_file == bank["itemsRoot"] == bench["itemsRoot"] else
                f"recomputed {root_file[:16]}… file {bank['itemsRoot'][:16]}… chain {bench['itemsRoot'][:16]}…")

    # layer 3 — every on-chain Reveal PDA re-derived and its hashes checked
    # against recomputed fingerprints (reveal layout: bench32, chunk u16 @40,
    # part u8 @42, hashes[8] u64 @52)
    reveals = {}  # global item index → revealed u64
    n_reveal = 0
    for a in sect:
        d = base64.b64decode(a["data"])
        if len(d) < 116 or d[:8] != disc("Reveal"):
            continue
        if b58encode(d[8:40]) != bench_pk:
            continue
        chunk = int.from_bytes(d[40:42], "little"); part = d[42]
        want = b58encode(pda([b"reveal", b58decode(bench_pk),
                              u16(chunk), bytes([part])], prog))
        ok &= check(f"reveal PDA {chunk}/{part}", a["pubkey"] == want,
                    "re-derived from declared seeds")
        if a["pubkey"] != want:
            continue
        for j in range(8):
            reveals[chunk * 32 + part * 8 + j] = \
                int.from_bytes(d[52 + 8 * j:60 + 8 * j], "little")
        n_reveal += 1
    mismatch = sum(1 for pos, h in reveals.items()
                   if pos >= len(bank["items"])
                   or h != ans_hash(bank["items"][pos]["index"],
                                    bank["items"][pos]["answer"]))
    ok &= check("revealed fingerprints", n_reveal > 0 and mismatch == 0,
                f"{len(reveals)} positions: on-chain Reveal.hashes == recomputed answerHash"
                if mismatch == 0 else f"{mismatch}/{len(reveals)} mismatches")

    # layers 4+5 per committed artifact — outputs_root binding + rescore
    runs = [a for a in sect
            if (len(base64.b64decode(a["data"])) >= 188
                and base64.b64decode(a["data"])[:8] == disc("Run")
                and b58encode(base64.b64decode(a["data"])[8:40]) == bench_pk)]
    for ap in arts:
        artifact = json.loads(ap.read_text())
        outs = [int(r["outputHash"]) for r in artifact["items"]]
        out_leaves = []
        for c in range(0, len(outs), 32):
            ch = outs[c:c + 32] + [0] * (32 - len(outs[c:c + 32]))
            out_leaves.append(cout_leaf(c // 32, ch))
        root_hex = merkle_root(out_leaves).hex()
        hit = None
        for a in runs:
            d = base64.b64decode(a["data"])
            if d[152:184].hex() == artifact["outputsRoot"]:
                hit = a
                break
        ok &= check(f"{ap.name}: run account", hit is not None,
                    f"found by outputs_root scan → {hit['pubkey'][:16]}…"
                    if hit else f"no run on bank with outputs_root={artifact['outputsRoot'][:16]}…")
        if hit is None:
            continue
        d = base64.b64decode(hit["data"])
        run = decode_run(d)
        ok &= check(f"{ap.name}: outputs_root binding",
                    root_hex == artifact["outputsRoot"] == d[152:184].hex(),
                    f"{root_hex[:16]}… == artifact == Run.outputs_root")
        indep = sum(1 for it in bank["items"]
                    if it["index"] in reveals
                    and outs[it["index"]] == reveals[it["index"]])
        ok &= check(f"{ap.name}: independent rescore",
                    indep == run["correct"],
                    f"recomputed {indep} == MPC-written Run.correct {run['correct']} "
                    f"(model {run['modelId']})"
                    if indep == run["correct"] else
                    f"recomputed {indep} != Run.correct {run['correct']}")
        ok &= check(f"{ap.name}: run finalized + local pre-score",
                    run["status"] == 1 and artifact["localCorrect"] == indep,
                    f"status=1, localCorrect {artifact['localCorrect']} == independent {indep}")

    print("\n" + ("RESCORED — the MPC's arithmetic reproduced in a third language"
                  if ok else "RESCORE FAILED"))
    return ok


def check_anchor():
    """--check-anchor: fetch the notarization memo tx back from devnet and
    prove the chain carries the claimed BUNDLE ROOT — stdlib urllib +
    JSON-RPC only, no Solana SDK, no node. Mirrors `chain fingerprint
    --check-anchor`; needs network (the only mode that is not offline)."""
    import urllib.request
    ok = True
    a = json.loads((ROOT / "docs" / "evidence-anchor.json").read_text())
    if a.get("kind") != "sealed-anchor/v1":
        check("anchor doc", False, f"kind={a.get('kind')}")
        return False
    print(f"sealed-anchor/v1 — {a.get('signature', '?')[:24]}…")
    url = a.get("cluster") or "https://api.devnet.solana.com"
    body = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "getTransaction",
        "params": [a["signature"], {"encoding": "json", "commitment": "confirmed",
                                    "maxSupportedTransactionVersion": 0}],
    }).encode()
    try:
        req = urllib.request.Request(url, data=body,
                                     headers={"Content-Type": "application/json"})
        res = json.loads(urllib.request.urlopen(req, timeout=30).read())
    except Exception as e:
        check("on-chain fetch", False, f"{url}: {e}")
        return False
    tx = res.get("result")
    if not tx:
        check("on-chain fetch", False, f"{a['signature']} not found on {url}")
        return False
    ok &= check("on-chain fetch", True,
                f"tx found on {url.replace('https://', '')} — slot {tx.get('slot')}")
    memo = None
    for log in (tx.get("meta") or {}).get("logMessages") or []:
        m = re.match(r'^Program log: Memo \(len \d+\): "(.*)"$', log)
        if m:
            memo = m.group(1)
    ok &= check("memo on-chain", memo == a.get("memo"),
                f'the ledger carries "{memo}" — timestamped slot {tx.get("slot")}'
                if memo == a.get("memo") else f'got "{memo}", wanted "{a.get("memo")}"')
    declared = f"sealed-fingerprint/v1 {a.get('bundleRoot')}"
    ok &= check("root in memo", memo == declared,
                "the memo embeds the claimed BUNDLE ROOT"
                if memo == declared else f'memo="{memo}" ≠ "{declared}"')
    sig = ((tx.get("transaction") or {}).get("signatures") or [None])[0]
    ok &= check("signature echo", sig == a.get("signature"),
                "tx.transaction.signatures[0] matches the anchor doc")
    ok &= check("slot + blockTime echo",
                tx.get("slot") == a.get("slot") and tx.get("blockTime") == a.get("blockTime"),
                f"slot {tx.get('slot')} · blockTime {tx.get('blockTime')}"
                if tx.get("slot") == a.get("slot") else
                f"doc claims slot {a.get('slot')}, chain says {tx.get('slot')}")
    keys = ((tx.get("transaction") or {}).get("message") or {}).get("accountKeys") or []
    payer = keys[0] if keys and isinstance(keys[0], str) else \
        (keys[0] or {}).get("pubkey") if keys else None
    ok &= check("payer echo", payer == a.get("payer"),
                f"fee payer {str(payer)[:16]}… is the anchoring wallet"
                if payer == a.get("payer") else f"doc claims {a.get('payer')}, chain says {payer}")
    # anchors go stale the moment evidence moves — compare against the CURRENT tree
    sums = ROOT / "docs" / "evidence" / "SHA256SUMS"
    man = ROOT / "web" / "MANIFEST"
    cur = hashlib.sha256(
        f"sealed-fingerprint/v1\n{manifest_root(sums)}\n{manifest_root(man)}\n"
        .encode()).hexdigest()
    ok &= check("anchor vs current", cur == a.get("bundleRoot"),
                "the anchored root IS the current bundle root — evidence unchanged since notarization"
                if cur == a.get("bundleRoot") else
                f"DRIFT: anchored {a.get('bundleRoot', '')[:16]}… ≠ current {cur[:16]}… — re-anchor at freeze")
    print("\n" + ("ANCHOR VERIFIED" if ok else "ANCHOR FAILED") +
          f" — {a.get('signature')} on {url}")
    return ok


KNOWN_KINDS = {f"sealed-{k}/v1" for k in
               ("position", "bounty", "grant", "trail", "board", "match",
                "claim", "policy", "catalog", "bank", "evidence-digest",
                "tamper", "report")}

if __name__ == "__main__":
    argv = sys.argv[1:]
    if argv and argv[0] == "--remote":
        has_base = len(argv) > 1 and not argv[1].startswith("--")
        ROOT = fetch_remote(argv[1] if has_base else WEB_BASE)
        argv = argv[2:] if has_base else argv[1:]
    if argv and argv[0] == "--card":
        p = Path(argv[1])
        if not p.exists():
            sys.exit(f"no such file: {p}")
        raw = p.read_text(errors="replace")
        kind = ("sealed-report/v1" if p.suffix == ".md"
                and "sealed-report/v1" in raw
                else None if p.suffix == ".md"
                else json.loads(raw).get("kind"))
        if kind not in KNOWN_KINDS:
            sys.exit(f"unrecognized artifact kind: {kind!r} — "
                     f"expected one of {sorted(KNOWN_KINDS)}")
        _CARD = (str(p), kind)
        sys.exit(0 if main() else 1)
    if argv and argv[0] == "--tamper":
        sys.exit(0 if tamper_demo() else 1)
    if argv and argv[0] == "--decrypt":
        sys.exit(0 if decrypt_demo() else 1)
    if argv and argv[0] == "--check-anchor":
        sys.exit(0 if check_anchor() else 1)
    if argv and argv[0] == "--rescore":
        sys.exit(0 if rescore_demo() else 1)
    main()
