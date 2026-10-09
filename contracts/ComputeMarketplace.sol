// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ComputeMarketplace
/// @notice Escrowed marketplace where quantum hardware providers list backends
///         and researchers rent machine time, paid in QBC.
///
/// Lifecycle of a reservation:
///   1. Renter calls `reserve` -> QBC is escrowed in this contract.
///   2. Provider calls `complete` with a hash of the job results -> escrow is
///      released to the provider, minus the protocol fee sent to the treasury.
///   3. If the provider never completes before the deadline, the renter calls
///      `refund` and gets the full escrow back. The provider can also
///      `reject` a reservation at any time before completion to refund it.
contract ComputeMarketplace is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Pending,
        Completed,
        Refunded
    }

    struct Backend {
        address provider;
        string name; // e.g. "ion-trap-32q"
        uint32 qubits;
        uint256 pricePerSecond; // in QBC wei
        bool active;
    }

    struct Reservation {
        uint256 backendId;
        address renter;
        address provider;
        uint64 seconds_;
        uint64 deadline;
        uint256 amount;
        Status status;
        bytes32 jobSpecHash; // hash of the circuit / job description
        bytes32 resultHash; // hash of results, set on completion
    }

    uint16 public constant MAX_FEE_BPS = 1_000; // 10%

    IERC20 public immutable qbc;
    address public treasury;
    uint16 public feeBps;

    uint256 public nextBackendId = 1;
    uint256 public nextReservationId = 1;
    mapping(uint256 => Backend) public backends;
    mapping(uint256 => Reservation) public reservations;

    event BackendRegistered(uint256 indexed id, address indexed provider, string name, uint32 qubits, uint256 pricePerSecond);
    event BackendUpdated(uint256 indexed id, uint256 pricePerSecond, bool active);
    event Reserved(uint256 indexed id, uint256 indexed backendId, address indexed renter, uint64 seconds_, uint256 amount, uint64 deadline, bytes32 jobSpecHash);
    event Completed(uint256 indexed id, bytes32 resultHash, uint256 providerPayout, uint256 fee);
    event Refunded(uint256 indexed id, uint256 amount);
    event FeeUpdated(uint16 feeBps);
    event TreasuryUpdated(address treasury);

    error NotProvider();
    error BackendInactive();
    error InvalidParams();
    error BadStatus();
    error DeadlineNotReached();
    error DeadlinePassed();
    error PriceChanged();

    constructor(IERC20 qbc_, address owner_, address treasury_, uint16 feeBps_) Ownable(owner_) {
        if (address(qbc_) == address(0) || treasury_ == address(0) || feeBps_ > MAX_FEE_BPS) revert InvalidParams();
        qbc = qbc_;
        treasury = treasury_;
        feeBps = feeBps_;
    }

    // ---------------------------------------------------------------------
    // Providers
    // ---------------------------------------------------------------------

    function registerBackend(string calldata name, uint32 qubits, uint256 pricePerSecond) external returns (uint256 id) {
        if (bytes(name).length == 0 || qubits == 0 || pricePerSecond == 0) revert InvalidParams();
        id = nextBackendId++;
        backends[id] = Backend(msg.sender, name, qubits, pricePerSecond, true);
        emit BackendRegistered(id, msg.sender, name, qubits, pricePerSecond);
    }

    function updateBackend(uint256 id, uint256 pricePerSecond, bool active) external {
        Backend storage b = backends[id];
        if (b.provider != msg.sender) revert NotProvider();
        if (pricePerSecond == 0) revert InvalidParams();
        b.pricePerSecond = pricePerSecond;
        b.active = active;
        emit BackendUpdated(id, pricePerSecond, active);
    }

    // ---------------------------------------------------------------------
    // Renters
    // ---------------------------------------------------------------------

    /// @param maxPricePerSecond guards against the provider front-running a price increase.
    /// @param ttl seconds from now within which the provider must complete the job.
    function reserve(
        uint256 backendId,
        uint64 seconds_,
        uint256 maxPricePerSecond,
        uint64 ttl,
        bytes32 jobSpecHash
    ) external nonReentrant returns (uint256 id) {
        Backend storage b = backends[backendId];
        if (!b.active) revert BackendInactive();
        if (seconds_ == 0 || ttl == 0) revert InvalidParams();
        if (b.pricePerSecond > maxPricePerSecond) revert PriceChanged();

        uint256 amount = b.pricePerSecond * seconds_;
        uint64 deadline = uint64(block.timestamp) + ttl;

        id = nextReservationId++;
        reservations[id] = Reservation({
            backendId: backendId,
            renter: msg.sender,
            provider: b.provider,
            seconds_: seconds_,
            deadline: deadline,
            amount: amount,
            status: Status.Pending,
            jobSpecHash: jobSpecHash,
            resultHash: bytes32(0)
        });

        qbc.safeTransferFrom(msg.sender, address(this), amount);
        emit Reserved(id, backendId, msg.sender, seconds_, amount, deadline, jobSpecHash);
    }

    /// @notice Provider marks the job as executed and gets paid.
    function complete(uint256 id, bytes32 resultHash) external nonReentrant {
        Reservation storage r = reservations[id];
        if (r.provider != msg.sender) revert NotProvider();
        if (r.status != Status.Pending) revert BadStatus();
        if (block.timestamp > r.deadline) revert DeadlinePassed();

        r.status = Status.Completed;
        r.resultHash = resultHash;

        uint256 fee = (r.amount * feeBps) / 10_000;
        uint256 payout = r.amount - fee;
        if (fee > 0) qbc.safeTransfer(treasury, fee);
        qbc.safeTransfer(r.provider, payout);
        emit Completed(id, resultHash, payout, fee);
    }

    /// @notice Provider declines a reservation; renter is fully refunded.
    function reject(uint256 id) external nonReentrant {
        Reservation storage r = reservations[id];
        if (r.provider != msg.sender) revert NotProvider();
        _refund(r, id);
    }

    /// @notice Anyone can trigger a refund to the renter once the deadline has passed unfulfilled.
    function refund(uint256 id) external nonReentrant {
        Reservation storage r = reservations[id];
        if (block.timestamp <= r.deadline) revert DeadlineNotReached();
        _refund(r, id);
    }

    function _refund(Reservation storage r, uint256 id) private {
        if (r.status != Status.Pending) revert BadStatus();
        r.status = Status.Refunded;
        qbc.safeTransfer(r.renter, r.amount);
        emit Refunded(id, r.amount);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setFeeBps(uint16 feeBps_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert InvalidParams();
        feeBps = feeBps_;
        emit FeeUpdated(feeBps_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert InvalidParams();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }
}
