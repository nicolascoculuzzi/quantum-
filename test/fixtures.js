const { ethers } = require("hardhat");

const QBC = (n) => ethers.parseEther(String(n));
const DAY = 24 * 60 * 60;
const FEE_BPS = 250;
const DISPUTE_WINDOW = 3 * DAY;

async function deployAll() {
  const [admin, treasury, arbiter, provider, renter, researcher, funder, other] = await ethers.getSigners();
  const token = await ethers.deployContract("QubitCompute", [admin.address, QBC(1_000_000)]);
  const market = await ethers.deployContract("ComputeMarketplace", [
    token,
    admin.address,
    treasury.address,
    arbiter.address,
    FEE_BPS,
    DISPUTE_WINDOW,
  ]);
  const bounties = await ethers.deployContract("ResearchBounties", [token]);
  for (const s of [renter, funder, other]) await token.transfer(s.address, QBC(10_000));
  return { token, market, bounties, admin, treasury, arbiter, provider, renter, researcher, funder, other };
}

module.exports = { QBC, DAY, FEE_BPS, DISPUTE_WINDOW, deployAll };
