# Invoice OCR Chrome Extension

Extract structured data from PDF invoices using local Marker OCR — outputs clean JSON + Markdown ready for vdesk form filling.

---

## Architecture

```
Browser (Chrome Extension)
        |
        | HTTP POST /extract-invoice (multipart PDF)
        |
invoice_server.py  (FastAPI, port 8765)
        |
        | Marker PdfConverter
        |
    OCR + invoice field extraction
        |
        | JSON response
        |
Chrome Extension popup  →  displays results  →  fills vdesk form
```

---

## 1. Start the backend server

```bash
# Install dependencies (if not already done)
pip install fastapi uvicorn python-multipart

# Start the invoice server
python invoice_server.py

# Optional flags
python invoice_server.py --port 8765 --host 0.0.0.0

# LLM-enhanced extraction (higher accuracy) — requires Gemini API key
GEMINI_API_KEY=AIza... python invoice_server.py
```

The server loads Marker models on startup (~20–30s first run).  
Visit http://localhost:8765/docs for the Swagger API explorer.

---

## 2. Install the Chrome extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `chrome-extension/` folder from this repo
5. The Invoice OCR icon appears in the toolbar

---

## 3. Using the extension

### Extract from a PDF file
1. Click the toolbar icon
2. Drag-and-drop a PDF invoice onto the upload area, or click **Browse file**
3. Wait for extraction (~5–15s depending on PDF size)
4. View structured data in the **JSON**, **Markdown**, or **Raw OCR** tabs

### Extract from a PDF open in Chrome
1. Open the PDF invoice in a Chrome tab
2. Click the toolbar icon
3. Click **Extract from current tab PDF**

### Output formats
- **JSON** — Structured invoice object (invoice #, dates, vendor, line items, totals, etc.)
- **Markdown** — Readable summary table
- **Raw OCR** — Full Marker output before field extraction

### Copy / Download
- **Copy JSON** — Copies the structured JSON to clipboard
- **Copy MD** — Copies the Markdown summary
- **Download** — Saves both `invoice_<number>.json` and `invoice_<number>.md`

---

## 4. Auto-fill vdesk forms

1. Open your vdesk form in Chrome
2. Extract an invoice using the extension
3. Click **Fill vdesk form** — the content script maps invoice fields to form inputs

### Configuring field mappings

Click the settings gear icon and edit the **Field mapping** JSON:

```json
{
  "invoice_number": "#inv-num, [name='invoice_number']",
  "invoice_date":   "#inv-date",
  "vendor.name":    "#supplier-name",
  "total":          "#total-amount",
  "tax":            "#vat-amount",
  "bill_to.name":   "#customer-name"
}
```

Keys are invoice field paths (supports dot notation for nested fields like `vendor.name`).  
Values are comma-separated CSS selectors — the first matching element is filled.

### Available invoice fields

| Field | Description |
|-------|-------------|
| `invoice_number` | Invoice / reference number |
| `invoice_date` | Issue date |
| `due_date` | Payment due date |
| `po_number` | Purchase order number |
| `vendor.name` | Supplier name |
| `vendor.address` | Supplier address |
| `vendor.tax_id` | Supplier VAT / tax ID |
| `vendor.email` | Supplier email |
| `vendor.phone` | Supplier phone |
| `bill_to.name` | Customer / billed-to name |
| `bill_to.address` | Customer address |
| `subtotal` | Pre-tax subtotal |
| `tax` | Tax / VAT amount |
| `discount` | Discount amount |
| `shipping` | Shipping / freight |
| `total` | Invoice total |
| `balance_due` | Outstanding balance |
| `currency` | Currency code (USD, EUR, etc.) |
| `payment_terms` | Payment terms (Net 30, etc.) |
| `bank_details` | Bank / IBAN details |
| `notes` | Notes / remarks |

---

## 5. LLM-enhanced extraction

For higher accuracy (especially on complex layouts), enable **Use LLM (Gemini)**:

1. Get a free Gemini API key at https://aistudio.google.com/
2. Open extension Settings → paste key in **Gemini API Key**
3. Toggle **Use LLM** in the popup before extracting

The server must also have `GEMINI_API_KEY` set in its environment.

---

## 6. Settings reference

| Setting | Default | Description |
|---------|---------|-------------|
| Server URL | `http://localhost:8765` | URL of the running invoice_server.py |
| Gemini API Key | — | Optional, enables LLM extraction |
| vdesk URL pattern | — | For documentation only (future: restrict content script) |
| Field mapping | (see defaults) | CSS selector map for form filling |

---

## Troubleshooting

**"Server offline"** — Run `python invoice_server.py` and wait for models to load.

**"Could not reach page"** — The content script didn't inject. Try reloading the vdesk tab.

**Extraction misses fields** — Enable LLM mode for better accuracy, or use Force OCR for scanned PDFs.

**CORS error in server** — The server has `allow_origins=["*"]` so this shouldn't occur; check firewall rules if running on a non-localhost host.
