/* global chrome */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let serverUrl = "http://localhost:8765";
let extractedData = null;

// Hardcoded field mapping for vdesk at https://faktury.unilogo.local
// Element IDs sourced from ksefvdeskpins export.
// Fields prefixed with "select2:" are Select2 dropdowns — content.js handles them specially.
const DEFAULT_FIELD_MAPPING = {
  // Plain text inputs
  "invoice_number": "#fv_edycjadanych2_cc2_a133_idx16",   // invoiceNumber
  "invoice_date":   "#fv_edycjadanych2_cc2_a133_idx20",   // issueDate
  "due_date":       "#fv_edycjadanych2_cc2_a133_idx40",   // paymentDue
  "vendor.name":    "#fv_edycjadanych2_cc2_a133_idx3",    // sellerName
  "vendor.address": "#fv_edycjadanych2_cc2_a133_idx21",   // sellerAddress
  "vendor.tax_id":  "#fv_edycjadanych2_cc2_a133_idx29",   // sellerNip (Polish tax ID)
  "subtotal":       "#fv_edycjadanych2_cc2_a133_idx59",   // totalNet
  "tax":            "#fv_edycjadanych2_cc2_a133_idx63",   // totalVat
  "total":          "#fv_edycjadanych2_cc2_a133_idx61",   // totalGross
  "bank_details":   "#fv_edycjadanych2_cc2_a133_idx39",   // bankAccount
  // Select2 dropdowns (underlying <select> IDs, stripped of select2- prefix/-container suffix)
  "currency":       "select2:#fv_edycjadanych2_cc2_a133_idx38",   // currency
  "payment_terms":  "select2:#fv_edycjadanych2_cc2_a133_idx36",   // paymentForm
};

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const views = {
  main: $("mainView"),
  loading: $("loadingView"),
  results: $("resultsView"),
  settings: $("settingsView"),
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  checkServerHealth();
  bindEvents();
});

async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ["serverUrl", "geminiKey", "vdeskUrl", "fieldMapping", "useLlm", "forceOcr"],
      (data) => {
        serverUrl = data.serverUrl || "http://localhost:8765";
        $("serverUrlInput").value = serverUrl;
        $("geminiKeyInput").value = data.geminiKey || "";
        $("vdeskUrlInput").value = data.vdeskUrl || "https://faktury.unilogo.local";
        $("fieldMappingInput").value =
          data.fieldMapping || JSON.stringify(DEFAULT_FIELD_MAPPING, null, 2);
        $("useLlmToggle").checked = data.useLlm || false;
        $("forceOcrToggle").checked = data.forceOcr || false;
        resolve();
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Server health
// ---------------------------------------------------------------------------

async function checkServerHealth() {
  const dot = $("statusDot");
  const text = $("statusText");
  dot.className = "status-dot checking";
  text.textContent = "Checking server...";
  try {
    const res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    if (data.status === "ok") {
      dot.className = "status-dot online";
      text.textContent = data.models_loaded
        ? "Server online • Models ready"
        : "Server online • Loading models...";
    } else {
      throw new Error("bad status");
    }
  } catch {
    dot.className = "status-dot offline";
    text.textContent = "Server offline — run invoice_server.py";
  }
}

// ---------------------------------------------------------------------------
// Event binding
// ---------------------------------------------------------------------------

function bindEvents() {
  // Upload area
  const uploadArea = $("uploadArea");
  const fileInput = $("fileInput");

  uploadArea.addEventListener("click", () => fileInput.click());
  $("browseBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  fileInput.addEventListener("change", (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });

  uploadArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadArea.classList.add("drag-over");
  });
  uploadArea.addEventListener("dragleave", () => uploadArea.classList.remove("drag-over"));
  uploadArea.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadArea.classList.remove("drag-over");
    const file = e.dataTransfer?.files[0];
    if (file) handleFile(file);
  });

  // Current tab PDF
  $("extractTabBtn").addEventListener("click", handleTabPdf);

  // Results actions
  $("copyJsonBtn").addEventListener("click", () => {
    if (!extractedData) return;
    navigator.clipboard.writeText(JSON.stringify(extractedData.invoice_json, null, 2));
    showToast("JSON copied!", "success");
  });

  $("copyMdBtn").addEventListener("click", () => {
    if (!extractedData) return;
    navigator.clipboard.writeText(extractedData.markdown);
    showToast("Markdown copied!", "success");
  });

  $("downloadBtn").addEventListener("click", () => {
    if (!extractedData) return;
    downloadResult(extractedData);
  });

  $("fillFormBtn").addEventListener("click", fillVdeskForm);

  $("newExtractionBtn").addEventListener("click", () => {
    extractedData = null;
    showView("main");
    fileInput.value = "";
  });

  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-pane").forEach((p) => p.classList.add("hidden"));
      tab.classList.add("active");
      $(`tab-${tab.dataset.tab}`).classList.remove("hidden");
    });
  });

  // Settings
  $("settingsBtn").addEventListener("click", () => showView("settings"));
  $("saveSettingsBtn").addEventListener("click", saveSettings);
  $("cancelSettingsBtn").addEventListener("click", () => showView("main"));
}

// ---------------------------------------------------------------------------
// File handling
// ---------------------------------------------------------------------------

async function handleFile(file) {
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    showToast("Please select a PDF file", "error");
    return;
  }
  await uploadAndExtract(file);
}

async function handleTabPdf() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab.url || "";

    if (!url.toLowerCase().endsWith(".pdf") && !url.includes("application/pdf")) {
      showToast("Current tab is not a PDF", "error");
      return;
    }

    $("loadingStep").textContent = "Fetching PDF from tab...";
    showView("loading");

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch PDF: ${response.status}`);
    const blob = await response.blob();
    const file = new File([blob], "invoice.pdf", { type: "application/pdf" });
    await uploadAndExtract(file);
  } catch (err) {
    showToast(err.message, "error");
    showView("main");
  }
}

// ---------------------------------------------------------------------------
// Upload + extract
// ---------------------------------------------------------------------------

async function uploadAndExtract(file) {
  showView("loading");
  $("loadingStep").textContent = "Converting PDF with Marker OCR...";

  const useLlm = $("useLlmToggle").checked;
  const forceOcr = $("forceOcrToggle").checked;

  const formData = new FormData();
  formData.append("file", file);

  const params = new URLSearchParams({
    use_llm: useLlm,
    force_ocr: forceOcr,
  });

  try {
    $("loadingStep").textContent = "Extracting invoice fields...";
    const res = await fetch(`${serverUrl}/extract-invoice?${params}`, {
      method: "POST",
      body: formData,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Extraction failed");
    }

    extractedData = await res.json();
    renderResults(extractedData);
    showView("results");
  } catch (err) {
    showToast(`Error: ${err.message}`, "error");
    showView("main");
  }
}

// ---------------------------------------------------------------------------
// Render results
// ---------------------------------------------------------------------------

function renderResults(data) {
  const inv = data.invoice_json;

  // Summary cards
  const cards = [
    { label: "Invoice #", value: inv.invoice_number || "—" },
    { label: "Date", value: inv.invoice_date || "—" },
    { label: "Total", value: inv.total || inv.balance_due || "—", accent: true },
    { label: "Vendor", value: inv.vendor?.name || "—" },
  ];

  $("summaryCards").innerHTML = cards
    .map(
      (c) => `
      <div class="summary-card${c.accent ? " accent" : ""}">
        <div class="summary-card-label">${c.label}</div>
        <div class="summary-card-value" title="${c.value}">${c.value}</div>
      </div>`
    )
    .join("");

  // JSON tab
  $("jsonOutput").textContent = JSON.stringify(inv, null, 2);

  // Markdown tab
  $("markdownOutput").textContent = data.markdown;

  // Raw tab
  $("rawOutput").textContent = data.raw_markdown;
}

// ---------------------------------------------------------------------------
// vdesk form filling
// ---------------------------------------------------------------------------

async function fillVdeskForm() {
  if (!extractedData) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chrome.storage.local.get(["fieldMapping"], (storageData) => {
    let mapping;
    try {
      mapping = JSON.parse(storageData.fieldMapping || "{}");
    } catch {
      mapping = DEFAULT_FIELD_MAPPING;
    }

    chrome.tabs.sendMessage(
      tab.id,
      {
        action: "fillForm",
        invoiceData: extractedData.invoice_json,
        fieldMapping: mapping,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          showToast("Could not reach page. Is vdesk open?", "error");
          return;
        }
        if (response?.success) {
          showToast(`Filled ${response.filled} field(s)`, "success");
        } else {
          showToast(response?.error || "Form fill failed", "error");
        }
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

function downloadResult(data) {
  const inv = data.invoice_json;
  const filename = `invoice_${inv.invoice_number || Date.now()}`;

  // Download JSON
  const jsonBlob = new Blob([JSON.stringify(inv, null, 2)], { type: "application/json" });
  const jsonUrl = URL.createObjectURL(jsonBlob);
  chrome.downloads.download({ url: jsonUrl, filename: `${filename}.json`, saveAs: false });

  // Download Markdown
  const mdBlob = new Blob([data.markdown], { type: "text/markdown" });
  const mdUrl = URL.createObjectURL(mdBlob);
  chrome.downloads.download({ url: mdUrl, filename: `${filename}.md`, saveAs: false });

  showToast("Downloading JSON + Markdown", "success");
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function saveSettings() {
  const newUrl = $("serverUrlInput").value.trim().replace(/\/$/, "");
  const geminiKey = $("geminiKeyInput").value.trim();
  const vdeskUrl = $("vdeskUrlInput").value.trim();
  let fieldMapping = $("fieldMappingInput").value.trim();

  try {
    JSON.parse(fieldMapping);
  } catch {
    showToast("Field mapping is not valid JSON", "error");
    return;
  }

  serverUrl = newUrl || "http://localhost:8765";

  chrome.storage.local.set({ serverUrl, geminiKey, vdeskUrl, fieldMapping }, () => {
    showToast("Settings saved", "success");
    checkServerHealth();
    showView("main");
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function showView(name) {
  Object.values(views).forEach((v) => v.classList.add("hidden"));
  views[name]?.classList.remove("hidden");
}

let toastTimer = null;
function showToast(msg, type = "") {
  const toast = $("toast");
  toast.textContent = msg;
  toast.className = `toast${type ? " " + type : ""}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.className = "toast hidden"), 2500);
}
