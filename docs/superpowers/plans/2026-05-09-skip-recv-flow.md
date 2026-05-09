# Skip / RECV Flow Redesign (v5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make recv-pos use Gemini's extracted RECV number automatically (no user reply), make "skip" append a `รอเลข` sheet row for invoice/shipping-cost, and write column A (date) for recv-pos rows.

**Architecture:** All changes are in `api/webhook.js`. Task 1 updates the shared `updateSheetLink` function first since all other tasks depend on its new signature. Tasks 2–4 then modify the three call sites independently. Task 5 deploys and verifies via the live bot.

**Tech Stack:** Vercel Edge Runtime, Google Sheets API v4 (batchUpdate + append), LINE Messaging API, Upstash Redis

---

## File Map

| File | Change |
|---|---|
| `api/webhook.js` | All 4 code changes — no other files touched |

---

### Task 1: updateSheetLink — add `date` param, write col A for recv-pos only

**Files:**
- Modify: `api/webhook.js` — `updateSheetLink` function (lines ~612–689)

- [ ] **Step 1: Update the function signature**

Find this line (currently line 612):
```js
async function updateSheetLink(recvNo, category, fileId, billNo, branch, dealer, amount) {
```
Replace with:
```js
async function updateSheetLink(recvNo, category, fileId, billNo, branch, dealer, amount, date) {
```

- [ ] **Step 2: Write col A in the "found row" branch**

Find the found-row batch update block (starts around line 649):
```js
    const data = [{ range: `${tabName}!${linkCol}${rowNum}`, values: [[formula]] }];
    if (category === 'recv-pos') {
```
Replace that first `data` line with:
```js
    const data = [{ range: `${tabName}!${linkCol}${rowNum}`, values: [[formula]] }];
    if (category === 'recv-pos' && date) data.push({ range: `${tabName}!A${rowNum}`, values: [[date]] });
    if (category === 'recv-pos') {
```

- [ ] **Step 3: Write col A in the "new row" append branch**

Find the append block (around line 663). It starts with:
```js
    const newRow = Array(12).fill('');
    if (category === 'recv-pos') {
```
Replace with:
```js
    const newRow = Array(12).fill('');
    newRow[0] = category === 'recv-pos' ? (date || '') : ''; // A: date only for recv-pos
    if (category === 'recv-pos') {
```

- [ ] **Step 4: Commit**

```bash
git add api/webhook.js
git commit -m "feat: updateSheetLink accepts date, writes col A for recv-pos only"
```

---

### Task 2: sendConfirmation — show extracted RECV No. in recv-pos message

**Files:**
- Modify: `api/webhook.js` — `sendConfirmation` function (lines ~164–228)

- [ ] **Step 1: Add the RECV line to the confirmation message text**

Find this block inside `sendConfirmation` (around line 205):
```js
  const proposed = buildFilename(dealer, date, amount, mimeType);
  const resp = await fetch('https://api.line.me/v2/bot/message/reply', {
```
Insert one line between them:
```js
  const proposed = buildFilename(dealer, date, amount, mimeType);
  const recvLine = category === 'recv-pos' && billNo ? `\n🔢 เลข RECV: ${billNo}` : '';
  const resp = await fetch('https://api.line.me/v2/bot/message/reply', {
```

- [ ] **Step 2: Inject `recvLine` into the message text**

Find the message text string (around line 217):
```js
          text: `📄 AI จัดหมวดเป็น: ${catLabel[category] ?? category}\n📝 ชื่อไฟล์: ${proposed}\nถูกต้องไหม? กดเพื่อบันทึก:`,
```
Replace with:
```js
          text: `📄 AI จัดหมวดเป็น: ${catLabel[category] ?? category}${recvLine}\n📝 ชื่อไฟล์: ${proposed}\nถูกต้องไหม? กดเพื่อบันทึก:`,
```

- [ ] **Step 3: Commit**

```bash
git add api/webhook.js
git commit -m "feat: show Gemini-extracted RECV No. in recv-pos confirmation message"
```

---

### Task 3: handlePostback — recv-pos saves immediately, bypasses Redis

**Files:**
- Modify: `api/webhook.js` — `handlePostback` function (lines ~92–158)

- [ ] **Step 1: Remove recv-pos from SHEET_LINKED**

Find (around line 135):
```js
  const SHEET_LINKED = ['invoice', 'recv-pos', 'shipping-cost'];
```
Replace with:
```js
  const SHEET_LINKED = ['invoice', 'shipping-cost'];
```

- [ ] **Step 2: Add the recv-pos immediate-save block**

Find the line just before the `SHEET_LINKED` check (around line 136):
```js
  const { messageId, category, dealer, date, amount, filename: customFilename, branch, billNo } = data;

  if (SHEET_LINKED.includes(category)) {
```
Insert the recv-pos block between the destructure and the SHEET_LINKED check:
```js
  const { messageId, category, dealer, date, amount, filename: customFilename, branch, billNo } = data;

  if (category === 'recv-pos') {
    try {
      const { fileBytes, mimeType: ft } = await downloadByMessageId(messageId);
      const fname = customFilename || buildFilename(dealer, date, amount, ft);
      const { uploadedName, fileId } = await uploadToDrive(fileBytes, ft, fname, 'recv-pos');
      const recvKey = billNo || 'รอเลข';
      await updateSheetLink(recvKey, 'recv-pos', fileId, billNo, branch, dealer, amount, date);
      await sendLineReply(replyToken, `✅ บันทึกแล้ว: recv-pos → ${uploadedName}`);
    } catch (err) {
      console.error('handlePostback recv-pos error:', err);
      if (userId) await sendLinePush(userId, '❌ เกิดข้อผิดพลาด กรุณาลองใหม่');
    }
    return;
  }

  if (SHEET_LINKED.includes(category)) {
```

- [ ] **Step 3: Verify the prompt message for remaining SHEET_LINKED categories**

The reply after the Redis set should now read (around line 141 — update if it still says "POS/RECV"):
```js
      await sendLineReply(replyToken, '📋 พิมพ์เลข RECV เพื่อลิงก์ในชีท\n(หรือพิมพ์ "skip" ถ้ายังไม่มีเลข)');
```

- [ ] **Step 4: Commit**

```bash
git add api/webhook.js
git commit -m "feat: recv-pos confirms and saves immediately using Gemini-extracted RECV No."
```

---

### Task 4: handleTextReply — skip appends รอเลข row

**Files:**
- Modify: `api/webhook.js` — `handleTextReply` function (lines ~234–260, recv_pending block)

- [ ] **Step 1: Replace the skip guard with if/else**

Find this block (around line 249):
```js
      if (recvNo.toLowerCase() !== 'skip') {
        const amountFromFilename = uploadedName.replace(/\.[^.]+$/, '').split('_').pop().replace('฿', '');
        await updateSheetLink(recvNo, category, fileId, billNo, branch, dealer, amountFromFilename).catch(e =>
          console.error('Sheet update error:', e)
        );
      }
```
Replace with:
```js
      const amountFromFilename = uploadedName.replace(/\.[^.]+$/, '').split('_').pop().replace('฿', '');
      if (recvNo.toLowerCase() !== 'skip') {
        await updateSheetLink(recvNo, category, fileId, billNo, branch, dealer, amountFromFilename, date).catch(e =>
          console.error('Sheet update error:', e)
        );
      } else {
        await updateSheetLink('รอเลข', category, fileId, billNo, branch, dealer, amountFromFilename, date).catch(e =>
          console.error('Sheet skip-append error:', e)
        );
      }
```

Note: `date` is already destructured from `recvPending` at the top of this block:
```js
      const { messageId, category, branch, billNo, dealer, date, amount, customFilename } = recvPending;
```

- [ ] **Step 2: Commit**

```bash
git add api/webhook.js
git commit -m "feat: skip appends รอเลข row to sheet instead of dropping the transaction"
```

---

### Task 5: Deploy and verify

- [ ] **Step 1: Deploy to production**

```bash
vercel --prod
```
Expected output: `✅ Production: https://vercel-file-sorter.vercel.app`

- [ ] **Step 2: Verify recv-pos auto-RECV**

1. Open Google Sheet `AccountPayable` tab — note existing rows
2. Send a POS receipt image to the LINE bot
3. Confirmation message should show `🔢 เลข RECV: RECV XXX` — verify it matches the receipt
4. Tap `✅ RECV(POS)` to confirm
5. Check sheet: new or updated row should have **A = date, B = clickable hyperlink (RECV XXX), C = branch code, D = dealer name**
6. Click the hyperlink in B — Drive file should open ✅

- [ ] **Step 3: Verify invoice with RECV number**

1. Send an invoice image → confirm as `Invoice`
2. Bot asks "พิมพ์เลข RECV" — type a RECV number that exists in col B (e.g. `RECV 988`)
3. Check sheet: row with RECV 988 — **E = clickable hyperlink (bill No.), F = amount, A stays blank** ✅

- [ ] **Step 4: Verify invoice skip → รอเลข row**

1. Send an invoice image → confirm as `Invoice`
2. Bot asks for RECV — type `skip`
3. Check sheet: new row appended with **B = `รอเลข`, E = clickable hyperlink, F = amount, A blank** ✅
4. Click E hyperlink — Drive file opens ✅

- [ ] **Step 5: Verify shipping-cost skip → รอเลข row**

1. Send a shipping receipt image → confirm as `Shipping Cost`
2. Bot asks for RECV — type `skip`
3. Check sheet: new row appended with **B = `รอเลข`, H = clickable hyperlink, A blank** ✅

- [ ] **Step 6: Log the session**

Update `Agent/progress/daily/2026-05-09.md` with what was built and test results.
