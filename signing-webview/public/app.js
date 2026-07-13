const params = new URLSearchParams(window.location.search);
const mode = params.get("mode");
const appEl = document.getElementById("app");
const statusEl = document.getElementById("status");

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#d33" : "inherit";
}

function getProvider() {
  if (window.solana && window.solana.isPhantom) return window.solana;
  if (window.solana) return window.solana;
  if (window.solflare) return window.solflare;
  return null;
}

async function connectWallet() {
  const provider = getProvider();
  if (!provider) {
    setStatus("No Solana wallet found. Install Phantom (phantom.app) and reload this page.", true);
    throw new Error("no wallet");
  }
  const resp = await provider.connect();
  return { provider, pubkey: resp.publicKey ?? provider.publicKey };
}

async function apiGet(path) {
  const res = await fetch(path);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error ?? `request to ${path} failed`);
  return data;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error ?? `request to ${path} failed`);
  return data;
}

async function runLinkMode() {
  const challengeId = params.get("challengeId");
  const token = params.get("token");
  if (!challengeId || !token) {
    appEl.textContent = "Missing link parameters. Ask Moot to run /moot link-wallet again.";
    return;
  }

  let message;
  try {
    ({ message } = await apiGet(
      `/api/link/message?challengeId=${encodeURIComponent(challengeId)}&token=${encodeURIComponent(token)}`
    ));
  } catch (err) {
    appEl.textContent = err.message ?? String(err);
    return;
  }

  appEl.innerHTML = `
    <p>Connect your wallet to prove you own it. This does not authorize any payment.</p>
    <pre style="white-space:pre-wrap;font-size:12px;background:rgba(128,128,128,0.1);padding:10px;border-radius:8px;">${message}</pre>
    <button id="go" class="primary">Connect wallet and sign</button>
  `;

  document.getElementById("go").addEventListener("click", async () => {
    try {
      setStatus("Connecting wallet...");
      const { provider, pubkey } = await connectWallet();
      setStatus("Requesting signature...");
      const encoded = new TextEncoder().encode(message);
      const { signature } = await provider.signMessage(encoded, "utf8");
      const signatureBase64 = btoa(String.fromCharCode(...signature));

      setStatus("Verifying with Moot...");
      await api("/api/link/complete", {
        challengeId,
        pubkeyBase58: pubkey.toString(),
        signatureBase64,
        token,
      });

      appEl.innerHTML = `<p>Wallet linked: <code>${pubkey.toString()}</code></p><p>You can close this tab and go back to Slack.</p>`;
      setStatus("");
    } catch (err) {
      setStatus(err.message ?? String(err), true);
    }
  });
}

async function runApproveMode() {
  const treasuryId = params.get("treasuryId");
  const proposalId = params.get("proposalId");
  const token = params.get("token");
  if (!treasuryId || !proposalId || !token) {
    appEl.textContent = "Missing approval parameters.";
    return;
  }

  appEl.innerHTML = `<p>Connect your wallet to review this proposal.</p><button id="connect" class="primary">Connect wallet</button>`;

  document.getElementById("connect").addEventListener("click", async () => {
    try {
      setStatus("Connecting wallet...");
      const { provider, pubkey } = await connectWallet();

      setStatus("Loading proposal...");
      const { unsignedTransactionBase64, proposal, state } = await api("/api/approval/unsigned", {
        treasuryId,
        proposalId,
        memberPubkey: pubkey.toString(),
        token,
      });

      appEl.innerHTML = `
        <div class="row"><span>Recipient</span><span>${proposal.recipient}</span></div>
        <div class="row"><span>Amount</span><span>${proposal.amount} ${proposal.token}</span></div>
        ${proposal.memo ? `<div class="row"><span>Memo</span><span>${proposal.memo}</span></div>` : ""}
        <div class="row"><span>Approvals</span><span>${state.approvals.length} of ${state.requiredApprovals ?? state.threshold}</span></div>
        <p class="muted">Signing this submits your real on-chain approval. It only executes once enough members have approved.</p>
        <button id="approve" class="primary">Approve</button>
      `;

      document.getElementById("approve").addEventListener("click", async () => {
        try {
          setStatus("Requesting signature...");
          const txBytes = Uint8Array.from(atob(unsignedTransactionBase64), (c) => c.charCodeAt(0));
          const tx = solanaWeb3.VersionedTransaction.deserialize(txBytes);
          const signedTx = await provider.signTransaction(tx);
          const signedBytes = signedTx.serialize();
          const signedTransactionBase64 = btoa(String.fromCharCode(...signedBytes));

          setStatus("Submitting approval...");
          const { txSignature } = await api("/api/approval/relay", { signedTransactionBase64 });

          appEl.innerHTML = `<p>Approved. <a href="https://explorer.solana.com/tx/${txSignature}?cluster=devnet" target="_blank">View on Explorer</a></p><p>You can close this tab.</p>`;
          setStatus("");
        } catch (err) {
          setStatus(err.message ?? String(err), true);
        }
      });
      setStatus("");
    } catch (err) {
      setStatus(err.message ?? String(err), true);
    }
  });
}

if (mode === "link") {
  runLinkMode();
} else if (mode === "approve") {
  runApproveMode();
} else {
  appEl.textContent = "Unknown or missing mode.";
}
