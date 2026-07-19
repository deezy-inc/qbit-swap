// WebAuthn passkey with the PRF extension: derive a stable per-credential secret used to wrap the
// vault DEK (see keystore.js). Browser-only. Enroll once (create), then unlock returns the 32-byte
// PRF secret. The passkey never leaves the authenticator; only the derived secret reaches the page.
const PRF_SALT = new TextEncoder().encode("qbit-swap/prf-salt-v1");
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export function passkeySupported() {
  return typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;
}

// Create a resident passkey and obtain its PRF secret. Most authenticators do NOT return PRF results
// at creation, so we request an eval at create and, if the secret isn't returned there, fetch it via
// a follow-up assertion. Throws "UNSUPPORTED" when the authenticator has no PRF (hmac-secret) at all.
// Returns { credentialId, prfSecret }.
export async function enrollPasskeyPRF({ rpName = "qbit-swap", userName = "swap" } = {}) {
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: rand(32),
    rp: { name: rpName },
    user: { id: rand(16), name: userName, displayName: userName },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    extensions: { prf: { eval: { first: PRF_SALT } } },
  } });
  const credentialId = new Uint8Array(cred.rawId);
  const ext = cred.getClientExtensionResults?.() || {};
  let prf = ext.prf?.results?.first;                 // some platforms return it right here
  if (!prf) {
    if (ext.prf?.enabled === false) throw new Error("UNSUPPORTED");   // authenticator lacks PRF
    prf = await passkeyPRF(credentialId).catch(() => null);           // otherwise fetch via assertion
    if (!prf) throw new Error("UNSUPPORTED");
  }
  return { credentialId, prfSecret: new Uint8Array(prf) };
}

// Unlock: run an assertion evaluating the PRF at our fixed salt; return the 32-byte secret.
export async function passkeyPRF(credentialId) {
  const assertion = await navigator.credentials.get({ publicKey: {
    challenge: rand(32),
    allowCredentials: credentialId ? [{ type: "public-key", id: credentialId }] : [],
    userVerification: "preferred",
    extensions: { prf: { eval: { first: PRF_SALT } } },
  } });
  const prf = assertion.getClientExtensionResults()?.prf?.results?.first;
  if (!prf) throw new Error("this authenticator did not return a PRF result");
  return new Uint8Array(prf);
}
