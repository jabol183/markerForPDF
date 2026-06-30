/* global chrome */

// Service worker for Invoice OCR extension.
// Handles PDF fetching for tabs that the popup can't reach directly,
// and manages download cleanup.

// Hardcoded vdesk mapping (https://faktury.unilogo.local)
// IDs sourced from ksefvdeskpins export. "select2:" prefix = Select2 dropdown.
const VDESK_FIELD_MAPPING = {
  "invoice_number": "#fv_edycjadanych2_cc2_a133_idx16",
  "invoice_date":   "#fv_edycjadanych2_cc2_a133_idx20",
  "due_date":       "#fv_edycjadanych2_cc2_a133_idx40",
  "vendor.name":    "#fv_edycjadanych2_cc2_a133_idx3",
  "vendor.address": "#fv_edycjadanych2_cc2_a133_idx21",
  "vendor.tax_id":  "#fv_edycjadanych2_cc2_a133_idx29",
  "subtotal":       "#fv_edycjadanych2_cc2_a133_idx59",
  "tax":            "#fv_edycjadanych2_cc2_a133_idx63",
  "total":          "#fv_edycjadanych2_cc2_a133_idx61",
  "bank_details":   "#fv_edycjadanych2_cc2_a133_idx39",
  "currency":       "select2:#fv_edycjadanych2_cc2_a133_idx38",
  "payment_terms":  "select2:#fv_edycjadanych2_cc2_a133_idx36",
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["serverUrl", "fieldMapping", "vdeskUrl"], (data) => {
    const defaults = {};
    if (!data.serverUrl) defaults.serverUrl = "http://localhost:8765";
    if (!data.vdeskUrl)  defaults.vdeskUrl  = "https://faktury.unilogo.local";
    if (!data.fieldMapping) defaults.fieldMapping = JSON.stringify(VDESK_FIELD_MAPPING, null, 2);
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
