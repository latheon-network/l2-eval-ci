// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title WrappedLTH (WLTH) for the Latheon test chain
/// @notice On the Latheon test chain LTH is the native currency (it pays gas). The V5 pools and the distribution
///         router take an ERC-20, so they run on this wrapper, unchanged from the other testnets. 1 WLTH is always
///         backed by 1 LTH held by this contract: deposit() wraps, withdraw() unwraps. Same semantics as WETH9.
///         No owner, no fee, no upgrade path, no mint other than against deposited LTH. Testnet only, not reviewed.
contract WrappedLTH is ERC20 {
    event Deposit(address indexed account, uint256 amount);
    event Withdrawal(address indexed account, uint256 amount);

    constructor() ERC20("Wrapped LTH", "WLTH") {}

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        emit Withdrawal(msg.sender, amount);
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "LTH transfer failed");
    }
}
