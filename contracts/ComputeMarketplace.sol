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
///   Pending    Renter called `reserve`; QBC is escrowed here.
///              - provider `deliver`s before the deadline       -> Delivered
///              - provider `reject`s                             -> Refunded
///              - deadline passes, anyone calls `refund`         -> Refunded
///   Delivered  Provider posted a result hash. A dispute window opens.
///              - renter `accept`s                               -> Settled (provider paid)
///              - window passes, anyone calls `finalize`         -> Settled (provider paid)
///              - renter `dispute`s inside the window            -> Disputed
///   Disputed   The arbiter `resolve`s with a provider/renter split -> Settled.
///              If the arbiter does nothing for ARBITRATION_TIMEOUT,
///              anyone can `settleStaleDispute` for a 50/50 split.
///
/// Fee and dispute window are snapshotted per reservation, so changing them
/// never affects reservations already made.
contract ComputeMarketplace is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Pending,
        Delivered,
        Disputed,
        Settled,
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
        uint64 deadline; // provider must deliver by this time
        uint64 updatedAt; // time of the last status change
        uint64 disputeWindow; // snapshot at reservation time
        uint16 feeBps; // snapshot at reservation time
        Status status;
        uint256 amount;
        bytes32 jobSpecHash; // hash of the circuit / job description
        bytes32 resultHash; // hash of results, set on delivery
    }

    uint16 public constant BPS = 10_000;
    uint16 public constant MAX_FEE_BPS = 1_000; // 10%
    uint64 public constant MAX_DISPUTE_WINDOW = 30 days;
    uint64 public constant ARBITRATION_TIMEOUT = 30 days;

    IERC20 public immutable qbc;
    address public treasury;
    address public arbiter;
    uint16 public feeBps;
    uint64 public disputeWindow;

    uint256 public nextBackendId = 1;
    uint256 public nextReservationId = 1;
    mapping(uint256 => Backend) public backends;
    mapping(uint256 => Reservation) public reservations;

    event BackendRegistered(uint256 indexed id, address indexed provider, string name, uint32 qubits, uint256 pricePerSecond);
    event BackendUpdated(uint256 indexed id, uint256 pricePerSecond, bool active);
    event Reserved(uint256 indexed id, uint256 indexed backendId, address indexed renter, uint64 seconds_, uint256 amount, uint64 deadline, bytes32 jobSpecHash);
    event Delivered(uint256 indexed id, bytes32 resultHash);
    event Disputed(uint256 indexed id);
    event Settled(uint256 indexed id, uint256 providerPayout, uint256 fee, uint256 renterRefund);
    event Refunded(uint256 indexed id, uint256 amount);
    event FeeUpdated(uint16 feeBps);
    event TreasuryUpdated(address treasury);
    event ArbiterUpdated(address arbiter);
    event DisputeWindowUpdated(uint64 disputeWindow);

    error NotProvider();
    error NotRenter();
    error NotArbiter();
    error BackendInactive();
    error InvalidParams();
    error BadStatus();
    error TooEarly();
    error TooLate();
    error PriceChanged();

    constructor(
        IERC20 qbc_,
        address owner_,
        address treasury_,
        address arbiter_,
        uint16 feeBps_,
        uint64 disputeWindow_
    ) Ownable(owner_) {
        if (
            address(qbc_) == address(0) || treasury_ == address(0) || arbiter_ == address(0) || feeBps_ > MAX_FEE_BPS
                || disputeWindow_ == 0 || disputeWindow_ > MAX_DISPUTE_WINDOW
        ) revert InvalidParams();
        qbc = qbc_;
        treasury = treasury_;
        arbiter = arbiter_;
        feeBps = feeBps_;
        disputeWindow = disputeWindow_;
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

    /// @notice Provider posts the result hash for an executed job. Payment is
    ///         released once the renter accepts or the dispute window passes.
    function deliver(uint256 id, bytes32 resultHash) external {
        Reservation storage r = reservations[id];
        if (r.provider != msg.sender) revert NotProvider();
        if (r.status != Status.Pending) revert BadStatus();
        if (block.timestamp > r.deadline) revert TooLate();
        if (resultHash == bytes32(0)) revert InvalidParams();
        r.status = Status.Delivered;
        r.resultHash = resultHash;
        r.updatedAt = uint64(block.timestamp);
        emit Delivered(id, resultHash);
    }

    /// @notice Provider declines a pending reservation; renter is fully refunded.
    function reject(uint256 id) external nonReentrant {
        Reservation storage r = reservations[id];
        if (r.provider != msg.sender) revert NotProvider();
        _refund(r, id);
    }

    // ---------------------------------------------------------------------
    // Renters
    // ---------------------------------------------------------------------

    /// @param maxPricePerSecond guards against the provider front-running a price increase.
    /// @param ttl seconds from now within which the provider must deliver.
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
            updatedAt: uint64(block.timestamp),
            disputeWindow: disputeWindow,
            feeBps: feeBps,
            status: Status.Pending,
            amount: amount,
            jobSpecHash: jobSpecHash,
            resultHash: bytes32(0)
        });

        qbc.safeTransferFrom(msg.sender, address(this), amount);
        emit Reserved(id, backendId, msg.sender, seconds_, amount, deadline, jobSpecHash);
    }

    /// @notice Renter confirms the delivered results and releases payment early.
    function accept(uint256 id) external nonReentrant {
        Reservation storage r = reservations[id];
        if (r.renter != msg.sender) revert NotRenter();
        if (r.status != Status.Delivered) revert BadStatus();
        _settle(r, id, BPS);
    }

    /// @notice Renter contests the delivered results within the dispute window.
    function dispute(uint256 id) external {
        Reservation storage r = reservations[id];
        if (r.renter != msg.sender) revert NotRenter();
        if (r.status != Status.Delivered) revert BadStatus();
        if (block.timestamp > r.updatedAt + r.disputeWindow) revert TooLate();
        r.status = Status.Disputed;
        r.updatedAt = uint64(block.timestamp);
        emit Disputed(id);
    }

    // ---------------------------------------------------------------------
    // Permissionless settlement
    // ---------------------------------------------------------------------

    /// @notice Pays the provider once the dispute window has passed undisputed.
    function finalize(uint256 id) external nonReentrant {
        Reservation storage r = reservations[id];
        if (r.status != Status.Delivered) revert BadStatus();
        if (block.timestamp <= r.updatedAt + r.disputeWindow) revert TooEarly();
        _settle(r, id, BPS);
    }

    /// @notice Refunds the renter once the delivery deadline has passed undelivered.
    function refund(uint256 id) external nonReentrant {
        Reservation storage r = reservations[id];
        if (block.timestamp <= r.deadline) revert TooEarly();
        _refund(r, id);
    }

    /// @notice Splits a dispute 50/50 if the arbiter has not ruled in time,
    ///         so escrow can never be locked forever.
    function settleStaleDispute(uint256 id) external nonReentrant {
        Reservation storage r = reservations[id];
        if (r.status != Status.Disputed) revert BadStatus();
        if (block.timestamp <= r.updatedAt + ARBITRATION_TIMEOUT) revert TooEarly();
        _settle(r, id, BPS / 2);
    }

    // ---------------------------------------------------------------------
    // Arbiter
    // ---------------------------------------------------------------------

    /// @param providerBps share of the escrow paid to the provider (0..10000);
    ///        the rest is refunded to the renter. Fee applies to the provider share only.
    function resolve(uint256 id, uint16 providerBps) external nonReentrant {
        if (msg.sender != arbiter) revert NotArbiter();
        Reservation storage r = reservations[id];
        if (r.status != Status.Disputed) revert BadStatus();
        if (providerBps > BPS) revert InvalidParams();
        _settle(r, id, providerBps);
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _settle(Reservation storage r, uint256 id, uint256 providerBps) private {
        r.status = Status.Settled;
        r.updatedAt = uint64(block.timestamp);

        uint256 providerGross = (r.amount * providerBps) / BPS;
        uint256 renterRefund = r.amount - providerGross;
        uint256 fee = (providerGross * r.feeBps) / BPS;
        uint256 payout = providerGross - fee;

        if (fee > 0) qbc.safeTransfer(treasury, fee);
        if (payout > 0) qbc.safeTransfer(r.provider, payout);
        if (renterRefund > 0) qbc.safeTransfer(r.renter, renterRefund);
        emit Settled(id, payout, fee, renterRefund);
    }

    function _refund(Reservation storage r, uint256 id) private {
        if (r.status != Status.Pending) revert BadStatus();
        r.status = Status.Refunded;
        r.updatedAt = uint64(block.timestamp);
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

    function setArbiter(address arbiter_) external onlyOwner {
        if (arbiter_ == address(0)) revert InvalidParams();
        arbiter = arbiter_;
        emit ArbiterUpdated(arbiter_);
    }

    function setDisputeWindow(uint64 disputeWindow_) external onlyOwner {
        if (disputeWindow_ == 0 || disputeWindow_ > MAX_DISPUTE_WINDOW) revert InvalidParams();
        disputeWindow = disputeWindow_;
        emit DisputeWindowUpdated(disputeWindow_);
    }
}
