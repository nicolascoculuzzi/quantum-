const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const { ethers, network } = hre;

const DAY = 24 * 60 * 60;

async function main() {
  const [deployer] = await ethers.getSigners();
  const cfg = {
    admin: process.env.ADMIN || deployer.address,
    treasury: process.env.TREASURY || deployer.address,
    arbiter: process.env.ARBITER || deployer.address,
    feeBps: Number(process.env.FEE_BPS || 250), // 2.5%
    disputeWindow: Number(process.env.DISPUTE_WINDOW || 3 * DAY),
    initialSupply: ethers.parseEther(process.env.INITIAL_SUPPLY || "100000000"),
  };

  console.log(`Deploying to ${network.name} from ${deployer.address}`);

  const token = await ethers.deployContract("QubitCompute", [cfg.admin, cfg.initialSupply]);
  await token.waitForDeployment();
  const market = await ethers.deployContract("ComputeMarketplace", [
    token,
    cfg.admin,
    cfg.treasury,
    cfg.arbiter,
    cfg.feeBps,
    cfg.disputeWindow,
  ]);
  await market.waitForDeployment();
  const bounties = await ethers.deployContract("ResearchBounties", [token]);
  await bounties.waitForDeployment();

  const deployment = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    config: { ...cfg, initialSupply: cfg.initialSupply.toString() },
    contracts: {
      QubitCompute: {
        address: await token.getAddress(),
        args: [cfg.admin, cfg.initialSupply.toString()],
      },
      ComputeMarketplace: {
        address: await market.getAddress(),
        args: [await token.getAddress(), cfg.admin, cfg.treasury, cfg.arbiter, cfg.feeBps, cfg.disputeWindow],
      },
      ResearchBounties: {
        address: await bounties.getAddress(),
        args: [await token.getAddress()],
      },
    },
  };

  for (const [name, c] of Object.entries(deployment.contracts)) console.log(`${name.padEnd(20)} ${c.address}`);

  if (network.name !== "hardhat") {
    const dir = path.join(__dirname, "..", "deployments");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${network.name}.json`);
    fs.writeFileSync(file, JSON.stringify(deployment, null, 2) + "\n");
    console.log(`Saved ${path.relative(process.cwd(), file)}`);

    if (process.env.VERIFY) {
      for (const c of Object.values(deployment.contracts)) {
        await hre.run("verify:verify", { address: c.address, constructorArguments: c.args }).catch((e) => {
          console.warn(`verify ${c.address}: ${e.message}`);
        });
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
