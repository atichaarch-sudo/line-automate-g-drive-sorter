import { waitUntil } from '@vercel/functions';

// ---------------------------------------------------------------------------
// Vercel Web Standard export — required for waitUntil to work
// ---------------------------------------------------------------------------
export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const rawBodyBytes = await request.arrayBuffer();
    const rawBodyText = new TextDecoder().decode(rawBodyBytes);

    const signature = request.headers.get('x-line-signature');
    if (!signature) return new Response('Forbidden', { status: 403 });

    const isValid = await verifyLineSignature(rawBodyText, signature, process.env.LINE_CHANNEL_SECRET);
    if (!isValid) return new Response('Forbidden', { status: 403 });

    let body;
    try {
      body = JSON.parse(rawBodyText);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    for (const event of body.events || []) {
      if (event.type === 'message') {
        const msgType = event.message?.type;
        if (msgType === 'image' || msgType === 'file') {
          waitUntil(classifyAndConfirm(event));
        } else if (msgType === 'text') {
          waitUntil(handleTextReply(event));
        }
      } else if (event.type === 'postback') {
        waitUntil(handlePostback(event));
      }
    }

    return new Response('OK', { status: 200 });
  },
};

// ---------------------------------------------------------------------------
// LINE signature verification
// HMAC-SHA256(rawBody, channelSecret) — compared against x-line-signature
// ---------------------------------------------------------------------------
async function verifyLineSignature(rawBody, signature, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signatureBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const computed = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));
  return computed === signature;
}

// ---------------------------------------------------------------------------
// Step 1: Classify the file and send a confirmation quick reply
// Does NOT save to Drive yet — user must confirm first
// ---------------------------------------------------------------------------
async function classifyAndConfirm(event) {
  const { message, replyToken, source } = event;
  const userId = source?.userId;

  try {
    const { fileBytes, mimeType, isExternal } = await downloadFromLine(message);
    const { category, branch, billNo, dealer, date, amount } = await classifyAndExtract(fileBytes, mimeType);
    const filename = buildFilename(dealer, date, amount, mimeType);

    if (isExternal) {
      // External-hosted images can't be re-fetched by messageId — save immediately
      const { uploadedName } = await uploadToDrive(fileBytes, mimeType, filename, category);
      await sendLineReply(replyToken, `✅ บันทึกแล้ว: ${category} → ${uploadedName}`);
    } else {
      await sendConfirmation(replyToken, message.id, category, dealer, date, amount, mimeType, branch, billNo);
    }
  } catch (err) {
    console.error('classifyAndConfirm error:', err);
    if (userId) await sendLinePush(userId, '❌ เกิดข้อผิดพลาด กรุณาลองใหม่');
  }
}

// ---------------------------------------------------------------------------
// Step 2: User tapped a quick reply button — save file to the chosen folder
// ---------------------------------------------------------------------------
async function handlePostback(event) {
  const { postback, replyToken, source } = event;
  const userId = source?.userId;

  let data;
  try {
    data = JSON.parse(postback.data);
  } catch {
    return;
  }

  if (data.action === 'cancel') {
    await sendLineReply(replyToken, '❌ ยกเลิกแล้ว');
    return;
  }

  if (data.action === 'edit_filename') {
    const { messageId, category, dealer, date, amount, mimeType, branch, billNo } = data;
    try {
      const currentFilename = buildFilename(dealer, date, amount, mimeType);
      const baseName = currentFilename.replace(/\.[^.]+$/, '');
      // userId key means one pending edit at a time per user — intentional
      await redisSet(`edit:${userId}`, { messageId, category, mimeType, branch, billNo }, 300);
      await fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          replyToken,
          messages: [
            { type: 'text', text: '✏️ ชื่อไฟล์ปัจจุบัน พิมพ์ชื่อไฟล์ใหม่แล้วส่งมาได้เลย (ไม่ต้องใส่ .jpg หรือ .pdf) (กดค้างเพื่อคัดลอก):' },
            { type: 'text', text: baseName },
          ],
        }),
      });
    } catch (err) {
      console.error('edit_filename error:', err);
      if (userId) await sendLinePush(userId, '❌ เกิดข้อผิดพลาด กรุณาลองใหม่');
    }
    return;
  }

  if (data.action !== 'save') return;

  const SHEET_LINKED = ['invoice', 'shipping-cost'];
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
    try {
      await redisSet(`recv_pending:${userId}`, { messageId, category, branch, billNo, dealer, date, amount, customFilename }, 300);
      await sendLineReply(replyToken, '📋 พิมพ์เลข RECV เพื่อลิงก์ในชีท\n(หรือพิมพ์ "skip" ถ้ายังไม่มีเลข)');
    } catch (err) {
      console.error('handlePostback recv_pending error:', err);
      if (userId) await sendLinePush(userId, '❌ เกิดข้อผิดพลาด กรุณาลองใหม่');
    }
    return;
  }

  try {
    const { fileBytes, mimeType } = await downloadByMessageId(messageId);
    const filename = customFilename || buildFilename(dealer, date, amount, mimeType);
    const { uploadedName } = await uploadToDrive(fileBytes, mimeType, filename, category);
    await sendLineReply(replyToken, `✅ บันทึกแล้ว: ${category} → ${uploadedName}`);
  } catch (err) {
    console.error('handlePostback error:', err);
    if (userId) await sendLinePush(userId, '❌ เกิดข้อผิดพลาด กรุณาลองใหม่');
  }
}

// ---------------------------------------------------------------------------
// Send LINE quick reply for user to confirm or correct the category
// Four buttons: one per category, AI's guess is highlighted with ✅
// ---------------------------------------------------------------------------
async function sendConfirmation(replyToken, messageId, category, dealer, date, amount, mimeType, branch, billNo) {
  const allCategories = ['expense', 'shipping-cost', 'invoice', 'slip-bank', 'recv-pos', 'etc'];
  const catLabel = {
    'expense': 'Expense',
    'shipping-cost': 'Shipping Cost',
    'invoice': 'Invoice',
    'slip-bank': 'Slip-Bank',
    'recv-pos': 'RECV(POS)',
    'etc': 'ETC',
  };

  const quickReplyItems = [
    ...allCategories.map(cat => ({
      type: 'action',
      action: {
        type: 'postback',
        label: (cat === category ? '✅ ' : '') + catLabel[cat],
        data: JSON.stringify({ action: 'save', messageId, category: cat, dealer, date, amount, branch, billNo }),
        displayText: `บันทึกเป็น ${catLabel[cat]}`,
      },
    })),
    {
      type: 'action',
      action: {
        type: 'postback',
        label: '✏️ แก้ชื่อไฟล์',
        data: JSON.stringify({ action: 'edit_filename', messageId, category, dealer, date, amount, mimeType, branch, billNo }),
        displayText: 'แก้ไขชื่อไฟล์',
      },
    },
    {
      type: 'action',
      action: {
        type: 'postback',
        label: '❌ ยกเลิก',
        data: JSON.stringify({ action: 'cancel' }),
        displayText: 'ยกเลิก',
      },
    },
  ];

  const proposed = buildFilename(dealer, date, amount, mimeType);
  const recvLine = category === 'recv-pos' && billNo ? `\n🔢 เลข RECV: ${billNo}` : '';
  const resp = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.LINE_CHANNEL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      replyToken,
      messages: [
        {
          type: 'text',
          text: `📄 AI จัดหมวดเป็น: ${catLabel[category] ?? category}${recvLine}\n📝 ชื่อไฟล์: ${proposed}\nถูกต้องไหม? กดเพื่อบันทึก:`,
          quickReply: { items: quickReplyItems },
        },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`LINE confirmation reply failed: ${resp.status} — ${errText}`);
  }
}

// ---------------------------------------------------------------------------
// Step 2b: User typed a new filename after tapping ✏️ แก้ชื่อไฟล์
// Reads pending state from Redis, builds filename from typed text, shows re-confirm
// ---------------------------------------------------------------------------
async function handleTextReply(event) {
  const { message, replyToken, source } = event;
  const userId = source?.userId;
  if (!userId) return;

  // Check recv_pending first — user typed a RECV/POS number after confirming a sheet-linked category
  const recvPending = await redisGet(`recv_pending:${userId}`);
  if (recvPending) {
    const recvNo = message.text.trim();
    await redisDel(`recv_pending:${userId}`);
    try {
      const { messageId, category, branch, billNo, dealer, date, amount, customFilename } = recvPending;
      const { fileBytes, mimeType } = await downloadByMessageId(messageId);
      const filename = customFilename || buildFilename(dealer, date, amount, mimeType);
      const { uploadedName, fileId } = await uploadToDrive(fileBytes, mimeType, filename, category);
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
      await sendLineReply(replyToken, `✅ บันทึกแล้ว: ${category} → ${uploadedName}`);
    } catch (err) {
      console.error('handleTextReply recv_pending error:', err);
      if (userId) await sendLinePush(userId, '❌ เกิดข้อผิดพลาด กรุณาลองใหม่');
    }
    return;
  }

  const pending = await redisGet(`edit:${userId}`);
  if (!pending) return; // no pending edit — ignore normal text messages

  const newName = message.text.trim();
  if (!newName) {
    await sendLineReply(replyToken, '⚠️ ชื่อว่างเปล่า กรุณาพิมพ์ชื่อไฟล์ใหม่:');
    return;
  }

  await redisDel(`edit:${userId}`);

  const { messageId, category, mimeType, branch, billNo } = pending;
  const ext = (mimeType || '').includes('pdf') ? 'pdf' : 'jpg';
  const safe = s => s.replace(/[/\\:*?"<>|]/g, '').trim().slice(0, 80);
  const baseName = safe(newName).replace(/\.(jpg|jpeg|png|pdf)$/i, '');
  const filename = `${baseName}.${ext}`;

  const allCategories = ['expense', 'shipping-cost', 'invoice', 'slip-bank', 'recv-pos', 'etc'];
  const catLabel = {
    'expense': 'Expense',
    'shipping-cost': 'Shipping Cost',
    'invoice': 'Invoice',
    'slip-bank': 'Slip-Bank',
    'recv-pos': 'RECV(POS)',
    'etc': 'ETC',
  };
  const quickReplyItems = [
    ...allCategories.map(cat => ({
      type: 'action',
      action: {
        type: 'postback',
        label: (cat === category ? '✅ ' : '') + catLabel[cat],
        data: JSON.stringify({ action: 'save', messageId, category: cat, filename, branch, billNo }),
        displayText: `บันทึกเป็น ${catLabel[cat]}`,
      },
    })),
    {
      type: 'action',
      action: {
        type: 'postback',
        label: '❌ ยกเลิก',
        data: JSON.stringify({ action: 'cancel' }),
        displayText: 'ยกเลิก',
      },
    },
  ];

  const resp = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.LINE_CHANNEL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      replyToken,
      messages: [{
        type: 'text',
        text: `✏️ ชื่อไฟล์ใหม่:\n${filename}\nเลือกหมวดหมู่:`,
        quickReply: { items: quickReplyItems },
      }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`LINE text reply failed: ${resp.status} — ${errText}`);
  }
}

// ---------------------------------------------------------------------------
// Upstash Redis REST helpers — no SDK, plain fetch
// ---------------------------------------------------------------------------
async function redisCommand(...args) {
  const resp = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!resp.ok) throw new Error(`Redis command failed: ${resp.status}`);
  const json = await resp.json();
  return json.result;
}

async function redisSet(key, value, ttlSeconds) {
  await redisCommand('SET', key, JSON.stringify(value), 'EX', String(ttlSeconds));
}

async function redisGet(key) {
  const result = await redisCommand('GET', key);
  return result ? JSON.parse(result) : null;
}

async function redisDel(key) {
  await redisCommand('DEL', key);
}

// ---------------------------------------------------------------------------
// Download file from LINE — used during classification step
// Returns isExternal=true for external-hosted images (can't re-fetch by ID)
// ---------------------------------------------------------------------------
async function downloadFromLine(message) {
  const token = process.env.LINE_CHANNEL_TOKEN;
  let fileUrl;
  let fetchOptions = {};
  let isExternal = false;

  if (message.type === 'image' && message.contentProvider?.type === 'external') {
    fileUrl = message.contentProvider.originalContentUrl;
    isExternal = true;
  } else {
    fileUrl = `https://api-data.line.me/v2/bot/message/${message.id}/content`;
    fetchOptions.headers = { Authorization: `Bearer ${token}` };
  }

  const resp = await fetch(fileUrl, fetchOptions);
  if (!resp.ok) throw new Error(`LINE content download failed: ${resp.status} ${resp.statusText}`);

  const mimeType = resp.headers.get('Content-Type') || 'application/octet-stream';
  const fileBytes = await resp.arrayBuffer();

  return { fileBytes, mimeType, isExternal };
}

// ---------------------------------------------------------------------------
// Re-download file from LINE by message ID — used during postback (save step)
// ---------------------------------------------------------------------------
async function downloadByMessageId(messageId) {
  const resp = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_TOKEN}` },
  });

  if (!resp.ok) throw new Error(`LINE re-download failed: ${resp.status} ${resp.statusText}`);

  const mimeType = resp.headers.get('Content-Type') || 'application/octet-stream';
  const fileBytes = await resp.arrayBuffer();

  return { fileBytes, mimeType };
}

function buildFilename(dealer, date, amount, mimeType) {
  const ext = (mimeType || '').includes('pdf') ? 'pdf' : 'jpg';
  const safe = s => (s || '').replace(/[/\\:*?"<>|]/g, '').trim();
  const d = safe(dealer) || 'unknown';
  const dt = safe(date) || 'nodate';
  const amt = safe(String(amount || '0'));
  return `${d}_${dt}_${amt}฿.${ext}`;
}

// ---------------------------------------------------------------------------
// Classify and extract key fields via Gemini 2.5 Flash
// Returns { category, dealer, date, amount }
//
// Prompt teaches 6 Thai document categories for PolMusic Lampang
// ---------------------------------------------------------------------------
async function classifyAndExtract(fileBytes, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const base64Data = arrayBufferToBase64(fileBytes);

  const payload = {
    contents: [
      {
        parts: [
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Data,
            },
          },
          {
            text:
              'You are analyzing a Thai business document for a music instrument shop.\n\n' +
              'Classify the document and extract key fields:\n\n' +
              'CATEGORY — pick exactly one:\n' +
              '- "expense": ค่าใช้จ่ายทั่วไปของบริษัท เช่น ค่าน้ำ ค่าไฟ ค่าเช่า ค่าซ่อม ใบเสร็จรับเงินทั่วไปที่ร้านจ่ายออก\n' +
              '- "shipping-cost": ค่าขนส่ง ค่าส่งพัสดุ ใบเสร็จจากบริษัทขนส่ง เช่น Kerry, Flash, EMS, Nim\n' +
              '- "invoice": ใบแจ้งหนี้ / ใบกำกับภาษี จากซัพพลายเออร์ที่ขายสินค้าให้ร้าน\n' +
              '- "slip-bank": สลิปโอนเงิน ภาพหน้าจอการโอนเงินผ่านแอปธนาคาร รายการธนาคาร\n' +
              '- "recv-pos": ใบเสร็จรับเงินจากการขาย POS receipt ใบเสร็จที่ร้านออกให้ลูกค้า\n' +
              '- "etc": อื่นๆ ที่ไม่ใช่หมวดข้างต้น\n\n' +
              'DEALER — the company or customer name (ชื่อบริษัท/ลูกค้า). Use a short recognizable name, omit "Co.,Ltd" / "จำกัด" suffixes.\n\n' +
              'DATE — document date in DD.MM.YY format using Buddhist Era year (e.g. 29.04.69 for 29 April 2569). If the year looks like 2025/2026, convert: subtract 543 to get BE year, take last 2 digits.\n\n' +
              'AMOUNT — the grand total as digits only, no currency symbol or commas (e.g. 10408).\n\n' +
              'BRANCH — the branch code from the "สาขา" field. Return the numeric code only (e.g. "001" from "001:สาขาพิษณุโลก"). Leave empty string if not present.\n\n' +
              'BILL_NO — the invoice or bill number printed on the document (e.g. "INV2260101289"). Leave empty string if not present.\n\n' +
              'Reply with valid JSON only, no explanation.\n' +
              'Format: {"category":"<category>","dealer":"<dealer>","date":"<DD.MM.YY>","amount":"<amount>","branch":"<branch>","bill_no":"<bill_no>"}',
          },
        ],
      },
    ],
    generationConfig: {
      response_mime_type: 'application/json',
      temperature: 0,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  let resp;
  for (let attempt = 1; attempt <= 3; attempt++) {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (resp.ok) break;
    const retryable = resp.status === 503 || resp.status === 429;
    if (!retryable || attempt === 3) {
      const errText = await resp.text();
      throw new Error(`Gemini API error: ${resp.status} — ${errText}`);
    }
    console.warn(`Gemini returned ${resp.status} on attempt ${attempt}, retrying in ${attempt * 2}s...`);
    await new Promise(r => setTimeout(r, attempt * 2000));
  }

  const json = await resp.json();
  const rawText = (json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}')
    .replace(/```json\n?|\n?```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = {};
  }

  const valid = ['expense', 'shipping-cost', 'invoice', 'slip-bank', 'recv-pos', 'etc'];
  const category = parsed.category?.toLowerCase();
  return {
    category: valid.includes(category) ? category : 'etc',
    dealer: parsed.dealer || '',
    date: parsed.date || '',
    amount: parsed.amount || '0',
    branch: parsed.branch || '',
    billNo: parsed.bill_no || '',
  };
}

// ---------------------------------------------------------------------------
// Convert ArrayBuffer to base64 string
// ---------------------------------------------------------------------------
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Upload file to Google Drive
// ---------------------------------------------------------------------------
async function uploadToDrive(fileBytes, mimeType, filename, category) {
  const folderMap = {
    'expense':       process.env.FOLDER_EXPENSE,
    'shipping-cost': process.env.FOLDER_SHIPPING_COST,
    'invoice':       process.env.FOLDER_INVOICE,
    'slip-bank':     process.env.FOLDER_SLIP_BANK,
    'recv-pos':      process.env.FOLDER_RECV_POS,
    'etc':           process.env.FOLDER_ETC,
  };
  const folderId = folderMap[category] || process.env.FOLDER_ETC;

  const accessToken = await getAccessToken();

  const { filename: uploadedName, fileId } = await driveResumableUpload(accessToken, folderId, filename, mimeType, fileBytes);
  return { uploadedName, fileId };
}

// ---------------------------------------------------------------------------
// Exchange OAuth2 refresh token for an access token
// ---------------------------------------------------------------------------
async function getAccessToken() {
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  if (!tokenResp.ok) {
    const errText = await tokenResp.text();
    throw new Error(`OAuth token refresh failed: ${tokenResp.status} — ${errText}`);
  }

  const tokenJson = await tokenResp.json();
  return tokenJson.access_token;
}

// ---------------------------------------------------------------------------
// Resumable upload to Google Drive — safe for files of any size
// ---------------------------------------------------------------------------
async function driveResumableUpload(accessToken, folderId, filename, mimeType, fileBytes) {
  const metadata = JSON.stringify({ name: filename, parents: [folderId] });

  const initiateResp = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(fileBytes.byteLength),
      },
      body: metadata,
    },
  );

  if (!initiateResp.ok) {
    const errText = await initiateResp.text();
    throw new Error(`Drive resumable initiate failed: ${initiateResp.status} — ${errText}`);
  }

  const uploadUri = initiateResp.headers.get('Location');
  if (!uploadUri) throw new Error('Drive resumable initiate did not return Location header');

  const uploadResp = await fetch(uploadUri, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType,
      'Content-Length': String(fileBytes.byteLength),
    },
    body: fileBytes,
  });

  if (!uploadResp.ok) {
    const errText = await uploadResp.text();
    throw new Error(`Drive upload failed: ${uploadResp.status} — ${errText}`);
  }

  const uploadJson = await uploadResp.json();
  return { filename, fileId: uploadJson.id };
}

// ---------------------------------------------------------------------------
// Find the matching row in AccountPayable by RECV number (col B) and update
// the correct hyperlink cell. For recv-pos also writes branch (C) and dealer (D).
// ---------------------------------------------------------------------------
async function updateSheetLink(recvNo, category, fileId, billNo, branch, dealer, amount, date) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tabName = process.env.GOOGLE_SHEET_TAB;
  const driveUrl = `https://drive.google.com/file/d/${fileId}/view`;
  const accessToken = await getAccessToken();

  // Search column B for the RECV number
  const searchResp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(tabName + '!B:B')}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!searchResp.ok) {
    const errText = await searchResp.text();
    throw new Error(`Sheets read failed: ${searchResp.status} — ${errText}`);
  }
  const searchJson = await searchResp.json();
  const rows = searchJson.values || [];

  // Normalize: "RECV 988", "988", "RECV988" all match the same row
  const normalize = s => String(s).replace(/\s+/g, '').toLowerCase();
  const normalizedRecv = normalize(recvNo);
  const rowIndex = rows.findIndex(r => normalize(r[0] || '') === normalizedRecv);

  const linkCol = category === 'invoice' ? 'E' : category === 'recv-pos' ? 'B' : 'H';
  const displayText = category === 'invoice' ? (billNo || recvNo) : category === 'shipping-cost' ? (amount || recvNo) : recvNo;
  const formula = `=HYPERLINK("${driveUrl}","${displayText}")`;

  if (rowIndex >= 1) {
    // Row found — batch update hyperlink cell + branch/dealer for recv-pos
    const rowNum = rowIndex + 1;
    const data = [{ range: `${tabName}!${linkCol}${rowNum}`, values: [[formula]] }];
    if (category === 'recv-pos' && date) data.push({ range: `${tabName}!A${rowNum}`, values: [[date]] }); // A: date — only for recv-pos
    if (category === 'recv-pos') {
      data.push({ range: `${tabName}!C${rowNum}`, values: [[branch || '']] });
      data.push({ range: `${tabName}!D${rowNum}`, values: [[dealer || '']] });
    } else if (category === 'invoice') {
      data.push({ range: `${tabName}!F${rowNum}`, values: [[amount || '']] });
    }
    const batchResp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
      }
    );
    if (!batchResp.ok) {
      const errText = await batchResp.text();
      throw new Error(`Sheets batchUpdate failed: ${batchResp.status} — ${errText}`);
    }
  } else {
    // Row not found — append new row (A/F left blank for manual entry)
    const newRow = Array(12).fill('');
    if (category === 'recv-pos') newRow[0] = date || ''; // A: date only for recv-pos
    if (category === 'recv-pos') {
      newRow[1] = formula;       // B: hyperlink
      newRow[2] = branch || '';  // C: branch code
      newRow[3] = dealer || '';  // D: dealer
    } else if (category === 'invoice') {
      newRow[1] = recvNo;        // B: raw RECV (primary key)
      newRow[4] = formula;       // E: invoice hyperlink
      newRow[5] = amount || '';  // F: invoice amount
    } else {
      newRow[1] = recvNo;        // B: raw RECV (primary key)
      newRow[7] = formula;       // H: shipping-cost hyperlink
    }
    const appendResp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(tabName + '!A:L')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [newRow] }),
      }
    );
    if (!appendResp.ok) {
      const errText = await appendResp.text();
      throw new Error(`Sheets append failed: ${appendResp.status} — ${errText}`);
    }
  }
}

// ---------------------------------------------------------------------------
// LINE reply — valid 60 seconds after webhook receipt
// ---------------------------------------------------------------------------
async function sendLineReply(replyToken, text) {
  const resp = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.LINE_CHANNEL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`LINE reply failed: ${resp.status} — ${errText}`);
  }
}

// ---------------------------------------------------------------------------
// LINE push — used for error notifications when replyToken may be expired
// ---------------------------------------------------------------------------
async function sendLinePush(userId, text) {
  const resp = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.LINE_CHANNEL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: 'text', text }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`LINE push failed: ${resp.status} — ${errText}`);
  }
}
