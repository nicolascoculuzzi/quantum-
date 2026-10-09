require("@nomicfoundation/hardhat-toolbox");
const { subtask } = require("hardhat/config");
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

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: SOLC_VERSION,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
};
