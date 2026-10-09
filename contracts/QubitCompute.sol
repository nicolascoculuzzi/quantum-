// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Capped} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Capped.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title Qubit Compute (QBC)
/// @notice Utility token used to rent time on quantum cloud hardware
///         (see ComputeMarketplace) and to fund quantum research bounties
///         (see ResearchBounties).
contract QubitCompute is ERC20, ERC20Burnable, ERC20Capped, ERC20Permit, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Hard cap: 1,000,000,000 QBC.
    uint256 public constant MAX_SUPPLY = 1_000_000_000 ether;

    constructor(address admin, uint256 initialSupply)
        ERC20("Qubit Compute", "QBC")
        ERC20Capped(MAX_SUPPLY)
        ERC20Permit("Qubit Compute")
    {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        if (initialSupply > 0) _mint(admin, initialSupply);
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Capped) {
        super._update(from, to, value);
    }
}
