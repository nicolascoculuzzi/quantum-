// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ResearchBounties
/// @notice Crowdfunded QBC bounties for quantum research problems
///         (e.g. "beat this error-correction threshold", "new VQE ansatz").
///
/// Anyone can open a bounty and anyone can add to it until the deadline.
/// Researchers submit claims (a URI + content hash pointing at a paper, code
/// or proof) until the deadline. The bounty's reviewer then has until
/// `deadline + REVIEW_PERIOD` to award the full pool to one claim; funds
/// cannot be withdrawn during that time. If no award is made by then, or the
/// bounty is cancelled, each funder withdraws their own contribution.
///
/// The creator can cancel only while no claims exist, so researchers who
/// already submitted work cannot be rugged. The reviewer can cancel at any
/// time (e.g. no claim met the criteria).
contract ResearchBounties is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Awarded,
        Cancelled
    }

    struct Bounty {
        address creator;
        address reviewer;
        uint64 deadline;
        Status status;
        uint256 pool;
        string metadataURI; // problem statement / acceptance criteria
    }

    struct Claim {
        address researcher;
        string uri;
        bytes32 contentHash;
    }

    uint64 public constant REVIEW_PERIOD = 14 days;

    IERC20 public immutable qbc;

    uint256 public nextBountyId = 1;
    mapping(uint256 => Bounty) public bounties;
    mapping(uint256 => mapping(address => uint256)) public contributions;
    mapping(uint256 => Claim[]) private _claims;

    event BountyCreated(uint256 indexed id, address indexed creator, address indexed reviewer, uint64 deadline, string metadataURI);
    event Funded(uint256 indexed id, address indexed funder, uint256 amount);
    event ClaimSubmitted(uint256 indexed id, uint256 indexed claimIndex, address indexed researcher, string uri, bytes32 contentHash);
    event Awarded(uint256 indexed id, uint256 indexed claimIndex, address indexed researcher, uint256 amount);
    event Cancelled(uint256 indexed id);
    event Withdrawn(uint256 indexed id, address indexed funder, uint256 amount);

    error InvalidParams();
    error NotOpen();
    error NotReviewer();
    error NotAuthorized();
    error DeadlinePassed();
    error StillActive();
    error NothingToWithdraw();

    constructor(IERC20 qbc_) {
        if (address(qbc_) == address(0)) revert InvalidParams();
        qbc = qbc_;
    }

    function createBounty(
        string calldata metadataURI,
        address reviewer,
        uint64 deadline,
        uint256 initialFunding
    ) external nonReentrant returns (uint256 id) {
        if (reviewer == address(0) || deadline <= block.timestamp || bytes(metadataURI).length == 0) revert InvalidParams();
        id = nextBountyId++;
        bounties[id] = Bounty(msg.sender, reviewer, deadline, Status.Open, 0, metadataURI);
        emit BountyCreated(id, msg.sender, reviewer, deadline, metadataURI);
        if (initialFunding > 0) _fund(id, initialFunding);
    }

    function fund(uint256 id, uint256 amount) external nonReentrant {
        _fund(id, amount);
    }

    function _fund(uint256 id, uint256 amount) private {
        Bounty storage b = bounties[id];
        if (b.status != Status.Open) revert NotOpen();
        if (block.timestamp > b.deadline) revert DeadlinePassed();
        if (amount == 0) revert InvalidParams();
        b.pool += amount;
        contributions[id][msg.sender] += amount;
        qbc.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(id, msg.sender, amount);
    }

    function submitClaim(uint256 id, string calldata uri, bytes32 contentHash) external returns (uint256 claimIndex) {
        Bounty storage b = bounties[id];
        if (b.status != Status.Open) revert NotOpen();
        if (block.timestamp > b.deadline) revert DeadlinePassed();
        if (bytes(uri).length == 0) revert InvalidParams();
        claimIndex = _claims[id].length;
        _claims[id].push(Claim(msg.sender, uri, contentHash));
        emit ClaimSubmitted(id, claimIndex, msg.sender, uri, contentHash);
    }

    /// @notice Reviewer pays the whole pool to the winning claim, any time
    ///         up to the end of the review period.
    function award(uint256 id, uint256 claimIndex) external nonReentrant {
        Bounty storage b = bounties[id];
        if (b.status != Status.Open) revert NotOpen();
        if (msg.sender != b.reviewer) revert NotReviewer();
        if (block.timestamp > uint256(b.deadline) + REVIEW_PERIOD) revert DeadlinePassed();
        if (claimIndex >= _claims[id].length || b.pool == 0) revert InvalidParams();

        Claim storage c = _claims[id][claimIndex];
        uint256 amount = b.pool;
        b.status = Status.Awarded;
        b.pool = 0;
        qbc.safeTransfer(c.researcher, amount);
        emit Awarded(id, claimIndex, c.researcher, amount);
    }

    /// @notice Cancels an open bounty; funders then withdraw. The reviewer
    ///         may cancel any time, the creator only while there are no claims.
    function cancel(uint256 id) external {
        Bounty storage b = bounties[id];
        if (b.status != Status.Open) revert NotOpen();
        bool creatorMayCancel = msg.sender == b.creator && _claims[id].length == 0;
        if (msg.sender != b.reviewer && !creatorMayCancel) revert NotAuthorized();
        b.status = Status.Cancelled;
        emit Cancelled(id);
    }

    /// @notice Funders reclaim their contribution from a cancelled bounty,
    ///         or from an open one whose review period ended without an award.
    function withdraw(uint256 id) external nonReentrant {
        Bounty storage b = bounties[id];
        bool expired = b.status == Status.Open && block.timestamp > uint256(b.deadline) + REVIEW_PERIOD;
        if (b.status != Status.Cancelled && !expired) revert StillActive();

        uint256 amount = contributions[id][msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        contributions[id][msg.sender] = 0;
        b.pool -= amount;
        qbc.safeTransfer(msg.sender, amount);
        emit Withdrawn(id, msg.sender, amount);
    }

    function claimCount(uint256 id) external view returns (uint256) {
        return _claims[id].length;
    }

    function getClaim(uint256 id, uint256 claimIndex) external view returns (Claim memory) {
        return _claims[id][claimIndex];
    }
}
