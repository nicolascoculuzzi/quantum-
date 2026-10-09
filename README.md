# Qubit Compute (QBC)

QBC is an ERC-20 token for **renting time on quantum cloud hardware** and **funding quantum research bounties**.

## Contracts

| Contract | Purpose |
| --- | --- |
| [`QubitCompute.sol`](contracts/QubitCompute.sol) | The QBC token. ERC-20 with a 1B hard cap, burnable, EIP-2612 `permit`, and role-gated minting (`MINTER_ROLE`). |
| [`ComputeMarketplace.sol`](contracts/ComputeMarketplace.sol) | Providers list quantum backends and renters book machine time. Payment is held in escrow, with a dispute window and arbitration. |
| [`ResearchBounties.sol`](contracts/ResearchBounties.sol) | Crowdfunded QBC bounties for open quantum research problems. Researchers submit claims, and a reviewer awards the pool to one claim. |

## Renting compute

```
            deliver               accept / finalize (after window)
 Pending ─────────────▶ Delivered ─────────────────────────────▶ Settled
   │                       │ dispute (within window)               ▲
   │ reject / refund       ▼                                       │
   │ (after deadline)   Disputed ── resolve(split) / stale 50-50 ──┘
   ▼
 Refunded
```

1. **List a backend.** A provider calls `registerBackend("ion-trap-32q", 32, pricePerSecond)`, and can change the price or pause it later with `updateBackend`.
2. **Reserve time.** A renter approves QBC, then calls `reserve(backendId, seconds, maxPricePerSecond, ttl, jobSpecHash)`.
   - `price × seconds` goes into escrow.
   - `maxPricePerSecond` stops the provider from raising the price just before the reservation goes through.
   - The fee and dispute window in effect at this moment are saved with the reservation. Later admin changes don't affect it.
3. **Deliver.** The provider runs the job and calls `deliver(id, resultHash)` before the deadline (`now + ttl`). This does **not** pay them yet.
   - If the provider never delivers, anyone can call `refund(id)` after the deadline to return the full escrow to the renter.
   - The provider can `reject(id)` a reservation that hasn't been delivered yet, for a full refund.
4. **Settle.** After delivery, one of these happens:
   - The renter calls `accept(id)` and the provider is paid straight away.
   - The dispute window (default 3 days) passes with no dispute, and anyone calls `finalize(id)` to pay the provider.
   - The renter calls `dispute(id)` inside the window. The **arbiter** then calls `resolve(id, providerBps)` to split the escrow between the provider and the renter.
     - If the arbiter doesn't rule within 30 days, anyone can call `settleStaleDispute(id)` for a 50/50 split, so the escrow can never be stuck.

The protocol fee (`feeBps`, at most 10%) is charged only on what the provider receives, and goes to the treasury.

## Research bounties

1. **Open a bounty.** `createBounty(metadataURI, reviewer, deadline, initialFunding)` creates it. Anyone can add QBC with `fund(id, amount)` until the deadline.
2. **Submit claims.** Researchers call `submitClaim(id, uri, contentHash)` before the deadline.
3. **Award.** The reviewer has until `deadline + 14 days` (the review period) to call `award(id, claimIndex)`, which pays the whole pool to that researcher. Funders **cannot** withdraw during this time.
4. **Cancel or expire.** If the bounty is cancelled, or the review period ends with no award, each funder calls `withdraw(id)` to get their own contribution back.
   - The **creator** can cancel only while no claims exist, so researchers who already submitted work can't be cheated out of the pool.
   - The **reviewer** can cancel at any time, for example when no claim meets the criteria.

## Trust assumptions

- **Admin:** the token admin can mint up to the cap. The marketplace owner can change the fee (at most 10%), treasury, arbiter and dispute window for *new* reservations only. Use a multisig for these roles in production.
- **Arbiter:** the arbiter decides disputed compute jobs.
- **Reviewer:** each bounty's reviewer decides its winner.
- **Off-chain results:** these contracts record hashes of job specs and results. They do not and cannot check on-chain that a quantum job actually ran.

## Development

```bash
npm install
npm test               # unit tests
npm run coverage       # coverage report
npm run gas            # tests with gas report
```

CI (GitHub Actions) runs compile, tests and coverage on every push and pull request.

### Deploying

Secrets are stored with Hardhat's `vars` (they are never committed to the repo):

```bash
npx hardhat vars set DEPLOYER_PRIVATE_KEY
npx hardhat vars set SEPOLIA_RPC_URL        # or BASE_SEPOLIA_RPC_URL, MAINNET_RPC_URL, BASE_RPC_URL
npx hardhat vars set ETHERSCAN_API_KEY      # optional, for verification

VERIFY=1 npm run deploy:sepolia
```

Local deploy:

```bash
npm run node             # terminal 1
npm run deploy:local     # terminal 2
```

| Deploy env var | Default |
| --- | --- |
| `ADMIN` | deployer address; token admin/minter and marketplace owner |
| `TREASURY` | deployer address |
| `ARBITER` | deployer address |
| `FEE_BPS` | `250` (2.5%) |
| `DISPUTE_WINDOW` | `259200` (3 days, in seconds) |
| `INITIAL_SUPPLY` | `100000000` (in whole QBC) |

The script saves addresses and constructor arguments to `deployments/<network>.json`.

### Offline compiler

If Hardhat can't download solc (`binaries.soliditylang.org` is blocked), install `solc@0.8.28` from npm somewhere and point Hardhat at its wasm build:

```bash
SOLCJS_PATH=/path/to/node_modules/solc/soljson.js npm test
```

## Status

| Done | Not done yet |
| --- | --- |
| Token, marketplace and bounty contracts | Security audit |
| Unit tests (100% line coverage) | Testnet or mainnet deployment |
| Deploy and verify scripts, CI | Web app for renters, providers and bounties |
| | Provider agent that connects the marketplace to real quantum hardware |
| | Tokenomics: distribution and vesting |

## Disclaimer

This code is unaudited and is not financial advice. Get a professional security audit before deploying it to mainnet.
