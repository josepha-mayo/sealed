#!/usr/bin/env python3
"""Sealed — second-language evidence verifier (stdlib-only Python).

This is deliberately a SEPARATE implementation: the TypeScript harness and
the in-browser verifier replay every check in full; this file proves the
evidence base is language-agnostic — no node_modules, no pip install,
no RPC. If this script and `chain fingerprint` agree on the BUNDLE ROOT,
the bundle is self-consistent under two implementations that must agree.

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
 12. sealed-tamper/v1 exhibits — the committed forgeries are
     replayed through Python's decoders and MUST be rejected; a lie
     that verifies under the second implementation fails the audit.
     sealed-ceiling/v1 — proof-of-a-negative cards (all 31): the card
     lists the ENTIRE subject run set, and the verifier re-derives that
     set from the snapshot — completeness is the claim. The argmax
     (max floor(correct*10000/items) over finalized runs) is recomputed;
     an omitted run, a phantom run, a renamed model, or a shaved maxPct
     all die at named checks.
     sealed-circuit/v1 — the MPC itself as evidence: all Arcium PDAs
     re-derived with the same ed25519 math (6 compdefs from
     sha256(name)[:4] seeds, the raw bytecode accounts from
     [ComputationDefinitionRaw, compdef, u8] seeds, MXE, cluster,
     SignPda), program identity against the deployed Arcium program,
     the canonical six-circuit set, the card's recorded account-content
     sha256s bound against the committed web/arcium-infra.json bytes,
     the cluster committee's aggregated BLS key proven present inside
     the bound cluster account, and the SignPda bound to the snapshot's
     SignPdaAccount — a phantom referee dies at derivation, a
     re-uploaded circuit at the content hash, not at plausibility.
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

Coverage: every committed artifact — all 13 JSON kinds and
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
  python3 scripts/verify.py --all         # every mode in one pass: main
                                        # replay → forgery lab → decrypt →
                                        # rescore → live anchor check
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
from decimal import Decimal, ROUND_HALF_UP
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
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=12) as pool:
        bodies = list(pool.map(lambda j: get(j[0]), jobs))
    for (url, dst), body in zip(jobs, bodies):
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(body)
    print(f"          {len(jobs)}/{len(jobs)} mirrored into {tmp} — "
          f"running the full pass on served bytes")
    # web/arcium-infra.json — the circuit card's content-binding payload
    # (the bytes the cluster executes) lives under web/ but is not
    # necessarily MANIFEST-pinned; mirror it best-effort so the remote
    # "account binding"/"cluster committee" checks run on served bytes
    # too (if the site doesn't serve it, those checks report it absent).
    if not (tmp / "web" / "arcium-infra.json").exists():
        try:
            (tmp / "web" / "arcium-infra.json").write_bytes(
                get(f"{web_base}/arcium-infra.json"))
        except Exception as e:
            print(f"          (web/arcium-infra.json not served — {e})")
    return tmp


def card_iter(dirpath, pattern="*.json", kind=None):
    """Normal mode: the committed glob. --card mode: only the judge's file,
    and only in the block that owns its kind — every other kind's block
    sees an empty list and skips."""
    if _CARD is None:
        return sorted(dirpath.glob(pattern))
    return [Path(_CARD[0])] if kind is not None and _CARD[1] == kind else []



def snapshot_path():
    """web/snapshot.json, overridable via SEALED_SNAPSHOT — lets the
    hostile-snapshot test feed mutated bytes without touching the tree."""
    import os
    return Path(os.environ.get("SEALED_SNAPSHOT", str(ROOT / "web" / "snapshot.json")))


def snapshot_text():
    return snapshot_path().read_text()


def snapshot_bytes():
    return snapshot_path().read_bytes()


# --- sealed-circuit/v1 content binding (chain.ts verifyCircuitCard 3b–3d) ---
ARCIUM_PID = "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
RAW_CIRCUIT_SEED = b"ComputationDefinitionRaw"  # [RAW, compdef, u8(idx)] PDAs


def arcium_infra():
    """Load web/arcium-infra.json — the committed Arcium-infrastructure
    dump (6 compdef headers, 6 raw-circuit bytecode accounts, MXE, the
    offset-456 cluster): the bytes the cluster executes. Mirror of
    chain.ts loadArciumInfra(). Returns {"byPk": pubkey→raw bytes,
    "fileSha": sha256 of the file itself} or None when absent — absence
    is a check failure, not a crash ("cannot prove which bytes the
    cluster executes"). SEALED_ARCIUM_INFRA overrides the path the way
    SEALED_SNAPSHOT overrides the snapshot."""
    p = Path(os.environ.get("SEALED_ARCIUM_INFRA",
                            str(ROOT / "web" / "arcium-infra.json")))
    try:
        raw = p.read_bytes()
        doc = json.loads(raw)
        return {"byPk": {a["pubkey"]: base64.b64decode(a["data"])
                         for a in doc.get("accounts") or []},
                "fileSha": hashlib.sha256(raw).hexdigest()}
    except Exception:
        return None


def circuit_raw_pdas(card, arcium_pid):
    """"raw-circuit PDAs" replay — each compdef's bytecode lives in
    [ComputationDefinitionRaw, compdefPda, u8(index)] accounts under the
    Arcium program; a hash recorded under a made-up PDA binds nothing.
    Returns (ok, ran): ran is False when the card records no rawCircuits
    entries at all (old-format cards skip the check, same as TS)."""
    raw_ok = raw_n = 0
    for c in card.get("circuits") or []:
        for r in c.get("rawCircuits") or []:
            raw_n += 1
            got = pda([RAW_CIRCUIT_SEED, b58decode(c["pda"]),
                       bytes([int(r.get("index") or 0) & 0xFF])], arcium_pid)
            if b58encode_check(got or b"", str(r.get("pda") or "")) \
                    and re.fullmatch(r"[0-9a-f]{64}", str(r.get("sha256") or "")):
                raw_ok += 1
    return raw_ok == raw_n, raw_n > 0


def circuit_account_binding(card):
    """"account binding" replay — the card pins sha256 of the actual
    account bytes (compdef headers, raw bytecode, MXE, cluster); the
    committed arcium-infra.json supplies those bytes offline, so a
    re-uploaded circuit keeps its PDA but dies on the hash. Returns None
    when the card records no content hashes (old-format cards skip);
    False when it does but the infra dump is absent, its pinned file sha
    differs, or any recorded hash misses/mismatches the account bytes."""
    needed = any((c.get("rawCircuits") or []) or c.get("compdefSha256")
                 for c in card.get("circuits") or []) \
        or (card.get("cluster") or {}).get("sha256") \
        or (card.get("mxe") or {}).get("sha256")
    if not needed:
        return None
    infra = arcium_infra()
    if infra is None:
        return False
    pin = (card.get("infra") or {}).get("sha256")
    file_ok = (not pin) or pin == infra["fileSha"]
    a_ok = a_n = 0

    def expect(addr, want_sha):
        nonlocal a_ok, a_n
        if not want_sha or not addr:
            return
        a_n += 1
        b = infra["byPk"].get(addr)
        if b is not None and hashlib.sha256(b).hexdigest() == want_sha:
            a_ok += 1

    for c in card.get("circuits") or []:
        expect(c.get("pda"), c.get("compdefSha256"))
        for r in c.get("rawCircuits") or []:
            expect(r.get("pda"), r.get("sha256"))
    expect((card.get("cluster") or {}).get("pda"),
           (card.get("cluster") or {}).get("sha256"))
    expect((card.get("mxe") or {}).get("pda"),
           (card.get("mxe") or {}).get("sha256"))
    return bool(file_ok and a_ok == a_n and a_n > 0)


def circuit_cluster_committee(card):
    """"cluster committee" replay — the cluster account records the
    nodes' aggregated BLS public key (the committee attesting every
    SignedComputationOutputs callback) and size; byte-presence inside
    the sha-bound account is the portable proof, no Arcium IDL needed.
    Returns None when the card carries neither cluster.blsPubkey nor
    cluster.sha256 (old-format cards skip)."""
    cl = card.get("cluster") or {}
    if not (cl.get("blsPubkey") or cl.get("sha256")):
        return None
    infra = arcium_infra()
    cbytes = infra["byPk"].get(str(cl.get("pda") or "")) if infra else None
    bls = str(cl.get("blsPubkey") or "")
    auth_hex = ""
    if cl.get("authority"):
        try:
            raw = b58decode(str(cl["authority"]))
            auth_hex = raw.hex() if len(raw) == 32 else ""
        except Exception:
            auth_hex = ""
    try:
        nodes = float(cl.get("nodeCount"))
    except (TypeError, ValueError):
        nodes = float("nan")  # Number(garbage) → NaN → >= 1 is False
    return bool(cbytes is not None
                and re.fullmatch(r"[0-9a-f]{128}", bls)
                and not re.fullmatch(r"0+", bls)
                and bls in cbytes.hex()
                and (not cl.get("authority")
                     or (auth_hex != "" and auth_hex in cbytes.hex()))
                and nodes >= 1)


def main():
    ok = True
    global SNAP
    SNAP = json.loads(snapshot_text())
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

    snap_hash = hashlib.sha256(snapshot_bytes()).hexdigest()

    # account census — every snapshot account's discriminator must be a
    # known class, including the ones only decoders elsewhere consume
    # (AnswerChunk ciphertexts, Arcium's SignPda), AND every known class
    # must unpack under its owning decoder: an account that fails to parse
    # silently evaporating is a verifier bug, not a pass. The same pass
    # builds the per-class maps the snapshot-wide sweeps below run on —
    # the decode-and-classify stage of scripts/verify.mjs, ported.
    SIGN_DISC = bytes.fromhex("d69d7a72752cd64a")  # Arcium SignPdaAccount
    KNOWN_DISCS = {
        disc(n) for n in (
            "Benchmark", "Run", "ScoreLog", "ModelRecord", "Reveal",
            "ShareGrant", "ItemChunk", "PrivItemChunk", "AnswerChunk",
            "Market", "DarkMarket", "Ladder", "Bounty", "Position",
            "DarkPosition")
    } | {SIGN_DISC}
    census, unknown, undecoded = {}, 0, 0
    benches, runs, item_chunks, priv_chunks = {}, {}, [], []
    chunks, reveals, grants = [], [], []
    records, scorelogs, sign_pda = {}, {}, None
    markets, ladders, darks = {}, [], {}
    dark_pos, positions, bounties = [], [], []
    for a in SNAP.get("sealed", []):
        d = base64.b64decode(a["data"])
        dd = d[:8]
        if dd not in KNOWN_DISCS:
            unknown += 1
            continue
        census[dd] = census.get(dd, 0) + 1
        try:
            if dd == disc("Benchmark"):
                benches[a["pubkey"]] = decode_benchmark(d)
            elif dd == disc("Run"):
                runs[a["pubkey"]] = decode_run(d)
            elif dd == disc("ItemChunk"):
                ic = decode_item_chunk(d)
                item_chunks.append({"pk": a["pubkey"], "bench": b58encode(d[8:40]),
                                    "index": ic["index"], "dec": ic, "raw": d})
            elif dd == disc("PrivItemChunk"):
                pc = decode_priv_item_chunk(d)
                priv_chunks.append({"pk": a["pubkey"], "bench": b58encode(d[8:40]),
                                    "index": pc["index"], "dec": pc, "raw": d})
            elif dd == disc("Reveal"):
                rv = decode_reveal(d)
                reveals.append({"pk": a["pubkey"], "bench": rv["benchmark"],
                                "chunk": rv["chunk"], "part": rv["part"],
                                "revealedAt": rv["revealedAt"]})
            elif dd == disc("ShareGrant"):
                g = decode_share_grant(d)
                grants.append({"pk": a["pubkey"], "bench": g["benchmark"],
                               "chunk": g["chunkIndex"], "part": g["part"],
                               "viewer": g["viewer"]})
            elif dd == disc("AnswerChunk"):
                chunks.append({"pk": a["pubkey"], "bench": b58encode(d[8:40]),
                               "index": int.from_bytes(d[40:42], "little")})
            elif dd == disc("ModelRecord"):
                records[a["pubkey"]] = decode_model_record(d)
            elif dd == disc("ScoreLog"):
                scorelogs[a["pubkey"]] = decode_scorelog(d)
            elif dd == SIGN_DISC:
                sign_pda = a["pubkey"]
            else:
                raise ValueError("market-class account in the sealed section")
        except Exception as e:
            undecoded += 1
            print(f"    ! unparseable sealed account {a['pubkey']}: {e}")
    for a in SNAP.get("market", []):
        d = base64.b64decode(a["data"])
        dd = d[:8]
        if dd not in KNOWN_DISCS:
            unknown += 1
            continue
        census[dd] = census.get(dd, 0) + 1
        try:
            if dd == disc("Market"):
                m = decode_market(d)
                m["duel"] = bool(m["runB"]) and m["runB"] != NULL_PK
                markets[a["pubkey"]] = m
            elif dd == disc("Ladder"):
                l = decode_ladder(d)
                l["legs"] = l["legs"][:l["legCount"]]
                ladders.append({**l, "pk": a["pubkey"]})
            elif dd == disc("DarkMarket"):
                darks[a["pubkey"]] = decode_dark_market(d)
            elif dd == disc("DarkPosition"):
                dark_pos.append({**decode_dark_position(d), "pk": a["pubkey"]})
            elif dd == disc("Bounty"):
                bounties.append({**decode_bounty(d), "pk": a["pubkey"]})
            elif dd == disc("Position"):
                positions.append({**decode_position(d), "pk": a["pubkey"]})
            else:
                raise ValueError("sealed-class account in the market section")
        except Exception as e:
            undecoded += 1
            print(f"    ! unparseable market account {a['pubkey']}: {e}")
    total = sum(census.values()) + unknown
    ok &= check("account census", unknown == 0 and undecoded == 0,
                f"{total} accounts · {len(census)} known discriminator classes "
                f"({census.get(disc('AnswerChunk'), 0)} MPC answer chunks "
                f"+ Arcium sign PDA included) — all decoded, none unrecognized"
                if unknown == 0 and undecoded == 0
                else f"{unknown} unknown discriminator(s) + "
                     f"{undecoded} unparseable account(s)")

    # --- snapshot-wide sweeps (ported from scripts/verify.mjs) ------------
    # The same battery the TypeScript verifier runs over the WHOLE decoded
    # snapshot: PDA re-derivation for every account, run-mask invariants,
    # items_root commitment folds, market resolutions as pure functions of
    # MPC-written scores, bounty claims, the capability registry replayed
    # from its receipts, referential integrity, bundled Merkle proofs, and
    # the post_reveal flag report — all against the bytes decoded above.
    spid = SNAP.get("meta", {}).get("programs", {}).get("sealed")
    mpid = SNAP.get("meta", {}).get("programs", {}).get("market")

    # [2] PDA re-derivation — every account must sit at its seed-derived
    # address (17 seed shapes, real ed25519 off-curve bump iteration).
    pda_bad = 0

    def pda_check(want, seeds, pid, what):
        nonlocal pda_bad
        got = pda(seeds, pid)
        got = b58encode(got) if got is not None else None
        if got != want:
            pda_bad += 1
            print(f"    ! {what}: want {want} got {got}")

    for pkk, b in benches.items():
        pda_check(pkk, [b"benchmark", b58decode(b["authority"]),
                        struct.pack("<I", b["id"])], spid, f"benchmark {b['id']}")
    for c in item_chunks:
        pda_check(c["pk"], [b"items", b58decode(c["bench"]),
                            struct.pack("<H", c["index"])], spid, f"items {c['index']}")
    for c in priv_chunks:
        pda_check(c["pk"], [b"pitems", b58decode(c["bench"]),
                            struct.pack("<H", c["index"])], spid, f"pitems {c['index']}")
    for c in chunks:
        pda_check(c["pk"], [b"chunk", b58decode(c["bench"]),
                            struct.pack("<H", c["index"])], spid, f"chunk {c['index']}")
    for pkk, r in runs.items():
        pda_check(pkk, [b"run", b58decode(r["benchmark"]), u64le(r["index"])],
                  spid, f"run {r['index']}")
    for r in reveals:
        pda_check(r["pk"], [b"reveal", b58decode(r["bench"]),
                            struct.pack("<H", r["chunk"]), bytes([r["part"]])],
                  spid, f"reveal {r['chunk']}/{r['part']}")
    for g in grants:
        pda_check(g["pk"], [b"grant", b58decode(g["bench"]),
                            struct.pack("<H", g["chunk"]), bytes([g["part"]]),
                            b58decode(g["viewer"])], spid, f"grant {g['chunk']}/{g['part']}")
    for pkk, m in markets.items():
        plain = b58encode(pda([b"market", b58decode(m["run"]),
                               u64le(m["salt"])], mpid) or b"")
        duel = (b58encode(pda([b"duel", b58decode(m["run"]), b58decode(m["runB"]),
                              u64le(m["salt"])], mpid) or b"") if m["duel"] else None)
        if pkk != plain and pkk != duel:
            pda_bad += 1
            print(f"    ! market {pkk}: neither [market,run,salt] nor [duel,a,b,salt]")
    for l in ladders:
        pda_check(l["pk"], [b"ladder", b58decode(l["legs"][0]), u64le(l["salt"])],
                  mpid, "ladder")
    for pkk, dm in darks.items():
        pda_check(pkk, [b"dark", b58decode(dm["run"]), u64le(dm["salt"])],
                  mpid, "dark market")
    for b in bounties:
        pda_check(b["pk"], [b"bounty", b58decode(b["bank"]), b58decode(b["sponsor"]),
                            u64le(b["salt"])], mpid, "bounty")
    for p in dark_pos:
        found = any(b58encode(pda([b"darkpos", b58decode(p["market"]),
                                   b58decode(p["bettor"]), u64le(s)], mpid) or b"") == p["pk"]
                    for s in range(4096))
        if not found:
            pda_bad += 1
            print(f"    ! darkpos {p['pk']}: no pos_salt 0..4095 derives it")
    for p in positions:
        pda_check(p["pk"], [b"position", b58decode(p["market"]),
                            b58decode(p["bettor"])], mpid, "position")
    for pkk, m in records.items():
        pda_check(pkk, [b"modelrec", bytes.fromhex(m["modelHash"])], spid,
                  f"modelrec {m['modelId']}")
    for pkk, l in scorelogs.items():
        pda_check(pkk, [b"scorelog", b58decode(l["run"])], spid,
                  f"scorelog {l['run'][:8]}")
    if sign_pda:
        pda_check(sign_pda, [b"ArciumSignerAccount"], spid, "SignPdaAccount")
    ok &= check("PDA derivation", pda_bad == 0,
                "every account re-derives to its own address" if pda_bad == 0
                else f"{pda_bad} mismatches — snapshot contains accounts "
                     "the program could never have written")

    # [3] run invariants — masks, capacity, finalization, parent bank.
    run_bad = 0
    for pkk, r in runs.items():
        # guard: old-layout runs carry no ever_queued_mask tail — the subset
        # check is skipped when the field was never written (mjs [3]).
        if r["everQueuedMask"] and (r["scoredMask"] & ~r["everQueuedMask"]):
            run_bad += 1
            print(f"    ! run {pkk}: scored bits never queued")
        if r["correct"] > bin(r["scoredMask"]).count("1") * 32:
            run_bad += 1
            print(f"    ! run {pkk}: correct {r['correct']} exceeds scored capacity")
        if r["status"] == 1 and r["pendingMask"]:
            run_bad += 1
            print(f"    ! run {pkk}: finalized with pending bits")
        if r["benchmark"] not in benches:
            run_bad += 1
            print(f"    ! run {pkk}: parent benchmark absent")
    ok &= check("run invariants", run_bad == 0,
                f"{len(runs)} runs: scored⊆queued, correct≤capacity, "
                "finalized⇒no pending" if run_bad == 0 else f"{run_bad} violations")

    # [4] items_root commitment replay — every generated/private bank's
    # stored root re-folded from chunk bytes in mint_order landing sequence
    # (gen banks fold the 40 spec bytes; private banks fold ciphertexts+nonce).
    fold_bad = folded = 0
    for pkk, b in benches.items():
        if b["kind"] == 0:
            continue
        steps = []
        for c in (item_chunks if b["kind"] == 1 else priv_chunks):
            if c["bench"] != pkk:
                continue
            dec = c["dec"]
            for part in range(4):
                if not (dec["partsWritten"] & (1 << part)):
                    continue
                enc = (b"".join(bytes(t) for t in dec["specs"][part * 8:part * 8 + 8])
                       if b["kind"] == 1 else
                       b"".join(dec["ciphertexts"][part * 2 + k] for k in range(2))
                       + dec["nonces"][part].to_bytes(16, "little"))
                steps.append((dec["mintOrder"][part], c["index"], part, enc))
        if not steps:
            print(f"  note  bank {pkk[:8]} — no minted parts in snapshot")
            continue
        fold_root = b"\x00" * 32
        for _seq, ci, part, enc in sorted(steps, key=lambda s: (s[0], s[1], s[2])):
            fold_root = (gen_items_fold(fold_root, ci, part, enc) if b["kind"] == 1
                         else priv_items_fold(fold_root, ci, part, enc))
        if fold_root.hex() == b["itemsRoot"]:
            folded += 1
        else:
            fold_bad += 1
            print(f"    ! bank {pkk}: fold {fold_root.hex()[:16]}… "
                  f"!= stored {b['itemsRoot'][:16]}…")
    ok &= check("items_root folds", fold_bad == 0,
                f"{folded} banks replayed bit-exact"
                if fold_bad == 0 else f"{fold_bad} mismatches")

    # [5] market resolutions are pure functions of MPC-written scores.
    m_bad = m_checked = 0
    for pkk, m in markets.items():
        r = runs.get(m["run"])
        if r is None:
            print(f"  note  market {pkk[:8]} — run not in snapshot")
            continue
        if m["status"] != 1:
            continue
        m_checked += 1
        if m["duel"]:
            rb = runs.get(m["runB"])
            if rb is None:
                print(f"  note  duel {pkk[:8]} — runB missing")
                continue
            expect = 0 if r["correct"] > rb["correct"] else \
                1 if rb["correct"] > r["correct"] else 2
            packed = (r["correct"] << 16) | rb["correct"]
            if m["outcome"] != expect or m["resolvedScore"] != packed:
                m_bad += 1
                print(f"    ! duel {pkk}: outcome {m['outcome']} != {expect} "
                      f"or packed {m['resolvedScore']} != {packed}")
        else:
            if m["resolvedScore"] != r["correct"]:
                m_bad += 1
                print(f"    ! market {pkk}: resolvedScore {m['resolvedScore']} "
                      f"!= run.correct {r['correct']}")
            if m["outcome"] != outcome_of(m["edges"], m["n"], r["correct"]):
                m_bad += 1
                print(f"    ! market {pkk}: outcome {m['outcome']} != band "
                      f"{outcome_of(m['edges'], m['n'], r['correct'])} "
                      f"for score {r['correct']}")
    ok &= check("score-band + duel purity", m_bad == 0,
                f"{m_checked} resolved markets re-derived" if m_bad == 0
                else f"{m_bad} resolutions don't match MPC scores")

    l_bad = l_checked = 0
    for l in ladders:
        if l["status"] != 1:
            continue
        l_checked += 1
        scores = [runs.get(lp, {}).get("correct") for lp in l["legs"]]
        if None in scores:
            print(f"  note  ladder {l['pk'][:8]} — leg run missing from snapshot")
            continue
        mx = max(scores)
        expect = sum((1 << i) for i, s in enumerate(scores) if s == mx)
        if l["resultMask"] != expect:
            l_bad += 1
            print(f"    ! ladder {l['pk']}: mask {l['resultMask']} "
                  f"!= argmax {expect} over {scores}")
    ok &= check("ladder argmax masks", l_bad == 0,
                f"{l_checked} ladders re-derived" if l_bad == 0
                else f"{l_bad} mismatches")

    d_bad = d_checked = 0
    for pkk, dm in darks.items():
        if dm["status"] not in (1, 2):  # resolved or cancelled
            continue
        r = runs.get(dm["run"])
        if dm["status"] == 1 and r:
            d_checked += 1
            if dm["resolvedScore"] != r["correct"] or \
                    dm["outcome"] != outcome_of(dm["edges"], dm["n"], r["correct"]):
                d_bad += 1
                print(f"    ! dark {pkk}: outcome/score mismatch")
        pos = [p for p in dark_pos if p["market"] == pkk]
        # positions close on claim — open revealed positions can only ever be
        # a subset of the lifetime revealed_count.
        rev = [p for p in pos if p["revealed"] != 255]
        if len(rev) > dm["revealedCount"]:
            d_bad += 1
            print(f"    ! dark {pkk}: {len(rev)} open revealed "
                  f"> lifetime revealedCount {dm['revealedCount']}")
        for p in rev:
            if p["revealed"] >= dm["n"]:
                d_bad += 1
                print(f"    ! darkpos {p['pk']}: revealed outcome "
                      f"{p['revealed']} >= n {dm['n']}")
        if dm["winTotal"] > dm["poolTotal"]:
            d_bad += 1
            print(f"    ! dark {pkk}: winTotal > pool")
    ok &= check("dark-market accounting", d_bad == 0,
                f"{d_checked} resolved darks re-derived; "
                "revealedCount/wintotal consistent" if d_bad == 0
                else f"{d_bad} violations")

    # Claimed under the pre-guard binary (the self-deal guard
    # `runner != sponsor` shipped after this claim landed). Grandfathered as
    # historical evidence; any NEW self-deal claim fails hard.
    GRANDFATHERED_BOUNTIES = {"EJzXf3q4pRddNcqHWFiSWfBEntwaKGUqPx8cWH1aiBSc"}
    b_bad = b_checked = 0
    for b in bounties:
        if b["status"] != 1:
            continue  # only claimed bounties carry assertions
        b_checked += 1
        r = runs.get(b["winnerRun"])
        if r is None:
            b_bad += 1
            print(f"    ! bounty {b['pk']}: winner_run {b['winnerRun']} absent")
            continue
        if r["benchmark"] != b["bank"]:
            b_bad += 1
            print(f"    ! bounty {b['pk']}: winner run is on a different bank")
        if r["correct"] < b["threshold"]:
            b_bad += 1
            print(f"    ! bounty {b['pk']}: winning score {r['correct']} "
                  f"< threshold {b['threshold']}")
        if b["winningScore"] != r["correct"]:
            b_bad += 1
            print(f"    ! bounty {b['pk']}: winningScore {b['winningScore']} "
                  f"!= run.correct {r['correct']}")
        if r["createdAt"] < b["createdAt"]:
            b_bad += 1
            print(f"    ! bounty {b['pk']}: winner run predates the bounty "
                  "(retroactive claim)")
        if r["runner"] == b["sponsor"]:
            if b["pk"] in GRANDFATHERED_BOUNTIES:
                print(f"    note bounty {b['pk']}: self-claimed under "
                      "pre-guard binary — rejected by current code")
            else:
                b_bad += 1
                print(f"    ! bounty {b['pk']}: winner run's runner IS "
                      "the sponsor (self-deal)")
    ok &= check("bounty claims", b_bad == 0,
                f"{b_checked} claimed bounties re-verified against winner runs"
                if b_bad == 0 else f"{b_bad} violations")

    # [5b] capability registry — every ScoreLog binds to its run, every
    # ModelRecord replays bit-exact from its receipts.
    reg_bad = reg_checked = 0
    for pkk, l in scorelogs.items():
        r = runs.get(l["run"])
        if r is None:
            reg_bad += 1
            print(f"    ! scorelog {pkk}: run {l['run']} absent")
            continue
        if l["correct"] != r["correct"] or l["items"] != r["chunkCount"] * 32:
            reg_bad += 1
            print(f"    ! scorelog {pkk}: snapshotted score "
                  f"{l['correct']}/{l['items']} != run "
                  f"{r['correct']}/{r['chunkCount'] * 32}")
        if l["benchmark"] != r["benchmark"]:
            reg_bad += 1
            print(f"    ! scorelog {pkk}: benchmark != run's")
        want_rec = b58encode(
            pda([b"modelrec", sha256(r["modelId"].encode())], spid) or b"")
        if l["modelRecord"] != want_rec:
            reg_bad += 1
            print(f"    ! scorelog {pkk}: model_record not derived "
                  "from sha256(run.model_id)")
        if l["postReveal"] != (1 if r["postReveal"] else 0):
            reg_bad += 1
            print(f"    ! scorelog {pkk}: post_reveal {l['postReveal']} != "
                  f"immutable run flag {1 if r['postReveal'] else 0}")
        # vouched is a record-time snapshot and attestation is monotone —
        # a 1 must still be attested today; a 0 only means "not yet at
        # record time" (Run.attested IS tail-parsed here, unlike mjs).
        if l["vouched"] and not r["attested"]:
            reg_bad += 1
            print(f"    ! scorelog {pkk}: vouched receipt but run is "
                  "not attested")
    for pkk, m in records.items():
        reg_checked += 1
        if sha256(m["modelId"].encode()).hex() != m["modelHash"]:
            reg_bad += 1
            print(f"    ! modelrec {pkk}: model_hash != sha256(model_id)")
        logs = sorted((l for l in scorelogs.values() if l["modelRecord"] == pkk),
                      key=lambda l: l["recordedAt"])
        if len(logs) != m["runsScored"]:
            reg_bad += 1
            print(f"    ! modelrec {pkk}: runs_scored {m['runsScored']} "
                  f"!= {len(logs)} receipts")
        tc = sum(l["correct"] for l in logs)
        ti = sum(l["items"] for l in logs)
        if tc != m["totalCorrect"] or ti != m["totalItems"]:
            reg_bad += 1
            print(f"    ! modelrec {pkk}: totals "
                  f"{m['totalCorrect']}/{m['totalItems']} != replayed {tc}/{ti}")
        # On-chain keeps the FIRST-LANDED argmax (accuracy, then correct).
        # Same-second receipts make landing order unrecoverable from the
        # snapshot, so verify the stored best is ANY member of the optimal
        # set — the invariant is optimality, not which optimal run won.
        bc = bi = 0
        for l in logs:
            nc, ni = l["correct"], l["items"]
            if nc * bi > bc * ni or (nc * bi == bc * ni and nc > bc):
                bc, bi = nc, ni
        w = next((l for l in logs
                  if l["correct"] == bc and l["items"] == bi
                  and l["run"] == m["bestRun"]), None)
        if m["bestCorrect"] != bc or m["bestItems"] != bi:
            reg_bad += 1
            print(f"    ! modelrec {pkk}: best {m['bestCorrect']}/"
                  f"{m['bestItems']} != replayed optimum {bc}/{bi}")
        if bc == 0:
            # every receipt scored 0 — the on-chain best legitimately
            # stays default
            if m["bestRun"] != NULL_PK or m["bestBank"] != NULL_PK:
                reg_bad += 1
                print(f"    ! modelrec {pkk}: zero-score record but "
                      f"best_run set to {m['bestRun'][:8]}")
        elif w is None:
            reg_bad += 1
            print(f"    ! modelrec {pkk}: best_run {m['bestRun'][:8]} "
                  "is not an optimal receipt")
        elif m["bestBank"] != w["benchmark"]:
            reg_bad += 1
            print(f"    ! modelrec {pkk}: best_bank mismatch")
        if m["lastScored"] != max((l["recordedAt"] for l in logs), default=None):
            reg_bad += 1
            print(f"    ! modelrec {pkk}: last_scored != max recorded_at")
        if m["firstSeen"] != min((l["recordedAt"] for l in logs), default=None):
            reg_bad += 1
            print(f"    ! modelrec {pkk}: first_seen != min recorded_at")
        if not any(l["run"] == m["lastRun"] and l["recordedAt"] == m["lastScored"]
                   for l in logs):
            reg_bad += 1
            print(f"    ! modelrec {pkk}: last_run not the latest receipt")
    ok &= check("capability registry", reg_bad == 0,
                f"{reg_checked} records replayed bit-exact from "
                f"{len(scorelogs)} receipts" if reg_bad == 0
                else f"{reg_bad} violations — aggregates don't match receipts")

    # [6] cross-references — every inter-account link must resolve.
    x_bad = 0
    for pkk, m in markets.items():
        if m["run"] not in runs:
            x_bad += 1
    for b in bounties:
        if b["bank"] not in benches:
            x_bad += 1
        if b["status"] == 1 and b["winnerRun"] not in runs:
            x_bad += 1
    for l in ladders:
        for leg in l["legs"]:
            if leg not in runs:
                x_bad += 1
    for c in item_chunks + priv_chunks + chunks:
        if c["bench"] not in benches:
            x_bad += 1
    for r in reveals:
        if r["bench"] not in benches:
            x_bad += 1
    for pkk, l in scorelogs.items():
        if l["modelRecord"] not in records:
            x_bad += 1
    ok &= check("referential integrity", x_bad == 0,
                "every market/chunk/reveal/registry link resolves"
                if x_bad == 0 else f"{x_bad} dangling links")

    # [7] Merkle proof files — docs/evidence/prove-*.json re-verified
    # end-to-end: leaf hash → sibling fold → outputsRoot → the run account.
    pf_bad = pf_ok = 0
    D_COUT, D_NODE = b"sealed/v1/chunkout\x00", b"\x01"
    for f in sorted((ROOT / "docs" / "evidence").glob("prove-*.json")):
        try:
            p = json.loads(f.read_text())
            outs = [int(x) for x in p["chunkOutputs"]]
            while len(outs) < 32:
                outs.append(0)
            h = sha256(D_COUT + struct.pack("<H", int(p["chunkIndex"]))
                       + b"".join(u64le(o) for o in outs))
            i = int(p["chunkIndex"])
            for s in p["proof"]:
                sb = bytes.fromhex(s)
                h = sha256(D_NODE + (h + sb if i % 2 == 0 else sb + h))
                i >>= 1
            root_ok = h.hex() == p["outputsRoot"]
            slot_ok = int(p["outputHash"]) == \
                int(p["chunkOutputs"][int(p["itemIndex"]) % 32])
            run = runs.get(p.get("runPda"))
            chain_ok = run["outputsRoot"] == p["outputsRoot"] if run else None
            if root_ok and slot_ok and chain_ok is not False:
                pf_ok += 1
            else:
                pf_bad += 1
                print(f"    ! {f.name}: root={root_ok} slot={slot_ok} "
                      f"chain={chain_ok}")
        except Exception as e:
            pf_bad += 1
            print(f"    ! {f.name}: {e}")
    ok &= check("merkle proofs", pf_bad == 0,
                f"{pf_ok} proof files verify end-to-end"
                if pf_bad == 0 else f"{pf_bad} failed")

    # [8] post_reveal flags — the on-chain F1 flag vs timestamp inference:
    # flagged runs must be explainable by the bank's first reveal (the flag
    # is authoritative; inference only has to EXPLAIN it — flagged ⊆
    # inferred; unflagged same-second runs remain legitimate).
    reveal_by_bench = {}
    for r in reveals:
        reveal_by_bench.setdefault(r["bench"], []).append(r)
    flag_bad = 0
    for bench, rs in reveal_by_bench.items():
        min_t = min(r["revealedAt"] for r in rs)
        bench_runs = [(pk, r) for pk, r in runs.items() if r["benchmark"] == bench]
        inferred = {pk for pk, r in bench_runs if r["createdAt"] >= min_t}
        flagged = {pk for pk, r in bench_runs if r["postReveal"]}
        disagree = len(flagged - inferred)
        if disagree:
            flag_bad += 1
            print(f"    ! bank {bench}: {disagree} flagged run(s) "
                  "not explainable by timestamps")
        print(f"  note  bank {bench[:8]} — {len(rs)} reveal(s) — "
              f"{len(flagged)} flagged on-chain, {len(inferred)} inferred")
    ok &= check("post_reveal flags", flag_bad == 0,
                "on-chain flags consistent with reveal timestamps"
                if flag_bad == 0 else f"{flag_bad} inconsistencies")

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

        # venue field binding — a card-declared null is honest only when the
        # account field is absent too; every declared field must equal bytes.
        ints = lambda xs: None if xs is None else [int(x) for x in xs]
        big = lambda x: None if x is None else int(x)
        vdisc = {"band": "Market", "duel": "Market", "dark": "DarkMarket",
                 "ladder": "Ladder"}.get(v["kind"])
        vraw = find_account(msec, v["pk"], disc(vdisc)) if vdisc else None
        if vraw is None:
            ok &= check(f"{card_path.name}: venue binding", False,
                        "venue not in snapshot")
        elif v["kind"] in ("band", "duel"):
            a = decode_market(vraw)
            ok &= check(f"{card_path.name}: venue binding",
                        a["status"] == v["status"] and a["feeBps"] == v["feeBps"]
                        and a["outcome"] == v["outcome"]
                        and ints(v["totals"]) == a["totals"]
                        and v["mask"] is None and v["tallied"] is None
                        and v["poolTotal"] is None and v["winTotal"] is None,
                        "status · outcome · totals · fee equal the decoded Market")
        elif v["kind"] == "dark":
            a = decode_dark_market(vraw)
            ok &= check(f"{card_path.name}: venue binding",
                        a["status"] == v["status"] and a["feeBps"] == v["feeBps"]
                        and a["outcome"] == v["outcome"]
                        and big(v["poolTotal"]) == a["poolTotal"]
                        and big(v["winTotal"]) == a["winTotal"]
                        and v["tallied"] == bool(a["tallied"])
                        and v["totals"] is None and v["mask"] is None,
                        "status · outcome · pools · tallied equal the decoded DarkMarket")
        else:
            a = decode_ladder(vraw)
            ok &= check(f"{card_path.name}: venue binding",
                        a["status"] == v["status"] and a["feeBps"] == v["feeBps"]
                        and a["resultMask"] == v["mask"]
                        and ints(v["totals"]) == a["totals"]
                        and v["outcome"] is None,
                        "status · resultMask · totals · fee equal the decoded Ladder")

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
        if card["bounty"]["status"] == 1:
            w = card.get("winner") or {}
            ok &= check(f"{card_path.name}: paid-winner binding",
                        w.get("run") == card["bounty"]["winnerRun"],
                        "the embedded winner run IS the run the pot paid")

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
                    and dec["sharedAt"] == int(card["grant"]["sharedAt"])
                    and card["grant"]["seeds"]["bank"] == card["grant"]["benchmark"],
                    "all eight ShareGrant fields unpacked from account bytes")
        # bank semantics — grants are evidence only on ciphertext banks; a
        # card without the bank block proves nothing about the exam it names.
        bank = card.get("bank")
        ok &= check(f"{card_path.name}: bank semantics",
                    bank is not None and card["grant"]["benchmark"] == bank["pk"]
                    and card["grant"]["seeds"]["bank"] == bank["pk"]
                    and int(bank["kind"]) == 2,
                    "kind=2 ciphertext exam — the questions moved, not the answers")
        # the bank block is card-say-so until it's bound — a forged card
        # could claim kind=2 on an authored bank or a fake items_root.
        braw = find_account(SNAP["sealed"], card["grant"]["benchmark"], disc("Benchmark"))
        bdec = decode_benchmark(braw) if braw else None
        ok &= check(f"{card_path.name}: bank account binding",
                    bank is not None and bdec is not None
                    and str(bdec["name"]) == str(bank["name"])
                    and str(bdec["kind"]) == str(bank["kind"])
                    and bdec["itemsRoot"] == bank["itemsRoot"],
                    "card's bank block == decoded Benchmark (name · kind · items_root)")

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
                d = round4(100 * (pa - pb))
                sa, sb = stats[A["recordPk"]], stats[B["recordPk"]]
                sa["rankedPairs"] += 1; sb["rankedPairs"] += 1
                sa["sharedBanks"] += len(shared); sb["sharedBanks"] += len(shared)
                sa["ppDelta"] = round4(sa["ppDelta"] + d); sb["ppDelta"] = round4(sb["ppDelta"] - d)
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
            and x["verdict"] == y["verdict"] and x["deltaPp"] == y["deltaPp"]
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
            lcb = round4(wilson_lcb(s["wins"] + s["ties"] / 2, s["rankedPairs"])) if s else -1
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

        # completeness — the card's model set must EQUAL the snapshot's
        # ModelRecord set (erasing a losing model re-ranks cleanly), each
        # model's receipts must equal its full decoded ScoreLog set, and
        # declared record rows must match decoded accounts field-for-field.
        idx = snap_idx()
        true_pks = set(idx["recs"])
        card_pks = {m["recordPk"] for m in card["models"]}
        ok &= check(f"{name}: model-set completeness", true_pks == card_pks,
                    f"{len(true_pks)} ModelRecords on-chain == {len(card_pks)} listed")
        rc_ok = all(
            set(idx["logsByRec"].get(m["recordPk"], {})) == {l["pk"] for l in m["receipts"]}
            for m in card["models"])
        ok &= check(f"{name}: receipt completeness", rc_ok,
                    "every model's receipts == its full decoded ScoreLog set")
        tot_ok = True
        for m in card["models"]:
            r = idx["recs"].get(m["recordPk"])
            rec = m["record"]
            if (r is None or r["runsScored"] != rec["runsScored"]
                    or r["totalCorrect"] != rec["totalCorrect"] or r["totalItems"] != rec["totalItems"]
                    or r["bestCorrect"] != rec["bestCorrect"] or r["bestItems"] != rec["bestItems"]
                    or r["bestRun"] != rec["bestRun"] or r["bestBank"] != rec["bestBank"]
                    or r["lastRun"] != rec["lastRun"] or r["firstSeen"] != rec["firstSeen"]
                    or r["lastScored"] != rec["lastScored"] or r["modelHash"] != rec["modelHash"]
                    or r["modelId"] != m["modelId"]):
                tot_ok = False
        ok &= check(f"{name}: record totals", tot_ok,
                    "declared record rows == decoded ModelRecord fields")

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
                # model identity — the declared ids must hash to their
                # declared modelHash seeds: the seeds are self-declared,
                # so PDA-consistency alone still lets a card rename a model.
                id_ok = all(
                    hashlib.sha256((card[s].get("id") or "").encode()).hexdigest()
                    == card[s]["seeds"]["modelHash"] for s in ("a", "b"))
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
                # receipt-bank binding — every receipt's benchmark must equal
                # the benchmark of the run it cites; a receipt moved to an
                # unlisted bank drops out of the pooled aggregates, and an
                # undeclared run is misbound by definition.
                run_bank = {r["pk"]: r["benchmark"] for r in card["runs"]}
                rb_ok = all(run_bank.get(l["run"]) == l["benchmark"] for l in all_rec)
                # snapshot binding — receipt fields == decoded ScoreLog bytes,
                # and each side's receipts point at THAT side's model record
                bind_ok = True
                for side in ("a", "b"):
                    for l in card["receipts"][side]:
                        raw = find_account(SNAP["sealed"], l["pk"], disc("ScoreLog"))
                        sl = decode_scorelog(raw) if raw else None
                        if (sl is None or sl["run"] != l["run"]
                                or sl["benchmark"] != l["benchmark"]
                                or sl["correct"] != l["correct"] or sl["items"] != l["items"]
                                or sl["modelRecord"] != card[side]["recordPk"]
                                or bool(sl["vouched"]) != bool(l["vouchedAtRecord"])
                                or bool(sl["postReveal"]) != bool(l["postReveal"])):
                            bind_ok = False
                    # the record's on-chain modelId must be the card's
                    # claimed side name — same mislabel trap as claims.
                    rec_raw = find_account(SNAP["sealed"], card[side]["recordPk"], disc("ModelRecord"))
                    rec_dec = decode_model_record(rec_raw) if rec_raw else None
                    if not rec_dec or rec_dec["modelId"] != card[side]["id"]:
                        bind_ok = False
                # completeness — the declared shared-bank set must EQUAL
                # the snapshot's (banks where BOTH records carry ScoreLogs)
                # and each side's receipts must equal the decoded logs on
                # those banks: dropping a losing bank launders the verdict.
                idx = snap_idx()
                banks_of = lambda pk: {l["benchmark"] for l in idx["logsByRec"].get(pk, {}).values()}
                true_shared = banks_of(card["a"]["recordPk"]) & banks_of(card["b"]["recordPk"])
                bank_set_ok = true_shared == {b["pk"] for b in card["banks"]}
                rec_ok = all(
                    {p for p, l in idx["logsByRec"].get(card[s]["recordPk"], {}).items()
                     if l["benchmark"] in true_shared}
                    == {r["pk"] for r in card["receipts"][s]}
                    for s in ("a", "b"))
                bind_ok = bind_ok and bank_set_ok and rec_ok
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
                if not (ident and id_ok and banks_ok and runs_ok and logs_ok
                        and rb_ok and bind_ok and replay_ok):
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
                # model identity — the declared name must hash to the
                # declared modelHash seed; the seeds are self-declared so
                # a consistent (modelHash, recordPk) pair can still rename
                # the model. Free + offline (account-level binding below).
                id_ok = (hashlib.sha256((card["model"].get("id") or "").encode())
                         .hexdigest() == card["record"]["seeds"]["modelHash"])
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
                            or sl["modelRecord"] != card["record"]["pk"]
                            or bool(sl["vouched"]) != bool(l["vouched"])
                            or bool(sl["postReveal"]) != bool(l["postReveal"])):
                        bind_ok = False
                # the record's on-chain modelId must BE the card's model —
                # a card renaming the model while keeping real receipts
                # dies here (PDA seeds are self-declared, this is not).
                rec_raw = find_account(SNAP["sealed"], card["record"]["pk"], disc("ModelRecord"))
                rec_dec = decode_model_record(rec_raw) if rec_raw else None
                if not rec_dec or rec_dec["modelId"] != card["model"]["id"]:
                    bind_ok = False
                # completeness — the embedded receipt set must EQUAL the
                # record's full ScoreLog set, and the declared model totals
                # must equal the decoded ModelRecord: a dropped receipt
                # self-aggregates cleanly on the subset without this.
                want = set(snap_idx()["logsByRec"].get(card["record"]["pk"], {}))
                comp_ok = want == {l["pk"] for l in card["receipts"]}
                tot_ok = (rec_dec is not None
                          and rec_dec["runsScored"] == card["model"]["runsScored"]
                          and rec_dec["totalCorrect"] == card["model"]["totalCorrect"]
                          and rec_dec["totalItems"] == card["model"]["totalItems"])
                bind_ok = bind_ok and comp_ok and tot_ok
                # run account binding — every embedded run must exist in
                # the snapshot and equal its decoded Run fields; the card's
                # "subject"/"co-participant" roles are lies unless the
                # decoded run's modelId agrees (role lies count).
                runs_ix = snap_idx()["runs"]
                r_bad = r_miss = role_bad = 0
                for r in card["runs"]:
                    real = runs_ix.get(r["pk"])
                    if real is None:
                        r_miss += 1
                        continue
                    if (real["benchmark"] != r["benchmark"]
                            or real["index"] != r["index"]
                            or real["status"] != r["status"]
                            or real["correct"] != r["correct"]
                            or real["chunkCount"] != r["chunkCount"]
                            or bool(real["postReveal"]) != bool(r["postReveal"])
                            or bool(real["attested"]) != bool(r["attested"])):
                        r_bad += 1
                    if (r.get("role") == "subject") != (real["modelId"] == card["model"]["id"]):
                        role_bad += 1
                rbind_ok = r_bad == 0 and r_miss == 0 and role_bad == 0
                # run completeness — every subject run plus every
                # co-participant leg the true venue set reads (duel runB,
                # ladder legs, dark run) must be embedded; a dropped leg
                # laundered a verdict.
                _subj, true_venue, want_runs = claim_true_venues(card["model"]["id"])
                got_runs = {r["pk"] for r in card["runs"]}
                rcomp_ok = not [p for p in want_runs if p not in got_runs]
                # venue account binding + completeness — every declared
                # venue equals its decoded account's fields, and the
                # declared pk set EQUALS the set re-derived from the
                # snapshot's subject runs (an omitted losing venue — or a
                # phantom one — was invisible before).
                v_bad = v_miss = 0
                vix = snap_idx()
                for v in card["venues"]:
                    a = venue_acct(v, vix)
                    if a is None:
                        v_miss += 1
                    elif not venue_field_match(v, a):
                        v_bad += 1
                vbind_ok = v_bad == 0 and v_miss == 0
                got_ven = {v["pk"] for v in card["venues"]}
                vcomp_ok = (not [p for p in true_venue if p not in got_ven]
                            and len(got_ven) == len(true_venue))
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
                if not (ident and id_ok and runs_ok and banks_ok and logs_ok
                        and venue_ok and ag_ok and bind_ok and rbind_ok
                        and rcomp_ok and vbind_ok and vcomp_ok and res_ok):
                    c_bad += 1
            except Exception:
                c_bad += 1
        ok &= check("sealed-claim/v1 cards", c_bad == 0,
                    f"{c_n - c_bad}/{c_n} model claims: every PDA re-derived, run + receipt "
                    f"bytes bound, venues replayed from Run.correct + bound to decoded accounts")

    # --- sealed-ceiling/v1 — proof-of-a-negative cards --------------------
    # "No finalized run of this model scored above N%." The card lists the
    # ENTIRE subject run set; we re-derive that set from the snapshot, so
    # an omitted argmax run dies at completeness and a phantom dies too.
    kdir = ROOT / "docs" / "evidence" / "ceilings"
    if kdir.is_dir():
        k_n, k_bad = 0, 0
        # the subject sets — every decoded Run grouped by its on-chain modelId
        subj_by_model = {}
        for e in SNAP["sealed"]:
            d = base64.b64decode(e["data"])
            if d[:8] != disc("Run"):
                continue
            dr = decode_run(d)
            subj_by_model.setdefault(dr["modelId"], {})[e["pubkey"]] = dr
        for card_path in card_iter(kdir, kind="sealed-ceiling/v1"):
            if card_path.name == "index.json":
                continue
            card = json.loads(card_path.read_text())
            if card.get("kind") != "sealed-ceiling/v1":
                continue
            k_n += 1
            spid = card["programs"]["sealed"]
            try:
                okc = b58encode_check(
                    pda([b"modelrec", bytes.fromhex(card["record"]["seeds"]["modelHash"])],
                        spid) or b"", card["record"]["pk"])
                # the record's on-chain modelId must BE the card's model
                rec_raw = find_account(SNAP["sealed"], card["record"]["pk"], disc("ModelRecord"))
                rec_dec = decode_model_record(rec_raw) if rec_raw else None
                okc &= bool(rec_dec) and rec_dec["modelId"] == card["model"]["id"]
                # every listed run re-derives its PDA
                okc &= all(
                    b58encode_check(pda([b"run", b58decode(r["benchmark"]),
                                         u64le(r["index"])], spid) or b"", r["pk"])
                    for r in card["runs"])
                # completeness — card set == snapshot subject set, both ways
                subject = subj_by_model.get(card["model"]["id"], {})
                listed = {r["pk"] for r in card["runs"]}
                okc &= listed == set(subject.keys())
                # field binding — every listed run equals its decoded bytes
                for r in card["runs"]:
                    dr = subject.get(r["pk"])
                    okc &= bool(dr) and dr["benchmark"] == r["benchmark"] \
                        and dr["index"] == r["index"] and dr["status"] == r["status"] \
                        and dr["correct"] == r["correct"] and dr["chunkCount"] == r["chunkCount"] \
                        and dr["postReveal"] == bool(r["postReveal"]) \
                        and bool(dr["attested"]) == bool(r["attested"])
                # ceiling arithmetic — recompute argmax over status==1
                scoped = [r for r in card["runs"] if r["status"] == 1]
                scope_ok = (card["scope"]["subjectRuns"] == len(card["runs"])
                            and card["scope"]["finalizedRuns"] == len(scoped)
                            and card["scope"]["unfinishedRuns"] == len(card["runs"]) - len(scoped)
                            and card["scope"]["postRevealRuns"] == sum(1 for r in scoped if r["postReveal"]))
                if scoped:
                    bp = {r["pk"]: (r["correct"] * 10000 // (r["chunkCount"] * 32))
                          if r["chunkCount"] else 0 for r in scoped}
                    mx = max(bp.values())
                    argmax = [p for p, b in bp.items() if b == mx]
                    br = card["ceiling"]["bestRun"] or {}
                    scope_ok &= (card["ceiling"]["maxPctBp"] == mx
                                 and br.get("pk") in argmax
                                 and br.get("correct") == subject[br["pk"]]["correct"]
                                 and br.get("items") == subject[br["pk"]]["chunkCount"] * 32)
                else:
                    scope_ok &= card["ceiling"]["maxPctBp"] is None and card["ceiling"]["bestRun"] is None
                okc &= scope_ok
                # snapshot hash pin — the negative is only defined vs THIS
                # dump; a card that drops the pin opts out of completeness
                okc &= bool(card.get("snapshotSha256")) and card["snapshotSha256"] == snap_hash
                if not okc:
                    k_bad += 1
            except Exception:
                k_bad += 1
        ok &= check("sealed-ceiling/v1 cards", k_bad == 0,
                    f"{k_n - k_bad}/{k_n} ceiling cards: PDAs re-derived, subject-set "
                    f"completeness vs snapshot, argmax recomputed")

    # --- sealed-circuit/v1 — the MPC itself as evidence -------------------
    # Every other artifact binds what the MPC wrote; this binds the MPC —
    # the six compdef accounts, MXE, cluster, and callback signer are PDAs
    # of the DEPLOYED Arcium program (or the sealed program for signPda),
    # re-derived here with the same ed25519 curve math as every other PDA.
    cdir = ROOT / "docs" / "evidence" / "circuit"
    if cdir.is_dir():
        ARCIUM = "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
        CIRCUITS = {"seal_part", "score_chunk", "gen_part",
                    "gen_part_private", "reveal_part", "reshare_part"}
        k_n, k_bad = 0, 0
        sp_entry = next((e for e in SNAP["sealed"]
                         if base64.b64decode(e["data"])[:8].hex() == "d69d7a72752cd64a"), None)
        for card_path in card_iter(cdir, kind="sealed-circuit/v1"):
            if card_path.name == "index.json":
                continue
            card = json.loads(card_path.read_text())
            if card.get("kind") != "sealed-circuit/v1":
                continue
            k_n += 1
            try:
                spid = card["programs"]["sealed"]
                okc = (card["programs"]["arcium"] == ARCIUM
                       and spid == SNAP["meta"]["programs"]["sealed"])
                # the canonical six — no dropped, no phantom
                named = {c["name"] for c in card["circuits"]}
                okc &= named == CIRCUITS and len(card["circuits"]) == 6
                # compdef pda: [CompDef, sealedPid, u32le(sha256(name)[:4])]
                for c in card["circuits"]:
                    want = int.from_bytes(hashlib.sha256(c["name"].encode()).digest()[:4], "little")
                    got = pda([b"ComputationDefinitionAccount", b58decode(spid),
                               struct.pack("<I", c["offset"])], ARCIUM)
                    okc &= c["offset"] == want and b58encode_check(got or b"", c["pda"])
                # content-level binding (chain.ts 3b–3d): raw-circuit PDAs,
                # recorded account bytes vs web/arcium-infra.json, and the
                # cluster committee's aggregated BLS key inside the bound
                # account. Old-format cards carry none of these fields —
                # each check skips and the card verifies exactly as before.
                raw_ok, raw_ran = circuit_raw_pdas(card, ARCIUM)
                if raw_ran:
                    okc &= raw_ok
                ab = circuit_account_binding(card)
                if ab is not None:
                    okc &= ab
                cc = circuit_cluster_committee(card)
                if cc is not None:
                    okc &= cc
                okc &= b58encode_check(pda([b"MXEAccount", b58decode(spid)], ARCIUM) or b"",
                                       card["mxe"]["pda"])
                okc &= b58encode_check(pda([b"Cluster", struct.pack("<I", card["cluster"]["offset"])],
                                           ARCIUM) or b"", card["cluster"]["pda"])
                okc &= b58encode_check(pda([b"ArciumSignerAccount"], spid) or b"",
                                       card["signPda"])
                for k, m in (card.get("fetched") or {}).get("accounts", {}).items():
                    okc &= m.get("exists") and (k == "signPda" or m.get("owner") == ARCIUM) \
                        and int(m.get("dataLen", 0)) > 8
                okc &= bool(card.get("snapshotSha256")) and card["snapshotSha256"] == snap_hash
                okc &= bool(sp_entry) and sp_entry["pubkey"] == card["signPda"] \
                    and card.get("signPdaSnapshot") == card["signPda"]
                if not okc:
                    k_bad += 1
            except Exception:
                k_bad += 1
        ok &= check("sealed-circuit/v1 cards", k_bad == 0,
                    f"{k_n - k_bad}/{k_n} circuit cards: Arcium PDAs re-derived, "
                    f"account bytes bound to arcium-infra.json, "
                    f"signPda bound to the snapshot's SignPdaAccount")

    # --- sealed-ledger/v1 — the nothing-up-my-sleeve census ---------------
    # The completeness assumption every negative claim rests on, made
    # verifiable: recompute per-program account totals, per-kind
    # discriminator counts, and the sorted-pubkey-set sha256 from the raw
    # bundle bytes, then diff the card's declared census. Honest scope:
    # enumerable, not "the chain holds nothing else".
    ldir = ROOT / "docs" / "evidence" / "ledger"
    if ldir.is_dir():
        SEALED_KINDS = {disc(n): n for n in
                        ("Benchmark", "Run", "AnswerChunk", "ItemChunk",
                         "PrivItemChunk", "Reveal", "ShareGrant",
                         "ModelRecord", "ScoreLog")}
        SEALED_KINDS[bytes.fromhex("d69d7a72752cd64a")] = "SignPdaAccount"
        MARKET_KINDS = {disc(n): n for n in
                        ("Market", "Ladder", "Position", "DarkMarket",
                         "DarkPosition", "Bounty")}

        def census(entries, kind_map):
            kinds, pks, unknown = {}, [], 0
            for e in entries:
                pks.append(e["pubkey"])
                d = base64.b64decode(e["data"])
                kind = kind_map.get(d[:8]) if len(d) >= 8 else None
                if kind:
                    kinds[kind] = kinds.get(kind, 0) + 1
                else:
                    unknown += 1
            if unknown:
                kinds["unknown"] = unknown
            return {"accounts": len(entries),
                    "pubkeySetSha256": sha256("\n".join(sorted(pks)).encode()).hex(),
                    "kinds": kinds}

        l_n, l_bad = 0, 0
        for card_path in card_iter(ldir, kind="sealed-ledger/v1"):
            if card_path.name == "index.json":
                continue
            card = json.loads(card_path.read_text())
            if card.get("kind") != "sealed-ledger/v1":
                continue
            l_n += 1
            try:
                okl = (card["programs"]["sealed"] == SNAP["meta"]["programs"]["sealed"]
                       and card["programs"]["market"] == SNAP["meta"]["programs"]["market"])
                okl &= card.get("snapshotSha256") == snap_hash
                okl &= card.get("takenAt") == SNAP["meta"].get("takenAt")
                for section, km in (("sealed", SEALED_KINDS), ("market", MARKET_KINDS)):
                    want = census(SNAP.get(section, []), km)
                    got = card.get("census", {}).get(section, {})
                    allk = set(want["kinds"]) | set(got.get("kinds", {}))
                    okl &= (got.get("accounts") == want["accounts"]
                            and got.get("pubkeySetSha256") == want["pubkeySetSha256"]
                            and all(got.get("kinds", {}).get(k, 0) == want["kinds"][k] for k in allk))
                if not okl:
                    l_bad += 1
            except Exception:
                l_bad += 1
        ok &= check("sealed-ledger/v1 cards", l_bad == 0,
                    f"{l_n - l_bad}/{l_n} census cards: "
                    f"{len(SNAP.get('sealed', [])) + len(SNAP.get('market', []))} "
                    f"raw entries re-classified, pubkey-set hashes replayed")

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
            npass, v_bad, r_bad, id_bad = 0, 0, 0, 0
            for m in card["models"]:
                ident = b58encode_check(
                    pda([b"modelrec", bytes.fromhex(m["seeds"]["modelHash"])], spid) or b"",
                    m["recordPk"])
                # the cert's only payload is the name→verdict mapping — a
                # renamed model launders a failing record onto a competitor.
                # The declared name must hash to the declared seed (free,
                # offline); account-level binding is checked below.
                if not (isinstance(m.get("modelId"), str)
                        and hashlib.sha256(m["modelId"].encode()).hexdigest()
                            == m["seeds"]["modelHash"]):
                    id_bad += 1
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
            ok &= check(f"{name}: model identity", id_bad == 0,
                        f"{len(card['models']) - id_bad}/{len(card['models'])} declared modelIds "
                        "hash to their declared modelHash seeds")
            ok &= check(f"{name}: verdict replay", v_bad == 0,
                        f"{len(card['models'])} models — record PDAs + verdicts recomputed (pass/reason exact, pct within 0.01pp)")
            ok &= check(f"{name}: receipt binding", r_bad == 0,
                        "every embedded receipt multiset == decoded ScoreLog bytes"
                        + (f" (bank {bank_arg[:8]}…)" if bank_arg else ""))
            ok &= check(f"{name}: summary", s.get("records") == len(card["models"])
                        and s.get("pass") == npass
                        and s.get("fail") == recomp_fail
                        and s.get("noEvidence") == recomp_ne,
                        f"{s.get('records')} records · {s.get('pass')} pass · {s.get('fail')} fail · {s.get('noEvidence')} no-evidence")
            true_pks = set(snap_idx()["recs"])
            card_pks = {m["recordPk"] for m in card["models"]}
            ok &= check(f"{name}: record-set completeness", true_pks == card_pks,
                        f"{len(true_pks)} ModelRecords on-chain == {len(card_pks)} listed")
            # account-level name binding — sha→seed alone isn't enough (the
            # seeds are self-declared too): the declared modelId must equal
            # the decoded ModelRecord's model_id for every listed record
            # present in the snapshot.
            rec_by_pk = snap_idx()["recs"]
            name_bad = sum(1 for m in card["models"]
                           if m["recordPk"] in rec_by_pk
                           and rec_by_pk[m["recordPk"]]["modelId"] != m["modelId"])
            ok &= check(f"{name}: account modelId", name_bad == 0,
                        f"{len(card['models']) - name_bad}/{len(card['models'])} declared "
                        "names == decoded ModelRecord.model_id")

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
            # [6] disclosure surface — reveals + grants re-derive and
            # enumerate completely: the card claims "this is EVERYTHING
            # disclosed on this exam".
            real_rv, real_gr = {}, {}
            for a in SNAP["sealed"]:
                d = base64.b64decode(a["data"])
                if d[:8] == disc("Reveal") and b58encode(d[8:40]) == bank["pk"]:
                    real_rv[a["pubkey"]] = decode_reveal(d)
                elif d[:8] == disc("ShareGrant") and b58encode(d[8:40]) == bank["pk"]:
                    real_gr[a["pubkey"]] = decode_share_grant(d)
            d_bad = 0
            for r in card["reveals"]:
                d_bad += 0 if b58encode_check(
                    pda([b"reveal", b58decode(bank["pk"]), struct.pack("<H", r["chunkIndex"]),
                         bytes([r["part"]])], spid) or b"", r["pk"]) else 1
            for g in card["grants"]:
                d_bad += 0 if b58encode_check(
                    pda([b"grant", b58decode(bank["pk"]), struct.pack("<H", g["chunkIndex"]),
                         bytes([g["part"]]), b58decode(g["viewer"])], spid) or b"", g["pk"]) else 1
            # duplicates inflate the count without covering the set — a
            # count-only check waves a duplicated real reveal past a
            # missing one.
            if len({r["pk"] for r in card["reveals"]}) != len(card["reveals"]) \
                    or len({g["pk"] for g in card["grants"]}) != len(card["grants"]):
                d_bad += 1
            # exact pk sets — a phantom (chunk,part) re-derives a clean PDA
            # but names no account; a swapped grant keeps the count. Only
            # set equality binds "this is EVERYTHING disclosed".
            if not (len(real_rv) == len(card["reveals"])
                    and all(r["pk"] in real_rv for r in card["reveals"])):
                d_bad += 1
            if not (len(real_gr) == len(card["grants"])
                    and all(g["pk"] in real_gr for g in card["grants"])):
                d_bad += 1
            # every carried field binds to decoded bytes — timestamps and
            # positions are what the card claims, so they're what must match.
            for r in card["reveals"]:
                a = real_rv.get(r["pk"])
                if (a is None or a["chunk"] != r["chunkIndex"] or a["part"] != r["part"]
                        or a["revealedAt"] != r["revealedAt"]):
                    d_bad += 1
            for g in card["grants"]:
                a = real_gr.get(g["pk"])
                if (a is None or a["chunkIndex"] != g["chunkIndex"] or a["part"] != g["part"]
                        or a["viewer"] != g["viewer"] or a["sharedAt"] != g["sharedAt"]):
                    d_bad += 1
            ok &= check(f"{name}: disclosure surface", d_bad == 0,
                        f"{len(card['reveals'])} reveals + {len(card['grants'])} grants — "
                        "PDAs re-derive · exact sets · field-bound")
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
            snap_digest = hashlib.sha256(snapshot_bytes()).hexdigest()
            ok &= check(f"{name}: snapshot binding", snap_digest == card.get("snapshot"),
                        "sha256(snapshot.json) == card.snapshot")

    # --- sealed-evidence-digest/v1 — the whole-ledger verdict --------------
    dig_path = Path(_CARD[0]) if _CARD and _CARD[1] == "sealed-evidence-digest/v1" \
        else ROOT / "docs" / "evidence" / "digest.json"
    if dig_path.exists() and (_CARD is None or _CARD[1] == "sealed-evidence-digest/v1"):
        card = json.loads(dig_path.read_text())
        if card.get("kind") == "sealed-evidence-digest/v1":
            rebuilt = build_digest()
            snap_sha = hashlib.sha256(snapshot_bytes()).hexdigest()
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
            # markdown artifacts mutate as text — the report exhibits carry
            # forgedMd and replay through the report verifier's checks.
            died = (forged_report_checks(e["forgedMd"])
                    if isinstance(e.get("forgedMd"), str)
                    else forged_card_checks(e.get("forged") or {}))
            expected = set(e.get("expectFail") or [])
            # strict, same as TS/browser: the forged card must be rejected
            # AND every check name the exhibit claims must fire — an
            # exhibit that dies one check earlier than recorded is itself
            # a lie about the verifier's behavior.
            named_ok = not expected or expected.issubset(died)
            throw_ok = (not expected and e.get("expectThrow")
                        and "(thrown)" in died)
            if not died or not (named_ok or throw_ok):
                t_bad += 1
        ok &= check("sealed-tamper/v1 exhibits", t_bad == 0,
                    f"{t_n - t_bad}/{t_n} committed forgeries rejected at the "
                    f"recorded named checks")

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


_SNAPIDX = [None]


def snap_idx():
    """Decoded snapshot indexes, built once: every ScoreLog keyed by
    pubkey AND grouped by modelRecord, plus ModelRecord and Run maps —
    what the completeness checks (claim/match/board/policy) iterate —
    and the market-side venue maps (Market/DarkMarket/Ladder/Bounty)
    the claim card's venue completeness + binding checks re-derive."""
    if _SNAPIDX[0] is None:
        idx = {"logs": {}, "logsByRec": {}, "recs": {}, "runs": {},
               "markets": {}, "darks": {}, "ladders": {}, "bounties": {}}
        for e in SNAP.get("sealed", []):
            d = base64.b64decode(e["data"])
            if d[:8] == disc("ScoreLog"):
                l = decode_scorelog(d)
                idx["logs"][e["pubkey"]] = l
                idx["logsByRec"].setdefault(l["modelRecord"], {})[e["pubkey"]] = l
            elif d[:8] == disc("ModelRecord"):
                idx["recs"][e["pubkey"]] = decode_model_record(d)
            elif d[:8] == disc("Run"):
                idx["runs"][e["pubkey"]] = decode_run(d)
        for e in SNAP.get("market", []):
            d = base64.b64decode(e["data"])
            dd = d[:8]
            if dd == disc("Market"):
                idx["markets"][e["pubkey"]] = decode_market(d)
            elif dd == disc("DarkMarket"):
                idx["darks"][e["pubkey"]] = decode_dark_market(d)
            elif dd == disc("Ladder"):
                idx["ladders"][e["pubkey"]] = decode_ladder(d)
            elif dd == disc("Bounty"):
                idx["bounties"][e["pubkey"]] = decode_bounty(d)
        _SNAPIDX[0] = idx
    return _SNAPIDX[0]


def claim_true_venues(model_id):
    """The venue set `verifyClaimCard` re-derives from the snapshot for
    `model_id` — Market where a subject run is priced (or is the duel's
    runB), DarkMarket on a subject run, Ladder with any subject leg, and
    Bounty on a benchmark the subject+co-leg runs used or one paying a
    subject run. Returns (subject run pks, venue pks, runs the card must
    embed: subject ∪ co-legs that exist as Run accounts)."""
    idx = snap_idx()
    subj = {p for p, r in idx["runs"].items() if r["modelId"] == model_id}
    is_duel = lambda a: bool(a.get("runB")) and a["runB"] != NULL_PK
    true_venue = set()
    for p, a in idx["markets"].items():
        if a["run"] in subj or (is_duel(a) and a["runB"] in subj):
            true_venue.add(p)
    for p, a in idx["darks"].items():
        if a["run"] in subj:
            true_venue.add(p)
    for p, a in idx["ladders"].items():
        if any(leg in subj for leg in a["legs"][:a["legCount"]]):
            true_venue.add(p)
    co_set = set()
    for p, a in idx["markets"].items():
        if p in true_venue:
            co_set.add(a["run"])
            if is_duel(a):
                co_set.add(a["runB"])
    for p, a in idx["darks"].items():
        if p in true_venue:
            co_set.add(a["run"])
    for p, a in idx["ladders"].items():
        if p in true_venue:
            co_set.update(a["legs"][:a["legCount"]])
    bank_set = {r["benchmark"] for p, r in idx["runs"].items()
                if p in subj or p in co_set}
    for p, a in idx["bounties"].items():
        if a["bank"] in bank_set or (a.get("winnerRun") and a["winnerRun"] in subj):
            true_venue.add(p)
    want_runs = subj | {p for p in co_set if p in idx["runs"]}
    return subj, true_venue, want_runs


def venue_field_match(v, a):
    """`verifyClaimCard`'s venue account binding — a declared venue must
    equal its decoded account's fields by kind. band/duel → Market
    (run · runB-or-null · salt · status · outcome · resolvedScore ·
    pot=Σtotals), dark → DarkMarket (run · salt · status · outcome ·
    resolvedScore · tallied · pool=poolTotal), ladder → Ladder
    (legs[:legCount] · salt · status · resultMask · resolvedScore · pot),
    bounty → Bounty (bank · sponsor · salt · status · threshold · amount
    · winningScore · winnerRun-or-null). `a` is None when absent."""
    if a is None:
        return False
    pot = sum(a["totals"]) if a.get("totals") is not None else None
    if v.get("kind") == "bounty":
        return (a["bank"] == v.get("bank") and a["sponsor"] == v.get("sponsor")
                and a["salt"] == v.get("salt") and a["status"] == v.get("status")
                and a["threshold"] == v.get("threshold")
                and a["amount"] == v.get("amount")
                and a["winningScore"] == v.get("winningScore")
                and (a.get("winnerRun") or None) == v.get("winnerRun"))
    if v.get("kind") == "ladder":
        return (a["legs"][:a["legCount"]] == list(v.get("legs") or [])
                and a["salt"] == v.get("salt") and a["status"] == v.get("status")
                and a["resultMask"] == v.get("resultMask")
                and a["resolvedScore"] == v.get("resolvedScore")
                and pot == v.get("pot"))
    if v.get("kind") == "dark":
        return (a["run"] == v.get("run") and a["salt"] == v.get("salt")
                and a["status"] == v.get("status") and a["outcome"] == v.get("outcome")
                and a["resolvedScore"] == v.get("resolvedScore")
                and bool(a["tallied"]) == bool(v.get("tallied"))
                and a["poolTotal"] == v.get("pool"))
    # band / duel → Market
    return (a["run"] == v.get("run")
            and (a["runB"] if a.get("runB") and a["runB"] != NULL_PK else None)
                == v.get("runB")
            and a["salt"] == v.get("salt") and a["status"] == v.get("status")
            and a["outcome"] == v.get("outcome")
            and a["resolvedScore"] == v.get("resolvedScore")
            and pot == v.get("pot"))


def venue_acct(v, idx):
    """The decoded venue account a claim-card venue entry claims to be —
    routed by kind: dark→DarkMarket, ladder→Ladder, bounty→Bounty,
    band/duel (and anything else)→Market."""
    p = v.get("pk")
    if v.get("kind") == "dark":
        return idx["darks"].get(p)
    if v.get("kind") == "ladder":
        return idx["ladders"].get(p)
    if v.get("kind") == "bounty":
        return idx["bounties"].get(p)
    return idx["markets"].get(p)


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
    # [ | spec_commitment 32B — tail-appended on post-upgrade accounts;
    #   absence (196-byte legacy layout) means no commitment, not malformed ]
    g = {
        "benchmark": b58encode(d[8:40]),
        "chunkIndex": int.from_bytes(d[40:42], "little"),
        "part": d[42],
        "viewer": b58encode(d[44:76]),
        "encryptionKey": b58encode(d[76:108]),
        "nonce": int.from_bytes(d[108:124], "little"),
        "ciphertexts": [b58encode(d[124:156]), b58encode(d[156:188])],
        "sharedAt": int.from_bytes(d[188:196], "little", signed=True),
    }
    if len(d) >= 228:
        g["specCommitment"] = d[196:228].hex()
    return g


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


def round4(x):
    """JS `+(v).toFixed(4)` — round-half-up on the shortest-round-trip decimal,
    NOT Python's banker's-rounding round(). Parity with the TS minting code."""
    return float(Decimal(repr(x)).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP))


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
    # [ | spec_commitments 4×32B — tail-appended on post-upgrade accounts ]
    nonces = [int.from_bytes(d[76 + p * 16:92 + p * 16], "little") for p in range(4)]
    cts = [d[140 + i * 32:172 + i * 32] for i in range(8)]
    mint_order = [int.from_bytes(d[396 + p * 2:398 + p * 2], "little") for p in range(4)]
    pc = {"index": int.from_bytes(d[40:42], "little"), "partsWritten": d[43],
          "nonces": nonces, "ciphertexts": cts, "mintOrder": mint_order}
    if len(d) >= 532:
        pc["specCommitments"] = [d[404 + p * 32:436 + p * 32].hex() for p in range(4)]
    return pc


def gen_items_fold(root, chunk_index, part, spec_bytes):
    # sha256("sealed/v1/genitems\0" ‖ root ‖ u16le(chunk) ‖ u8(part) ‖ specs)
    return sha256(b"sealed/v1/genitems\x00" + root
                  + struct.pack("<H", chunk_index) + bytes([part]) + spec_bytes)


def priv_items_fold(root, chunk_index, part, enc_bytes):
    return sha256(b"sealed/v1/privitems\x00" + root
                  + struct.pack("<H", chunk_index) + bytes([part]) + enc_bytes)


def decode_reveal(d):
    # disc8 benchmark32 chunk u16 part u8 bump revealed_at i64 hashes[8]u64
    if len(d) < 52:
        raise ValueError("truncated Reveal")
    return {"benchmark": b58encode(d[8:40]),
            "chunk": int.from_bytes(d[40:42], "little"),
            "part": d[42],
            "revealedAt": int.from_bytes(d[44:52], "little", signed=True)}


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
        "chunkCount": int.from_bytes(d[82:84], "little"),
        "pendingMask": int.from_bytes(d[84:92], "little"),
        "scoredMask": int.from_bytes(d[92:100], "little"),
        "correct": int.from_bytes(d[100:104], "little"),
        "createdAt": int.from_bytes(d[104:112], "little", signed=True),
        "finalizedAt": int.from_bytes(d[112:120], "little", signed=True),
        "outputsRoot": d[152:184].hex(),
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
        "n": d[120],
        "edges": [int.from_bytes(d[121 + 4 * i:125 + 4 * i], "little") for i in range(7)],
        "status": d[150], "outcome": d[151],
        "totals": [int.from_bytes(d[152 + 8 * i:160 + 8 * i], "little") for i in range(8)],
        "resolvedScore": int.from_bytes(d[216:220], "little"),
        "runB": b58encode(d[236:268]) if len(d) >= 268 else None,
        "feeBps": int.from_bytes(d[268:270], "little") if len(d) >= 278 else 0,
        "feesAccrued": int.from_bytes(d[270:278], "little") if len(d) >= 278 else 0,
        "resolveBy": int.from_bytes(d[286:294], "little", signed=True) if len(d) >= 294 else 0,
    }


def decode_dark_market(d):
    # disc8 authority32 run32 benchmark32 runIndex u64 salt u64 n u8
    # edges[7]u32 bump status outcome pool u64 winTotal u64
    # revealedCount u32 resolvedScore u32 ts i64×4 fee tail tallied u8
    return {
        "authority": b58encode(d[8:40]), "run": b58encode(d[40:72]),
        "salt": int.from_bytes(d[112:120], "little"),
        "n": d[120],
        "edges": [int.from_bytes(d[121 + 4 * i:125 + 4 * i], "little") for i in range(7)],
        "status": d[150], "outcome": d[151],
        "poolTotal": int.from_bytes(d[152:160], "little"),
        "winTotal": int.from_bytes(d[160:168], "little"),
        "revealedCount": int.from_bytes(d[168:172], "little"),
        "resolvedScore": int.from_bytes(d[172:176], "little"),
        "revealUntil": int.from_bytes(d[200:208], "little", signed=True) if len(d) >= 208 else 0,
        "feeBps": int.from_bytes(d[208:210], "little") if len(d) >= 218 else 0,
        "feesAccrued": int.from_bytes(d[210:218], "little") if len(d) >= 218 else 0,
        "resolveBy": int.from_bytes(d[226:234], "little", signed=True) if len(d) >= 234 else 0,
        "tallied": len(d) > 234 and d[234] == 1,
    }


def decode_model_record(d):
    # disc8 model_hash32 model_id str runs_scored u32 total_correct u64
    # total_items u64 best_correct u32 best_items u32 best_run32
    # best_bank32 last_run32 first_seen i64 last_scored i64 bump
    ml = int.from_bytes(d[40:44], "little")
    o = 44 + ml
    if o + 140 > len(d):
        raise ValueError("truncated ModelRecord")
    return {"modelHash": d[8:40].hex(),
            "modelId": d[44:o].decode(),
            "runsScored": int.from_bytes(d[o:o + 4], "little"),
            "totalCorrect": int.from_bytes(d[o + 4:o + 12], "little"),
            "totalItems": int.from_bytes(d[o + 12:o + 20], "little"),
            "bestCorrect": int.from_bytes(d[o + 20:o + 24], "little"),
            "bestItems": int.from_bytes(d[o + 24:o + 28], "little"),
            "bestRun": b58encode(d[o + 28:o + 60]),
            "bestBank": b58encode(d[o + 60:o + 92]),
            "lastRun": b58encode(d[o + 92:o + 124]),
            "firstSeen": int.from_bytes(d[o + 124:o + 132], "little", signed=True),
            "lastScored": int.from_bytes(d[o + 132:o + 140], "little", signed=True)}


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
        "feeBps": int.from_bytes(d[424:426], "little") if len(d) >= 434 else 0,
        "feesAccrued": int.from_bytes(d[426:434], "little") if len(d) >= 434 else 0,
        "resolveBy": int.from_bytes(d[442:450], "little", signed=True) if len(d) >= 450 else 0,
    }


def outcome_of(edges, n, score):
    # band bucket index: the first edge strictly above the score (verify.mjs).
    i = 0
    while i < n - 1 and score >= edges[i]:
        i += 1
    return i


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
            snapshot_bytes()).hexdigest(),
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
        "money": {
            "escrowLamports":
                sum(sum(m["totals"]) for _p, m in mkt.get("Market", []))
                + sum(sum(l["totals"]) for _p, l in mkt.get("Ladder", []))
                + sum(d["poolTotal"] for _p, d in mkt.get("DarkMarket", []))
                + sum(b["amount"] for _p, b in mkt.get("Bounty", [])),
            "venueFeesAccruedLamports":
                sum(m["feesAccrued"] for _p, m in mkt.get("Market", []))
                + sum(l["feesAccrued"] for _p, l in mkt.get("Ladder", []))
                + sum(d["feesAccrued"] for _p, d in mkt.get("DarkMarket", [])),
            "venueFeeBearing":
                sum(1 for _p, m in mkt.get("Market", []) if m["feeBps"] > 0)
                + sum(1 for _p, l in mkt.get("Ladder", []) if l["feeBps"] > 0)
                + sum(1 for _p, d in mkt.get("DarkMarket", []) if d["feeBps"] > 0),
            "bankFeesChargedLamports":
                sum(b["feeLamports"] * b["runCount"] for _p, b in seal.get("Benchmark", [])),
            "feeBearingBanks":
                sum(1 for _p, b in seal.get("Benchmark", []) if b["feeLamports"] > 0),
            "feeBearingRuns":
                sum(b["runCount"] for _p, b in seal.get("Benchmark", []) if b["feeLamports"] > 0),
            "bountyOpenLamports":
                sum(b["amount"] for _p, b in mkt.get("Bounty", []) if b["status"] != 1),
            "bountiesClaimed":
                sum(1 for _p, b in mkt.get("Bounty", []) if b["status"] == 1),
        },
        "banks": [{"pk": pk, "name": b["name"], "kind": b["kind"],
                   "items": b["chunkCount"] * 32, "runs": b["runCount"],
                   "reveals": b["revealCount"], "itemsRoot": b["itemsRoot"]}
                  for pk, b in seal.get("Benchmark", [])],
        "records": [{"pk": pk, "modelId": a["modelId"], "runsScored": a["runsScored"],
                     "totalCorrect": a["totalCorrect"], "totalItems": a["totalItems"]}
                    for pk, a in seal.get("ModelRecord", [])],
    }


def forged_report_checks(md):
    """sealed-report/v1 forgery replay — the markdown exhibits carry
    `forgedMd`, not a JSON card. Same named checks as the TypeScript
    reportVerify: record PDA ([modelrec, sha256(model)] == printed PDA ==
    the bound card's recordPk), card digest binding (canonical claim-card
    sha256 == printed), bound card replay (the claim card itself must
    verify). A report naming a model with no committed claim mirrors the
    TS throw — no ModelRecord to mint from."""
    died = set()
    model_m = re.search(r"^# Capability report — (.+)$", md, re.M)
    want = re.search(r"claim-card content sha256 `([0-9a-f]{64})`", md)
    record = re.search(r"record PDA `([1-9A-HJ-NP-Za-km-z]{32,44})`", md)
    if not (model_m and want and record):
        died.add("(thrown)")  # malformed report — the route throws
        return died
    model = model_m.group(1).strip()
    claim = ROOT / "docs" / "evidence" / "claims" / f"{model}.json"
    card = None
    try:
        card = json.loads(claim.read_text()) if claim.exists() else None
    except Exception:
        card = None
    if card is None:
        died.add("(thrown)")
        return died
    spid = card["programs"]["sealed"]
    rec_pda = b58encode(pda([b"modelrec", hashlib.sha256(model.encode()).digest()],
                            spid) or b"")
    if not (rec_pda == record.group(1) and rec_pda == card["model"]["recordPk"]):
        died.add("record PDA")
    c = dict(card)
    c.pop("generatedAt", None)
    c.pop("source", None)
    canon = json.dumps(c, sort_keys=True, separators=(",", ":")).encode()
    if hashlib.sha256(canon).hexdigest() != want.group(1):
        died.add("card digest binding")
    if forged_card_checks(card):
        died.add("bound card replay")
    return died


def forged_card_rejected(f):
    """sealed-tamper/v1 helper: True if the inner forged card FAILS at least
    one real check under this implementation — the exhibit's whole claim."""
    return bool(forged_card_checks(f))


def forged_card_checks(f):
    """Return the set of check names the forged card FAILS — the SAME names
    the TypeScript check()/note() rows print, so a committed exhibit's
    expectFail list can be required to be a subset of this set. An empty
    set means Python's replay would have printed VERIFIED for the lie."""
    kind = f.get("kind")
    died = set()
    idx = snap_idx()
    try:
        if kind == "sealed-board/v1":
            models = f.get("models", [])
            spid = f.get("programs", {}).get("sealed")
            if not all(hashlib.sha256(m["modelId"].encode()).hexdigest() == m["record"]["modelHash"]
                       and b58encode_check(pda([b"modelrec", hashlib.sha256(m["modelId"].encode()).digest()],
                                              spid) or b"", m["recordPk"])
                       for m in models):
                died.add("record identity")
            if not all(b58encode_check(pda([b"scorelog", b58decode(l["run"])], spid) or b"", l["pk"])
                       and l["modelRecord"] == m["recordPk"]
                       for m in models for l in m["receipts"]):
                died.add("receipt identity")
            # snapshot binding — receipt fields vs decoded ScoreLog + Run
            for m in models:
                for l in m["receipts"]:
                    sl, dr = idx["logs"].get(l["pk"]), idx["runs"].get(l["run"])
                    if (sl is None or dr is None or sl["run"] != l["run"]
                            or sl["benchmark"] != l["benchmark"]
                            or sl["modelRecord"] != m["recordPk"]
                            or sl["correct"] != l["correct"] or sl["items"] != l["items"]
                            or sl["vouched"] != l["vouched"] or sl["postReveal"] != l["postReveal"]
                            or sl["recordedAt"] != l["recordedAt"] or dr["correct"] != l["correct"]):
                        died.add("snapshot binding")
            # completeness — card's model set must equal the snapshot's
            if {m["recordPk"] for m in models} != set(idx["recs"]):
                died.add("model-set completeness")
            for m in models:
                if set(idx["logsByRec"].get(m["recordPk"], {})) != {l["pk"] for l in m["receipts"]}:
                    died.add("receipt completeness")
                r = idx["recs"].get(m["recordPk"])
                rec = m["record"]
                if (r is None or r["runsScored"] != rec["runsScored"]
                        or r["totalCorrect"] != rec["totalCorrect"] or r["totalItems"] != rec["totalItems"]
                        or r["bestCorrect"] != rec["bestCorrect"] or r["bestItems"] != rec["bestItems"]
                        or r["bestRun"] != rec["bestRun"] or r["bestBank"] != rec["bestBank"]
                        or r["lastRun"] != rec["lastRun"] or r["firstSeen"] != rec["firstSeen"]
                        or r["lastScored"] != rec["lastScored"] or r["modelHash"] != rec["modelHash"]
                        or r["modelId"] != m["modelId"]):
                    died.add("record totals")
            # aggregates — record totals + ranking rows replay from receipts
            for m in models:
                c = sum(l["correct"] for l in m["receipts"])
                i = sum(l["items"] for l in m["receipts"])
                row = next((r for r in f["ranking"] if r["recordPk"] == m["recordPk"]), None)
                if (c != m["record"]["totalCorrect"] or i != m["record"]["totalItems"]
                        or len(m["receipts"]) != m["record"]["runsScored"] or row is None
                        or row["aggregate"]["correct"] != c or row["aggregate"]["items"] != i
                        or row["aggregate"]["runs"] != len(m["receipts"])):
                    died.add("aggregates")
            # pairwise — rebuild the shared-bank join + W-L-T tallies
            by_bank = {m["recordPk"]: {} for m in models}
            for m in models:
                for l in m["receipts"]:
                    e = by_bank[m["recordPk"]].setdefault(l["benchmark"], [0, 0])
                    e[0] += l["correct"]; e[1] += l["items"]
            stats = {m["recordPk"]: dict(wins=0, losses=0, ties=0, rankedPairs=0,
                                         sharedBanks=0, ppDelta=0.0) for m in models}
            rebuilt = []
            for i, A in enumerate(models):
                for B in models[i + 1:]:
                    a, b = by_bank[A["recordPk"]], by_bank[B["recordPk"]]
                    shared = [k for k in a if k in b]
                    if not shared:
                        continue
                    pa = sum(a[k][0] for k in shared) / max(1, sum(a[k][1] for k in shared))
                    pb = sum(b[k][0] for k in shared) / max(1, sum(b[k][1] for k in shared))
                    d = round4(100 * (pa - pb))
                    sa, sb = stats[A["recordPk"]], stats[B["recordPk"]]
                    sa["rankedPairs"] += 1; sb["rankedPairs"] += 1
                    sa["sharedBanks"] += len(shared); sb["sharedBanks"] += len(shared)
                    sa["ppDelta"] = round4(sa["ppDelta"] + d); sb["ppDelta"] = round4(sb["ppDelta"] - d)
                    v = "a" if pa > pb else "b" if pb > pa else "tie"
                    if v == "a": sa["wins"] += 1; sb["losses"] += 1
                    elif v == "b": sb["wins"] += 1; sa["losses"] += 1
                    else: sa["ties"] += 1; sb["ties"] += 1
                    flip = A["modelId"] > B["modelId"]
                    rebuilt.append({
                        "a": B["modelId"] if flip else A["modelId"],
                        "b": A["modelId"] if flip else B["modelId"],
                        "shared": len(shared), "deltaPp": -d if flip else d,
                        "verdict": ("b" if v == "a" else "a" if v == "b" else "tie") if flip else v})
            key = lambda x: (x["a"], x["b"])
            mine, theirs = sorted(rebuilt, key=key), sorted(f.get("pairs", []), key=key)
            if not (len(mine) == len(theirs) and all(
                    x["a"] == y["a"] and x["b"] == y["b"] and x["shared"] == y["shared"]
                    and x["verdict"] == y["verdict"] and x["deltaPp"] == y["deltaPp"]
                    for x, y in zip(mine, theirs))):
                died.add("pairwise verdicts")
            for m in models:
                st = stats[m["recordPk"]]
                p = next((r["pairwise"] for r in f["ranking"] if r["recordPk"] == m["recordPk"]), None)
                if (p is None or st["wins"] != p["wins"] or st["losses"] != p["losses"]
                        or st["ties"] != p["ties"] or st["rankedPairs"] != p["rankedPairs"]
                        or st["sharedBanks"] != p["sharedBanks"]
                        or abs(st["ppDelta"] - p["ppDelta"]) > 0.001):
                    died.add("pairwise tallies")
            order = sorted(((m["recordPk"], stats[m["recordPk"]]) for m in models),
                           key=lambda t: (-wilson_lcb(t[1]["wins"] + t[1]["ties"] / 2,
                                                      t[1]["rankedPairs"]),
                                          -t[1]["wins"], -t[1]["ppDelta"]))
            for i, r in enumerate(f.get("ranking", [])):
                pk, st = order[i] if i < len(order) else (None, None)
                lcb = round4(wilson_lcb(st["wins"] + st["ties"] / 2, st["rankedPairs"])) if st else -1
                if r["recordPk"] != pk or r["rank"] != i + 1 or abs(r["pairwise"]["lcb"] - lcb) > 0.001:
                    died.add("ranking")
        elif kind == "sealed-claim/v1":
            spid = f.get("programs", {}).get("sealed")
            mpid = f.get("programs", {}).get("market")
            if not b58encode_check(pda([b"modelrec", bytes.fromhex(f["record"]["seeds"]["modelHash"])],
                                       spid) or b"", f["record"]["pk"]):
                died.add("record PDA")
            # free check — the declared model id must hash to the declared
            # modelHash seed; seeds are self-declared so a consistent pair
            # can still rename the model.
            if hashlib.sha256((f["model"].get("id") or "").encode()).hexdigest() \
                    != f["record"]["seeds"]["modelHash"]:
                died.add("model identity")
            run_by = {r["pk"]: r for r in f["runs"]}
            if not all(b58encode_check(pda([b"run", b58decode(r["benchmark"]), u64le(r["index"])],
                                           spid) or b"", r["pk"]) for r in f["runs"]):
                died.add("run PDAs")
            if not all(b58encode_check(pda([b"benchmark", b58decode(b["authority"]),
                                            struct.pack("<I", int(b["id"]))], spid) or b"", b["pk"])
                       for b in f["banks"]):
                died.add("bank PDAs")
            if not all(l["run"] in run_by
                       and b58encode_check(pda([b"scorelog", b58decode(l["run"])], spid) or b"", l["pk"])
                       for l in f["receipts"]):
                died.add("receipt PDAs")
            vok = True
            for v in f["venues"]:
                seeds = ([b"market", b58decode(v["run"]), u64le(v["salt"])] if v["kind"] == "band"
                         else [b"duel", b58decode(v["run"]), b58decode(v["runB"]), u64le(v["salt"])] if v["kind"] == "duel"
                         else [b"dark", b58decode(v["run"]), u64le(v["salt"])] if v["kind"] == "dark"
                         else [b"ladder", b58decode(v["legs"][0]), u64le(v["salt"])] if v["kind"] == "ladder"
                         else [b"bounty", b58decode(v["bank"]), b58decode(v["sponsor"]), u64le(v["salt"])])
                if not b58encode_check(pda(seeds, mpid) or b"", v["pk"]):
                    vok = False
            if not vok:
                died.add("venue PDAs")
            tot_c = sum(l["correct"] for l in f["receipts"])
            tot_i = sum(l["items"] for l in f["receipts"])
            if tot_c != f["model"]["totalCorrect"] or tot_i != f["model"]["totalItems"]:
                died.add("record aggregate")
            if len(f["receipts"]) != f["model"]["runsScored"]:
                died.add("runsScored=receipts")
            for l in f["receipts"]:
                r = run_by.get(l["run"])
                if r and r["status"] == 1 and r["correct"] != l["correct"]:
                    died.add("receipt=run score")
            # snapshot binding — receipt fields + named record's modelId
            for l in f["receipts"]:
                sl = idx["logs"].get(l["pk"])
                if (sl is None or sl["run"] != l["run"] or sl["benchmark"] != l["benchmark"]
                        or sl["correct"] != l["correct"] or sl["items"] != l["items"]
                        or sl["modelRecord"] != f["record"]["pk"]
                        or bool(sl["vouched"]) != bool(l["vouched"])
                        or bool(sl["postReveal"]) != bool(l["postReveal"])):
                    died.add("snapshot binding")
            rec_dec = idx["recs"].get(f["record"]["pk"])
            if not rec_dec or rec_dec["modelId"] != f["model"]["id"]:
                died.add("snapshot binding")
            # completeness + record totals
            if set(idx["logsByRec"].get(f["record"]["pk"], {})) != {l["pk"] for l in f["receipts"]}:
                died.add("receipt completeness")
            if (rec_dec is None or rec_dec["runsScored"] != f["model"]["runsScored"]
                    or rec_dec["totalCorrect"] != f["model"]["totalCorrect"]
                    or rec_dec["totalItems"] != f["model"]["totalItems"]):
                died.add("record totals")
            # run account binding — every embedded run must exist in the
            # snapshot and match decoded Run fields; role=="subject" iff the
            # decoded run's modelId is the card's model (role lies counted).
            r_bad = r_miss = role_bad = 0
            for r in f["runs"]:
                real = idx["runs"].get(r["pk"])
                if real is None:
                    r_miss += 1
                    continue
                if (real["benchmark"] != r.get("benchmark")
                        or real["index"] != r.get("index")
                        or real["status"] != r.get("status")
                        or real["correct"] != r.get("correct")
                        or real["chunkCount"] != r.get("chunkCount")
                        or bool(real["postReveal"]) != bool(r.get("postReveal"))
                        or bool(real["attested"]) != bool(r.get("attested"))):
                    r_bad += 1
                if (r.get("role") == "subject") != (real["modelId"] == f["model"].get("id")):
                    role_bad += 1
            if r_bad or r_miss or role_bad:
                died.add("run account binding")
            # run completeness — every subject run plus every co-participant
            # leg the true venue set needs must be embedded.
            _subj, true_venue, want_runs = claim_true_venues(f["model"].get("id"))
            got_runs = {r["pk"] for r in f["runs"]}
            if [p for p in want_runs if p not in got_runs]:
                died.add("run completeness")
            # venue account binding + completeness — every declared venue
            # must equal its decoded account fields, and the declared pk
            # set must EQUAL the re-derived set.
            v_bad = v_miss = 0
            for v in f["venues"]:
                a = venue_acct(v, idx)
                if a is None:
                    v_miss += 1
                elif not venue_field_match(v, a):
                    v_bad += 1
            if v_bad or v_miss:
                died.add("venue account binding")
            got_ven = {v["pk"] for v in f["venues"]}
            if [p for p in true_venue if p not in got_ven] \
                    or len(got_ven) != len(true_venue):
                died.add("venue completeness")
            # venue resolutions replayed from embedded runs
            for v in f["venues"]:
                if v["status"] != 1:
                    continue
                if v["kind"] == "duel":
                    a, b = run_by.get(v["run"]), run_by.get(v["runB"])
                    if not a or not b or a["status"] != 1 or b["status"] != 1:
                        continue
                    if not (v["resolvedScore"] == (a["correct"] << 16 | b["correct"])
                            and v["outcome"] == (0 if a["correct"] > b["correct"]
                                                 else 1 if a["correct"] < b["correct"] else 2)):
                        died.add("venue resolutions")
                elif v["kind"] == "ladder":
                    legs = [run_by.get(p) for p in v["legs"]]
                    if any(r is None or r["status"] != 1 for r in legs):
                        continue
                    best = max(r["correct"] for r in legs)
                    mask = sum((1 << i) for i, r in enumerate(legs) if r["correct"] == best)
                    if not (v["resolvedScore"] == best and v["resultMask"] == mask):
                        died.add("venue resolutions")
                elif v["kind"] == "bounty":
                    w = run_by.get(v.get("winnerRun"))
                    if w and w["status"] == 1 and not (w["correct"] == v["winningScore"]
                                                     and w["correct"] >= v["threshold"]):
                        died.add("venue resolutions")
                else:
                    r = run_by.get(v["run"])
                    if r and r["status"] == 1 and v["resolvedScore"] != r["correct"]:
                        died.add("venue resolutions")
        elif kind == "sealed-match/v1":
            spid = f.get("programs", {}).get("sealed")
            for sd in ("a", "b"):
                if not b58encode_check(pda([b"modelrec", bytes.fromhex(f[sd]["seeds"]["modelHash"])],
                                           spid) or b"", f[sd]["recordPk"]):
                    died.add(f"record PDA {sd}")
            if not all(b58encode_check(pda([b"benchmark", b58decode(b["authority"]),
                                            struct.pack("<I", int(b["id"]))], spid) or b"", b["pk"])
                       for b in f["banks"]):
                died.add("bank PDAs")
            if not all(b58encode_check(pda([b"run", b58decode(r["benchmark"]), u64le(r["index"])],
                                           spid) or b"", r["pk"]) for r in f["runs"]):
                died.add("run PDAs")
            all_rec = f["receipts"]["a"] + f["receipts"]["b"]
            if not all(b58encode_check(pda([b"scorelog", b58decode(l["run"])], spid) or b"", l["pk"])
                       for l in all_rec):
                died.add("receipt PDAs")
            # the declared names must hash to the declared seeds — a card
            # can carry a consistent (modelHash, recordPk) pair while
            # renaming the model.
            if not all(hashlib.sha256((f[sd].get("id") or "").encode()).hexdigest()
                       == f[sd]["seeds"]["modelHash"] for sd in ("a", "b")):
                died.add("model identity")
            # a receipt's bank must equal the bank of the run it cites —
            # the run's benchmark is PDA-bound, so a receipt moved to an
            # unlisted bank drops out of the pooled aggregates and
            # launders the verdict.
            run_bank = {r["pk"]: r["benchmark"] for r in f["runs"]}
            if any(run_bank.get(l["run"]) != l["benchmark"] for l in all_rec):
                died.add("receipt-bank binding")
            # snapshot binding — receipt fields + each side's modelId
            for sd in ("a", "b"):
                for l in f["receipts"][sd]:
                    sl = idx["logs"].get(l["pk"])
                    if (sl is None or sl["run"] != l["run"] or sl["benchmark"] != l["benchmark"]
                            or sl["correct"] != l["correct"] or sl["items"] != l["items"]
                            or sl["modelRecord"] != f[sd]["recordPk"]
                            or bool(sl["vouched"]) != bool(l["vouchedAtRecord"])
                            or bool(sl["postReveal"]) != bool(l["postReveal"])):
                        died.add("snapshot binding")
                rec_dec = idx["recs"].get(f[sd]["recordPk"])
                if not rec_dec or rec_dec["modelId"] != f[sd]["id"]:
                    died.add("snapshot binding")
            # completeness — declared shared banks must equal the snapshot's
            banks_of = lambda pk: {l["benchmark"] for l in idx["logsByRec"].get(pk, {}).values()}
            true_shared = banks_of(f["a"]["recordPk"]) & banks_of(f["b"]["recordPk"])
            if true_shared != {b["pk"] for b in f["banks"]}:
                died.add("shared-bank completeness")
            for sd in ("a", "b"):
                want = {p for p, l in idx["logsByRec"].get(f[sd]["recordPk"], {}).items()
                        if l["benchmark"] in true_shared}
                if want != {r["pk"] for r in f["receipts"][sd]}:
                    died.add("receipt completeness")
            # verdict replay — shared banks, pooled aggregates, wins, winner
            bank_pks = {b["pk"] for b in f["banks"]}
            agg = {}
            for sd in ("a", "b"):
                m = {}
                for l in f["receipts"][sd]:
                    if l["benchmark"] not in bank_pks:
                        continue
                    e = m.setdefault(l["benchmark"], [0, 0])
                    e[0] += l["correct"]; e[1] += l["items"]
                agg[sd] = m
            shared = [k for k in agg["a"] if k in agg["b"]]
            v = f.get("verdict", {})
            if len(shared) != v.get("sharedBanks"):
                died.add("shared banks")
            pa_c = sum(e[0] for e in agg["a"].values()); pa_i = sum(e[1] for e in agg["a"].values())
            pb_c = sum(e[0] for e in agg["b"].values()); pb_i = sum(e[1] for e in agg["b"].values())
            if pa_c != v.get("pooledA") or pa_i != v.get("pooledItemsA") \
                    or pb_c != v.get("pooledB") or pb_i != v.get("pooledItemsB"):
                died.add("pooled aggregates")
            wins = {"a": 0, "tie": 0, "b": 0}
            for k in shared:
                pa = 100 * agg["a"][k][0] / agg["a"][k][1] if agg["a"][k][1] else 0
                pb = 100 * agg["b"][k][0] / agg["b"][k][1] if agg["b"][k][1] else 0
                wins["a" if pa > pb else "b" if pb > pa else "tie"] += 1
            if wins != v.get("bankWins"):
                died.add("bank wins")
            pctA = 100 * pa_c / pa_i if pa_i else 0
            pctB = 100 * pb_c / pb_i if pb_i else 0
            winner = "tie" if pctA == pctB else "a" if pctA > pctB else "b"
            if winner != v.get("winner") or abs(pctA - v.get("pctA", -1)) > 0.01 \
                    or abs(pctB - v.get("pctB", -1)) > 0.01:
                died.add("verdict replay")
        elif kind == "sealed-policy/v1":
            spid = f.get("programs", {}).get("sealed")
            pol = f.get("policy", {})
            if not all(b58encode_check(pda([b"modelrec", bytes.fromhex(m["seeds"]["modelHash"])],
                                           spid) or b"", m["recordPk"])
                       for m in f.get("models", [])):
                died.add("record PDAs")
            # the cert's only payload is the name→verdict mapping — the
            # declared name must hash to the declared seed (free, offline).
            if not all(isinstance(m.get("modelId"), str)
                       and hashlib.sha256(m["modelId"].encode()).hexdigest()
                           == m["seeds"]["modelHash"]
                       for m in f.get("models", [])):
                died.add("model identity")
            for m in f.get("models", []):
                v = eval_gate(m["receipts"], pol)
                w = m["verdict"]
                if (bool(w["pass"]) != v["pass"] or w.get("reason") != v["reason"]
                        or abs(w.get("pct", -1) - v["pct"]) > 0.01
                        or w.get("runs") != v["runs"] or w.get("items") != v["items"]
                        or w.get("correct") != v["correct"]
                        or w.get("postRevealRuns") != v["postRevealRuns"]):
                    died.add("verdict replay")
            st = f.get("summary", {})
            if (st.get("pass") is not None
                    and (st.get("pass") != sum(1 for m in f["models"] if m["verdict"]["pass"])
                         or st.get("fail") != sum(1 for m in f["models"]
                                                  if m["verdict"].get("reason") == "policy")
                         or st.get("noEvidence") != sum(1 for m in f["models"]
                                                        if m["verdict"].get("reason") == "no-evidence"))):
                died.add("summary consistent")
            # receipt binding — per-record multiset vs decoded ScoreLogs
            bank_arg = pol.get("bank")
            bank_pks = None
            if bank_arg:
                bank_pks = set()
                for a in SNAP["sealed"]:
                    d = base64.b64decode(a["data"])
                    if d[:8] == disc("Benchmark") and (a["pubkey"] == bank_arg
                                                     or decode_benchmark(d)["name"] == bank_arg):
                        bank_pks.add(a["pubkey"])
            for m in f.get("models", []):
                want = sorted((l["correct"], l["items"], bool(l["vouched"]), bool(l["postReveal"]))
                              for p, l in idx["logsByRec"].get(m["recordPk"], {}).items()
                              if bank_pks is None or l["benchmark"] in bank_pks)
                got = sorted((r["correct"], r["items"], bool(r.get("vouchedAtRecord")),
                              bool(r.get("postReveal"))) for r in m["receipts"])
                if want != got:
                    died.add("receipt binding")
            if {m["recordPk"] for m in f.get("models", [])} != set(idx["recs"]):
                died.add("record-set completeness")
            # account-level name binding — the declared modelId must equal
            # the decoded ModelRecord's model_id for every listed record
            # present in the snapshot.
            if any(m["recordPk"] in idx["recs"]
                   and idx["recs"][m["recordPk"]]["modelId"] != m.get("modelId")
                   for m in f.get("models", [])):
                died.add("account modelId")
        elif kind == "sealed-ceiling/v1":
            spid = f.get("programs", {}).get("sealed")
            if not b58encode_check(pda([b"modelrec", bytes.fromhex(f["record"]["seeds"]["modelHash"])],
                                       spid) or b"", f["record"]["pk"]):
                died.add("record PDA")
            if not all(b58encode_check(pda([b"run", b58decode(r["benchmark"]), u64le(r["index"])],
                                           spid) or b"", r["pk"]) for r in f.get("runs", [])):
                died.add("run PDAs")
            scoped = [r for r in f.get("runs", []) if r["status"] == 1]
            pct = lambda r: (r["correct"] * 10000 // (r["chunkCount"] * 32)) if r["chunkCount"] else 0
            if scoped:
                mx = max(pct(r) for r in scoped)
                argmax = [r for r in scoped if pct(r) == mx]
                if f["ceiling"]["maxPctBp"] != mx:
                    died.add("ceiling exact")
                br = f["ceiling"].get("bestRun")
                if not (br and any(r["pk"] == br["pk"] for r in argmax)
                        and br["correct"] == next((r["correct"] for r in f["runs"] if r["pk"] == br["pk"]), None)
                        and br["items"] == next((r["chunkCount"] * 32 for r in f["runs"]
                                                 if r["pk"] == br["pk"]), None)):
                    died.add("bestRun = argmax")
            elif f["ceiling"]["maxPctBp"] is not None or f["ceiling"].get("bestRun") is not None:
                died.add("ceiling exact")
            sc = f.get("scope", {})
            if not (sc.get("subjectRuns") == len(f["runs"])
                    and sc.get("finalizedRuns") == len(scoped)
                    and sc.get("unfinishedRuns") == len(f["runs"]) - len(scoped)
                    and sc.get("postRevealRuns") == sum(1 for r in scoped if r.get("postReveal"))):
                died.add("scope tallies")
            # snapshot binding is mandatory — the sha must pin THIS snapshot
            if f.get("snapshotSha256") != hashlib.sha256(snapshot_bytes()).hexdigest():
                died.add("snapshot binding")
            rec_dec = idx["recs"].get(f["record"]["pk"])
            if (not rec_dec or rec_dec["modelId"] != f["model"]["id"]
                    or f["model"].get("recordPk") != f["record"]["pk"]):
                died.add("record identity")
            subject = {p: r for p, r in idx["runs"].items() if r["modelId"] == f["model"]["id"]}
            listed = {r["pk"] for r in f.get("runs", [])}
            if listed != set(subject):
                died.add("run-set completeness")
            for r in f.get("runs", []):
                a = subject.get(r["pk"])
                if (a is None or a["benchmark"] != r["benchmark"] or a["index"] != r["index"]
                        or a["status"] != r["status"] or a["correct"] != r["correct"]
                        or a["chunkCount"] != r["chunkCount"]
                        or bool(a["postReveal"]) != bool(r["postReveal"])
                        or bool(a["attested"]) != bool(r.get("attested", 0))):
                    died.add("run field binding")
        elif kind == "sealed-circuit/v1":
            ARCIUM = "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
            CIRCUITS = {"seal_part", "score_chunk", "gen_part",
                        "gen_part_private", "reveal_part", "reshare_part"}
            progs = f.get("programs", {})
            spid = progs.get("sealed")
            if not (progs.get("arcium") == ARCIUM and spid == SNAP["meta"]["programs"]["sealed"]):
                died.add("program identity")
            named = {c["name"] for c in f.get("circuits", [])}
            if named != CIRCUITS or len(f.get("circuits", [])) != 6:
                died.add("circuit-set completeness")
            cd_ok = 0
            for c in f.get("circuits", []):
                want = int.from_bytes(hashlib.sha256(c["name"].encode()).digest()[:4], "little")
                got = pda([b"ComputationDefinitionAccount", b58decode(spid),
                           struct.pack("<I", c["offset"])], ARCIUM)
                if c["offset"] == want and b58encode_check(got or b"", c["pda"]):
                    cd_ok += 1
            if cd_ok != 6:
                died.add("compdef PDAs")
            # content-level binding — chain.ts verifyCircuitCard 3b–3d.
            # Each check skips on old-format cards (no recorded fields).
            raw_ok, raw_ran = circuit_raw_pdas(f, ARCIUM)
            if raw_ran and not raw_ok:
                died.add("raw-circuit PDAs")
            if circuit_account_binding(f) is False:
                died.add("account binding")
            if circuit_cluster_committee(f) is False:
                died.add("cluster committee")
            if not b58encode_check(pda([b"MXEAccount", b58decode(spid)], ARCIUM) or b"",
                                   f.get("mxe", {}).get("pda", "")):
                died.add("MXE PDA")
            if not b58encode_check(pda([b"Cluster", struct.pack("<I", f.get("cluster", {}).get("offset", -1) & 0xFFFFFFFF)],
                                       ARCIUM) or b"", f.get("cluster", {}).get("pda", "")):
                died.add("cluster PDA")
            if not b58encode_check(pda([b"ArciumSignerAccount"], spid) or b"",
                                   f.get("signPda", "")):
                died.add("signPda PDA")
            for k, m in (f.get("fetched") or {}).get("accounts", {}).items():
                if not (m.get("exists") and (k == "signPda" or m.get("owner") == ARCIUM)
                        and int(m.get("dataLen", 0)) > 8):
                    died.add("fetched fields")
            if f.get("snapshotSha256") != hashlib.sha256(snapshot_bytes()).hexdigest():
                died.add("snapshot binding")
            sp_entry = next((e for e in SNAP["sealed"]
                             if base64.b64decode(e["data"])[:8].hex() == "d69d7a72752cd64a"), None)
            if not (sp_entry and sp_entry["pubkey"] == f.get("signPda")
                    and f.get("signPdaSnapshot") == f.get("signPda")):
                died.add("signPda binding")
        elif kind == "sealed-ledger/v1":
            SEALED_KINDS = {disc(n): n for n in
                            ("Benchmark", "Run", "AnswerChunk", "ItemChunk",
                             "PrivItemChunk", "Reveal", "ShareGrant",
                             "ModelRecord", "ScoreLog")}
            SEALED_KINDS[bytes.fromhex("d69d7a72752cd64a")] = "SignPdaAccount"
            MARKET_KINDS = {disc(n): n for n in
                            ("Market", "Ladder", "Position", "DarkMarket",
                             "DarkPosition", "Bounty")}

            def census(entries, kind_map):
                kinds, pks, unknown = {}, [], 0
                for e in entries:
                    pks.append(e["pubkey"])
                    d = base64.b64decode(e["data"])
                    kind = kind_map.get(d[:8]) if len(d) >= 8 else None
                    if kind:
                        kinds[kind] = kinds.get(kind, 0) + 1
                    else:
                        unknown += 1
                if unknown:
                    kinds["unknown"] = unknown
                return {"accounts": len(entries),
                        "pubkeySetSha256": sha256("\n".join(sorted(pks)).encode()).hex(),
                        "kinds": kinds}

            progs = f.get("programs", {})
            if not (progs.get("sealed") == SNAP["meta"]["programs"]["sealed"]
                    and progs.get("market") == SNAP["meta"]["programs"]["market"]):
                died.add("program identity")
            sha_ok = f.get("snapshotSha256") == hashlib.sha256(snapshot_bytes()).hexdigest()
            if not sha_ok:
                died.add("snapshot binding")
            if f.get("takenAt") != SNAP["meta"].get("takenAt"):
                died.add("dump timestamp")
            for section, km in (("sealed", SEALED_KINDS), ("market", MARKET_KINDS)):
                want = census(SNAP.get(section, []), km)
                got = f.get("census", {}).get(section, {})
                allk = set(want["kinds"]) | set(got.get("kinds", {}))
                if not (sha_ok and got.get("accounts") == want["accounts"]
                        and got.get("pubkeySetSha256") == want["pubkeySetSha256"]
                        and all(got.get("kinds", {}).get(k, 0) == want["kinds"][k] for k in allk)):
                    died.add(f"{section} census")
        elif kind == "sealed-trail/v1":
            spid = f.get("programs", {}).get("sealed")
            mpid = f.get("programs", {}).get("market")
            r = f["run"]
            if not b58encode_check(pda([b"run", b58decode(r["benchmark"]), u64le(r["index"])],
                                       spid) or b"", r["pk"]):
                died.add("run PDA")
            dr = idx["runs"].get(r["pk"])
            if (dr is None or dr["correct"] != r["correct"] or dr["status"] != r["status"]
                    or dr["runner"] != r["runner"] or dr["modelId"] != r["modelId"]
                    or dr["benchmark"] != r["benchmark"]
                    or bool(dr["postReveal"]) != bool(r["postReveal"])):
                died.add("run binding")
            msec = SNAP["market"]
            vtype = {"band": "Market", "duel": "Market", "dark": "DarkMarket",
                     "ladder": "Ladder", "bounty": "Bounty"}
            for v in f.get("venues", []):
                raw = find_account(msec, v["pk"], disc(vtype[v["kind"]]))
                if raw is None:
                    died.add("venue binding")
                    continue
                if v["kind"] in ("band", "duel"):
                    a = decode_market(raw)
                    if (a["totals"] != [int(x) for x in v.get("totals", [])] or a["status"] != v["status"]
                            or (v["status"] == 1 and a["resolvedScore"] != v.get("resolvedScore"))
                            or (v.get("outcome") is not None and v["status"] == 1
                                and a["outcome"] != v["outcome"])):
                        died.add("venue binding")
                elif v["kind"] == "dark":
                    a = decode_dark_market(raw)
                    if (a["poolTotal"] != int(v["poolTotal"]) or a["winTotal"] != int(v["winTotal"])
                            or a["tallied"] != bool(v["tallied"])
                            or (v["status"] == 1 and a["resolvedScore"] != v.get("resolvedScore"))):
                        died.add("venue binding")
                elif v["kind"] == "ladder":
                    a = decode_ladder(raw)
                    if (a["totals"] != [int(x) for x in v.get("totals", [])] or a["status"] != v["status"]
                            or (v["status"] == 1 and a["resultMask"] != v.get("resultMask"))):
                        died.add("venue binding")
                else:
                    a = decode_bounty(raw)
                    if (a["amount"] != int(v["amount"]) or a["status"] != v["status"]
                            or (v["status"] == 1 and (a["winningScore"] != v.get("winningScore")
                                                    or a["winnerRun"] != v.get("winnerRun")))):
                        died.add("venue binding")
            resolved = [v for v in f.get("venues", []) if v["status"] == 1]
            s_ok = 0
            for v in resolved:
                got = (v["resolvedScore"] if v["kind"] in ("band", "dark")
                       else (v["resolvedScore"] >> 16 if v.get("side") == "a"
                             else v["resolvedScore"] & 0xffff) if v["kind"] == "duel"
                       else v["winningScore"] if v["kind"] == "bounty"
                       else v["legs"][v["legIndex"]]["correct"])
                if got == r["correct"]:
                    s_ok += 1
            if s_ok != len(resolved):
                died.add("settlements from Run.correct")
            pools = sum(sum(v["totals"]) if v.get("totals") is not None else int(v.get("poolTotal") or 0)
                        for v in f.get("venues", []))
            if pools != int(f["verdict"]["poolsLamports"]):
                died.add("pool accounting")
            vd = f.get("verdict", {})
            if (vd.get("venuesTotal") != len(f.get("venues", []))
                    or vd.get("resolvedVenues") != len(resolved)
                    or vd.get("scoreMismatches") != len(resolved) - s_ok):
                died.add("verdict summary")
        elif kind == "sealed-bounty/v1":
            msec = SNAP["market"]
            b = f["bounty"]
            if not b58encode_check(pda([b"bounty", b58decode(b["seeds"]["bank"]),
                                        b58decode(b["seeds"]["sponsor"]),
                                        u64le(b["seeds"]["salt"])],
                                       f["programs"]["market"]) or b"", b["pk"]):
                died.add("bounty PDA")
            raw = find_account(msec, b["pk"], DISC["bounty"])
            d = decode_bounty(raw) if raw else None
            if d is None:
                died.add("account binding")
            else:
                if (d["threshold"] != b["threshold"] or str(d["amount"]) != str(b["amount"])
                        or d["status"] != b["status"]
                        or (d["status"] == 1 and (d["winnerRun"] != b.get("winnerRun")
                                                or d["winningScore"] != b.get("winningScore")))):
                    died.add("account binding")
            if b["status"] == 1:
                w = f.get("winner")
                if w is None:
                    died.add("bounty_qualifies replay")
                else:
                    if not (w["run"] == b.get("winnerRun")
                            and w["benchmark"] == b["seeds"]["bank"]
                            and int(w["createdAt"]) >= int(b["createdAt"])
                            and w["runner"] != b["seeds"]["sponsor"]
                            and w["correct"] >= b["threshold"]
                            and w["correct"] == b["winningScore"]
                            and not w.get("postReveal")):
                        died.add("bounty_qualifies replay")
                    wrun = idx["runs"].get(w["run"])
                    if wrun is None or wrun["correct"] != w["correct"] or wrun["runner"] != w["runner"]:
                        died.add("winner binding")
            if f.get("bank") and b["threshold"] > f["bank"]["capacity"]:
                died.add("threshold ≤ capacity")
            if f.get("snapshotSha256") and \
                    f["snapshotSha256"] != hashlib.sha256(snapshot_bytes()).hexdigest():
                died.add("snapshot binding")
        elif kind == "sealed-grant/v1":
            gs = f["grant"]["seeds"]
            derived = pda([b"grant", b58decode(gs["bank"]),
                           struct.pack("<H", int(gs["chunkIndex"])),
                           bytes([int(gs["part"])]), b58decode(gs["viewer"])],
                          f["programs"]["sealed"])
            if derived is None or derived != b58decode(f["grant"]["pk"]):
                died.add("grant PDA")
            raw = find_account(SNAP["sealed"], f["grant"]["pk"], DISC["shareGrant"])
            d = decode_share_grant(raw) if raw else None
            if d is None or d["viewer"] != f["grant"]["viewer"]:
                died.add("account binding")
            if f["grant"]["seeds"]["bank"] != f["grant"].get("benchmark"):
                died.add("account binding")
            gbank = f.get("bank")
            if (gbank is None or f["grant"].get("benchmark") != gbank.get("pk")
                    or int(gbank.get("kind", -1)) != 2):
                died.add("bank semantics")
            # the bank block is card-say-so until it's bound — the decoded
            # Benchmark at the grant's benchmark must match (name · kind ·
            # items_root), or a forged card could redescribe the exam.
            braw = find_account(SNAP["sealed"], f["grant"].get("benchmark"),
                                disc("Benchmark"))
            bdec = decode_benchmark(braw) if braw else None
            if (gbank is None or bdec is None
                    or str(bdec["name"]) != str(gbank.get("name"))
                    or str(bdec["kind"]) != str(gbank.get("kind"))
                    or bdec["itemsRoot"] != gbank.get("itemsRoot")):
                died.add("bank account binding")
            if f["grant"].get("encryptionKey") != f["grant"]["viewer"]:
                died.add("key echo")
        elif kind == "sealed-bank/v1":
            # the exam dossier — mirror of the honest replay block: bank
            # PDA, chunk-set PDAs + completeness + field binding, bank
            # fields vs decoded Benchmark, run / reveal / grant / receipt
            # surfaces, and the snapshot pin.
            spid = f.get("programs", {}).get("sealed")
            bank = f.get("bank") or {}
            bpk = bank.get("pk", "")
            if not b58encode_check(
                    pda([b"benchmark", b58decode(bank.get("authority") or NULL_PK),
                         struct.pack("<I", int(bank.get("id") or 0))], spid) or b"", bpk):
                died.add("bank PDA")
            chunks_pub = list((f.get("chunks") or {}).get("public") or [])
            chunks_priv = list((f.get("chunks") or {}).get("private") or [])
            real_i, real_p = {}, {}
            for a in SNAP["sealed"]:
                d = base64.b64decode(a["data"])
                if d[:8] == disc("ItemChunk") and b58encode(d[8:40]) == bpk:
                    real_i[a["pubkey"]] = decode_item_chunk(d)
                elif d[:8] == disc("PrivItemChunk") and b58encode(d[8:40]) == bpk:
                    real_p[a["pubkey"]] = decode_priv_item_chunk(d)
            c_bad = 0
            for c in chunks_pub:
                if not b58encode_check(
                        pda([b"items", b58decode(bpk), struct.pack("<H", c["index"])],
                            spid) or b"", c["pk"]):
                    c_bad += 1
            for c in chunks_priv:
                if not b58encode_check(
                        pda([b"pitems", b58decode(bpk), struct.pack("<H", c["index"])],
                            spid) or b"", c["pk"]):
                    c_bad += 1
            card_set = [c["pk"] for c in chunks_pub + chunks_priv]
            if len(set(card_set)) != len(card_set) \
                    or set(card_set) != set(real_i) | set(real_p):
                c_bad += 1
            bound = 0
            for c in chunks_pub:
                st = real_i.get(c["pk"])
                if st and st["index"] == c["index"] and st["partsWritten"] == c["partsWritten"] \
                        and st["mintOrder"] == c["mintOrder"]:
                    bound += 1
            for c in chunks_priv:
                st = real_p.get(c["pk"])
                if st and st["index"] == c["index"] and st["partsWritten"] == c["partsWritten"] \
                        and st["mintOrder"] == c["mintOrder"]:
                    bound += 1
            if c_bad or bound != len(chunks_pub) + len(chunks_priv):
                died.add("chunk set")
            braw = find_account(SNAP["sealed"], bpk, disc("Benchmark"))
            real = decode_benchmark(braw) if braw else None
            if not (real and real["authority"] == bank.get("authority")
                    and str(real["id"]) == str(bank.get("id"))
                    and real["name"] == bank.get("name")
                    and str(real["kind"]) == str(bank.get("kind"))
                    and str(real["chunkCount"]) == str(bank.get("chunkCount"))
                    and str(real["chunksSealed"]) == str(bank.get("chunksSealed"))
                    and real["itemsRoot"] == bank.get("itemsRoot")
                    and str(real["feeLamports"]) == str(bank.get("feeLamports"))
                    and str(real["runCount"]) == str(bank.get("runCount"))
                    and str(real["revealCount"]) == str(bank.get("revealCount"))
                    and str(real["createdAt"]) == str(bank.get("createdAt"))
                    and str(real["status"]) == str(bank.get("status"))):
                died.add("bank fields")
            # [5] run surface — PDAs re-derive + exact snapshot set + fields
            real_runs = {}
            for a in SNAP["sealed"]:
                d = base64.b64decode(a["data"])
                if d[:8] == disc("Run") and b58encode(d[8:40]) == bpk:
                    real_runs[a["pubkey"]] = decode_run(d)
            r_bad = 0 if len(real_runs) == len(f.get("runs", [])) else 1
            for r in f.get("runs", []):
                if not b58encode_check(
                        pda([b"run", b58decode(bpk), u64le(r["index"])],
                            spid) or b"", r["pk"]):
                    r_bad += 1
                    continue
                rr = real_runs.get(r["pk"])
                if not (rr and rr["index"] == r["index"] and rr["modelId"] == r["modelId"]
                        and rr["status"] == r["status"] and rr["correct"] == r["correct"]
                        and rr["postReveal"] == r["postReveal"]):
                    r_bad += 1
            if r_bad:
                died.add("run surface")
            # [6] disclosure surface — PDAs + no duplicate pks + exact
            # pk-set equality + field binding vs decoded Reveal/ShareGrant.
            real_rv, real_gr = {}, {}
            for a in SNAP["sealed"]:
                d = base64.b64decode(a["data"])
                if d[:8] == disc("Reveal") and b58encode(d[8:40]) == bpk:
                    real_rv[a["pubkey"]] = decode_reveal(d)
                elif d[:8] == disc("ShareGrant") and b58encode(d[8:40]) == bpk:
                    real_gr[a["pubkey"]] = decode_share_grant(d)
            d_bad = 0
            for r in f.get("reveals", []):
                if not b58encode_check(
                        pda([b"reveal", b58decode(bpk), struct.pack("<H", r["chunkIndex"]),
                             bytes([r["part"]])], spid) or b"", r["pk"]):
                    d_bad += 1
            for g in f.get("grants", []):
                if not b58encode_check(
                        pda([b"grant", b58decode(bpk), struct.pack("<H", g["chunkIndex"]),
                             bytes([g["part"]]), b58decode(g["viewer"])], spid) or b"", g["pk"]):
                    d_bad += 1
            if len({r["pk"] for r in f.get("reveals", [])}) != len(f.get("reveals", [])) \
                    or len({g["pk"] for g in f.get("grants", [])}) != len(f.get("grants", [])):
                d_bad += 1
            if not (len(real_rv) == len(f.get("reveals", []))
                    and all(r["pk"] in real_rv for r in f.get("reveals", []))):
                d_bad += 1
            if not (len(real_gr) == len(f.get("grants", []))
                    and all(g["pk"] in real_gr for g in f.get("grants", []))):
                d_bad += 1
            for r in f.get("reveals", []):
                a = real_rv.get(r["pk"])
                if (a is None or a["chunk"] != r.get("chunkIndex") or a["part"] != r.get("part")
                        or a["revealedAt"] != r.get("revealedAt")):
                    d_bad += 1
            for g in f.get("grants", []):
                a = real_gr.get(g["pk"])
                if (a is None or a["chunkIndex"] != g.get("chunkIndex") or a["part"] != g.get("part")
                        or a["viewer"] != g.get("viewer") or a["sharedAt"] != g.get("sharedAt")):
                    d_bad += 1
            if d_bad:
                died.add("disclosure surface")
            # [7] receipt surface — every ScoreLog on this bank, field-bound
            real_logs = {}
            for a in SNAP["sealed"]:
                d = base64.b64decode(a["data"])
                if d[:8] == disc("ScoreLog") and b58encode(d[72:104]) == bpk:
                    real_logs[a["pubkey"]] = decode_scorelog(d)
            l_bad = 0 if len(real_logs) == len(f.get("receipts", [])) else 1
            for l in f.get("receipts", []):
                r = real_logs.get(l["pk"])
                if not (r and r["run"] == l["run"] and r["modelRecord"] == l["modelRecord"]
                        and r["correct"] == l["correct"] and r["items"] == l["items"]
                        and r["vouched"] == l["vouched"] and r["postReveal"] == l["postReveal"]
                        and r["recordedAt"] == l["recordedAt"]):
                    l_bad += 1
            if l_bad:
                died.add("receipt surface")
            # [8] snapshot binding
            if f.get("snapshot") != hashlib.sha256(snapshot_bytes()).hexdigest():
                died.add("snapshot binding")
        elif kind == "sealed-position/v1":
            msec = SNAP["market"]
            acct = f["position"]["account"]
            raw = find_account(msec, f["position"]["pk"],
                               DISC["darkPosition"] if acct == "dark" else DISC["position"])
            if raw is None:
                died.add("position account binding")
            else:
                if acct == "dark":
                    d = decode_dark_position(raw)
                    if str(d["amount"]) != str(f["stake"]["amount"]):
                        died.add("stake binding")
                else:
                    d = decode_position(raw)
                    if d["amounts"] != [int(x) for x in f["stake"]["amounts"]]:
                        died.add("stake binding")
            # venue field binding — a card-declared null is honest only when
            # the account field is absent too (parity with the honest path).
            vv = f.get("venue", {})
            vvdisc = {"band": "Market", "duel": "Market", "dark": "DarkMarket",
                      "ladder": "Ladder"}.get(vv.get("kind"))
            vvraw = find_account(msec, vv.get("pk", ""), disc(vvdisc)) if vvdisc else None
            if vvraw is None:
                died.add("venue binding")
            else:
                vv_ints = lambda xs: None if xs is None else [int(x) for x in xs]
                vv_big = lambda x: None if x is None else int(x)
                if vv["kind"] in ("band", "duel"):
                    a = decode_market(vvraw)
                    if not (a["status"] == vv["status"] and a["feeBps"] == vv["feeBps"]
                            and a["outcome"] == vv["outcome"]
                            and vv_ints(vv["totals"]) == a["totals"]
                            and vv.get("mask") is None and vv.get("tallied") is None
                            and vv.get("poolTotal") is None and vv.get("winTotal") is None):
                        died.add("venue binding")
                elif vv["kind"] == "dark":
                    a = decode_dark_market(vvraw)
                    if not (a["status"] == vv["status"] and a["feeBps"] == vv["feeBps"]
                            and a["outcome"] == vv["outcome"]
                            and vv_big(vv["poolTotal"]) == a["poolTotal"]
                            and vv_big(vv["winTotal"]) == a["winTotal"]
                            and vv.get("tallied") == bool(a["tallied"])
                            and vv.get("totals") is None and vv.get("mask") is None):
                        died.add("venue binding")
                else:
                    a = decode_ladder(vvraw)
                    if not (a["status"] == vv["status"] and a["feeBps"] == vv["feeBps"]
                            and a["resultMask"] == vv.get("mask")
                            and vv_ints(vv["totals"]) == a["totals"]
                            and vv.get("outcome") is None):
                        died.add("venue binding")
                # verdict replay — staked = winning-bucket amount; estPayout =
                # pro-rata pool share (fee-free cards only — the committed ones).
                v = f.get("verdict", {})
                venue = f.get("venue", {})
                if acct != "dark" and venue.get("status") == 1 and venue.get("totals"):
                    outc = venue["outcome"]
                    staked = int(f["stake"]["amounts"][outc])
                    pool = sum(int(x) for x in venue["totals"])
                    wtot = int(venue["totals"][outc])
                    est = pool * staked // wtot if wtot else 0
                    if int(v["staked"]) != staked or int(v["estPayout"]) != est:
                        died.add("verdict replay")
        elif kind == "sealed-catalog/v1":
            # catalog forgeries mutate the index; replay completeness vs disk
            pass
    except Exception:
        died.add("(thrown)")
    return died


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
    # noble parity: the decoded u must be canonical (< p) — RFC7748 permits
    # accepting non-canonical encodings, noble does not, and neither do we.
    if u >= FP:
        raise ValueError("x25519: non-canonical u coordinate (>= p)")
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
    out = x2 * pow(z2, FP - 2, FP) % FP
    # noble parity: a zero shared secret means a low-order peer — reject it
    # rather than deriving a publicly-known key.
    if out == 0:
        raise ValueError("x25519: low-order peer (zero shared secret)")
    return out.to_bytes(32, "little")


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
    snap = json.loads(snapshot_text())
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
    SNAP = json.loads(snapshot_text())
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

    # 7. model laundering — keep every real receipt, just rename the model.
    #    The named record's on-chain modelId disagrees.
    card = json.loads((ROOT / "docs/evidence/claims/dark_model-a.json").read_text())
    forged = copy.deepcopy(card)
    forged["model"]["id"] = "gpt-9000-ultra"
    caught = forged_card_rejected(forged)
    all_ok &= check("model laundering (claim card rename)", caught,
                    'forgery dies at "snapshot binding — MODEL ID MISMATCH"'
                    if caught else "FORGERY PASSED")

    # 8. same laundering on a head-to-head card — rename side A while keeping
    #    real receipts and the real verdict.
    card = json.loads((ROOT / "docs/evidence/matches/dark_model-a-vs-duel_model-a.json").read_text())
    forged = copy.deepcopy(card)
    forged["a"]["id"] = "totally-different-model"
    caught = forged_card_rejected(forged)
    all_ok &= check("model laundering (match card side rename)", caught,
                    'forgery dies at "snapshot binding — MODEL ID MISMATCH"'
                    if caught else "FORGERY PASSED")

    # 9. the hidden-argmax lie — a ceiling card claiming a 0% cap while
    #    quietly dropping the model's best run. Completeness kills it:
    #    the snapshot's subject set is recomputed, not read from the card.
    card = json.loads((ROOT / "docs/evidence/ceilings/llama-3.2-1b-instruct.json").read_text())
    forged = copy.deepcopy(card)
    best = forged["ceiling"]["bestRun"]["pk"]
    forged["runs"] = [r for r in forged["runs"] if r["pk"] != best]
    forged["scope"]["subjectRuns"] -= 1
    forged["scope"]["finalizedRuns"] -= 1
    forged["ceiling"]["maxPctBp"] = 0
    forged["ceiling"]["maxPct"] = "0.0%"
    forged["ceiling"]["bestRun"] = None
    caught = forged_card_rejected(forged)
    all_ok &= check("hidden argmax (ceiling 3.1%→0% via dropped run)", caught,
                    'forgery dies at "run-set completeness" / "ceiling exact"'
                    if caught else "FORGERY PASSED")

    # 10. the unpin — a ceiling card that drops snapshotSha256 opts out of
    #     every completeness check at once: no pin, no negative.
    forged = copy.deepcopy(card)
    forged.pop("snapshotSha256", None)
    caught = forged_card_rejected(forged)
    all_ok &= check("unpinned ceiling (snapshotSha256 dropped)", caught,
                    'forgery dies at "snapshot binding"'
                    if caught else "FORGERY PASSED")

    # 11. the receipt-subset launder — drop a claim card's worst receipt and
    #     rewrite the declared totals over the remainder. Every card-internal
    #     check stays green; only the complete ScoreLog set catches it.
    card = json.loads((ROOT / "docs/evidence/claims/dark_model-a.json").read_text())
    forged = copy.deepcopy(card)
    worst = min(forged["receipts"], key=lambda r: r["correct"] / max(1, r["items"]))
    forged["receipts"].remove(worst)
    forged["model"]["runsScored"] = len(forged["receipts"])
    forged["model"]["totalCorrect"] = sum(r["correct"] for r in forged["receipts"])
    forged["model"]["totalItems"] = sum(r["items"] for r in forged["receipts"])
    caught = forged_card_rejected(forged)
    all_ok &= check("receipt subset (worst receipt dropped, totals rewritten)", caught,
                    'forgery dies at "receipt completeness" / "record totals"'
                    if caught else "FORGERY PASSED")

    # 12. the shared-bank crop — a match card that quietly drops the bank
    #     where the loser did best, verdict rewritten over the subset.
    card = json.loads((ROOT / "docs/evidence/matches/dark_model-a-vs-duel_model-a.json").read_text())
    forged = copy.deepcopy(card)
    best_edge, drop_pk = -1e18, None
    for b in forged["banks"]:
        ra = [r for r in forged["receipts"]["a"] if r["benchmark"] == b["pk"]]
        rb = [r for r in forged["receipts"]["b"] if r["benchmark"] == b["pk"]]
        ca = sum(r["correct"] for r in ra); ia = sum(r["items"] for r in ra)
        cb = sum(r["correct"] for r in rb); ib = sum(r["items"] for r in rb)
        if ia and ib and cb / ib - ca / ia > best_edge:
            best_edge, drop_pk = cb / ib - ca / ia, b["pk"]
    forged["banks"] = [b for b in forged["banks"] if b["pk"] != drop_pk]
    forged["runs"] = [r for r in forged["runs"] if r["benchmark"] != drop_pk]
    for sd in ("a", "b"):
        forged["receipts"][sd] = [r for r in forged["receipts"][sd]
                                  if r["benchmark"] != drop_pk]
    v = forged["verdict"]
    for sd, pre in (("a", "pooledA"), ("b", "pooledB")):
        v[pre] = sum(r["correct"] for r in forged["receipts"][sd])
        v[pre.replace("pooled", "pooledItems")] = sum(r["items"] for r in forged["receipts"][sd])
    v["sharedBanks"] = len(forged["banks"])
    v["pctA"] = 100 * v["pooledA"] / v["pooledItemsA"]
    v["pctB"] = 100 * v["pooledB"] / v["pooledItemsB"]
    v["bankWins"] = {"a": 0, "tie": 0, "b": 0}
    for b in forged["banks"]:
        pa = sum(r["correct"] for r in forged["receipts"]["a"] if r["benchmark"] == b["pk"]) / \
             max(1, sum(r["items"] for r in forged["receipts"]["a"] if r["benchmark"] == b["pk"]))
        pb = sum(r["correct"] for r in forged["receipts"]["b"] if r["benchmark"] == b["pk"]) / \
             max(1, sum(r["items"] for r in forged["receipts"]["b"] if r["benchmark"] == b["pk"]))
        v["bankWins"]["a" if pa > pb else "b" if pb > pa else "tie"] += 1
    v["winner"] = "tie" if v["pctA"] == v["pctB"] else "a" if v["pctA"] > v["pctB"] else "b"
    caught = forged_card_rejected(forged)
    all_ok &= check("shared-bank crop (match card, verdict rewritten)", caught,
                    'forgery dies at "shared-bank completeness" / "receipt completeness"'
                    if caught else "FORGERY PASSED")

    # 13. the erasure — a policy certificate that silently drops one failing
    #     model and recomputes the summary over the remainder.
    card = json.loads((ROOT / "docs/evidence/policies/min60-3runs.json").read_text())
    forged = copy.deepcopy(card)
    i = next(i for i, m in enumerate(forged["models"]) if not m["verdict"]["pass"])
    del forged["models"][i]
    forged["summary"]["records"] = len(forged["models"])
    forged["summary"]["pass"] = sum(1 for m in forged["models"] if m["verdict"]["pass"])
    forged["summary"]["fail"] = sum(1 for m in forged["models"] if m["verdict"]["reason"] == "policy")
    forged["summary"]["noEvidence"] = sum(1 for m in forged["models"]
                                          if m["verdict"]["reason"] == "no-evidence")
    caught = forged_card_rejected(forged)
    all_ok &= check("erased model (policy cert drops a failure)", caught,
                    'forgery dies at "record-set completeness"'
                    if caught else "FORGERY PASSED")

    # 14. the phantom referee — point score_chunk at seal_part's address.
    #     Every check on the card's internals stays green; the PDA
    #     re-derivation catches it — scoring would then live at an address
    #     no Arcium circuit occupies.
    card = json.loads((ROOT / "docs/evidence/circuit/arcium-devnet.json").read_text())
    forged = copy.deepcopy(card)
    sc = next(c for c in forged["circuits"] if c["name"] == "score_chunk")
    sc["pda"] = next(c for c in forged["circuits"] if c["name"] == "seal_part")["pda"]
    caught = forged_card_rejected(forged)
    all_ok &= check("phantom referee (score_chunk → seal_part's pda)", caught,
                    'forgery dies at "compdef PDAs" (+"raw-circuit PDAs"/"account binding")'
                    if caught else "FORGERY PASSED")

    # 15. the cherry-pick — the census card claims one more Run than the dump
    #     holds. Every internal field stays self-consistent; the recomputed
    #     census catches it because the pubkey-set can no longer be padded.
    card = json.loads((ROOT / "docs/evidence/ledger/ledger.json").read_text())
    forged = copy.deepcopy(card)
    forged["census"]["sealed"]["kinds"]["Run"] += 1
    forged["census"]["sealed"]["accounts"] += 1
    caught = forged_card_rejected(forged)
    all_ok &= check("cherry-pick (census Run +1)", caught,
                    'forgery dies at "sealed census"'
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
    snap = json.loads(snapshot_text())
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
                "tamper", "report", "ceiling", "circuit")}

if __name__ == "__main__":
    argv = sys.argv[1:]
    if argv and argv[0] == "--remote":
        has_base = len(argv) > 1 and not argv[1].startswith("--")
        ROOT = fetch_remote(argv[1] if has_base else WEB_BASE)
        argv = argv[2:] if has_base else argv[1:]
    if argv and argv[0] == "--card":
        p = Path(argv[1])
        if not p.exists() and (ROOT / argv[1]).exists():
            p = ROOT / argv[1]  # --remote: repo-relative path inside the mirror
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
    if argv and argv[0] == "--all":
        # every third-language proof, one command — mirror of verify-all.sh
        ok = True
        for label, fn in [
            ("1/5 main replay", main),
            ("2/5 forgery lab", tamper_demo),
            ("3/5 sealed-exam decrypt", decrypt_demo),
            ("4/5 MPC rescore", rescore_demo),
            ("5/5 devnet anchor (networked)", check_anchor),
        ]:
            print(f"\n═══ {label} ═══")
            try:
                ok = bool(fn()) and ok
            except SystemExit as e:  # main() exits 0/1 itself — read the code
                ok = (e.code in (0, None)) and ok
            except Exception as e:
                print(f"  FAIL {label}: {e}")
                ok = False
        print(f"\n{'ALL VERIFIED — every third-language proof green' if ok else 'FAILURES ABOVE'}")
        sys.exit(0 if ok else 1)
    main()
