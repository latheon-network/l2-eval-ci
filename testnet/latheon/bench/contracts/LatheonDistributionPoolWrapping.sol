// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IWrappedNative is IERC20 {
    function deposit() external payable;
}

interface IFixedPoolV5 {
    function token() external view returns (IERC20);
    function DENOMINATION() external view returns (uint256);
    function deposit(uint256 commitment) external;
    function withdraw(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256 root,
        uint256 nullifierHash,
        address recipient
    ) external;
}

/// @title Latheon Distribution Pool — wrapping variant (PROTOTYPE, testnet only, not audited)
/// @notice The unchanged V5 pools on a WETH-style wrapper; this router takes the native coin and wraps it itself,
///         so a depositor sends one transaction with no separate wrap and no approve.
///         Withdrawals cannot be unwrapped here without breaking the recipient binding: a proof made for the
///         router as recipient could be replayed by anyone with their own final address. So withdrawMany pays
///         the wrapped token to the recipient, exactly as the ERC-20 router does, and the recipient unwraps.
contract LatheonDistributionPoolWrapping {

    uint256 public constant POOL_COUNT = 4;
    uint256 public constant MAX_NOTES = 32;
    uint256 public constant MAX_WITHDRAWALS = 16;

    IWrappedNative public immutable token;
    IFixedPoolV5[POOL_COUNT] public pools;
    uint256[POOL_COUNT] public denominations;

    struct Withdrawal {
        uint256 pool;
        uint256[2] pA;
        uint256[2][2] pB;
        uint256[2] pC;
        uint256 root;
        uint256 nullifierHash;
    }

    event Distributed(address indexed depositor, uint256 amount, uint256 notes);
    event WithdrawnMany(address indexed recipient, uint256 notes);

    constructor(address wrapped, address[POOL_COUNT] memory poolAddresses) {
        token = IWrappedNative(wrapped);
        for (uint256 i = 0; i < POOL_COUNT; i++) {
            IFixedPoolV5 p = IFixedPoolV5(poolAddresses[i]);
            require(address(p) != address(0), "Zero pool");
            require(address(p.token()) == wrapped, "Pool token mismatch");
            uint256 d = p.DENOMINATION();
            require(d > 0, "Zero denomination");
            if (i > 0) require(denominations[i - 1] > d && denominations[i - 1] % d == 0, "Denominations must be descending and divide each other");
            pools[i] = p;
            denominations[i] = d;
        }
    }

    function split(uint256 amount) public view returns (uint256[POOL_COUNT] memory counts, uint256 total) {
        require(amount > 0, "Zero amount");
        require(amount % denominations[POOL_COUNT - 1] == 0, "Amount is not a multiple of the smallest denomination");
        uint256 rest = amount;
        for (uint256 i = 0; i < POOL_COUNT; i++) {
            counts[i] = rest / denominations[i];
            rest -= counts[i] * denominations[i];
            total += counts[i];
        }
    }

    /// @notice Deposit msg.value (native coin) as the canonical set of notes; wrapped here, no approve needed.
    function deposit(uint256 amount, uint256[] calldata commitments) external payable {
        require(msg.value == amount, "msg.value must equal amount");
        (uint256[POOL_COUNT] memory counts, uint256 total) = split(amount);
        require(total <= MAX_NOTES, "Too many notes");
        require(commitments.length == total, "Wrong number of commitments");
        for (uint256 i = 0; i < total; i++) {
            for (uint256 j = i + 1; j < total; j++) {
                require(commitments[i] != commitments[j], "Duplicate commitment");
            }
        }
        token.deposit{value: amount}();
        uint256 k = 0;
        for (uint256 i = 0; i < POOL_COUNT; i++) {
            if (counts[i] == 0) continue;
            require(token.approve(address(pools[i]), counts[i] * denominations[i]), "Approve failed");
            for (uint256 n = 0; n < counts[i]; n++) {
                pools[i].deposit(commitments[k]);
                k++;
            }
        }
        emit Distributed(msg.sender, amount, total);
    }

    function withdrawMany(Withdrawal[] calldata items, address recipient) external {
        require(items.length > 0, "No withdrawals");
        require(items.length <= MAX_WITHDRAWALS, "Too many withdrawals");
        for (uint256 i = 0; i < items.length; i++) {
            Withdrawal calldata w = items[i];
            require(w.pool < POOL_COUNT, "Unknown pool");
            pools[w.pool].withdraw(w.pA, w.pB, w.pC, w.root, w.nullifierHash, recipient);
        }
        emit WithdrawnMany(recipient, items.length);
    }
}
