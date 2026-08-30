const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// ─────────────────────────────────────────────────────────────────────────────
// AUD-026 Adversarial Test Suite: Hosted Checkout Language & Sanitization Check
// ─────────────────────────────────────────────────────────────────────────────

test('AUD-026: checkout.js static file has no raw Hindi/Hinglish mixing in error states or labels', () => {
  const checkoutJsPath = path.join(__dirname, '../public/checkout.js');
  const code = fs.readFileSync(checkoutJsPath, 'utf8');

  // Assert legacy mixed Hinglish strings are NOT present
  assert.strictEqual(code.includes('30 din ke liye'), false, 'Legacy "30 din ke liye" must be removed');
  assert.strictEqual(code.includes('Payment fail ho gaya:'), false, 'Legacy "Payment fail ho gaya" must be removed');
  assert.strictEqual(code.includes('Ab is tab ko band karke'), false, 'Legacy Hinglish tab close message must be removed');
  assert.strictEqual(code.includes('Payment SDK load nahi ho paya'), false, 'Legacy SDK error must be removed');
  assert.strictEqual(code.includes('Server se connect nahi ho pa raha'), false, 'Legacy server error must be removed');

  // Assert clean, friendly English copy is present
  assert.strictEqual(code.includes('Valid for 30 days'), true, 'Duration label must be clean English');
  assert.strictEqual(code.includes('Payment could not be completed. Please try again or use another payment method.'), true, 'Payment failed message must be clean English');
  assert.strictEqual(code.includes('You can now close this tab and return to the Utkio app.'), true, 'Success message must be clean English');
  assert.strictEqual(code.includes('Payment system could not load. Please check your internet connection and reload the page.'), true, 'SDK load failure message must be clean English');
});

test('AUD-026: checkout.html has clean English fallback error message', () => {
  const checkoutHtmlPath = path.join(__dirname, '../public/checkout.html');
  const html = fs.readFileSync(checkoutHtmlPath, 'utf8');

  assert.strictEqual(html.includes('Payment system could not load.'), true);
  assert.strictEqual(html.includes('Please check your internet connection and reload.'), true);
});
