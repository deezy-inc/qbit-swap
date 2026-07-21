// Real-browser wizard test: Playwright drives the one-decision-per-screen wizard (creator +
// participant) in BOTH directions to COMPLETE. Funding is done from the node wallets (the product UI
// only shows the deposit address — the user sends). Point it at a running trial (see deploy/trial.js).
// Run:  TRIAL_URL=https://<host> DEV_CONFS_CAP=2 node test/browser.e2e.mjs
import { chromium } from "playwright";
import { qbit, btc } from "../../coordinator/chain.js";

const URL = process.env.TRIAL_URL || "http://127.0.0.1:8080";
// Fund a deposit address from whichever node wallet holds that coin (detected by address prefix).
const fundAddr = (addr) => addr.startsWith("qbrt1") ? qbit.rpcWallet("bob", "sendtoaddress", addr, 5) : btc.rpcWallet("alice", "sendtoaddress", addr, 1);
const depositAddr = (pg) => pg.locator(".fund .mono").first().innerText();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addrFilled = (pg) => pg.waitForFunction(() => { const i = document.querySelector(".card input"); return i && i.value && i.value.length > 15; }, { timeout: 15000 });
const clickBtn = (pg, name) => pg.getByRole("button", { name, exact: true }).click({ timeout: 20000 });
const badge = (pg) => pg.locator(".badge").first().innerText().catch(() => "");

async function runDirection(browser, choiceText, label) {
  console.log(`\n[${label}]`);
  const ctx = await browser.newContext();
  const A = await ctx.newPage(); await A.goto(URL);
  await clickBtn(A, "Start a swap");                           // 0: hero landing -> chooser
  await A.getByText(choiceText, { exact: true }).click();     // 1: buy/sell QBT (order book flagged off -> straight to peer)
  await A.getByRole("button", { name: /agreed to a price/ }).click({ timeout: 20000 }); // 1b: confirm counterparty
  // 2: amounts — fill "you send" + "you receive" so the deal is 1 BTC / 5 QBT (matches fundAddr below).
  const sendAmt = choiceText === "Buy QBT" ? "1" : "5", recvAmt = choiceText === "Buy QBT" ? "5" : "1";
  await A.locator(".card input").nth(0).fill(sendAmt);
  await A.locator(".card input").nth(1).fill(recvAmt);
  await clickBtn(A, "Continue");
  await addrFilled(A); await clickBtn(A, "Continue");          // 3: receive address
  await addrFilled(A); await clickBtn(A, "Create swap");       // 4: refund address -> create
  const dl1 = A.waitForEvent("download", { timeout: 15000 });
  await A.getByRole("button", { name: "Download backup file" }).click(); await dl1; // 5: download
  await A.locator("input[type=checkbox]").check();             // 5b: confirm saved -> enables Continue
  await clickBtn(A, "Continue");
  const link = (await A.locator(".mono").first().innerText()).trim();
  await clickBtn(A, "Copy link");                              // 6: share (copying reveals Continue)
  await clickBtn(A, "Continue");                               // 6b: go live
  await A.waitForSelector("text=Waiting for your counterparty", { timeout: 15000 });
  console.log("  creator waiting for counterparty ✓");

  // Participant runs in a SEPARATE browser context: same-context would share A's Vault, and opening the
  // invite link there resumes A's own swap (the vault-resume-on-link path) instead of joining fresh.
  const ctxB = await browser.newContext(); const B = await ctxB.newPage(); await B.goto(link);
  await clickBtn(B, "Continue");                               // invited
  await addrFilled(B); await clickBtn(B, "Continue");          // receive
  await addrFilled(B); await clickBtn(B, "Join swap");         // refund -> join
  const dl2 = B.waitForEvent("download", { timeout: 15000 });
  await B.getByRole("button", { name: "Download backup file" }).click(); await dl2;
  await B.locator("input[type=checkbox]").check();
  await clickBtn(B, "Continue");
  console.log("  participant joined ✓");

  // presence: once both hold their live screens, each should see the other online
  await A.waitForSelector("text=Your counterparty is online", { timeout: 20000 });
  await B.waitForSelector("text=Your counterparty is online", { timeout: 20000 });
  console.log("  presence: both see counterparty online ✓");

  // Address verification gate: each side must confirm their receive + refund addresses before the
  // deposit address is revealed.
  for (const pg of [A, B]) {
    await pg.getByRole("button", { name: "Begin verification", exact: true }).click({ timeout: 20000 });
    await clickBtn(pg, "Yes, it's mine");   // receiving address
    await clickBtn(pg, "Yes, it's mine");   // refund address
  }
  console.log("  both verified their addresses ✓");

  // Sequenced funding: the BTC (buyer) deposit address shows immediately; the QBT (seller) address is
  // withheld until the BTC deposit confirms. So fund BTC first, then the QBT side once it unlocks.
  // Buy QBT: creator(A)=buyer funds BTC, joiner(B)=seller funds QBT. Sell QBT: the reverse.
  const btcPage = choiceText === "Buy QBT" ? A : B;
  const qbtPage = choiceText === "Buy QBT" ? B : A;
  await btcPage.waitForSelector(".fund .mono", { timeout: 20000 });
  await fundAddr((await depositAddr(btcPage)).trim());     // user sends — here the node wallets stand in
  console.log("  BTC deposit sent; waiting for it to confirm before QBT address unlocks…");
  await qbtPage.waitForSelector(".fund .mono", { timeout: 90000 });   // unlocks only after BTC buries
  await fundAddr((await depositAddr(qbtPage)).trim());
  console.log("  both deposits sent (BTC first, QBT after confirmation) ✓");
  let a = "", bb = ""; const end = Date.now() + 150000;
  while (Date.now() < end) { a = await badge(A); bb = await badge(B); if (a === "COMPLETE" && bb === "COMPLETE") break; await sleep(3000); }
  console.log(`  creator=${a} participant=${bb}`);
  await ctx.close(); await ctxB.close();
  return a === "COMPLETE" && bb === "COMPLETE";
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const r1 = await runDirection(browser, "Buy QBT", "creator buys QBT (creator initiates)");
const r2 = await runDirection(browser, "Sell QBT", "creator sells QBT (joiner initiates)");
await browser.close();
console.log(`\n${r1 && r2 ? "PASS — wizard works both directions, one decision per screen" : "FAIL"}`);
process.exit(r1 && r2 ? 0 : 1);
