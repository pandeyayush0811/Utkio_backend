(function () {
  'use strict';

  const cardEl = document.getElementById('card');
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');

  // Basic HTML-escape for anything derived from server data before we
  // ever put it into innerHTML — order.plan is server-controlled today,
  // but this keeps the page safe even if that ever changes.
  function esc(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function renderError(text) {
    cardEl.innerHTML =
      '<div class="logo">Utkio</div>' +
      '<div class="msg err" style="margin-top:16px;">' + esc(text) + '</div>' +
      '<div class="sub" style="margin-top:10px;">App par wapas jaakar dobara try karo.</div>';
  }

  function renderSuccess(planLabel) {
    cardEl.innerHTML =
      '<div class="logo">Utkio</div>' +
      '<svg class="success-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>' +
      '<div class="plan-name" style="margin-top:14px;">Payment successful!</div>' +
      '<div class="sub">' + esc(planLabel) + ' plan is now active.</div>' +
      '<div class="sub" style="margin-top:18px;">Ab is tab ko band karke Utkio app par wapas jao.</div>';
  }

  function renderOrder(order) {
    const rupees = (order.amount / 100).toLocaleString('en-IN');
    const planLabel = order.plan.charAt(0).toUpperCase() + order.plan.slice(1);
    cardEl.innerHTML =
      '<div class="logo">Utkio</div>' +
      '<div class="plan-name">Uktio ' + esc(planLabel) + '</div>' +
      '<div class="amount">\u20B9' + esc(rupees) + '</div>' +
      '<div class="sub">30 din ke liye</div>' +
      '<button id="payBtn">Pay \u20B9' + esc(rupees) + '</button>' +
      '<div class="msg" id="msg"></div>';

    document.getElementById('payBtn').addEventListener('click', function () {
      startPayment(order, planLabel);
    });
  }

  function startPayment(order, planLabel) {
    if (typeof Razorpay === 'undefined') {
      const msg = document.getElementById('msg');
      msg.textContent = 'Payment SDK load nahi ho paya — internet check karke page reload karo.';
      msg.className = 'msg err';
      return;
    }
    const payBtn = document.getElementById('payBtn');
    const msg = document.getElementById('msg');
    payBtn.disabled = true;
    msg.textContent = '';
    msg.className = 'msg';

    const rzp = new Razorpay({
      key: order.key_id,
      amount: order.amount,
      currency: order.currency,
      order_id: order.order_id,
      name: 'Uktio',
      description: 'Uktio ' + planLabel + ' \u2014 30 din',
      theme: { color: '#6a63f1' },
      handler: async function (response) {
        msg.textContent = 'Verifying payment...';
        try {
          const res = await fetch('/payments/checkout/' + encodeURIComponent(token) + '/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(response)
          });
          const data = await res.json().catch(function () { return {}; });
          if (!res.ok) throw new Error(data.error || 'Verification failed');
          renderSuccess(planLabel);
        } catch (e) {
          // Payment DID succeed with Razorpay — the webhook (server-to-
          // server, independent of this tab) still activates the plan
          // shortly even if this verify call itself failed. Don't scare
          // the user into re-paying.
          msg.textContent = 'Payment ho gaya! Plan activate hone mein thoda time lag sakta hai. App par wapas jaakar thodi der mein check karo.';
          msg.className = 'msg ok';
          payBtn.style.display = 'none';
        }
      },
      modal: {
        ondismiss: function () {
          payBtn.disabled = false;
        }
      }
    });

    rzp.on('payment.failed', function (resp) {
      msg.textContent = 'Payment fail ho gaya: ' + (resp.error && resp.error.description ? resp.error.description : 'try again');
      msg.className = 'msg err';
      payBtn.disabled = false;
    });

    rzp.open();
  }

  async function init() {
    if (!token) {
      renderError('Invalid checkout link.');
      return;
    }
    // Guard: if the Razorpay SDK script itself got blocked (CSP
    // misconfig, ad-blocker, offline CDN) we want a visible error
    // instead of silently sitting at "Loading your order...".
    if (typeof Razorpay === 'undefined') {
      renderError('Payment SDK load nahi ho paya. Internet check karke reload karo.');
      return;
    }
    try {
      const res = await fetch('/payments/checkout/' + encodeURIComponent(token));
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        renderError(data.error || 'This checkout link is no longer valid.');
        return;
      }
      renderOrder(data);
    } catch (e) {
      renderError('Server se connect nahi ho pa raha. Internet check karo aur reload karo.');
    }
  }

  // Hard safety net: if anything above throws synchronously before its
  // own try/catch can run (e.g. a future edit), the user still sees an
  // error instead of an infinite spinner.
  window.addEventListener('error', function () {
    if (cardEl && cardEl.querySelector('.spinner')) {
      renderError('Kuch gadbad hui page load karte waqt. Reload karo.');
    }
  });

  init();
})();
