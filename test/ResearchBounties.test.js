const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { QBC, DAY, deployAll } = require("./fixtures");

const REVIEW_PERIOD = 14 * DAY;
const OPEN = 1n, AWARDED = 2n, CANCELLED = 3n;

// funder opens bounty #1 with 600 QBC, other adds 400; admin is the reviewer.
async function funded() {
  const ctx = await deployAll();
  const { bounties, token, admin, funder, other } = ctx;
  const deadline = (await time.latest()) + 7 * DAY;
  await token.connect(funder).approve(bounties, QBC(1000));
  await bounties.connect(funder).createBounty("ipfs://surface-code-threshold", admin.address, deadline, QBC(600));
  await token.connect(other).approve(bounties, QBC(400));
  await bounties.connect(other).fund(1, QBC(400));
  return { ...ctx, deadline, reviewer: admin };
}

async function claimed() {
  const ctx = await funded();
  await ctx.bounties.connect(ctx.researcher).submitClaim(1, "ipfs://paper", ethers.id("paper"));
  return ctx;
}

describe("ResearchBounties", () => {
  describe("create & fund", () => {
    it("validates creation params", async () => {
      const { bounties, admin, token } = await loadFixture(deployAll);
      const F = await ethers.getContractFactory("ResearchBounties");
      await expect(F.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "InvalidParams");
      const future = (await time.latest()) + DAY;
      await expect(bounties.createBounty("x", ethers.ZeroAddress, future, 0)).to.be.revertedWithCustomError(bounties, "InvalidParams");
      await expect(bounties.createBounty("", admin.address, future, 0)).to.be.revertedWithCustomError(bounties, "InvalidParams");
      await expect(bounties.createBounty("x", admin.address, await time.latest(), 0)).to.be.revertedWithCustomError(bounties, "InvalidParams");
      await bounties.createBounty("x", admin.address, future, 0); // unfunded bounty is allowed
      expect((await bounties.bounties(1)).status).to.equal(OPEN);
      await expect(bounties.fund(1, 0)).to.be.revertedWithCustomError(bounties, "InvalidParams");
      await expect(bounties.fund(2, 1)).to.be.revertedWithCustomError(bounties, "NotOpen");
      expect(await token.balanceOf(bounties)).to.equal(0n);
    });

    it("pools and tracks contributions", async () => {
      const { bounties, token, funder, other } = await loadFixture(funded);
      expect((await bounties.bounties(1)).pool).to.equal(QBC(1000));
      expect(await bounties.contributions(1, funder.address)).to.equal(QBC(600));
      expect(await bounties.contributions(1, other.address)).to.equal(QBC(400));
      expect(await token.balanceOf(bounties)).to.equal(QBC(1000));
    });

    it("stops funding and claims after the deadline", async () => {
      const { bounties, researcher, other } = await loadFixture(funded);
      await time.increase(7 * DAY + 1);
      await expect(bounties.connect(other).fund(1, 1)).to.be.revertedWithCustomError(bounties, "DeadlinePassed");
      await expect(bounties.connect(researcher).submitClaim(1, "x", ethers.ZeroHash)).to.be.revertedWithCustomError(bounties, "DeadlinePassed");
    });
  });

  describe("claims & award", () => {
    it("records claims", async () => {
      const { bounties, researcher } = await loadFixture(claimed);
      expect(await bounties.claimCount(1)).to.equal(1n);
      const c = await bounties.getClaim(1, 0);
      expect(c.researcher).to.equal(researcher.address);
      expect(c.uri).to.equal("ipfs://paper");
      await expect(bounties.connect(researcher).submitClaim(1, "", ethers.ZeroHash)).to.be.revertedWithCustomError(bounties, "InvalidParams");
    });

    it("reviewer awards the whole pool to a claim", async () => {
      const { bounties, token, reviewer, researcher } = await loadFixture(claimed);
      await expect(bounties.connect(researcher).award(1, 0)).to.be.revertedWithCustomError(bounties, "NotReviewer");
      await expect(bounties.connect(reviewer).award(1, 1)).to.be.revertedWithCustomError(bounties, "InvalidParams");
      await expect(bounties.connect(reviewer).award(1, 0)).to.emit(bounties, "Awarded").withArgs(1, 0, researcher.address, QBC(1000));
      expect(await token.balanceOf(researcher.address)).to.equal(QBC(1000));
      expect((await bounties.bounties(1)).status).to.equal(AWARDED);
      await expect(bounties.connect(reviewer).award(1, 0)).to.be.revertedWithCustomError(bounties, "NotOpen");
      await time.increase(30 * DAY);
      await expect(bounties.connect(researcher).withdraw(1)).to.be.revertedWithCustomError(bounties, "StillActive");
    });

    it("reviewer can award during the review period, and funders cannot withdraw meanwhile", async () => {
      const { bounties, token, reviewer, researcher, funder } = await loadFixture(claimed);
      await time.increase(7 * DAY + REVIEW_PERIOD - 60);
      await expect(bounties.connect(funder).withdraw(1)).to.be.revertedWithCustomError(bounties, "StillActive");
      await bounties.connect(reviewer).award(1, 0);
      expect(await token.balanceOf(researcher.address)).to.equal(QBC(1000));
    });

    it("cannot award after the review period", async () => {
      const { bounties, reviewer } = await loadFixture(claimed);
      await time.increase(7 * DAY + REVIEW_PERIOD + 1);
      await expect(bounties.connect(reviewer).award(1, 0)).to.be.revertedWithCustomError(bounties, "DeadlinePassed");
    });

    it("cannot award an empty pool", async () => {
      const { bounties, admin, researcher } = await loadFixture(deployAll);
      await bounties.createBounty("x", admin.address, (await time.latest()) + DAY, 0);
      await bounties.connect(researcher).submitClaim(1, "ipfs://y", ethers.ZeroHash);
      await expect(bounties.award(1, 0)).to.be.revertedWithCustomError(bounties, "InvalidParams");
    });
  });

  describe("cancel & withdraw", () => {
    it("lets funders withdraw after the review period ends without an award", async () => {
      const { bounties, token, funder, other } = await loadFixture(claimed);
      await time.increase(7 * DAY + REVIEW_PERIOD + 1);
      await expect(bounties.connect(funder).withdraw(1)).to.emit(bounties, "Withdrawn").withArgs(1, funder.address, QBC(600));
      await bounties.connect(other).withdraw(1);
      expect(await token.balanceOf(funder.address)).to.equal(QBC(10_000));
      expect(await token.balanceOf(other.address)).to.equal(QBC(10_000));
      expect((await bounties.bounties(1)).pool).to.equal(0n);
      await expect(bounties.connect(funder).withdraw(1)).to.be.revertedWithCustomError(bounties, "NothingToWithdraw");
    });

    it("creator can cancel only while there are no claims", async () => {
      const { bounties, token, funder, other, researcher } = await loadFixture(funded);
      await expect(bounties.connect(other).cancel(1)).to.be.revertedWithCustomError(bounties, "NotAuthorized");
      await bounties.connect(researcher).submitClaim(1, "ipfs://paper", ethers.ZeroHash);
      await expect(bounties.connect(funder).cancel(1)).to.be.revertedWithCustomError(bounties, "NotAuthorized");
      expect(await token.balanceOf(bounties)).to.equal(QBC(1000));
    });

    it("creator cancel lets funders withdraw immediately", async () => {
      const { bounties, token, funder, other } = await loadFixture(funded);
      await expect(bounties.connect(funder).cancel(1)).to.emit(bounties, "Cancelled").withArgs(1);
      expect((await bounties.bounties(1)).status).to.equal(CANCELLED);
      await expect(bounties.connect(other).fund(1, 1)).to.be.revertedWithCustomError(bounties, "NotOpen");
      await expect(bounties.connect(funder).cancel(1)).to.be.revertedWithCustomError(bounties, "NotOpen");
      await bounties.connect(other).withdraw(1);
      expect(await token.balanceOf(other.address)).to.equal(QBC(10_000));
    });

    it("reviewer can cancel even with claims", async () => {
      const { bounties, reviewer, funder } = await loadFixture(claimed);
      await bounties.connect(reviewer).cancel(1);
      await bounties.connect(funder).withdraw(1);
    });
  });
});
