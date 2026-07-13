import { Keypair, PublicKey } from "@solana/web3.js";
import {
  createTreasuryMultisig,
  fullMemberPermissions,
  mootMemberPermissions,
  readMultisig,
  vaultAddress as deriveVaultAddress,
} from "../squads/client.js";
import { getConnection, getMootKeypair, getPayerKeypair, getTokenMint } from "../config.js";
import { requireLinkedWallet } from "./linkWallet.js";
import { getTreasury, listTreasuries, saveTreasury, Treasury } from "../store.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

export interface CreateTreasuryInput {
  teamId: string;
  channelId: string;
  creatorSlackId: string;
  name: string;
  memberSlackIds: string[];
  threshold: number;
  timeLockSeconds?: number;
  tokens: string[];
}

export interface CreateTreasuryResult {
  treasuryId: string;
  multisigAddress: string;
  vaultAddress: string;
  summary: string;
}

export async function createTreasury(input: CreateTreasuryInput): Promise<CreateTreasuryResult> {
  const { teamId, channelId, name, memberSlackIds, threshold, timeLockSeconds = 0, tokens } = input;

  if (memberSlackIds.length === 0) {
    throw new Error("a treasury needs at least one wallet-linked member");
  }
  if (threshold < 1 || threshold > memberSlackIds.length) {
    throw new Error(
      `threshold must be between 1 and the number of members (${memberSlackIds.length})`
    );
  }
  if (await findTreasuryByNameLocal(teamId, channelId, name)) {
    throw new Error(`a treasury named "${name}" already exists in this channel`);
  }

  const memberPubkeys = memberSlackIds.map((id) => new PublicKey(requireLinkedWallet(teamId, id)));
  const moot = getMootKeypair();
  const payer = getPayerKeypair();
  const createKey = Keypair.generate();

  const { multisigPda, vaultPda } = await createTreasuryMultisig({
    connection: getConnection(),
    payer,
    createKey,
    threshold,
    timeLockSeconds,
    members: [
      { publicKey: moot.publicKey, permissions: mootMemberPermissions() },
      ...memberPubkeys.map((pk) => ({ publicKey: pk, permissions: fullMemberPermissions() })),
    ],
  });

  const treasuryId = multisigPda.toBase58();
  const treasury: Treasury = {
    treasuryId,
    teamId,
    channelId,
    name,
    multisigPda: multisigPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    threshold,
    timeLockSeconds,
    tokens,
    memberSlackIds,
    // The creator is the "treasury-admins" default: they're the one who set up
    // the treasury's policy in the first place. A future /moot treasury admins
    // command can adjust this; there's no UI for it yet.
    adminSlackIds: [input.creatorSlackId],
    createdAtMs: Date.now(),
  };
  saveTreasury(treasury);

  const summary =
    `Created "${name}": ${memberSlackIds.length} member(s), needs ${threshold} approval(s) per transfer` +
    (timeLockSeconds > 0 ? `, plus a ${timeLockSeconds}s cooldown after threshold` : "") +
    `. Deposit address: ${vaultPda.toBase58()}`;

  return {
    treasuryId,
    multisigAddress: multisigPda.toBase58(),
    vaultAddress: vaultPda.toBase58(),
    summary,
  };
}

async function findTreasuryByNameLocal(teamId: string, channelId: string, name: string) {
  return listTreasuries(teamId, channelId).find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? null;
}

export async function findTreasury(teamId: string, channelId: string, name: string): Promise<Treasury | null> {
  return findTreasuryByNameLocal(teamId, channelId, name);
}

export async function listTreasuriesForChannel(teamId: string, channelId: string): Promise<Treasury[]> {
  return listTreasuries(teamId, channelId);
}

export interface TreasuryStateResult {
  treasury: Treasury;
  balances: { token: string; amount: string }[];
}

export async function getTreasuryState(treasuryId: string): Promise<TreasuryStateResult> {
  const treasury = getTreasury(treasuryId);
  if (!treasury) throw new Error(`no treasury found for id ${treasuryId}`);

  const connection = getConnection();
  const vaultPda = new PublicKey(treasury.vaultPda);

  // Confirms the multisig still exists on-chain and re-derives, rather than trusting cache blindly.
  await readMultisig(connection, new PublicKey(treasury.multisigPda));

  const balances = await Promise.all(
    treasury.tokens.map(async (symbol) => {
      try {
        const mint = getTokenMint(symbol);
        const ata = getAssociatedTokenAddressSync(mint, vaultPda, true);
        const account = await connection.getTokenAccountBalance(ata);
        return { token: symbol, amount: account.value.uiAmountString ?? "0" };
      } catch {
        return { token: symbol, amount: "0" };
      }
    })
  );

  return { treasury, balances };
}

export { deriveVaultAddress };
