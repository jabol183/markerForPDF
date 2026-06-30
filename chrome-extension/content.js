/* global chrome */

// Content script injected into all pages.
// Listens for fillForm messages from the popup and auto-fills vdesk form fields.
// Handles both plain inputs and Select2 dropdowns.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "fillForm") {
    const result = fillForm(message.invoiceData, message.fieldMapping);
    sendResponse(result);
  }
  return true;
});

/**
 * Fill form fields using invoice data and the field mapping.
 * Mapping values starting with "select2:" are treated as Select2 dropdowns.
 */
function fillForm(invoiceData, fieldMapping) {
  let filled = 0;
  const errors = [];

  for (const [fieldPath, selector] of Object.entries(fieldMapping)) {
    if (!selector) continue;

    const value = resolvePath(invoiceData, fieldPath);
    if (!value || typeof value === "object") continue;

    const strValue = String(value);
    const isSelect2 = selector.startsWith("select2:");
    const cssSelector = isSelect2 ? selector.slice(8) : selector;

    // Try each comma-separated selector
    const selectors = cssSelector.split(",").map((s) => s.trim());
    let matched = false;

    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;

        if (isSelect2 || el.tagName === "SELECT") {
          fillSelect2(el, strValue);
        } else if (el.type === "checkbox" || el.type === "radio") {
          el.checked = Boolean(value);
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          setInputValue(el, strValue);
        }

        matched = true;
        filled++;
        break;
      } catch (err) {
        errors.push(`${fieldPath} → ${sel}: ${err.message}`);
      }
    }

    if (!matched) {
      errors.push(`${fieldPath}: no element found for selector "${cssSelector}"`);
    }
  }

  return { success: true, filled, errors };
}

// ---------------------------------------------------------------------------
// Select2 filling
// ---------------------------------------------------------------------------

/**
 * Set a Select2 (or plain <select>) element's value.
 * Tries three approaches in order:
 *   1. jQuery + Select2 API (if jQuery is on the page)
 *   2. Native <select> value + change event (works when Select2 listens to change)
 *   3. Click the Select2 container + type the value into the search box
 */
function fillSelect2(el, value) {
  const lower = value.toLowerCase();

  // --- Approach 1: jQuery / Select2 API ---
  if (window.jQuery) {
    const $el = window.jQuery(el);
    // Try matching by option text or value
    const matched = matchSelectOption(el, lower);
    if (matched !== null) {
      $el.val(matched).trigger("change");
      return;
    }
  }

  // --- Approach 2: Native select ---
  if (el.tagName === "SELECT") {
    const matched = matchSelectOption(el, lower);
    if (matched !== null) {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype, "value"
      )?.set;
      if (nativeSetter) nativeSetter.call(el, matched);
      else el.value = matched;

      el.dispatchEvent(new Event("change", { bubbles: true }));
      // Also fire select2:select so Select2 updates its display
      el.dispatchEvent(new CustomEvent("select2:select", {
        bubbles: true,
        detail: { data: { id: matched, text: value } },
      }));
      return;
    }
  }

  // --- Approach 3: Simulate click + type into Select2 search box ---
  // Find the Select2 container for this select element
  const containerId = `select2-${el.id}-container`;
  const container = document.getElementById(containerId);
  if (container) {
    simulateSelect2Search(container, el, value);
  }
}

/**
 * Find the option value in a <select> that best matches the given text (case-insensitive).
 * Returns the option's value attribute, or null if nothing matches.
 */
function matchSelectOption(el, lowerText) {
  // Exact value match
  for (const opt of el.options) {
    if (opt.value.toLowerCase() === lowerText) return opt.value;
  }
  // Exact text match
  for (const opt of el.options) {
    if (opt.text.toLowerCase() === lowerText) return opt.value;
  }
  // Partial text match
  for (const opt of el.options) {
    if (opt.text.toLowerCase().includes(lowerText)) return opt.value;
  }
  return null;
}

/**
 * Simulate opening a Select2 dropdown and typing to search, then picking the first result.
 */
function simulateSelect2Search(container, selectEl, value) {
  // Open the dropdown
  container.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

  setTimeout(() => {
    // Type into the search input Select2 creates
    const searchInput = document.querySelector(".select2-search__field");
    if (searchInput) {
      setInputValue(searchInput, value);
      searchInput.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));

      setTimeout(() => {
        // Click the first result
        const firstResult = document.querySelector(".select2-results__option");
        if (firstResult) firstResult.click();
      }, 300);
    }
  }, 150);
}

// ---------------------------------------------------------------------------
// Plain input filling
// ---------------------------------------------------------------------------

/**
 * Set input/textarea value and fire React/Vue/Angular compatible events.
 */
function setInputValue(el, value) {
  const proto = el.tagName === "TEXTAREA"
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

  if (nativeSetter) nativeSetter.call(el, value);
  else el.value = value;

  el.dispatchEvent(new Event("input",  { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur",   { bubbles: true }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a dot-separated path in an object.
 * e.g. resolvePath({vendor: {name: "Acme"}}, "vendor.name") => "Acme"
 */
function resolvePath(obj, path) {
  return path.split(".").reduce((acc, key) => acc?.[key], obj);
}
