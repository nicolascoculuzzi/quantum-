const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { QBC, DAY, DISPUTE_WINDOW, deployAll } = require("./fixtures");

const PENDING = 1n, DELIVERED = 2n, DISPUTED = 3n, SETTLED = 4n, REFUNDED = 5n;
const RESULT = ethers.id("results");

// 100 seconds at 2 QBC/s = 200 QBC escrowed; 2.5% fee = 5 QBC.
async function reserved() {
  const ctx = await deployAll();
  const { market, token, provider, renter } = ctx;
  await market.connect(provider).registerBackend("ion-trap-32q", 32, QBC(2));
  await token.connect(renter).approve(market, QBC(200));
  await market.connect(renter).reserve(1, 100, QBC(2), DAY, ethers.id("bell-state-circuit"));
  return ctx;
}

async function delivered() {
  const ctx = await reserved();
  await ctx.market.connect(ctx.provider).deliver(1, RESULT);
  return ctx;
}

async function disputed() {
  const ctx = await delivered();
  await ctx.market.connect(ctx.renter).dispute(1);
  return ctx;
}

describe("ComputeMarketplace", () => {
  describe("deployment & admin", () => {
    it("rejects bad constructor params", async () => {
      const { token, admin } = await loadFixture(deployAll);
      const F = await ethers.getContractFactory("ComputeMarketplace");
      const a = admin.address;
      await expect(F.deploy(ethers.ZeroAddress, a, a, a, 0, DAY)).to.be.revertedWithCustomError(F, "InvalidParams");
      await expect(F.deploy(token, a, ethers.ZeroAddress, a, 0, DAY)).to.be.revertedWithCustomError(F, "InvalidParams");
      await expect(F.deploy(token, a, a, ethers.ZeroAddress, 0, DAY)).to.be.revertedWithCustomError(F, "InvalidParams");
      await expect(F.deploy(token, a, a, a, 1001, DAY)).to.be.revertedWithCustomError(F, "InvalidParams");
      await expect(F.deploy(token, a, a, a, 0, 0)).to.be.revertedWithCustomError(F, "InvalidParams");
      await expect(F.deploy(token, a, a, a, 0, 31 * DAY)).to.be.revertedWithCustomError(F, "InvalidParams");
    });

    it("only the owner can change settings, within bounds", async () => {
      const { market, other } = await loadFixture(deployAll);
      for (const call of [
        (m) => m.setFeeBps(10),
        (m) => m.setTreasury(other.address),
        (m) => m.setArbiter(other.address),
        (m) => m.setDisputeWindow(DAY),
      ]) {
        await expect(call(market.connect(other))).to.be.revertedWithCustomError(market, "OwnableUnauthorizedAccount");
        await call(market);
      }
      await expect(market.setFeeBps(1001)).to.be.revertedWithCustomError(market, "InvalidParams");
      await expect(market.setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(market, "InvalidParams");
      await expect(market.setArbiter(ethers.ZeroAddress)).to.be.revertedWithCustomError(market, "InvalidParams");
      await expect(market.setDisputeWindow(0)).to.be.revertedWithCustomError(market, "InvalidParams");
      await expect(market.setDisputeWindow(31 * DAY)).to.be.revertedWithCustomError(market, "InvalidParams");
    });
  });

  describe("backends", () => {
    it("registers and updates backends", async () => {
      const { market, provider, other } = await loadFixture(deployAll);
      await expect(market.connect(provider).registerBackend("sc-127q", 127, QBC(1)))
        .to.emit(market, "BackendRegistered")
        .withArgs(1, provider.address, "sc-127q", 127, QBC(1));
      await expect(market.connect(other).updateBackend(1, QBC(2), true)).to.be.revertedWithCustomError(market, "NotProvider");
      await expect(market.connect(provider).updateBackend(1, 0, true)).to.be.revertedWithCustomError(market, "InvalidParams");
      await market.connect(provider).updateBackend(1, QBC(2), false);
      const b = await market.backends(1);
      expect(b.pricePerSecond).to.equal(QBC(2));
      expect(b.active).to.equal(false);
    });

    it("rejects invalid backends", async () => {
      const { market, provider } = await loadFixture(deployAll);
      await expect(market.connect(provider).registerBackend("", 1, 1)).to.be.revertedWithCustomError(market, "InvalidParams");
      await expect(market.connect(provider).registerBackend("x", 0, 1)).to.be.revertedWithCustomError(market, "InvalidParams");
      await expect(market.connect(provider).registerBackend("x", 1, 0)).to.be.revertedWithCustomError(market, "InvalidParams");
    });
  });

  describe("reserve", () => {
    it("escrows payment and snapshots terms", async () => {
      const { market, token, admin } = await loadFixture(reserved);
      expect(await token.balanceOf(market)).to.equal(QBC(200));
      const r = await market.reservations(1);
      expect(r.amount).to.equal(QBC(200));
      expect(r.status).to.equal(PENDING);
      // later setting changes don't affect the existing reservation
      await market.connect(admin).setFeeBps(1000);
      await market.connect(admin).setDisputeWindow(DAY);
      const r2 = await market.reservations(1);
      expect(r2.feeBps).to.equal(250n);
      expect(r2.disputeWindow).to.equal(BigInt(DISPUTE_WINDOW));
    });

    it("protects renters against price changes and inactive backends", async () => {
      const { market, provider, renter } = await loadFixture(reserved);
      await expect(market.connect(renter).reserve(1, 0, QBC(2), 60, ethers.ZeroHash)).to.be.revertedWithCustomError(market, "InvalidParams");
      await expect(market.connect(renter).reserve(1, 10, QBC(2), 0, ethers.ZeroHash)).to.be.revertedWithCustomError(market, "InvalidParams");
      await market.connect(provider).updateBackend(1, QBC(3), true);
      await expect(market.connect(renter).reserve(1, 10, QBC(2), 60, ethers.ZeroHash)).to.be.revertedWithCustomError(market, "PriceChanged");
      await market.connect(provider).updateBackend(1, QBC(3), false);
      await expect(market.connect(renter).reserve(1, 10, QBC(3), 60, ethers.ZeroHash)).to.be.revertedWithCustomError(market, "BackendInactive");
      await expect(market.connect(renter).reserve(99, 10, QBC(3), 60, ethers.ZeroHash)).to.be.revertedWithCustomError(market, "BackendInactive");
    });
  });

  describe("pending", () => {
    it("only the provider can deliver, before the deadline, with a result", async () => {
      const { market, provider, renter } = await loadFixture(reserved);
      await expect(market.connect(renter).deliver(1, RESULT)).to.be.revertedWithCustomError(market, "NotProvider");
      await expect(market.connect(provider).deliver(1, ethers.ZeroHash)).to.be.revertedWithCustomError(market, "InvalidParams");
      await time.increase(DAY + 1);
      await expect(market.connect(provider).deliver(1, RESULT)).to.be.revertedWithCustomError(market, "TooLate");
    });

    it("refunds the renter after an undelivered deadline", async () => {
      const { market, token, renter } = await loadFixture(reserved);
      await expect(market.refund(1)).to.be.revertedWithCustomError(market, "TooEarly");
      await time.increase(DAY + 1);
      await expect(market.refund(1)).to.emit(market, "Refunded").withArgs(1, QBC(200));
      expect(await token.balanceOf(renter.address)).to.equal(QBC(10_000));
      expect((await market.reservations(1)).status).to.equal(REFUNDED);
      await expect(market.refund(1)).to.be.revertedWithCustomError(market, "BadStatus");
    });

    it("provider can reject for a full refund", async () => {
      const { market, token, renter, provider } = await loadFixture(reserved);
      await expect(market.connect(renter).reject(1)).to.be.revertedWithCustomError(market, "NotProvider");
      await market.connect(provider).reject(1);
      expect(await token.balanceOf(renter.address)).to.equal(QBC(10_000));
    });

    it("cannot be accepted, disputed or finalized before delivery", async () => {
      const { market, renter } = await loadFixture(reserved);
      await expect(market.connect(renter).accept(1)).to.be.revertedWithCustomError(market, "BadStatus");
      await expect(market.connect(renter).dispute(1)).to.be.revertedWithCustomError(market, "BadStatus");
      await expect(market.finalize(1)).to.be.revertedWithCustomError(market, "BadStatus");
    });
  });

  describe("delivered", () => {
    it("does not pay the provider on delivery alone", async () => {
      const { market, token, provider } = await loadFixture(delivered);
      expect((await market.reservations(1)).status).to.equal(DELIVERED);
      expect(await token.balanceOf(provider.address)).to.equal(0n);
      expect(await token.balanceOf(market)).to.equal(QBC(200));
    });

    it("cannot be rejected or refunded once delivered", async () => {
      const { market, provider } = await loadFixture(delivered);
      await expect(market.connect(provider).reject(1)).to.be.revertedWithCustomError(market, "BadStatus");
      await time.increase(DAY + 1);
      await expect(market.refund(1)).to.be.revertedWithCustomError(market, "BadStatus");
    });

    it("renter can accept to pay the provider minus fee", async () => {
      const { market, token, provider, renter, treasury, other } = await loadFixture(delivered);
      await expect(market.connect(other).accept(1)).to.be.revertedWithCustomError(market, "NotRenter");
      await expect(market.connect(renter).accept(1)).to.emit(market, "Settled").withArgs(1, QBC(195), QBC(5), 0);
      expect(await token.balanceOf(provider.address)).to.equal(QBC(195));
      expect(await token.balanceOf(treasury.address)).to.equal(QBC(5));
      expect(await token.balanceOf(market)).to.equal(0n);
      expect((await market.reservations(1)).status).to.equal(SETTLED);
    });

    it("anyone can finalize after the dispute window", async () => {
      const { market, token, provider, other } = await loadFixture(delivered);
      await expect(market.finalize(1)).to.be.revertedWithCustomError(market, "TooEarly");
      await time.increase(DISPUTE_WINDOW + 1);
      await market.connect(other).finalize(1);
      expect(await token.balanceOf(provider.address)).to.equal(QBC(195));
      await expect(market.finalize(1)).to.be.revertedWithCustomError(market, "BadStatus");
    });

    it("renter can only dispute inside the window", async () => {
      const { market, renter, other } = await loadFixture(delivered);
      await expect(market.connect(other).dispute(1)).to.be.revertedWithCustomError(market, "NotRenter");
      await time.increase(DISPUTE_WINDOW + 1);
      await expect(market.connect(renter).dispute(1)).to.be.revertedWithCustomError(market, "TooLate");
    });
  });

  describe("disputed", () => {
    it("blocks accept/finalize while disputed", async () => {
      const { market, renter } = await loadFixture(disputed);
      expect((await market.reservations(1)).status).to.equal(DISPUTED);
      await time.increase(DISPUTE_WINDOW + 1);
      await expect(market.finalize(1)).to.be.revertedWithCustomError(market, "BadStatus");
      await expect(market.connect(renter).accept(1)).to.be.revertedWithCustomError(market, "BadStatus");
    });

    it("arbiter can split the escrow; fee only on the provider share", async () => {
      const { market, token, arbiter, provider, renter, treasury } = await loadFixture(disputed);
      await expect(market.connect(renter).resolve(1, 5000)).to.be.revertedWithCustomError(market, "NotArbiter");
      await expect(market.connect(arbiter).resolve(1, 10001)).to.be.revertedWithCustomError(market, "InvalidParams");
      // 40% to provider: 80 QBC gross, 2 QBC fee, 78 net; 120 refunded
      await expect(market.connect(arbiter).resolve(1, 4000)).to.emit(market, "Settled").withArgs(1, QBC(78), QBC(2), QBC(120));
      expect(await token.balanceOf(provider.address)).to.equal(QBC(78));
      expect(await token.balanceOf(treasury.address)).to.equal(QBC(2));
      expect(await token.balanceOf(renter.address)).to.equal(QBC(9_920));
      await expect(market.connect(arbiter).resolve(1, 0)).to.be.revertedWithCustomError(market, "BadStatus");
    });

    it("arbiter can fully refund the renter", async () => {
      const { market, token, arbiter, renter, treasury } = await loadFixture(disputed);
      await market.connect(arbiter).resolve(1, 0);
      expect(await token.balanceOf(renter.address)).to.equal(QBC(10_000));
      expect(await token.balanceOf(treasury.address)).to.equal(0n);
    });

    it("splits 50/50 if the arbiter never rules", async () => {
      const { market, token, provider, renter } = await loadFixture(disputed);
      await expect(market.settleStaleDispute(1)).to.be.revertedWithCustomError(market, "TooEarly");
      await time.increase(30 * DAY + 1);
      await market.settleStaleDispute(1);
      expect(await token.balanceOf(provider.address)).to.equal(QBC(97.5));
      expect(await token.balanceOf(renter.address)).to.equal(QBC(9_900));
      await expect(market.settleStaleDispute(1)).to.be.revertedWithCustomError(market, "BadStatus");
    });
  });
});
