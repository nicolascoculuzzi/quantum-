const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { QBC, deployAll } = require("./fixtures");

describe("QubitCompute", () => {
  it("has metadata, initial supply and cap", async () => {
    const { token, admin } = await loadFixture(deployAll);
    expect(await token.name()).to.equal("Qubit Compute");
    expect(await token.symbol()).to.equal("QBC");
    expect(await token.decimals()).to.equal(18n);
    expect(await token.totalSupply()).to.equal(QBC(1_000_000));
    expect(await token.cap()).to.equal(QBC(1_000_000_000));
    expect(await token.balanceOf(admin.address)).to.equal(QBC(970_000));
  });

  it("only minters can mint, and never past the cap", async () => {
    const { token, admin, other } = await loadFixture(deployAll);
    await expect(token.connect(other).mint(other.address, 1)).to.be.revertedWithCustomError(
      token,
      "AccessControlUnauthorizedAccount"
    );
    await token.mint(other.address, QBC(5));
    const remaining = (await token.cap()) - (await token.totalSupply());
    await expect(token.mint(admin.address, remaining + 1n)).to.be.revertedWithCustomError(token, "ERC20ExceededCap");
    await token.mint(admin.address, remaining);
    expect(await token.totalSupply()).to.equal(await token.cap());
  });

  it("admin can grant and revoke the minter role", async () => {
    const { token, other } = await loadFixture(deployAll);
    const MINTER = await token.MINTER_ROLE();
    await token.grantRole(MINTER, other.address);
    await token.connect(other).mint(other.address, 1);
    await token.revokeRole(MINTER, other.address);
    await expect(token.connect(other).mint(other.address, 1)).to.be.reverted;
  });

  it("holders can burn", async () => {
    const { token, other } = await loadFixture(deployAll);
    await token.connect(other).burn(QBC(1_000));
    expect(await token.balanceOf(other.address)).to.equal(QBC(9_000));
    expect(await token.totalSupply()).to.equal(QBC(999_000));
  });

  it("supports EIP-2612 permit", async () => {
    const { token, other, renter } = await loadFixture(deployAll);
    const { chainId } = await ethers.provider.getNetwork();
    const deadline = ethers.MaxUint256;
    const value = QBC(42);
    const sig = ethers.Signature.from(
      await other.signTypedData(
        { name: "Qubit Compute", version: "1", chainId, verifyingContract: await token.getAddress() },
        {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        { owner: other.address, spender: renter.address, value, nonce: 0, deadline }
      )
    );
    await token.permit(other.address, renter.address, value, deadline, sig.v, sig.r, sig.s);
    expect(await token.allowance(other.address, renter.address)).to.equal(value);
  });
});
