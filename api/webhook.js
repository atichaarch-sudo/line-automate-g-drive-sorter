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
    if (userId) await sendLinePush(userId, classifyError(err));
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
      if (userId) await sendLinePush(userId, classifyError(err));
    }
    return;
  }

  if (data.action !== 'save') return;

  const SHEET_LINKED = ['invoice', 'shipping-cost'];
  const { messageId, category, dealer, date, amount, filename: customFilename, branch, billNo } = data;

  if (category === 'expense') {
    try {
      const { fileBytes, mimeType: ft } = await downloadByMessageId(messageId);
      const fname = customFilename || buildFilename(dealer, date, amount, ft);
      const { uploadedName, fileId } = await uploadToDrive(fileBytes, ft, fname, 'expense');
      try {
        const description = await extractExpenseDescription(fileBytes, ft);
        const expNo = await writeExpenseRow(date, billNo, dealer, description, amount, fileId);
        await sendLineReply(replyToken, `✅ บันทึกแล้ว: expense → ${uploadedName}\n🔢 Expense No.: ${expNo}`);
      } catch (e) {
        console.error('ExpenseSheet error:', e);
        await sendLineReply(replyToken, `✅ บันทึกแล้ว: expense → ${uploadedName}`);
      }
    } catch (err) {
      console.error('handlePostback expense error:', err);
      if (userId) await sendLinePush(userId, classifyError(err));
    }
    return;
  }

  if (category === 'slip-bank') {
    try {
      const { fileBytes, mimeType: ft } = await downloadByMessageId(messageId);
      const fname = customFilename || buildFilename(dealer, date, amount, ft);
      const { uploadedName, fileId } = await uploadToDrive(fileBytes, ft, fname, 'slip-bank');
      await redisSet(`slip_pending:${userId}`, { fileId }, 300);
      await fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          replyToken,
          messages: [{
            type: 'text',
            text: `✅ บันทึกแล้ว: slip-bank → ${uploadedName}\n📎 พิมพ์ Expense No. เพื่อลิงก์สลิปนี้ (เช่น EXP003)`,
            quickReply: {
              items: [{
                type: 'action',
                action: { type: 'message', label: '⏭️ Skip', text: 'skip' },
              }],
            },
          }],
        }),
      });
    } catch (err) {
      console.error('handlePostback slip-bank error:', err);
      if (userId) await sendLinePush(userId, classifyError(err));
    }
    return;
  }

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
      if (userId) await sendLinePush(userId, classifyError(err));
    }
    return;
  }

  if (SHEET_LINKED.includes(category)) {
    try {
      await redisSet(`recv_pending:${userId}`, { messageId, category, branch, billNo, dealer, date, amount, customFilename }, 300);
      await fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          replyToken,
          messages: [{
            type: 'text',
            text: '📋 พิมพ์เลข RECV เพื่อลิงก์ในชีท\n(หรือกด Skip ถ้ายังไม่มีเลข)',
            quickReply: {
              items: [{
                type: 'action',
                action: { type: 'message', label: '⏭️ Skip (รอเลข)', text: 'skip' },
              }],
            },
          }],
        }),
      });
    } catch (err) {
      console.error('handlePostback recv_pending error:', err);
      if (userId) await sendLinePush(userId, classifyError(err));
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
    if (userId) await sendLinePush(userId, classifyError(err));
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

  // Check slip_pending — user typed an Expense No. to link a slip-bank file
  const slipPending = await redisGet(`slip_pending:${userId}`);
  if (slipPending) {
    const expNo = message.text.trim();
    await redisDel(`slip_pending:${userId}`);
    if (expNo.toLowerCase() === 'skip') {
      await sendLineReply(replyToken, '⏭️ ข้ามการลิงก์สลิป');
    } else {
      try {
        await updateExpenseSlip(expNo, slipPending.fileId);
        await sendLineReply(replyToken, `✅ ลิงก์สลิปกับ ${expNo.toUpperCase()} แล้ว`);
      } catch (e) {
        console.error('updateExpenseSlip error:', e);
        await sendLineReply(replyToken, `⚠️ ไม่พบ ${expNo} ในชีท กรุณาตรวจสอบเลข Expense No.`);
      }
    }
    return;
  }

  // Check recv_pending — user typed a RECV/POS number after confirming a sheet-linked category
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
      if (category === 'invoice') {
        const effectiveRecv = recvNo.toLowerCase() === 'skip' ? 'รอเลข' : recvNo;
        try {
          const items = await extractInvoiceLineItems(fileBytes, mimeType);
          const recvFormatted = effectiveRecv === 'รอเลข' ? 'รอเลข' : `RECV ${effectiveRecv}`;
          await writeInvoiceDetails(recvFormatted, branch, dealer, date, items);
        } catch (e) {
          console.error('InvoiceDetails error:', e);
        }
      }
    } catch (err) {
      console.error('handleTextReply recv_pending error:', err);
      if (userId) await sendLinePush(userId, classifyError(err));
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

// Parse amount string to a plain number Sheets can sum/format (handles decimals, stray symbols)
function parseAmount(s) {
  if (s === null || s === undefined || s === '') return '';
  const n = parseFloat(String(s).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? '' : n;
}

// Convert "DD.MM.YY" → "DD/MM/YYYY" so Sheets recognises it as a date
function expandDate(ddmmyy) {
  if (!ddmmyy) return '';
  const parts = String(ddmmyy).split('.');
  if (parts.length !== 3) return ddmmyy;
  const [dd, mm, yy] = parts;
  return `${dd}/${mm}/20${yy}`;
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
            text: [
              'You are a document classifier for PolMusic, a Thai music instrument shop (branches: Lampang, Phitsanulok).',
              'Analyze the image and fill every JSON field below.',
              '',
              '── CATEGORY ──────────────────────────────────────────────────',
              'Check rules IN ORDER. Use the FIRST match.',
              '',
              '1. "recv-pos"      Header reads "ใบรับสินค้า" AND doc number starts with RECV (e.g. RECV 1032).',
              '                   This is an internal store document — NOT a supplier invoice.',
              '2. "slip-bank"     Bank / PromptPay transfer confirmation from a mobile banking app.',
              '3. "shipping-cost" Receipt from a courier: Kerry, Flash, J&T, EMS, Thailand Post, Nim, Alpha Fast.',
              '4. "invoice"       ใบแจ้งหนี้ / ใบกำกับภาษี FROM a music supplier TO the shop',
              '                   (seller = supplier, buyer = Polmusic branch, goods = instruments / accessories).',
              '5. "expense"       Bill the shop pays for its own operations:',
              '                   AIS / True / DTAC, PEA / MEA electricity, water, rent, repair, insurance, etc.',
              '                   ⚠ A utility ใบกำกับภาษี (AIS, ค่าไฟ, ค่าน้ำ) is "expense", NOT "invoice".',
              '6. "etc"           None of the above.',
              '',
              '── DEALER ────────────────────────────────────────────────────',
              '• slip-bank  → recipient name (ผู้รับเงิน / ปลายทาง / To).',
              '• others     → value next to / below "ชื่อบริษัท/ร้านค้า" label; if absent, the issuing company.',
              '• NEVER return a Polmusic branch ("Polmusic Lampang", "Polmusic Phitsanulok", "พลมิวสิค").',
              '• Remove "Co.,Ltd" / "จำกัด" suffixes.',
              '',
              '── DATE ──────────────────────────────────────────────────────',
              'Return as DD.MM.YY using the LAST 2 DIGITS of the C.E. year.',
              'Thai docs may use B.E. (พ.ศ.) = C.E. + 543. Convert:',
              '  4-digit 2500-2599 (B.E.) → subtract 543  e.g. 2569→2026→"26"',
              '  4-digit 2000-2099 (C.E.) → last 2 digits  e.g. 2026→"26"',
              '  2-digit 60-99    (B.E.) → subtract 43    e.g. 69→26',
              '  2-digit 00-59    (C.E.) → use as-is       e.g. 26→"26"',
              'Examples: 10/05/2569→"10.05.26" | 27/02/2026→"27.02.26" | 28/03/69→"28.03.26"',
              '',
              '── AMOUNT ────────────────────────────────────────────────────',
              '• recv-pos → "รวมทั้งหมด" field.',
              '• others   → final grand total (after VAT if present).',
              'Digits and ONE decimal point only. No symbols, no commas.',
              'Examples: 49320 | 640.93 | 1234.50  ← preserve the decimal, do NOT drop it.',
              '',
              '── BRANCH ────────────────────────────────────────────────────',
              'Numeric code from "สาขา" field only. e.g. "001" from "001:สาขาพิษณุโลก".',
              'Empty string if absent.',
              '',
              '── BILL_NO ───────────────────────────────────────────────────',
              '• recv-pos   → "เลขที่เอกสาร" value (e.g. "RECV 1032").',
              '• slip-bank  → transaction ref / เลขที่อ้างอิง / Ref No. (shortest if multiple).',
              '• others     → invoice or receipt number on the document.',
              'Empty string if absent.',
            ].join('\n'),
          },
        ],
      },
    ],
    generationConfig: {
      response_mime_type: 'application/json',
      response_schema: {
        type: 'OBJECT',
        properties: {
          category: { type: 'STRING', enum: ['expense', 'shipping-cost', 'invoice', 'slip-bank', 'recv-pos', 'etc'] },
          dealer:   { type: 'STRING' },
          date:     { type: 'STRING' },
          amount:   { type: 'STRING' },
          branch:   { type: 'STRING' },
          bill_no:  { type: 'STRING' },
        },
        required: ['category', 'dealer', 'date', 'amount', 'branch', 'bill_no'],
      },
      temperature: 0,
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

  // Normalize: "RECV 988", "RECV988", "988" all match the same row
  const normalize = s => String(s).replace(/\s+/g, '').replace(/^(recv|pos)/i, '').toLowerCase();
  const normalizedRecv = normalize(recvNo);
  // 'รอเลข' is a placeholder — multiple docs share it, so never overwrite; always append
  const rowIndex = normalizedRecv === 'รอเลข'
    ? -1
    : rows.findIndex(r => normalize(r[0] || '') === normalizedRecv);

  const linkCol = category === 'invoice' ? 'E' : category === 'recv-pos' ? 'B' : 'H';
  const displayText = category === 'invoice' ? (billNo || recvNo) : category === 'shipping-cost' ? (amount || recvNo) : recvNo;
  const formula = `=HYPERLINK("${driveUrl}","${displayText}")`;

  if (rowIndex >= 1) {
    // Row found — batch update hyperlink cell + branch/dealer for recv-pos
    const rowNum = rowIndex + 1;
    const data = [{ range: `${tabName}!${linkCol}${rowNum}`, values: [[formula]] }];
    if (category === 'recv-pos') {
      data.push({ range: `${tabName}!C${rowNum}`, values: [[branch || '']] });
      data.push({ range: `${tabName}!D${rowNum}`, values: [[dealer || '']] });
    } else if (category === 'invoice') {
      data.push({ range: `${tabName}!F${rowNum}`, values: [[parseAmount(amount)]] });
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
      newRow[5] = parseAmount(amount);  // F: invoice amount
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
    const appendText = await appendResp.text();
    if (!appendResp.ok) throw new Error(`Sheets append failed: ${appendResp.status} — ${appendText}`);
    const appendJson = JSON.parse(appendText);
    const updatedRange = appendJson.updates?.updatedRange;
    const rowMatch = updatedRange?.match(/(\d+):/);
    const appendedRowIndex = rowMatch ? parseInt(rowMatch[1]) - 1 : null;

    if (category === 'recv-pos' && appendedRowIndex !== null) {
      try {
        const sheetNumId = await getSheetNumericId(accessToken, spreadsheetId, tabName);
        if (sheetNumId !== null) await clearRowFormatting(accessToken, spreadsheetId, sheetNumId, appendedRowIndex);
      } catch (e) {
        console.warn('Row formatting clear failed (non-critical):', e.message);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Extract invoice line items via Gemini — returns [] on any failure
// ---------------------------------------------------------------------------
async function extractInvoiceLineItems(fileBytes, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const payload = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: arrayBufferToBase64(fileBytes) } },
        {
          text:
            'Extract all line items from this invoice.\n' +
            'Return a JSON array of objects. Each object must have exactly:\n' +
            '{"item_name": "<product name>", "qty": <number>, "cost": <number>}\n' +
            'qty and cost must be numbers, not strings. cost is the unit price or line total as printed.\n' +
            'If no line items found, return []. Reply with valid JSON array only, no explanation.',
        },
      ],
    }],
    generationConfig: { response_mime_type: 'application/json', temperature: 0 },
  };

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) return [];
    const json = await resp.json();
    const rawText = (json.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]')
      .replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(rawText);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Append extracted line items to InvoiceDetails tab — creates tab if missing
// ---------------------------------------------------------------------------
async function writeInvoiceDetails(recvNo, branch, invoiceName, date, lineItems) {
  if (!lineItems.length) return;

  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const detailsTab = 'Invoice-List';
  const accessToken = await getAccessToken();

  // Auto-create tab if it doesn't exist
  const metaResp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (metaResp.ok) {
    const meta = await metaResp.json();
    const exists = (meta.sheets || []).some(s => s.properties.title === detailsTab);
    if (!exists) {
      const addResp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ addSheet: { properties: { title: detailsTab } } }] }),
        }
      );
      if (!addResp.ok) {
        const errText = await addResp.text();
        throw new Error(`InvoiceDetails tab creation failed ${addResp.status}: ${errText}`);
      }
    }
  }

  const rows = lineItems.map(item => [
    date || '',            // A: วันที่
    recvNo || '',          // B: RECV No.
    branch || '',          // C: จัดส่ง (branch)
    invoiceName || '',     // D: สั่งจาก (supplier/dealer)
    item.item_name || '',  // E: รายการ (item name)
    parseAmount(item.qty),   // F: จำนวน (qty)
    parseAmount(item.cost),  // G: ราคาส่ง (cost)
  ]);

  const appendResp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(detailsTab + '!A:G')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: rows }),
    }
  );
  if (!appendResp.ok) {
    const errText = await appendResp.text();
    throw new Error(`InvoiceDetails append failed ${appendResp.status}: ${errText}`);
  }
}

// ---------------------------------------------------------------------------
// Extract a brief expense description via Gemini
// ---------------------------------------------------------------------------
async function extractExpenseDescription(fileBytes, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const payload = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: arrayBufferToBase64(fileBytes) } },
        {
          text:
            'This is a Thai expense receipt. Write a short description of what this expense is for (max 60 chars).\n' +
            'Examples: "ค่าไฟฟ้า", "ค่าน้ำประปา", "ค่าเช่า", "ค่าซ่อมแอร์", "ค่าอินเทอร์เน็ต"\n' +
            'Reply with valid JSON only: {"description": "<text>"}',
        },
      ],
    }],
    generationConfig: { response_mime_type: 'application/json', temperature: 0 },
  };

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) return '';
    const json = await resp.json();
    const rawText = (json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}')
      .replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(rawText);
    return parsed.description || '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Append one expense row to the Expense-List tab
// Columns: A=Expense No. B=date C=Bill No.(link) D=provider E=list F=amount G=Slip-Bank
// Returns the generated Expense No. (e.g. "EXP003")
// ---------------------------------------------------------------------------
async function writeExpenseRow(date, billNo, dealer, description, amount, fileId) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tab = 'Expense-List';
  const accessToken = await getAccessToken();

  const metaResp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (metaResp.ok) {
    const meta = await metaResp.json();
    const exists = (meta.sheets || []).some(s => s.properties.title === tab);
    if (!exists) {
      await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }),
        }
      );
    }
  }

  // Determine next Expense No. by reading column A
  const colAResp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(tab + '!A:A')}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  let nextNum = 1;
  if (colAResp.ok) {
    const colAJson = await colAResp.json();
    const nums = (colAJson.values || [])
      .slice(1) // skip header row
      .map(r => parseInt(String(r[0] || '').replace(/\D/g, ''), 10))
      .filter(n => !isNaN(n));
    if (nums.length > 0) nextNum = Math.max(...nums) + 1;
  }
  const expNo = `EXP${String(nextNum).padStart(3, '0')}`;

  const driveUrl = `https://drive.google.com/file/d/${fileId}/view`;
  const billCell = fileId
    ? `=HYPERLINK("${driveUrl}","${(billNo || 'ดูไฟล์').replace(/"/g, '')}")`
    : (billNo || '');

  const appendResp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(tab + '!A:G')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[expNo, expandDate(date), billCell, dealer || '', description || '', parseAmount(amount), '']] }),
    }
  );
  if (!appendResp.ok) {
    const errText = await appendResp.text();
    throw new Error(`Expense sheet append failed ${appendResp.status}: ${errText}`);
  }
  return expNo;
}

// ---------------------------------------------------------------------------
// Find an expense row by Expense No. (col A) and write a slip hyperlink to col G
// ---------------------------------------------------------------------------
async function updateExpenseSlip(expNo, fileId) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const tab = 'Expense-List';
  const accessToken = await getAccessToken();

  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(tab + '!A:A')}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!resp.ok) throw new Error(`Sheets read failed: ${resp.status}`);
  const json = await resp.json();
  const rows = json.values || [];

  // Match "EXP003", "exp003", "3", "003" all to the same row
  const normalizeExp = s => String(s).replace(/\s+/g, '').replace(/^exp/i, '').replace(/^0+/, '').toLowerCase() || '0';
  const target = normalizeExp(expNo);
  const rowIndex = rows.findIndex(r => normalizeExp(r[0] || '') === target);
  if (rowIndex < 1) throw new Error(`Expense No. not found: ${expNo}`);

  const rowNum = rowIndex + 1;
  const driveUrl = `https://drive.google.com/file/d/${fileId}/view`;
  const formula = `=HYPERLINK("${driveUrl}","สลิป")`;

  const updateResp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(tab + `!G${rowNum}`)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[formula]] }),
    }
  );
  if (!updateResp.ok) {
    const errText = await updateResp.text();
    throw new Error(`Expense slip update failed: ${updateResp.status} — ${errText}`);
  }
}

// ---------------------------------------------------------------------------
// Classify an error into a user-facing Thai message based on its source
// ---------------------------------------------------------------------------
function classifyError(err) {
  const msg = err?.message || '';
  if (msg.startsWith('Gemini')) {
    if (msg.includes('429')) return '❌ Gemini API: คำขอเกินโควต้า กรุณารอสักครู่แล้วลองใหม่';
    if (msg.includes('503')) return '❌ Gemini API: บริการไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่';
    return '❌ Gemini API: เกิดข้อผิดพลาด กรุณาลองใหม่';
  }
  if (msg.startsWith('OAuth token refresh')) {
    return '❌ Google Authentication: token หมดอายุหรือไม่ถูกต้อง กรุณาแจ้งผู้ดูแลระบบ';
  }
  if (msg.startsWith('Drive')) {
    return '❌ Google Drive: อัปโหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่';
  }
  if (msg.startsWith('Sheets')) {
    return '❌ Google Sheets: บันทึกข้อมูลไม่สำเร็จ กรุณาลองใหม่';
  }
  if (msg.startsWith('Redis')) {
    return '❌ ระบบ Cache: เกิดข้อผิดพลาด กรุณาลองใหม่';
  }
  if (msg.startsWith('LINE')) {
    return '❌ LINE API: ดาวน์โหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่';
  }
  return '❌ เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ กรุณาลองใหม่';
}

// ---------------------------------------------------------------------------
// Get numeric sheetId for a tab name — required by the Sheets formatting API
// ---------------------------------------------------------------------------
async function getSheetNumericId(accessToken, spreadsheetId, sheetName) {
  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!resp.ok) return null;
  const json = await resp.json();
  const sheet = (json.sheets || []).find(s => s.properties.title === sheetName);
  return sheet?.properties?.sheetId ?? null;
}

// ---------------------------------------------------------------------------
// Reset a row's background to white and text to plain black
// ---------------------------------------------------------------------------
async function clearRowFormatting(accessToken, spreadsheetId, sheetId, rowIndex) {
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          repeatCell: {
            range: { sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 1, green: 1, blue: 1 },
                textFormat: { bold: false, foregroundColor: { red: 0, green: 0, blue: 0 } },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
          },
        }],
      }),
    }
  );
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
