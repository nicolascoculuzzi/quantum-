require("@nomicfoundation/hardhat-toolbox");
const { subtask, vars } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

const SOLC_VERSION = "0.8.28";

// Optional offline fallback: if the compiler download host is unreachable,
// point SOLCJS_PATH at a soljson.js from the `solc@0.8.28` npm package.
if (process.env.SOLCJS_PATH) {
  subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
    if (args.solcVersion !== SOLC_VERSION) return runSuper();
    return {
      compilerPath: process.env.SOLCJS_PATH,
      isSolcJs: true,
      version: args.solcVersion,
      longVersion: args.solcVersion,
    };
  });
}

// Secrets come from `npx hardhat vars set <NAME>` (or HARDHAT_VAR_<NAME> env vars).
// A network is only configured when both its RPC URL and the deployer key are set.
const deployerKey = vars.get("DEPLOYER_PRIVATE_KEY", "");
const networks = {};
for (const [name, rpcVar, chainId] of [
  ["sepolia", "SEPOLIA_RPC_URL", 11155111],
  ["baseSepolia", "BASE_SEPOLIA_RPC_URL", 84532],
  ["mainnet", "MAINNET_RPC_URL", 1],
  ["base", "BASE_RPC_URL", 8453],
]) {
  const url = vars.get(rpcVar, "");
  if (url && deployerKey) networks[name] = { url, chainId, accounts: [deployerKey] };
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: SOLC_VERSION,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  networks,
  etherscan: { apiKey: vars.get("ETHERSCAN_API_KEY", "") },
  sourcify: { enabled: false },
  gasReporter: { enabled: Boolean(process.env.REPORT_GAS) },
};
