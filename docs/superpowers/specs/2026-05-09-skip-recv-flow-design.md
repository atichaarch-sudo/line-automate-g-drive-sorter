# Design: Skip / RECV Flow Redesign (v5)

**Date:** 2026-05-09  
**File:** `api/webhook.js`  
**Status:** Approved — ready for implementation

---

## Problem

Three issues with the current v4 sheet-update flow:

1. **recv-pos asks for a RECV number the user already has on screen** — Gemini extracts it from the document, but the bot ignores it and asks the user to re-type it.
2. **"skip" drops the transaction entirely from the sheet** — invoice and shipping-cost documents with no RECV number yet are uploaded to Drive but never recorded in the sheet. No row is created.
3. **Column A (date) is never written for recv-pos** — the date column is left blank even though Gemini extracted it from the document.

---

## Design

### Rule: RECV number source per category

| Category | Where RECV comes from | User input required? |
|---|---|---|
| `recv-pos` | Gemini extracts from document (`bill_no` field) | **No** |
| `invoice` | User types it (not on the document) | Yes — or `skip` |
| `shipping-cost` | User types it (not on the document) | Yes — or `skip` |

### recv-pos flow (changed)

1. User sends image → Gemini classifies + extracts fields including `bill_no` = เลขที่เอกสาร (e.g. `RECV 988`)
2. Bot sends confirmation message — **shows extracted RECV No.** so user can verify before confirming
3. User taps confirm → bot immediately downloads + uploads to Drive + calls `updateSheetLink`
4. **No Redis state. No "พิมพ์เลข RECV" step.**

Confirmation message format for recv-pos:
```
📄 AI จัดหมวดเป็น: RECV(POS)
🔢 เลข RECV: RECV 988
🏢 สาขา: 001
🏪 ร้าน: CT Music Shop
📝 ชื่อไฟล์: CT Music Shop_26.03.69_6344฿.jpg
ถูกต้องไหม? กดเพื่อบันทึก:
```

### invoice / shipping-cost flow (skip behaviour changed)

- Normal path (user types RECV): unchanged
- Skip path: bot calls `updateSheetLink('รอเลข', category, ...)` → appends a new row with B = `"รอเลข"` and the hyperlink in the correct column

`"รอเลข"` rows are easy to filter in the sheet later when the RECV number arrives.

### Column A — date (recv-pos only)

Column A is written **only for `recv-pos`** — invoice and shipping-cost leave A blank (the date there is tied to the recv-pos row, not the invoice/shipping document).

- Found row: add `A{rowNum}` to the batchUpdate only when `category === 'recv-pos'`
- New row (append): set `newRow[0] = date` only when `category === 'recv-pos'`

### Full sheet write matrix

| Scenario | A date | B RECV | C branch | D dealer | E invoice | F amount | H shipping |
|---|---|---|---|---|---|---|---|
| recv-pos found | ✅ Gemini | 🔗 hyperlink | ✅ | ✅ | — | — | — |
| recv-pos new row | ✅ Gemini | 🔗 hyperlink | ✅ | ✅ | — | — | — |
| invoice found | — blank | — | — | — | 🔗 hyperlink | ✅ | — |
| invoice new / skip | — blank | `รอเลข` | — | — | 🔗 hyperlink | ✅ | — |
| shipping-cost found | — blank | — | — | — | — | — | 🔗 hyperlink |
| shipping-cost new / skip | — blank | `รอเลข` | — | — | — | — | 🔗 hyperlink |

---

## Code Changes (all in `api/webhook.js`)

### 1. `sendConfirmation` — add RECV line for recv-pos

Add one line to the confirmation message text when category is `recv-pos` and `billNo` is present:

```js
const recvLine = category === 'recv-pos' && billNo ? `\n🔢 เลข RECV: ${billNo}` : '';
// inject into message text: `...${recvLine}\n📝 ชื่อไฟล์: ...`
```

### 2. `handlePostback` — recv-pos bypasses Redis, saves immediately

Remove `recv-pos` from `SHEET_LINKED`. Add a dedicated `recv-pos` block before the `SHEET_LINKED` check:

```js
const SHEET_LINKED = ['invoice', 'shipping-cost']; // recv-pos removed

if (category === 'recv-pos') {
  const { fileBytes, mimeType: ft } = await downloadByMessageId(messageId);
  const fname = customFilename || buildFilename(dealer, date, amount, ft);
  const { uploadedName, fileId } = await uploadToDrive(fileBytes, ft, fname, 'recv-pos');
  // If Gemini failed to extract billNo, fall back to 'รอเลข' so we don't search col B for ""
  const recvKey = billNo || 'รอเลข';
  await updateSheetLink(recvKey, 'recv-pos', fileId, billNo, branch, dealer, amount, date);
  await sendLineReply(replyToken, `✅ บันทึกแล้ว: recv-pos → ${uploadedName}`);
  return;
}
```

### 3. `handleTextReply` — skip appends รอเลข row

Replace the current skip guard with an if/else:

```js
// before:
if (recvNo.toLowerCase() !== 'skip') {
  await updateSheetLink(recvNo, category, fileId, billNo, branch, dealer, amount);
}

// after:
if (recvNo.toLowerCase() !== 'skip') {
  await updateSheetLink(recvNo, category, fileId, billNo, branch, dealer, amount, date);
} else {
  await updateSheetLink('รอเลข', category, fileId, billNo, branch, dealer, amount, date);
}
```

### 4. `updateSheetLink` — add `date` parameter, write col A

**Signature change:**
```js
async function updateSheetLink(recvNo, category, fileId, billNo, branch, dealer, amount, date)
```

**Found row — add A to batch (recv-pos only):**
```js
const data = [{ range: `${tabName}!${linkCol}${rowNum}`, values: [[formula]] }];
if (category === 'recv-pos' && date) data.push({ range: `${tabName}!A${rowNum}`, values: [[date]] });
```

**New row (append) — set index 0 (recv-pos only):**
```js
newRow[0] = category === 'recv-pos' ? (date || '') : '';  // A: date only for recv-pos
```

---

## What Does NOT Change

- Gemini prompt — `bill_no` already captures the document number for recv-pos
- `SHEET_LINKED` behaviour for `invoice` and `shipping-cost` — only the skip path changes
- Drive upload logic — unchanged
- `expense`, `slip-bank`, `etc` — no sheet interaction, unchanged
- Redis TTL, edit-filename flow — unchanged

---

## Verification Steps

1. Send a recv-pos image → confirmation shows `🔢 เลข RECV: RECV 988` → tap confirm → sheet row **A = date, B = hyperlink, C = branch, D = dealer** ✅
2. Send an invoice → type RECV number → sheet row B = RECV, **E = hyperlink, F = amount** (A blank) ✅
3. Send an invoice → type `skip` → sheet appends row **B = `รอเลข`, E = hyperlink, F = amount** (A blank) ✅
4. Send shipping-cost → type `skip` → sheet appends row **B = `รอเลข`, H = hyperlink** (A blank) ✅
