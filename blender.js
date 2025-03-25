require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const chalk = require("chalk");
const Table = require("cli-table3");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Configuration
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL;
const RECIPIENT_ADDRESS = process.env.RECIPIENT_ADDRESS;

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Updated ABI
const contractAbi = [
  "function deposit(bytes32 hashedSecret) external payable",
  "function withdraw(bytes calldata secret, address recipient) external",
  "function FEE_AMOUNT() external view returns (uint256)",
  "event Deposited(bytes32 indexed hashedSecret, uint256 amount)",
  "event Withdrawn(address indexed recipient, uint256 amount, uint256 gasCompensation)",
];

const tokenAbi = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
];

const contract = new ethers.Contract(CONTRACT_ADDRESS, contractAbi, wallet);
const tokenContract = new ethers.Contract(TOKEN_ADDRESS, tokenAbi, wallet);
const secretsFile = path.join(__dirname, "secrets.json");

// Function to save secret details
function saveSecret(secretHex, hashedSecret, amount) {
  const secrets = fs.existsSync(secretsFile)
    ? JSON.parse(fs.readFileSync(secretsFile))
    : {};

  secrets[hashedSecret] = {
    secretHex,
    amount: amount.toString(),
    createdAt: Date.now(),
  };

  fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2));
}

// Enhanced console logging function
function logSuccess(message) {
  console.log(chalk.green(`✅ ${message}`));
}

function logError(message) {
  console.log(chalk.red(`❌ ${message}`));
}

function logWarning(message) {
  console.log(chalk.yellow(`⚠️ ${message}`));
}

// Function to display the balances of PEPU and BLENDER tokens
async function displayBalances() {
  // Fetch BLENDER balance
  const blenderBalance = await tokenContract.balanceOf(wallet.address);
  const pepuBalance = await wallet.getBalance(); // PEPU is typically the native token
  
  // Display balances in a table
  const balanceTable = new Table({
    head: [chalk.white("Token"), chalk.white("Balance")],
    colWidths: [20, 30],
  });

  balanceTable.push(
    ["BLENDER", ethers.utils.formatUnits(blenderBalance, 18)],
    ["PEPU", ethers.utils.formatUnits(pepuBalance, 18)]
  );
  
  console.log(balanceTable.toString());
}

// Function to handle deposit
async function deposit() {
  try {
    // Display balances before the deposit
    await displayBalances();

    // Get required fee
    const feeAmount = await contract.FEE_AMOUNT();
    console.log(
      chalk.blueBright(`Required fee: ${ethers.utils.formatUnits(feeAmount, 18)} BLENDER`)
    );

    // Check token balance
    const blenderBalance = await tokenContract.balanceOf(wallet.address);
    if (blenderBalance.lt(feeAmount)) {
      throw new Error("Insufficient BLENDER balance to cover the fee.");
    }

    // Get deposit amount
    const amount = await new Promise((resolve) =>
      rl.question(chalk.cyan("Enter deposit amount in PEPU: "), resolve)
    );
    const depositAmount = ethers.utils.parseEther(amount);

    // Check if the deposit amount is valid
    const validAmounts = [100, 1000, 10000, 100000, 1000000];
    if (!validAmounts.includes(Number(amount))) {
      console.log(chalk.red("Error: Invalid deposit amount."));
      console.log(chalk.yellow(`Allowed amounts are: ${validAmounts.join(', ')} PEPU.`));
      throw new Error(`Invalid deposit amount. Allowed amounts are: ${validAmounts.join(", ")} PEPU.`);
    }

    // Check PEPU balance
    const ethBalance = await wallet.getBalance();
    if (ethBalance.lt(depositAmount)) {
      throw new Error("Insufficient PEPU balance.");
    }

    // Approve transaction
    const allowance = await tokenContract.allowance(wallet.address, CONTRACT_ADDRESS);
    if (allowance.lt(feeAmount)) {
      console.log(chalk.yellow("Requesting token transfer approval..."));
      const tx = await tokenContract.approve(CONTRACT_ADDRESS, feeAmount);
      await tx.wait();
    }

    // Generate secret and hash
    const secretBytes = ethers.utils.randomBytes(32);
    const secretHex = ethers.utils.hexlify(secretBytes);
    const hashedSecret = ethers.utils.keccak256(ethers.utils.solidityPack(["bytes"], [secretBytes]));

    // Execute deposit transaction
    const tx = await contract.deposit(hashedSecret, {
      value: depositAmount,
      gasLimit: 250000,
    });

    await tx.wait();
    
    // After successful tx, display secret details
    console.log(chalk.magenta("Generated Secret Details:"));
    const table = new Table({
      head: [chalk.white("Attribute"), chalk.white("Value")],
      colWidths: [20, 70],
    });
    table.push(
      ["Raw Secret", secretHex],
      ["Hashed Secret", hashedSecret]
    );
    console.log(table.toString());

    // Save the secret information after transaction
    saveSecret(secretHex, hashedSecret, depositAmount);

    logSuccess(`Deposit successful! TX: ${tx.hash}`);

    // Display balances after the deposit
    await displayBalances();
  } catch (error) {
    console.error(chalk.red(error.message)); // Outputting error message in red
  }
}

// Withdraw function
async function withdraw() {
  try {
    const hashedSecret = await selectDeposit();
    const secrets = JSON.parse(fs.readFileSync(secretsFile));

    if (!secrets[hashedSecret]?.secretHex) {
      throw new Error("Invalid deposit data structure");
    }

    const secretBytes = ethers.utils.arrayify(secrets[hashedSecret].secretHex);

    // Execute withdrawal transaction
    const tx = await contract.withdraw(secretBytes, RECIPIENT_ADDRESS, {
      gasLimit: 100000,
    });

    await tx.wait();
    logSuccess(`Withdrawal successful! TX: ${tx.hash}`);

    // After withdrawal, display updated balances
    await displayBalances();
  } catch (error) {
    logError(error.message);
  }
}

// Select a deposit
async function selectDeposit() {
  if (!fs.existsSync(secretsFile)) throw new Error("Secrets file not found.");
  const secrets = JSON.parse(fs.readFileSync(secretsFile));

  const hashes = Object.keys(secrets);
  if (hashes.length === 0) throw new Error("No available deposits.");

  console.log(chalk.blue("\nAvailable deposits:"));
  hashes.forEach((hash, index) => {
    const dt = new Date(secrets[hash].createdAt);
    console.log(`${index + 1} - ${hash} (${dt.toLocaleDateString()})`);
  });

  const choice = await new Promise((resolve) =>
    rl.question(chalk.cyan("Select a deposit: "), resolve)
  );
  return hashes[choice - 1];
}

// Stylish ASCII banner
function showBanner() {
  const blenderASCII = `
┳┓┓ ┏┓┳┓┳┓┏┓┳┓  ┏┓┓ ┳
┣┫┃ ┣ ┃┃┃┃┣ ┣┫  ┃ ┃ ┃
┻┛┗┛┗┛┛┗┻┛┗┛┛┗  ┗┛┗┛┻
                v.1.0
`;
  console.log(chalk.green(blenderASCII));
}

// Display menu
function showMenu() {
  showBanner();
  console.log(chalk.magenta("1 — Deposit"));
  console.log(chalk.blue("2 — Withdraw"));
  console.log(chalk.white("0 — Exit"));
  console.log((""));
  rl.question(chalk.green("➡️  Your choice: "), async (choice) => {
    switch (choice) {
      case "1":
        await deposit();
        break;
      case "2":
        await withdraw();
        break;
      case "0":
        process.exit(0);
      default:
        logWarning("Invalid choice");
    }
    showMenu();
  });
}

showMenu();
