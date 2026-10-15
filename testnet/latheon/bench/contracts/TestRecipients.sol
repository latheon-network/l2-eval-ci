// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPoolW {
    function withdraw(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256, uint256, address) external;
}

/// @dev Test only: a recipient that refuses the native coin.
contract RefusingRecipient {
    receive() external payable { revert("no thanks"); }
}

/// @dev Test only: a recipient that, when paid, tries to withdraw the same note again (same proof, same nullifier).
contract ReenteringRecipient {
    IPoolW public pool;
    uint256[2] a; uint256[2][2] b; uint256[2] c; uint256 root; uint256 nh;
    bool public armed;
    bool public reentrySucceeded;
    uint256 public payments;
    string public reentryError;

    function arm(address p, uint256[2] calldata pA, uint256[2][2] calldata pB, uint256[2] calldata pC, uint256 r, uint256 n) external {
        pool = IPoolW(p); a = pA; b = pB; c = pC; root = r; nh = n; armed = true;
    }

    receive() external payable {
        payments++;
        if (!armed) return;
        armed = false;
        try pool.withdraw(a, b, c, root, nh, address(this)) { reentrySucceeded = true; }
        catch Error(string memory why) { reentryError = why; }
    }
}
