const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';

const COIN_PACKS = {
  50: { coins: 50, title: 'StarVibe — 50 Monedas', unit_price: 5.0 },
  150: { coins: 150, title: 'StarVibe — 150 Monedas', unit_price: 15.0 },
  500: { coins: 500, title: 'StarVibe — 500 Monedas', unit_price: 50.0 },
  1000: { coins: 1000, title: 'StarVibe — 1000 Monedas', unit_price: 100.0 }
};

const paymentsStore = new Map();

app.post('/api/mercadopago/create-order', async (req, res) => {
  try {
    const packId = Number(req.body.packCoins);
    const userId = String(req.body.userId || 'guest');
    const pack = COIN_PACKS[packId];

    if (!pack) {
      return res.status(400).json({ error: 'Paquete de monedas no válido' });
    }

    if (!MP_ACCESS_TOKEN) {
      return res.status(500).json({ error: 'Falta configurar MP_ACCESS_TOKEN en Render' });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
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

    paymentsStore.set(externalRef, {
      userId,
      coins: pack.coins,
      amountBRL: pack.unit_price,
      status: 'pending',
      approved: false
    });

    return res.json({
      ref: externalRef,
      checkoutUrl: data.init_point,
      sandboxUrl: data.sandbox_init_point
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Error interno del servidor' });
  }
});

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
        if (ref && paymentsStore.has(ref)) {
          const entry = paymentsStore.get(ref);
          entry.status = payment.status;
          entry.approved = payment.status === 'approved';
          paymentsStore.set(ref, entry);
        }
      }
    }
    return res.status(200).send('OK');
  } catch (err) {
    return res.status(200).send('OK');
  }
});

app.get('/api/mercadopago/status', (req, res) => {
  const ref = String(req.query.ref || '');
  const entry = paymentsStore.get(ref);
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`StarVibe server running on port ${PORT}`);
});
