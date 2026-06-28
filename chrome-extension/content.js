/* global chrome */

// Content script injected into all pages.
// Listens for fillForm messages from the popup and auto-fills vdesk form fields.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "fillForm") {
    const result = fillForm(message.invoiceData, message.fieldMapping);
    sendResponse(result);
  }
  return true;
});

/**
 * Fill form fields on the current page using invoice data and a CSS selector mapping.
 *
 * @param {Object} invoiceData  - The extracted invoice JSON
 * @param {Object} fieldMapping - Maps invoice field paths to CSS selectors
 * @returns {{ success: boolean, filled: number, errors: string[] }}
 */
function fillForm(invoiceData, fieldMapping) {
  let filled = 0;
  const errors = [];

  for (const [fieldPath, selector] of Object.entries(fieldMapping)) {
    if (!selector) continue;

    // Resolve nested field path like "vendor.name"
    const value = resolvePath(invoiceData, fieldPath);
    if (!value || (typeof value === "object")) continue;

    // Try each comma-separated selector
    const selectors = selector.split(",").map((s) => s.trim());
    let matched = false;

    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;

        if (el.tagName === "SELECT") {
          setSelectValue(el, String(value));
        } else if (el.type === "checkbox" || el.type === "radio") {
          el.checked = Boolean(value);
        } else {
          setInputValue(el, String(value));
        }

        matched = true;
        filled++;
        break;
      } catch (err) {
        errors.push(`${fieldPath} (${sel}): ${err.message}`);
      }
    }

    if (!matched && selectors.length > 0) {
      // non-fatal: field not found on this page
    }
  }

  // Also try to fill line items table if present
  if (invoiceData.line_items?.length) {
    fillLineItems(invoiceData.line_items);
  }

  return { success: true, filled, errors };
}

/**
 * Resolve a dot-separated path in an object.
 * e.g. resolvePath({vendor: {name: "Acme"}}, "vendor.name") => "Acme"
 */
function resolvePath(obj, path) {
  return path.split(".").reduce((acc, key) => acc?.[key], obj);
}

/**
 * Set input/textarea value and fire React/Vue compatible change events.
 */
function setInputValue(el, value) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
    "value"
  )?.set;

  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(el, value);
  } else {
    el.value = value;
  }

  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

/**
 * Set a <select> element's value by matching option text or value.
 */
function setSelectValue(el, value) {
  const lower = value.toLowerCase();

  // Try exact value match first
  for (const option of el.options) {
    if (option.value.toLowerCase() === lower || option.text.toLowerCase() === lower) {
      el.value = option.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
  }

  // Try partial text match
  for (const option of el.options) {
    if (option.text.toLowerCase().includes(lower)) {
      el.value = option.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
  }
}

/**
 * Attempt to fill a line items table.
 * Looks for a table with rows having cells matching quantity/description/amount patterns.
 */
function fillLineItems(lineItems) {
  const tables = document.querySelectorAll("table");
  for (const table of tables) {
    const rows = table.querySelectorAll("tbody tr");
    if (!rows.length) continue;

    lineItems.forEach((item, index) => {
      let row = rows[index];

      // If table has an "Add row" button and we need more rows, click it
      if (!row) {
        const addBtn = document.querySelector(
          '[data-action="add-line"], .add-line-item, button[aria-label*="add row" i]'
        );
        if (addBtn) {
          addBtn.click();
          row = table.querySelectorAll("tbody tr")[index];
        }
      }

      if (!row) return;

      // Try to fill cells by common input name/placeholder patterns
      const cellMappings = [
        { patterns: ["description", "desc", "item", "service"], value: item.description },
        { patterns: ["qty", "quantity", "units"], value: item.quantity },
        { patterns: ["unit_price", "price", "rate", "unit"], value: item.unit_price },
        { patterns: ["amount", "total", "subtotal", "line_total"], value: item.amount },
      ];

      const inputs = row.querySelectorAll("input, textarea, select");
      inputs.forEach((input) => {
        const name = (input.name || input.id || input.placeholder || "").toLowerCase();
        for (const { patterns, value } of cellMappings) {
          if (value && patterns.some((p) => name.includes(p))) {
            setInputValue(input, String(value));
            break;
          }
        }
      });
    });

    break; // only fill the first matching table
  }
}
