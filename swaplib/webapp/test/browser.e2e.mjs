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
  await A.getByText(choiceText).click();                       // 1: direction
  await A.getByRole("button", { name: "Trade directly with a peer" }).click({ timeout: 20000 }); // 1a: market -> peer
  await A.getByRole("button", { name: /agreed a trade/ }).click({ timeout: 20000 }); // 1b: confirm counterparty
  await clickBtn(A, "Continue");                               // 2: amount
  await addrFilled(A); await clickBtn(A, "Continue");          // 3: receive address
  await addrFilled(A); await clickBtn(A, "Create swap");       // 4: refund address -> create
  const dl1 = A.waitForEvent("download", { timeout: 15000 });
  await A.getByRole("button", { name: "Download backup file" }).click(); await dl1; // 5: download
  await A.locator("input[type=checkbox]").check();             // 5b: confirm saved -> enables Continue
  await clickBtn(A, "Continue");
  const link = (await A.locator(".mono").first().innerText()).trim();
  await clickBtn(A, "Copy link");                              // 6: share
  await clickBtn(A, "I have shared the link with my counterparty"); // 6b: confirm shared -> live
  await A.waitForSelector("text=Waiting for your counterparty", { timeout: 15000 });
  console.log("  creator waiting for counterparty ✓");

  const B = await ctx.newPage(); await B.goto(link);
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

  await A.waitForSelector(".fund .mono", { timeout: 20000 });
  await B.waitForSelector(".fund .mono", { timeout: 20000 });
  await fundAddr((await depositAddr(A)).trim());          // user sends — here the node wallets stand in
  await fundAddr((await depositAddr(B)).trim());
  console.log("  both deposits sent (manual funding) ✓");
  let a = "", bb = ""; const end = Date.now() + 150000;
  while (Date.now() < end) { a = await badge(A); bb = await badge(B); if (a === "COMPLETE" && bb === "COMPLETE") break; await sleep(3000); }
  console.log(`  creator=${a} participant=${bb}`);
  await ctx.close();
  return a === "COMPLETE" && bb === "COMPLETE";
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const r1 = await runDirection(browser, "I have BTC", "btc2qbt");
const r2 = await runDirection(browser, "I have QBT", "qbt2btc");
await browser.close();
console.log(`\n${r1 && r2 ? "PASS — wizard works both directions, one decision per screen" : "FAIL"}`);
process.exit(r1 && r2 ? 0 : 1);
