"""
Invoice OCR Server - wraps Marker PDF conversion with invoice-specific structured extraction.
Runs on http://localhost:8765 by default.

Usage:
    python invoice_server.py
    python invoice_server.py --port 8765 --host 0.0.0.0

Environment variables:
    GEMINI_API_KEY  - enables LLM-enhanced extraction (recommended for accuracy)
"""

import io
import json
import os
import re
import tempfile
import traceback
from contextlib import asynccontextmanager
from typing import Optional

import uvicorn
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from marker.config.parser import ConfigParser
from marker.converters.pdf import PdfConverter
from marker.models import create_model_dict
from marker.output import text_from_rendered

app_data = {}


# ---------------------------------------------------------------------------
# Startup / shutdown
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    app_data["models"] = create_model_dict()
    yield
    app_data.pop("models", None)


app = FastAPI(
    title="Invoice OCR API",
    description="Extract structured data from PDF invoices using Marker",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # Chrome extension uses chrome-extension:// origin
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Invoice schema
# ---------------------------------------------------------------------------

class LineItem(BaseModel):
    description: str = ""
    quantity: Optional[str] = None
    unit_price: Optional[str] = None
    amount: Optional[str] = None


class VendorInfo(BaseModel):
    name: str = ""
    address: str = ""
    tax_id: str = ""
    email: str = ""
    phone: str = ""
    website: str = ""


class BillToInfo(BaseModel):
    name: str = ""
    address: str = ""


class InvoiceData(BaseModel):
    invoice_number: str = ""
    invoice_date: str = ""
    due_date: str = ""
    po_number: str = ""
    vendor: VendorInfo = VendorInfo()
    bill_to: BillToInfo = BillToInfo()
    line_items: list[LineItem] = []
    subtotal: str = ""
    discount: str = ""
    tax: str = ""
    shipping: str = ""
    total: str = ""
    amount_paid: str = ""
    balance_due: str = ""
    currency: str = ""
    payment_terms: str = ""
    bank_details: str = ""
    notes: str = ""


# ---------------------------------------------------------------------------
# Regex extraction helpers
# ---------------------------------------------------------------------------

_DATE_PAT = r'\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}\b|\b\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b'
_AMOUNT_PAT = r'[\$€£¥₹]?\s*[\d,]+\.?\d{0,2}'


def _first(pattern: str, text: str, flags=re.IGNORECASE) -> str:
    m = re.search(pattern, text, flags)
    return m.group(0).strip() if m else ""


def _extract_regex(text: str) -> InvoiceData:
    """Best-effort regex extraction when no LLM is available."""
    data = InvoiceData()

    # Invoice number
    for pat in [
        r'invoice\s*#?\s*:?\s*([A-Z0-9\-\/]+)',
        r'inv\.?\s*#?\s*:?\s*([A-Z0-9\-\/]+)',
        r'invoice\s+no\.?\s*:?\s*([A-Z0-9\-\/]+)',
    ]:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            data.invoice_number = m.group(1).strip()
            break

    # Dates
    date_matches = re.findall(_DATE_PAT, text, re.IGNORECASE)
    if date_matches:
        for label_pat, attr in [
            (r'invoice\s+date|date\s+of\s+invoice|issued', 'invoice_date'),
            (r'due\s+date|payment\s+due|pay\s+by', 'due_date'),
        ]:
            m = re.search(label_pat + r'[\s:]+(' + _DATE_PAT + r')', text, re.IGNORECASE)
            if m:
                setattr(data, attr, m.group(1).strip())
        if not data.invoice_date and date_matches:
            data.invoice_date = date_matches[0]

    # PO number
    m = re.search(r'p\.?o\.?\s*#?\s*:?\s*([A-Z0-9\-\/]+)', text, re.IGNORECASE)
    if m:
        data.po_number = m.group(1).strip()

    # Currency detection
    if re.search(r'\$', text):
        data.currency = "USD"
    elif re.search(r'€', text):
        data.currency = "EUR"
    elif re.search(r'£', text):
        data.currency = "GBP"

    # Totals
    for label_pat, attr in [
        (r'sub\s*total|subtotal', 'subtotal'),
        (r'tax|vat|gst|hst', 'tax'),
        (r'discount', 'discount'),
        (r'shipping|freight|delivery', 'shipping'),
        (r'total\s+amount\s+due|total\s+due|amount\s+due|balance\s+due', 'balance_due'),
        (r'\btotal\b', 'total'),
        (r'amount\s+paid|paid', 'amount_paid'),
    ]:
        m = re.search(label_pat + r'[\s:$€£]*(' + _AMOUNT_PAT + r')', text, re.IGNORECASE)
        if m:
            setattr(data, attr, m.group(1).strip())

    # Payment terms
    m = re.search(r'(?:payment\s+terms?|terms?)[\s:]+([^\n]{3,60})', text, re.IGNORECASE)
    if m:
        data.payment_terms = m.group(1).strip()

    # Email
    m = re.search(r'[\w.\-+]+@[\w.\-]+\.\w+', text)
    if m:
        data.vendor.email = m.group(0)

    # Phone
    m = re.search(r'(?:tel|phone|ph|fax)?[\s.:]*(\+?[\d\s\-().]{7,20})', text, re.IGNORECASE)
    if m:
        data.vendor.phone = m.group(1).strip()

    # Notes
    m = re.search(r'(?:notes?|remarks?|comments?)[\s:]+([^\n]{5,200})', text, re.IGNORECASE)
    if m:
        data.notes = m.group(1).strip()

    return data


def _llm_extract(markdown_text: str) -> InvoiceData:
    """Use Gemini via Marker's LLM service to extract structured invoice data."""
    try:
        from marker.services.gemini import GoogleGeminiService
        import google.generativeai as genai

        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            return _extract_regex(markdown_text)

        genai.configure(api_key=api_key)
        model = genai.GenerativeModel("gemini-2.0-flash")

        schema_str = json.dumps(InvoiceData.model_json_schema(), indent=2)
        prompt = f"""You are an expert invoice parser. Extract all invoice fields from the document text below.
Return ONLY a valid JSON object matching this schema (no markdown, no code fences, no extra text):

{schema_str}

Rules:
- Use empty string "" for missing text fields
- Preserve original formatting for amounts (e.g. "$1,234.56")
- For line_items, extract every line item found
- vendor is the company issuing the invoice; bill_to is the recipient

Document text:
---
{markdown_text[:12000]}
---
"""
        response = model.generate_content(prompt)
        raw = response.text.strip()
        # strip possible markdown code fences
        raw = re.sub(r'^```(?:json)?\s*', '', raw)
        raw = re.sub(r'\s*```$', '', raw)
        parsed = json.loads(raw)
        return InvoiceData(**parsed)
    except Exception:
        # fall back to regex
        return _extract_regex(markdown_text)


def _to_markdown(data: InvoiceData, raw_md: str) -> str:
    lines = ["# Invoice Data\n"]

    if data.invoice_number:
        lines.append(f"**Invoice #:** {data.invoice_number}")
    if data.invoice_date:
        lines.append(f"**Invoice Date:** {data.invoice_date}")
    if data.due_date:
        lines.append(f"**Due Date:** {data.due_date}")
    if data.po_number:
        lines.append(f"**PO #:** {data.po_number}")

    if data.vendor.name or data.vendor.address:
        lines.append("\n## Vendor")
        if data.vendor.name:
            lines.append(f"**Name:** {data.vendor.name}")
        if data.vendor.address:
            lines.append(f"**Address:** {data.vendor.address}")
        if data.vendor.tax_id:
            lines.append(f"**Tax ID:** {data.vendor.tax_id}")
        if data.vendor.email:
            lines.append(f"**Email:** {data.vendor.email}")
        if data.vendor.phone:
            lines.append(f"**Phone:** {data.vendor.phone}")

    if data.bill_to.name or data.bill_to.address:
        lines.append("\n## Bill To")
        if data.bill_to.name:
            lines.append(f"**Name:** {data.bill_to.name}")
        if data.bill_to.address:
            lines.append(f"**Address:** {data.bill_to.address}")

    if data.line_items:
        lines.append("\n## Line Items\n")
        lines.append("| Description | Qty | Unit Price | Amount |")
        lines.append("|-------------|-----|-----------|--------|")
        for item in data.line_items:
            lines.append(f"| {item.description} | {item.quantity or ''} | {item.unit_price or ''} | {item.amount or ''} |")

    lines.append("\n## Totals")
    for label, val in [
        ("Subtotal", data.subtotal),
        ("Discount", data.discount),
        ("Tax / VAT", data.tax),
        ("Shipping", data.shipping),
        ("Total", data.total),
        ("Amount Paid", data.amount_paid),
        ("Balance Due", data.balance_due),
    ]:
        if val:
            lines.append(f"**{label}:** {val}")

    if data.payment_terms:
        lines.append(f"\n**Payment Terms:** {data.payment_terms}")
    if data.bank_details:
        lines.append(f"\n**Bank Details:** {data.bank_details}")
    if data.notes:
        lines.append(f"\n**Notes:** {data.notes}")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {"status": "ok", "models_loaded": "models" in app_data}


@app.post("/extract-invoice")
async def extract_invoice(
    file: UploadFile = File(...),
    output_format: str = "both",       # "json" | "markdown" | "both"
    use_llm: bool = False,
    force_ocr: bool = False,
):
    """
    Accept a PDF file upload, run Marker OCR, extract invoice fields.

    Returns:
        invoice_json  - structured invoice data as a dict
        markdown      - human-readable markdown summary
        raw_markdown  - full Marker output (unprocessed)
    """
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    if "models" not in app_data:
        raise HTTPException(status_code=503, detail="Models not yet loaded, please retry in a moment")

    try:
        pdf_bytes = await file.read()

        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(pdf_bytes)
            tmp_path = tmp.name

        try:
            config_dict = {
                "filepath": tmp_path,
                "output_format": "markdown",
                "force_ocr": force_ocr,
                "pdftext_workers": 1,
            }
            if use_llm and os.environ.get("GEMINI_API_KEY"):
                config_dict["use_llm"] = True
                config_dict["gemini_api_key"] = os.environ["GEMINI_API_KEY"]

            config_parser = ConfigParser(config_dict)
            converter = PdfConverter(
                config=config_parser.generate_config_dict(),
                artifact_dict=app_data["models"],
                processor_list=config_parser.get_processors(),
                renderer=config_parser.get_renderer(),
            )
            rendered = converter(tmp_path)
            raw_markdown, _, _ = text_from_rendered(rendered)

        finally:
            os.unlink(tmp_path)

        # Extract structured invoice data
        has_llm = use_llm and os.environ.get("GEMINI_API_KEY")
        invoice_data: InvoiceData = (
            _llm_extract(raw_markdown) if has_llm else _extract_regex(raw_markdown)
        )

        md_summary = _to_markdown(invoice_data, raw_markdown)

        return JSONResponse({
            "invoice_json": invoice_data.model_dump(),
            "markdown": md_summary,
            "raw_markdown": raw_markdown,
            "extraction_method": "llm" if has_llm else "regex",
        })

    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import click

    @click.command()
    @click.option("--host", default="127.0.0.1", help="Host to bind")
    @click.option("--port", default=8765, help="Port to listen on")
    @click.option("--reload", is_flag=True, help="Auto-reload on code changes")
    def main(host, port, reload):
        uvicorn.run(
            "invoice_server:app",
            host=host,
            port=port,
            reload=reload,
        )

    main()
