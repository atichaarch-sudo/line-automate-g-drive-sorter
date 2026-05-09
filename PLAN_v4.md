# vercel-file-sorter — v4 Plan: Google Sheets Row Update with Drive Hyperlinks

## What's New in v4
When a receipt image is uploaded, the bot finds the matching row in the `AccountPayable` sheet (matched by RECV/POS number in column B) and updates the correct cell with a clickable hyperlink to the Drive file. For `recv-pos`, it also writes Branch (col C) and Dealer (col D) extracted from the document.

---

## Target Sheet
- **Spreadsheet ID:** `1JXgAwLqY1BzNsdNZO3baAdWx3WD31bvn0-C1uETMff0`
- **Tab name:** `AccountPayable`
- **Primary key column:** B (เลขที่ POS / RECV No.) — search column for all sheet lookups

---

## Sheet Column Layout (A–L)

| Col | Field | Bot action |
|-----|-------|-----------|
| A | Date | extracted by Gemini |
| **B** | **เลขที่ POS (RECV No.)** | **primary key + hyperlink → recv-pos Drive file** |
| **C** | **สาขา (Branch)** | **written by bot for recv-pos** (extracted by Gemini) |
| **D** | **ร้าน (Dealer)** | **written by bot for recv-pos** (extracted by Gemini) |
| **E** | **เลขที่บิล (Bill No.)** | **hyperlink → Invoice Drive file** |
| F | ยอดเงิน (Amount) | extracted by Gemini |
| G | VAT | blank (manual) |
| **H** | **ค่าขนส่ง (Shipping cost)** | **hyperlink → Shipping cost Drive file** |
| I | ชำระโดย | blank (manual) |
| J | กำหนดชำระ | blank (manual) |
| K | วันที่ชำระ | blank (manual) |
| L | หมายเหตุ | blank (manual) |

### Hyperlink cell and extra writes by category:
| Category | Drive folder | Hyperlink cell | Extra writes |
|----------|-------------|----------------|--------------|
| `recv-pos` | FOLDER_RECV_POS | **B** — `=HYPERLINK(url, recvNo)` | C = branch, D = dealer |
| `invoice` | FOLDER_INVOICE | **E** — `=HYPERLINK(url, billNo)` | — |
| `shipping-cost` | FOLDER_SHIPPING_COST | **H** — `=HYPERLINK(url, recvNo)` | — |
| `expense`, `slip-bank`, `etc` | respective folders | Drive upload only | — |

---

## Gemini Extraction — recv-pos Document Fields

From the example (RECV 988, Polmusic Phitsanulok):
```
สาขา 001:สาขาพิษณุโลก   →  branch = "001"
ชื่อบริษัท/ร้านค้า CT Music Shop  →  dealer = "CT Music Shop"
เลขที่เอกสาร RECV 988        →  (user types this in LINE chat)
วันที่ออกเอกสาร 26/03/2026   →  date = "26/03/2026"
รวมทั้งหมด 6,344              →  amount = "6344"
```

Add to Gemini prompt:
```
BRANCH — the branch code from the "สาขา" field. Return the numeric code only
         (e.g. "001" from "001:สาขาพิษณุโลก", "002" from "002:สาขาลำปาง").
DEALER — the buyer company/store name from the "ชื่อบริษัท/ร้านค้า" field. Return as-is.
BILL_NO — the invoice or bill number (for invoice docs). Return as-is.
```

Return JSON: `{ category, branch, bill_no, dealer, date, amount }`

## Finalized Design Decisions

| # | Decision |
|---|----------|
| OAuth2 | Not re-authorized yet — deploy first, re-authorize only if 403 from Sheets |
| New row (recv-pos not found) | Append row with B=hyperlink, C=branch, D=dealer only — A/F left blank (manual) |
| Branch/Dealer writes | **recv-pos only** — invoice and shipping-cost do NOT write C/D |
| Branch format | Code only: `"001"` (not `"001:สาขาพิษณุโลก"`, not `"พิษณุโลก"`) |

---

## Updated Bot Flow

```
User sends image
  ↓
Bot classifies (Gemini) → shows category quick reply (unchanged)
  ↓
User taps category button  ─── if invoice/recv-pos/shipping-cost:
  ↓                                Bot stores pending data in Redis
  ↓                                Bot replies: "พิมพ์เลข POS/RECV:"
  ↓                                User types RECV number (e.g. "RECV 988")
  ↓                                Bot processes ↓
  └──────────────────────────────────────────────┘
        ↓
  Upload file to Drive
        ↓
  Search sheet column B for RECV number
  ├─ Found → update hyperlink cell + extra cells (branch/dealer for recv-pos)
  └─ Not found → append new row with all extracted data
        ↓
  LINE reply: ✅ บันทึกแล้ว + sheet updated
```

For `expense`, `slip-bank`, `etc`: existing flow unchanged — no RECV number step, no sheet update.

---

## Code Changes (all in `api/webhook.js`)

### 1. Update Gemini extraction — add `branch`, `bill_no`, `dealer`
```
BRANCH — city/location name from "สาขา" field (e.g. "พิษณุโลก")
DEALER — buyer name from "ชื่อบริษัท/ร้านค้า" field
BILL_NO — invoice/bill number (for invoice docs). Return as-is.
```
Return JSON: `{ category, branch, bill_no, dealer, date, amount }`

### 2. New Redis state: `recv_pending:${userId}`
After user confirms category (postback action=save) for sheet-linked categories:
```js
await redisSet(`recv_pending:${userId}`, {
  messageId, category, branch, billNo, dealer, date, amount, mimeType
}, 300);
await sendLineReply(replyToken, '📋 พิมพ์เลข POS/RECV เพื่อลิงก์ในชีท\n(หรือพิมพ์ "skip" เพื่อบันทึกโดยไม่ลิงก์)');
```

### 3. Modify `handlePostback` — defer save for sheet-linked categories
```js
const SHEET_LINKED = ['invoice', 'recv-pos', 'shipping-cost'];

if (data.action === 'save') {
  if (SHEET_LINKED.includes(data.category)) {
    await redisSet(`recv_pending:${userId}`, { ...data }, 300);
    await sendLineReply(replyToken, '📋 พิมพ์เลข POS/RECV:');
    return;
  }
  // Non-sheet categories: upload immediately (existing logic)
  ...
}
```

### 4. Modify `handleTextReply` — handle RECV number input
```js
const recvPending = await redisGet(`recv_pending:${userId}`);
if (recvPending) {
  const recvNo = message.text.trim();
  await redisDel(`recv_pending:${userId}`);

  const { messageId, category, branch, billNo, dealer, date, amount, mimeType } = recvPending;
  const { fileBytes } = await downloadByMessageId(messageId);
  const filename = buildFilename(dealer, date, amount, mimeType);
  const { uploadedName, fileId } = await uploadToDrive(fileBytes, mimeType, filename, category);

  if (recvNo.toLowerCase() !== 'skip') {
    await updateSheetLink(recvNo, category, fileId, billNo, branch, dealer).catch(e =>
      console.error('Sheet update error:', e)
    );
  }
  await sendLineReply(replyToken, `✅ บันทึกแล้ว: ${category} → ${uploadedName}`);
  return;
}
```

### 5. Modify `driveResumableUpload` — return fileId
```js
const uploadJson = await uploadResp.json();
return { filename, fileId: uploadJson.id };
```

### 6. Modify `uploadToDrive` — propagate fileId
```js
return await driveResumableUpload(...);  // now returns { filename, fileId }
```

### 7. New `updateSheetLink(recvNo, category, fileId, billNo, branch, dealer)` function

```js
async function updateSheetLink(recvNo, category, fileId, billNo, branch, dealer) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tabName = process.env.GOOGLE_SHEET_TAB;
  const driveUrl = `https://drive.google.com/file/d/${fileId}/view`;
  const accessToken = await getAccessToken();

  // Step 1: Find row by RECV number in column B (primary key)
  const searchResp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(tabName + '!B:B')}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const searchJson = await searchResp.json();
  const rows = searchJson.values || [];

  // Normalize: match "RECV 988", "988", "RECV988" to the same row
  const normalize = s => String(s).replace(/\s+/g, '').toLowerCase();
  const normalizedRecv = normalize(recvNo);
  const rowIndex = rows.findIndex(r => normalize(r[0] || '') === normalizedRecv);

  // Determine hyperlink cell and display text
  const linkCol = category === 'invoice' ? 'E' : category === 'recv-pos' ? 'B' : 'H';
  const displayText = category === 'invoice' ? (billNo || recvNo) : recvNo;
  const formula = `=HYPERLINK("${driveUrl}","${displayText}")`;

  if (rowIndex >= 1) {
    // Row found — build batch update
    const rowNum = rowIndex + 1;
    const data = [{ range: `${tabName}!${linkCol}${rowNum}`, values: [[formula]] }];

    if (category === 'recv-pos') {
      data.push({ range: `${tabName}!C${rowNum}`, values: [[branch || '']] });
      data.push({ range: `${tabName}!D${rowNum}`, values: [[dealer || '']] });
    }

    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
      }
    );
  } else {
    // Row not found — append new row
    // Layout: A=date, B=recvNo/hyperlink, C=branch, D=dealer, E=billNo/hyperlink, F=amount, G-L=blank
    const newRow = Array(12).fill('');
    if (category === 'recv-pos') {
      newRow[1] = formula;      // B: hyperlink
      newRow[2] = branch || ''; // C: branch
      newRow[3] = dealer || ''; // D: dealer
    } else if (category === 'invoice') {
      newRow[1] = recvNo;       // B: raw RECV number (primary key)
      newRow[4] = formula;      // E: invoice hyperlink
    } else {
      newRow[1] = recvNo;       // B: raw RECV number (primary key)
      newRow[7] = formula;      // H: shipping-cost hyperlink
    }

    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(tabName + '!A:L')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ values: [newRow] }),
      }
    );
  }
}
```

---

## New Environment Variables (add to Vercel)

| Variable | Value |
|----------|-------|
| `GOOGLE_SHEET_ID` | `1JXgAwLqY1BzNsdNZO3baAdWx3WD31bvn0-C1uETMff0` |
| `GOOGLE_SHEET_TAB` | `AccountPayable` |

---

## OAuth2 Scope Warning ⚠️
The existing `GOOGLE_REFRESH_TOKEN` was authorized for Drive only. The Sheets API requires `https://www.googleapis.com/auth/spreadsheets` scope. If Sheets returns 403 after deploy, re-run the OAuth2 authorization flow with both scopes and replace `GOOGLE_REFRESH_TOKEN` in Vercel.

---

## Verification Steps
1. Deploy: `vercel --prod`
2. Open `AccountPayable` tab, add a row with RECV number in column B (e.g. "RECV 988")
3. Send a POS receipt image to the LINE bot
4. Confirm category as `recv-pos`
5. Type "RECV 988" in LINE chat
6. Check sheet → column B becomes clickable hyperlink, C = branch, D = dealer ✅
7. Click → Drive file opens ✅
8. Test invoice: send invoice → confirm `invoice` → type RECV number → column E gets link ✅
9. Test shipping: send shipping receipt → confirm `shipping-cost` → type RECV number → column H gets link ✅
10. Test skip: type "skip" → Drive upload only, no sheet update ✅

---

## Version History
| Version | Feature |
|---------|---------|
| v1 | Basic LINE → Drive upload |
| v2 | Gemini AI classification |
| v3 | 6 categories, full filename edit, Redis state, end-to-end tested |
| **v4** | **Google Sheets: B/E/H hyperlinks matched by RECV No. (col B); recv-pos also writes Branch (C) + Dealer (D)** |
