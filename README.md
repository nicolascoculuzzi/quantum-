# Qubit Compute (QBC)

QBC is an ERC-20 token for **renting time on quantum cloud hardware** and **funding quantum research bounties**.

## Contracts

| Contract | Purpose |
| --- | --- |
| [`QubitCompute.sol`](contracts/QubitCompute.sol) | The QBC token. ERC-20 with a 1B hard cap, burnable, EIP-2612 `permit`, and role-gated minting (`MINTER_ROLE`). |
| [`ComputeMarketplace.sol`](contracts/ComputeMarketplace.sol) | Providers list quantum backends (name, qubit count, QBC price per second). Renters reserve time, and the QBC is held in escrow until the job is done. |
| [`ResearchBounties.sol`](contracts/ResearchBounties.sol) | Crowdfunded QBC bounties for open quantum research problems. Researchers submit claims, and a reviewer awards the pool to one claim. |

### Renting compute

1. A provider calls `registerBackend("ion-trap-32q", 32, pricePerSecond)`.
2. A renter approves QBC and calls `reserve(backendId, seconds, maxPricePerSecond, ttl, jobSpecHash)`. The cost `price × seconds` goes into escrow. `maxPricePerSecond` stops the provider from raising the price just before the reservation goes through.
3. The provider runs the job and calls `complete(id, resultHash)`. The provider gets the escrow minus the protocol fee (`feeBps`, at most 10%), and the fee goes to the treasury.
4. If the job is not completed by `deadline`, anyone can call `refund(id)` to return the full escrow to the renter. The provider can also `reject(id)` at any time before completing.

### Research bounties

1. `createBounty(metadataURI, reviewer, deadline, initialFunding)` creates a bounty. Anyone can add QBC with `fund(id, amount)` until the deadline.
2. Researchers call `submitClaim(id, uri, contentHash)` before the deadline.
3. The reviewer calls `award(id, claimIndex)`, which pays the whole pool to that researcher.
4. If the creator cancels the bounty, or the deadline passes without an award, each funder can `withdraw(id)` their own contribution.

> Note: the reviewer can still award a bounty after its deadline, as long as no funder has withdrawn yet. Once funders start withdrawing, the pool shrinks.

## Development

```bash
npm install
npx hardhat compile
npx hardhat test
npx hardhat run scripts/deploy.js            # local in-process network
```

Deploy settings (all optional): `TREASURY`, `FEE_BPS` (default `250` = 2.5%), and `INITIAL_SUPPLY` in whole QBC (default `100000000`).

### Offline compiler

If Hardhat can't download solc (`binaries.soliditylang.org` is blocked), install `solc@0.8.28` from npm somewhere and point Hardhat at its wasm build:

```bash
SOLCJS_PATH=/path/to/node_modules/solc/soljson.js npx hardhat test
```

## Disclaimer

This code is unaudited and is not financial advice. Get a professional security audit before deploying it to mainnet.
