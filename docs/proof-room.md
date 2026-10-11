# The Proof Room product decision

The broad private-benchmark/prediction-market framing was too crowded and the
interface buried its useful evidence in a long ledger. This release keeps the
audited protocol and rebuilds the product around one job: an evaluation
sponsor deciding whether to fund a model capability claim.

## Why this direction

Private benchmarking is not new. [TRUCE](https://arxiv.org/abs/2403.00393)
describes private model evaluation using confidential computing and
cryptography. [Gensyn Delphi](https://www.gensyn.ai/news/introducing-delphi)
describes model-performance markets. These are relevant prior art, not systems
we independently audited.

The opportunity here is the decision artifact and its failure path. A sponsor
can define its own score and sample requirements on one exact exam, see an
honest no-qualifier result, attack the decision, and export all the evidence
needed to replay it. A refusal can be useful; a glossy ranking is insufficient.
This is a focused integration and workflow, not a claim of global novelty.

Three possible directions were considered:

| Direction | Decision |
|---|---|
| General private benchmark and AI prediction market | Prior art is strong; leaves the buyer unclear and a crowded UI. Retain the protocol, stop leading with this. |
| A new autonomous procurement/refund contract | Requires new settlement semantics and fresh MPC execution evidence. A hurried promise would weaken the submission. |
| A sponsor proof room with portable decisions and reproducible forgeries | Uses verified account surfaces, ships a complete buyer interaction, and gives a judge a specific falsifiable demonstration. Implemented. |

## What ships

- Five workspace tabs: overview, decision, challenge, payout proof, vault.
- One exact exam account per policy; names alone are not unique identifiers.
- Score floor, minimum receipts/items, post-reveal exclusion and venue-linked
  evidence. Venue linking does not authenticate the model.
- Blind review by hiding runner names. This is presentation, not privacy.
- A useful negative result with evidence gaps. A disclosed exam cannot be
  repaired with new pre-reveal runs; future trials require a new sealed bank.
- Browser-generated `sealed-policy/v1` certificates containing every model
  record and the bank-scoped receipt multiset, regardless of display filters.
- Attacks on the newly generated decision: clone a record, invent an exam,
  claim an extra qualifier, or remove every evidence requirement. The same verifier rejects them.
- A separate captured bounty proof, with its own bank and single-run contract
  gate. The desk's aggregate policy never authorizes an on-chain payment.
- Dropdown access to the original proof tools; paginated tables/account cards.
- Bounded concurrent asset hashing: every asset remains checked.

## What the community review changed

The earlier review identified useful patterns but did not carry them far enough
into the interface. This release applies them to the product's working path:

| Inspected project | Product change |
|---|---|
| CredaVer | A specific sponsor decision and inspectable receipt, with declared execution scope. |
| Afterbell | Short task-based navigation; the judge can reach an outcome without scrolling a ledger. |
| Camalote | Editable requirements visibly change the outcome, now over actual exam-scoped receipts. |
| chaotic.markets | Missing evidence and excluded receipts remain visible; absent proof is distinct from a failed score rule. |
| Fianto | A useful buyer action before infrastructure details; export a decision the sponsor can keep. |
| PrivateDAO | Distinguish shipped capabilities, historical network evidence and future validation. |

See [community-review.md](community-review.md) for precisely what was inspected.
No external builder execution or adoption claim was treated as verified.

## Commercial test

Recruit one evaluation organizer or AI application team with a useful,
machine-checkable task. Run a sponsored trial with a fresh bank; measure setup
time, time to a defensible decision, repeated evaluations and willingness to
pay. The current code supports per-run bank fees and bounded resolution fees,
but captured localnet amounts are not revenue. No customers or pricing are
claimed. Useful task families and independent model-runner attestation remain
the largest product gaps.

## Promotion gate

The new product is publishable only after the buyer-generated certificate
passes browser, TypeScript and Python replay; all four generated attacks fail
at their named checks; the existing adversarial/decryption suite stays green;
desktop/mobile navigation and pagination work; and the hosted bytes match the
frozen bundle. Latest-source devnet MPC execution is a separate claim and is
not implied by this gate.
