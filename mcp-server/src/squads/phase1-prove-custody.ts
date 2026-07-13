/**
 * Phase 1 custody proof, run entirely off Slack, per moot/CLAUDE.md build order.
 *
 * What this proves, on real Solana devnet, nothing simulated:
 *   1. A real Squads v4 multisig where Moot's own key holds Initiate + Execute
 *      permissions and explicitly NOT Vote.
 *   2. A real deposit into the vault (a plain SPL transfer, exactly how a user
 *      would fund a treasury in production).
 *   3. A full proposal lifecycle: Moot drafts (vaultTransactionCreate +
 *      proposalCreate) -> two human members approve with their own keys
 *      (proposalApprove) -> Moot cranks execution (vaultTransactionExecute).
 *   4. A negative-authority proof: Moot's key alone attempting proposalApprove
 *      on an unapproved proposal must be rejected by the program itself, not
 *      by application logic. This is the load-bearing security claim of the
 *      whole product.
 *
 * Run: npm run phase1
 */
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { loadOrCreateKeypair } from "./keys.js";
import {
  approveProposal,
  createTreasuryMultisig,
  executeProposal,
  fullMemberPermissions,
  mootMemberPermissions,
  readProposal,
  submitProposal,
} from "./client.js";

const DECIMALS = 6;
const FUND_AMOUNT = 1_000 * 10 ** DECIMALS; // 1,000 test devUSDC into the vault
const TRANSFER_AMOUNT = 200 * 10 ** DECIMALS; // 200 test devUSDC proposed to Ada

function explorer(sig: string) {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

async function airdropIfNeeded(connection: Connection, pubkey: PublicKey, minSol = 0.5) {
  const balance = await connection.getBalance(pubkey);
  if (balance >= minSol * LAMPORTS_PER_SOL) {
    console.log(`  payer balance OK: ${balance / LAMPORTS_PER_SOL} SOL`);
    return;
  }
  console.log(`  requesting devnet airdrop for ${pubkey.toBase58()}...`);
  const attempts = 5;
  for (let i = 1; i <= attempts; i++) {
    try {
      const sig = await connection.requestAirdrop(pubkey, 1 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      console.log(`  airdropped 1 SOL: ${explorer(sig)}`);
      return;
    } catch (err) {
      const waitMs = i * 4000;
      console.log(`  attempt ${i}/${attempts} failed (${(err as Error).message}), retrying in ${waitMs}ms...`);
      if (i === attempts) {
        console.error(
          "  devnet airdrop failed after retries (public faucet is often rate-limited). " +
            `Fund this address manually: https://faucet.solana.com/?address=${pubkey.toBase58()}`
        );
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? clusterApiUrl("devnet");
  const connection = new Connection(rpcUrl, "confirmed");
  console.log(`Cluster: ${rpcUrl}\n`);

  // --- Identities ---------------------------------------------------------
  // payer: Moot's ops key in this proof script, pays all rent/fees.
  // moot: Moot's actual multisig member key, Initiate + Execute, no Vote.
  // alice, bob: two human test members, full voting permissions.
  // ada: payment recipient, not a multisig member.
  const payer = loadOrCreateKeypair("payer");
  const moot = loadOrCreateKeypair("moot");
  const alice = loadOrCreateKeypair("alice");
  const bob = loadOrCreateKeypair("bob");
  const ada = loadOrCreateKeypair("ada");
  const createKey = loadOrCreateKeypair("create-key"); // seeds the multisig PDA

  console.log("Identities:");
  console.log(`  payer (rent/fees) = ${payer.publicKey.toBase58()}`);
  console.log(`  moot  (no Vote)   = ${moot.publicKey.toBase58()}`);
  console.log(`  alice (Vote)      = ${alice.publicKey.toBase58()}`);
  console.log(`  bob   (Vote)      = ${bob.publicKey.toBase58()}`);
  console.log(`  ada   (recipient) = ${ada.publicKey.toBase58()}\n`);

  console.log("Step 1: fund payer with devnet SOL");
  await airdropIfNeeded(connection, payer.publicKey);

  console.log("\nStep 2: create a real Squads v4 multisig");
  const { multisigPda, vaultPda, signature: createSig } = await createTreasuryMultisig({
    connection,
    payer,
    createKey,
    threshold: 2,
    timeLockSeconds: 0,
    members: [
      { publicKey: moot.publicKey, permissions: mootMemberPermissions() },
      { publicKey: alice.publicKey, permissions: fullMemberPermissions() },
      { publicKey: bob.publicKey, permissions: fullMemberPermissions() },
    ],
  });
  console.log(`  multisig = ${multisigPda.toBase58()}`);
  console.log(`  vault    = ${vaultPda.toBase58()}`);
  console.log(createSig ? `  tx       = ${explorer(createSig)}` : `  (multisig already existed, reused)`);

  console.log("\nStep 3: fund the vault (plain SPL deposit, no multisig involved)");
  const mint = await createMint(connection, payer, payer.publicKey, null, DECIMALS);
  console.log(`  test devUSDC mint = ${mint.toBase58()} (self-issued for this proof script;`);
  console.log(`  production uses the real Circle devnet mint in config/tokens.devnet.json)`);

  const payerAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
  const vaultAta = getAssociatedTokenAddressSync(mint, vaultPda, true);
  const adaAta = getAssociatedTokenAddressSync(mint, ada.publicKey, true);

  const setupTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, payerAta, payer.publicKey, mint),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, vaultAta, vaultPda, mint),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, adaAta, ada.publicKey, mint)
  );
  await sendAndConfirmTransaction(connection, setupTx, [payer]);

  await mintTo(connection, payer, mint, payerAta, payer, FUND_AMOUNT);
  const depositSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      createTransferInstruction(payerAta, vaultAta, payer.publicKey, FUND_AMOUNT)
    ),
    [payer]
  );
  console.log(`  deposited ${FUND_AMOUNT / 10 ** DECIMALS} devUSDC into vault: ${explorer(depositSig)}`);

  console.log("\nStep 4: Moot drafts a proposal (vaultTransactionCreate + proposalCreate)");
  const transferIx = createTransferInstruction(vaultAta, adaAta, vaultPda, TRANSFER_AMOUNT);
  const { transactionIndex, vaultTransactionSignature, proposalSignature } =
    await submitProposal({
      connection,
      payer,
      creator: moot,
      multisigPda,
      instructions: [transferIx],
      memo: "pay Ada 200 devUSDC for the logo work",
    });
  console.log(`  transactionIndex = ${transactionIndex}`);
  console.log(`  vaultTransactionCreate = ${explorer(vaultTransactionSignature)}`);
  console.log(`  proposalCreate         = ${explorer(proposalSignature)}`);

  console.log("\nStep 5: negative-authority proof -- Moot alone tries to approve, must fail");
  let mootApprovalWronglySucceeded = false;
  try {
    await approveProposal({
      connection,
      payer,
      member: moot,
      multisigPda,
      transactionIndex,
    });
    mootApprovalWronglySucceeded = true;
  } catch (err: any) {
    console.log(`  correctly rejected by the program: ${err?.message ?? err}`);
  }
  if (mootApprovalWronglySucceeded) {
    throw new Error(
      "SECURITY FAILURE: Moot's key was able to approve a proposal. This must never happen."
    );
  }

  console.log("\nStep 6: real human members approve with their own keys");
  const aliceApproveSig = await approveProposal({
    connection,
    payer,
    member: alice,
    multisigPda,
    transactionIndex,
  });
  console.log(`  alice approved: ${explorer(aliceApproveSig)}`);

  const bobApproveSig = await approveProposal({
    connection,
    payer,
    member: bob,
    multisigPda,
    transactionIndex,
  });
  console.log(`  bob approved:   ${explorer(bobApproveSig)}`);

  const proposalAfterApprovals = await readProposal(connection, multisigPda, transactionIndex);
  console.log(`  on-chain proposal status: ${JSON.stringify(proposalAfterApprovals.status)}`);

  console.log("\nStep 7: Moot cranks execution of the already-approved transfer");
  const execSig = await executeProposal({
    connection,
    payer,
    executor: moot,
    multisigPda,
    transactionIndex,
  });
  console.log(`  executed: ${explorer(execSig)}`);

  const adaBalance = await getAccount(connection, adaAta);
  const vaultBalance = await getAccount(connection, vaultAta);
  console.log(`\nFinal balances:`);
  console.log(`  Ada's devUSDC:   ${Number(adaBalance.amount) / 10 ** DECIMALS}`);
  console.log(`  vault's devUSDC: ${Number(vaultBalance.amount) / 10 ** DECIMALS}`);

  console.log("\nCustody model proven on-chain:");
  console.log("  - Moot's key cannot approve (no Vote permission, program-enforced).");
  console.log("  - Real member signatures were required to reach threshold.");
  console.log("  - Moot could only crank execution of an already-approved transaction.");
}

main().catch((err) => {
  console.error("\nPhase 1 script failed:", err);
  process.exit(1);
});
