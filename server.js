const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || '';
const DATA_FILE = path.join(__dirname, 'starvibe_data.json');

const COIN_PACKS = {
  50: { coins: 50, title: 'StarVibe — 50 Monedas', unit_price: 5.0 },
  150: { coins: 150, title: 'StarVibe — 150 Monedas', unit_price: 15.0 },
  500: { coins: 500, title: 'StarVibe — 500 Monedas', unit_price: 50.0 },
  1000: { coins: 1000, title: 'StarVibe — 1000 Monedas', unit_price: 100.0 }
};

function loadPersistentState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        payments: parsed.payments || {},
        withdrawals: parsed.withdrawals || []
      };
    }
  } catch (e) {}
  return { payments: {}, withdrawals: [] };
}

let dbState = loadPersistentState();

function savePersistentState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(dbState, null, 2), 'utf8');
  } catch (e) {}
}

// Health check endpoint (used by external monitors like UptimeRobot/Cron and self-keepalive)
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'StarVibe Shielded Server',
    timestamp: new Date().toISOString(),
    mpConfigured: Boolean(MP_ACCESS_TOKEN)
  });
});

// Anti-sleep keep-alive ping every 10 minutes
setInterval(() => {
  const targetUrl = PUBLIC_APP_URL || `http://127.0.0.1:${PORT}/api/health`;
  fetch(targetUrl, { method: 'GET' }).catch(() => {});
}, 10 * 60 * 1000);

// Create Mercado Pago order
app.post('/api/mercadopago/create-order', async (req, res) => {
  try {
    const packId = Number(req.body.packCoins);
    const userId = String(req.body.userId || 'guest').slice(0, 80);
    const pack = COIN_PACKS[packId];

    if (!pack) {
      return res.status(400).json({ error: 'Paquete de monedas no válido' });
    }
    if (!MP_ACCESS_TOKEN) {
      return res.status(500).json({ error: 'Falta configurar MP_ACCESS_TOKEN en Render' });
    }

    const baseUrl = PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`;
    const externalRef = `sv_${userId}_${pack.coins}_${Date.now()}`;

    const mpResp = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        items: [
          {
            title: pack.title,
            quantity: 1,
            currency_id: 'BRL',
            unit_price: pack.unit_price
          }
        ],
        external_reference: externalRef,
        notification_url: `${baseUrl}/api/mercadopago/webhook`,
        back_urls: {
          success: `${baseUrl}/?mp_status=approved&ref=${encodeURIComponent(externalRef)}`,
          pending: `${baseUrl}/?mp_status=pending&ref=${encodeURIComponent(externalRef)}`,
          failure: `${baseUrl}/?mp_status=failure&ref=${encodeURIComponent(externalRef)}`
        },
        auto_return: 'approved',
        payment_methods: {
          excluded_payment_types: [],
          installments: 1
        }
      })
    });

    const data = await mpResp.json();
    if (!mpResp.ok) {
      return res.status(mpResp.status).json({ error: data.message || 'Error en Mercado Pago' });
    }

    dbState.payments[externalRef] = {
      userId,
      coins: pack.coins,
      amountBRL: pack.unit_price,
      status: 'pending',
      approved: false,
      createdAt: new Date().toISOString()
    };
    savePersistentState();

    return res.json({
      ref: externalRef,
      checkoutUrl: data.init_point,
      sandboxUrl: data.sandbox_init_point
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Error interno del servidor' });
  }
});

// Mercado Pago Webhook
app.post('/api/mercadopago/webhook', async (req, res) => {
  try {
    const topic = req.query.type || req.body.type;
    const paymentId = req.query['data.id'] || (req.body.data && req.body.data.id);

    if (topic === 'payment' && paymentId && MP_ACCESS_TOKEN) {
      const checkResp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
      });
      if (checkResp.ok) {
        const payment = await checkResp.json();
        const ref = payment.external_reference;
        if (ref && dbState.payments[ref]) {
          dbState.payments[ref].status = payment.status;
          dbState.payments[ref].approved = payment.status === 'approved';
          dbState.payments[ref].updatedAt = new Date().toISOString();
          savePersistentState();
        }
      }
    }
    return res.status(200).send('OK');
  } catch (err) {
    return res.status(200).send('OK');
  }
});

// Check order status
app.get('/api/mercadopago/status', (req, res) => {
  const ref = String(req.query.ref || '');
  const entry = dbState.payments[ref];
  if (!entry) {
    return res.status(404).json({ status: 'not_found' });
  }
  return res.json({
    status: entry.status,
    approved: entry.status === 'approved',
    coins: entry.coins,
    amountBRL: entry.amountBRL
  });
});

// Register creator payout / withdrawal request
app.post('/api/payouts/request', (req, res) => {
  try {
    const amountBRL = Number(req.body.amountBRL || 0);
    const pixKey = String(req.body.pixKey || '').trim();
    const fullName = String(req.body.fullName || '').trim();
    const uid = String(req.body.uid || 'guest');

    if (!fullName || fullName.length < 4) {
      return res.status(400).json({ error: 'Nombre completo del titular obligatorio' });
    }
    if (!pixKey || pixKey.length < 4) {
      return res.status(400).json({ error: 'Clave PIX válida obligatoria' });
    }
    if (!isFinite(amountBRL) || amountBRL < 20) {
      return res.status(400).json({ error: 'El retiro mínimo es de R$ 20,00' });
    }

    const requestRecord = {
      id: 'wd_' + Date.now(),
      uid,
      fullName,
      pixKey,
      amountBRL: Number(amountBRL.toFixed(2)),
      status: 'pending_review',
      createdAt: new Date().toISOString()
    };

    dbState.withdrawals.push(requestRecord);
    savePersistentState();

    return res.json({ ok: true, request: requestRecord });
  } catch (err) {
    return res.status(500).json({ error: 'Error al registrar solicitud de retiro' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`StarVibe Shielded Server running on port ${PORT}`);
});
