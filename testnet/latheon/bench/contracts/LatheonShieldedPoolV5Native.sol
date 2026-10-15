// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PoseidonT3.sol";

interface IGroth16VerifierV3 {
    function verifyProof(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[3] calldata _pubSignals   // [root, nullifierHash, recipient]
    ) external view returns (bool);
}

/// @title Latheon Shielded Pool — V5, native-coin variant (PROTOTYPE, testnet only, not audited)
/// @notice LatheonShieldedPoolV5 with the chain's native coin instead of an ERC-20, for a chain whose gas token is
///         the coin users hold (no wrapping, no approve). Same circuit (withdraw_v3), same verifier, same tree,
///         root history, nullifiers and recipient binding. Differences from V5, and nothing else:
///           - deposit() is payable and requires msg.value == DENOMINATION;
///           - withdraw() pays the recipient with a native transfer AFTER the nullifier is recorded
///             (checks-effects-interactions), so a re-entering recipient finds the note already spent;
///           - if the recipient refuses the coin, the whole withdrawal reverts and the note stays unspent
///             (prove again for another recipient);
///           - token() returns address(0) as the marker of the native coin.
contract LatheonShieldedPoolV5Native {

    IGroth16VerifierV3 public immutable verifier;

    uint256 public immutable DENOMINATION;
    uint256 public constant LEVELS = 8;
    uint256 public constant ROOT_HISTORY_SIZE = 30;

    uint256[LEVELS] public filledSubtrees;
    uint256[LEVELS + 1] public zeros;

    uint32 public nextIndex;
    uint32 public currentRootIndex;
    uint256[ROOT_HISTORY_SIZE] public roots;

    mapping(uint256 => bool) public nullifierHashes;

    event Deposit(uint256 indexed commitment, uint32 leafIndex, uint256 timestamp);
    event Withdrawal(address indexed to, uint256 nullifierHash, uint256 timestamp);

    constructor(address verifierAddress, uint256 denomination) {
        require(denomination > 0, "Denomination must be positive");
        verifier = IGroth16VerifierV3(verifierAddress);
        DENOMINATION = denomination;

        uint256 currentZero = 0;
        zeros[0] = currentZero;
        for (uint256 i = 0; i < LEVELS; i++) {
            filledSubtrees[i] = currentZero;
            currentZero = PoseidonT3.hash([currentZero, currentZero]);
            zeros[i + 1] = currentZero;
        }
        roots[0] = currentZero;
    }

    /// @notice address(0): this pool holds the native coin.
    function token() external pure returns (address) { return address(0); }

    function _insert(uint256 leaf) internal returns (uint32) {
        uint32 idx = nextIndex;
        require(idx < uint32(2 ** LEVELS), "Tree is full");

        uint256 currentIndex = idx;
        uint256 currentHash = leaf;

        for (uint256 i = 0; i < LEVELS; i++) {
            uint256 left;
            uint256 right;
            if (currentIndex % 2 == 0) {
                left = currentHash;
                right = zeros[i];
                filledSubtrees[i] = currentHash;
            } else {
                left = filledSubtrees[i];
                right = currentHash;
            }
            currentHash = PoseidonT3.hash([left, right]);
            currentIndex /= 2;
        }

        currentRootIndex = (currentRootIndex + 1) % uint32(ROOT_HISTORY_SIZE);
        roots[currentRootIndex] = currentHash;
        nextIndex = idx + 1;
        return idx;
    }

    function isKnownRoot(uint256 _root) public view returns (bool) {
        if (_root == 0) return false;
        uint32 i = currentRootIndex;
        for (uint32 c = 0; c < ROOT_HISTORY_SIZE; c++) {
            if (roots[i] == _root) return true;
            if (i == 0) {
                i = uint32(ROOT_HISTORY_SIZE);
            }
            i--;
        }
        return false;
    }

    /// @notice Deposit exactly DENOMINATION of the native coin with the commitment computed off-chain.
    function deposit(uint256 commitment) external payable {
        require(msg.value == DENOMINATION, "Wrong amount");
        uint32 leafIndex = _insert(commitment);
        emit Deposit(commitment, leafIndex, block.timestamp);
    }

    /// @notice Withdraw with a proof bound to `recipient`; pays `recipient` DENOMINATION of the native coin.
    function withdraw(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256 root,
        uint256 nullifierHash,
        address recipient
    ) external {
        require(recipient != address(0), "Zero recipient");
        require(isKnownRoot(root), "Unknown root");
        require(!nullifierHashes[nullifierHash], "Note already spent");

        uint256[3] memory pubSignals = [root, nullifierHash, uint256(uint160(recipient))];
        require(verifier.verifyProof(_pA, _pB, _pC, pubSignals), "Invalid proof");

        nullifierHashes[nullifierHash] = true;   // effect before the transfer: re-entry finds the note spent

        (bool ok, ) = payable(recipient).call{value: DENOMINATION}("");
        require(ok, "Native transfer failed");

        emit Withdrawal(recipient, nullifierHash, block.timestamp);
    }
}
