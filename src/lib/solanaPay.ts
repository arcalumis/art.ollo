import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

/**
 * The SOL transfer for a payment request. The server-issued reference key is appended to the
 * transfer instruction as a read-only, non-signer account (the Solana Pay pattern): the server
 * only accepts a transaction that carries the reference of the payment being verified.
 */
export function buildPaymentTransaction(
	from: PublicKey,
	payment: { recipientWallet: string; amountLamports: number; reference: string },
): Transaction {
	const transfer = SystemProgram.transfer({
		fromPubkey: from,
		toPubkey: new PublicKey(payment.recipientWallet),
		lamports: payment.amountLamports,
	});
	transfer.keys.push({ pubkey: new PublicKey(payment.reference), isSigner: false, isWritable: false });
	return new Transaction().add(transfer);
}
