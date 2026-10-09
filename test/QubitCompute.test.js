const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const QBC = (n) => ethers.parseEther(String(n));

async function deploy() {
  const [admin, treasury, provider, renter, researcher, funder, other] = await ethers.getSigners();
  const token = await ethers.deployContract("QubitCompute", [admin.address, QBC(1_000_000)]);
  const market = await ethers.deployContract("ComputeMarketplace", [token, admin.address, treasury.address, 250]);
  const bounties = await ethers.deployContract("ResearchBounties", [token]);
  for (const s of [renter, funder, other]) await token.transfer(s.address, QBC(10_000));
  return { token, market, bounties, admin, treasury, provider, renter, researcher, funder, other };
}

describe("QubitCompute token", () => {
  it("has metadata, initial supply and cap", async () => {
    const { token, admin } = await deploy();
    expect(await token.name()).to.equal("Qubit Compute");
    expect(await token.symbol()).to.equal("QBC");
    expect(await token.totalSupply()).to.equal(QBC(1_000_000));
    expect(await token.cap()).to.equal(QBC(1_000_000_000));
    expect(await token.balanceOf(admin.address)).to.equal(QBC(970_000));
  });

  it("only minters can mint, and never past the cap", async () => {
    const { token, admin, other } = await deploy();
    await expect(token.connect(other).mint(other.address, 1)).to.be.revertedWithCustomError(
      token,
      "AccessControlUnauthorizedAccount"
    );
    await token.mint(other.address, QBC(5));
    const remaining = (await token.cap()) - (await token.totalSupply());
    await expect(token.mint(admin.address, remaining + 1n)).to.be.revertedWithCustomError(token, "ERC20ExceededCap");
  });
});

describe("ComputeMarketplace", () => {
  async function withReservation() {
    const ctx = await deploy();
    const { market, token, provider, renter } = ctx;
    await market.connect(provider).registerBackend("ion-trap-32q", 32, QBC(2));
    await token.connect(renter).approve(market, QBC(200));
    const spec = ethers.id("bell-state-circuit");
    await market.connect(renter).reserve(1, 100, QBC(2), 3600, spec);
    return ctx;
  }

  it("escrows payment on reservation", async () => {
    const { market, token } = await withReservation();
    expect(await token.balanceOf(market)).to.equal(QBC(200));
    const r = await market.reservations(1);
    expect(r.amount).to.equal(QBC(200));
    expect(r.status).to.equal(1n);
  });

  it("pays provider minus fee on completion", async () => {
    const { market, token, provider, treasury } = await withReservation();
    await expect(market.connect(provider).complete(1, ethers.id("results")))
      .to.emit(market, "Completed")
      .withArgs(1, ethers.id("results"), QBC(195), QBC(5));
    expect(await token.balanceOf(provider.address)).to.equal(QBC(195));
    expect(await token.balanceOf(treasury.address)).to.equal(QBC(5));
    await expect(market.connect(provider).complete(1, ethers.ZeroHash)).to.be.revertedWithCustomError(market, "BadStatus");
  });

  it("only the provider can complete", async () => {
    const { market, renter } = await withReservation();
    await expect(market.connect(renter).complete(1, ethers.ZeroHash)).to.be.revertedWithCustomError(market, "NotProvider");
  });

  it("refunds the renter after the deadline", async () => {
    const { market, token, renter, provider } = await withReservation();
    await expect(market.refund(1)).to.be.revertedWithCustomError(market, "DeadlineNotReached");
    await time.increase(3601);
    await expect(market.connect(provider).complete(1, ethers.ZeroHash)).to.be.revertedWithCustomError(market, "DeadlinePassed");
    await market.refund(1);
    expect(await token.balanceOf(renter.address)).to.equal(QBC(10_000));
  });

  it("provider can reject for a full refund", async () => {
    const { market, token, renter, provider } = await withReservation();
    await market.connect(provider).reject(1);
    expect(await token.balanceOf(renter.address)).to.equal(QBC(10_000));
  });

  it("protects renters against price changes and inactive backends", async () => {
    const { market, provider, renter } = await withReservation();
    await market.connect(provider).updateBackend(1, QBC(3), true);
    await expect(market.connect(renter).reserve(1, 10, QBC(2), 60, ethers.ZeroHash)).to.be.revertedWithCustomError(
      market,
      "PriceChanged"
    );
    await market.connect(provider).updateBackend(1, QBC(3), false);
    await expect(market.connect(renter).reserve(1, 10, QBC(3), 60, ethers.ZeroHash)).to.be.revertedWithCustomError(
      market,
      "BackendInactive"
    );
  });

  it("caps the protocol fee", async () => {
    const { market, other } = await deploy();
    await expect(market.setFeeBps(1001)).to.be.revertedWithCustomError(market, "InvalidParams");
    await expect(market.connect(other).setFeeBps(10)).to.be.revertedWithCustomError(market, "OwnableUnauthorizedAccount");
  });
});

describe("ResearchBounties", () => {
  async function withBounty() {
    const ctx = await deploy();
    const { bounties, token, admin, funder, other } = ctx;
    const deadline = (await time.latest()) + 7 * 24 * 3600;
    await token.connect(funder).approve(bounties, QBC(1000));
    await bounties.connect(funder).createBounty("ipfs://surface-code-threshold", admin.address, deadline, QBC(600));
    await token.connect(other).approve(bounties, QBC(400));
    await bounties.connect(other).fund(1, QBC(400));
    return { ...ctx, deadline };
  }

  it("pools contributions and awards the winning claim", async () => {
    const { bounties, token, admin, researcher } = await withBounty();
    expect((await bounties.bounties(1)).pool).to.equal(QBC(1000));
    await bounties.connect(researcher).submitClaim(1, "ipfs://paper", ethers.id("paper"));
    expect(await bounties.claimCount(1)).to.equal(1n);
    await expect(bounties.connect(researcher).award(1, 0)).to.be.revertedWithCustomError(bounties, "NotReviewer");
    await bounties.connect(admin).award(1, 0);
    expect(await token.balanceOf(researcher.address)).to.equal(QBC(1000));
    await expect(bounties.connect(researcher).withdraw(1)).to.be.revertedWithCustomError(bounties, "StillActive");
  });

  it("lets funders withdraw after an unawarded deadline", async () => {
    const { bounties, token, funder, other, researcher } = await withBounty();
    await expect(bounties.connect(funder).withdraw(1)).to.be.revertedWithCustomError(bounties, "StillActive");
    await time.increase(7 * 24 * 3600 + 1);
    await expect(bounties.connect(researcher).submitClaim(1, "x", ethers.ZeroHash)).to.be.revertedWithCustomError(
      bounties,
      "DeadlinePassed"
    );
    await bounties.connect(funder).withdraw(1);
    await bounties.connect(other).withdraw(1);
    expect(await token.balanceOf(funder.address)).to.equal(QBC(10_000));
    expect(await token.balanceOf(other.address)).to.equal(QBC(10_000));
    await expect(bounties.connect(funder).withdraw(1)).to.be.revertedWithCustomError(bounties, "NothingToWithdraw");
  });

  it("lets the creator cancel so funders can withdraw", async () => {
    const { bounties, token, funder, other } = await withBounty();
    await expect(bounties.connect(other).cancel(1)).to.be.revertedWithCustomError(bounties, "NotCreator");
    await bounties.connect(funder).cancel(1);
    await expect(bounties.connect(other).fund(1, 1)).to.be.revertedWithCustomError(bounties, "NotOpen");
    await bounties.connect(other).withdraw(1);
    expect(await token.balanceOf(other.address)).to.equal(QBC(10_000));
  });
});
