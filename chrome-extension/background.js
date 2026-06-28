/* global chrome */

// Service worker for Invoice OCR extension.
// Handles PDF fetching for tabs that the popup can't reach directly,
// and manages download cleanup.

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["serverUrl", "fieldMapping"], (data) => {
    const defaults = {};
    if (!data.serverUrl) defaults.serverUrl = "http://localhost:8765";
    if (!data.fieldMapping) {
      defaults.fieldMapping = JSON.stringify({
        invoice_number: '[name="invoice_number"], #invoice_number',
        invoice_date: '[name="invoice_date"], #invoice_date',
        due_date: '[name="due_date"], #due_date',
        po_number: '[name="po_number"], #po_number',
        "vendor.name": '[name="vendor_name"], #vendor_name',
        "vendor.tax_id": '[name="vendor_tax_id"], #vendor_tax_id',
        "bill_to.name": '[name="bill_to_name"], #bill_to',
        subtotal: '[name="subtotal"], #subtotal',
        tax: '[name="tax"], #tax_amount',
        total: '[name="total"], #total_amount',
        balance_due: '[name="balance_due"], #balance_due',
        payment_terms: '[name="payment_terms"], #payment_terms',
        notes: '[name="notes"], textarea[name="remarks"]',
      }, null, 2);
    }
    if (Object.keys(defaults).length) chrome.storage.local.set(defaults);
  });
});

// Relay messages from popup to content script when direct messaging fails
// (e.g., popup context vs. background context differences).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "fetchPdfAsBase64") {
    fetchPdfAsBase64(message.url).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true; // keep channel open for async
  }
});

async function fetchPdfAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return { base64: btoa(binary) };
}
