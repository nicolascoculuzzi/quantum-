const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const treasury = process.env.TREASURY || deployer.address;
  const feeBps = Number(process.env.FEE_BPS || 250); // 2.5%
  const initialSupply = ethers.parseEther(process.env.INITIAL_SUPPLY || "100000000");

  const token = await ethers.deployContract("QubitCompute", [deployer.address, initialSupply]);
  await token.waitForDeployment();
  const market = await ethers.deployContract("ComputeMarketplace", [token, deployer.address, treasury, feeBps]);
  await market.waitForDeployment();
  const bounties = await ethers.deployContract("ResearchBounties", [token]);
  await bounties.waitForDeployment();

  console.log("QubitCompute (QBC):  ", await token.getAddress());
  console.log("ComputeMarketplace:  ", await market.getAddress());
  console.log("ResearchBounties:    ", await bounties.getAddress());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
