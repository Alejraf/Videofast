require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Servir archivos estáticos desde /public o desde la raíz
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}
app.use(express.static(__dirname));

// 1. Inicializar Firebase Admin (Firestore)
let db = null;
const hasFirebaseEnv =
  Boolean(process.env.FIREBASE_PROJECT_ID) &&
  Boolean(process.env.FIREBASE_CLIENT_EMAIL) &&
  Boolean(process.env.FIREBASE_PRIVATE_KEY);

if (hasFirebaseEnv) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      })
    });
    db = admin.firestore();
    console.log('✅ Firebase Firestore conectado correctamente.');
  } catch (err) {
    console.error('❌ Error inicializando Firebase Admin:', err.message);
  }
} else {
  console.warn('⚠️ Variables de Firebase no configuradas.');
}

const memoryBalances = new Map();
const processedPayments = new Set();

// 2. Configurar Mercado Pago
const mpAccessToken = process.env.MP_ACCESS_TOKEN || '';
const publicAppUrl = (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
const mpClient = mpAccessToken ? new MercadoPagoConfig({ accessToken: mpAccessToken }) : null;

const COIN_PACKAGES = {
  pack_50: { id: 'pack_50', title: '50 Monedas StarVibe', coins: 50, price: 5.0 },
  pack_250: { id: 'pack_250', title: '250 Monedas StarVibe', coins: 250, price: 25.0 },
  pack_1000: { id: 'pack_1000', title: '1.000 Monedas StarVibe', coins: 1000, price: 100.0 },
  pack_2500: { id: 'pack_2500', title: '2.500 Monedas StarVibe VIP', coins: 2500, price: 250.0 },
  pack_5000: { id: 'pack_5000', title: '5.000 Monedas StarVibe Legend', coins: 5000, price: 500.0 },
  pack_10000: { id: 'pack_10000', title: '10.000 Monedas StarVibe Supremo', coins: 10000, price: 1000.0 }
};

const OWNER_USER_ID = 'user_123alejrafnstaller_gmail_com';

async function getUserBalance(userId) {
  const safeUserId = String(userId || OWNER_USER_ID).trim();
  const defaultInitial = safeUserId === OWNER_USER_ID ? 200 : 100;
  if (db) {
    const userRef = db.collection('starvibe_users').doc(safeUserId);
    const snap = await userRef.get();
    if (!snap.exists) {
      let initialCoins = defaultInitial;
      if (safeUserId !== 'guest') {
        const guestSnap = await db.collection('starvibe_users').doc('guest').get();
        if (guestSnap.exists && Number(guestSnap.data()?.coins || 0) > initialCoins) {
          initialCoins = Number(guestSnap.data().coins);
        }
      }
      await userRef.set({
        email: safeUserId === OWNER_USER_ID ? '123alejrafnstaller@gmail.com' : '',
        coins: initialCoins,
        creatorEarnings: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { coins: initialCoins, creatorEarnings: 0 };
    }
    const data = snap.data() || {};
    let currentCoins = Number(data.coins ?? defaultInitial);
    if (safeUserId === OWNER_USER_ID && currentCoins < 200 && !data.ownerRecovered) {
      currentCoins = 200;
      await userRef.set({ coins: 200, ownerRecovered: true, email: '123alejrafnstaller@gmail.com' }, { merge: true });
    }
    return {
      coins: currentCoins,
      creatorEarnings: Number(data.creatorEarnings ?? 0)
    };
  }
  if (!memoryBalances.has(safeUserId)) {
    memoryBalances.set(safeUserId, { coins: defaultInitial, creatorEarnings: 0 });
  }
  return memoryBalances.get(safeUserId);
}

async function creditCoinsOnce({ paymentId, userId, coins, amountBRL }) {
  const safePaymentId = String(paymentId);
  const safeUserId = String(userId || 'guest').trim();
  const coinsToAdd = Number(coins || 0);

  if (!safePaymentId || coinsToAdd <= 0) return { credited: false, reason: 'invalid_data' };

  if (db) {
    const paymentRef = db.collection('starvibe_payments').doc(safePaymentId);
    const userRef = db.collection('starvibe_users').doc(safeUserId);

    return await db.runTransaction(async (tx) => {
      const paymentDoc = await tx.get(paymentRef);
      if (paymentDoc.exists && paymentDoc.data()?.credited) {
        return { credited: false, reason: 'already_processed' };
      }

      const userDoc = await tx.get(userRef);
      const currentCoins = userDoc.exists ? Number(userDoc.data()?.coins ?? 100) : 100;
      const newBalance = currentCoins + coinsToAdd;

      tx.set(
        userRef,
        {
          coins: newBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      tx.set(paymentRef, {
        paymentId: safePaymentId,
        userId: safeUserId,
        coins: coinsToAdd,
        amountBRL: Number(amountBRL || 0),
        credited: true,
        processedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return { credited: true, newBalance };
    });
  }

  if (processedPayments.has(safePaymentId)) {
    return { credited: false, reason: 'already_processed' };
  }
  processedPayments.add(safePaymentId);
  const current = await getUserBalance(safeUserId);
  current.coins += coinsToAdd;
  memoryBalances.set(safeUserId, current);
  return { credited: true, newBalance: current.coins };
}

// 3. Diagnóstico
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    mpConfigured: Boolean(mpClient),
    firebaseConfigured: Boolean(db),
    publicAppUrl: publicAppUrl || null
  });
});

// 4. Consultar saldo
app.get('/api/wallet/:userId', async (req, res) => {
  try {
    const balance = await getUserBalance(req.params.userId);
    res.json({ ok: true, userId: req.params.userId, ...balance });
  } catch (error) {
    res.status(500).json({ ok: false, error: 'Error consultando saldo' });
  }
});

// 4b. Regalos virtuales
app.post('/api/wallet/gift', async (req, res) => {
  try {
    const { senderUserId = 'guest', creatorUserId = 'guest', coinCost = 0, creatorShare = 0 } = req.body || {};
    const cost = Number(coinCost || 0);
    const share = Number(creatorShare || 0);
    if (!db || cost <= 0) return res.json({ ok: true });

    const senderRef = db.collection('starvibe_users').doc(String(senderUserId));
    const creatorRef = db.collection('starvibe_users').doc(String(creatorUserId));

    await db.runTransaction(async (tx) => {
      const sDoc = await tx.get(senderRef);
      const cur = sDoc.exists ? Number(sDoc.data()?.coins ?? 100) : 100;
      tx.set(senderRef, { coins: Math.max(0, cur - cost), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

      if (share > 0) {
        const cDoc = await tx.get(creatorRef);
        const curEarn = cDoc.exists ? Number(cDoc.data()?.creatorEarnings ?? 0) : 0;
        tx.set(creatorRef, { creatorEarnings: +(curEarn + share).toFixed(2), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      }
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 4c. Retiros PIX (mínimo R$ 50,00)
app.post('/api/payouts/request', async (req, res) => {
  try {
    const { amountBRL, pixKey, fullName, uid = 'guest' } = req.body || {};
    const amount = Number(amountBRL || 0);
    if (amount < 50 || !pixKey) {
      return res.status(400).json({ ok: false, error: 'Monto mínimo R$ 50,00 y clave PIX requerida.' });
    }
    if (db) {
      await db.collection('starvibe_payouts').add({
        uid: String(uid),
        fullName: String(fullName || ''),
        pixKey: String(pixKey),
        amountBRL: amount,
        status: 'pending',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      const userRef = db.collection('starvibe_users').doc(String(uid));
      const snap = await userRef.get();
      if (snap.exists) {
        const curEarn = Number(snap.data()?.creatorEarnings || 0);
        await userRef.set({ creatorEarnings: Math.max(0, +(curEarn - amount).toFixed(2)) }, { merge: true });
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 4d. Monetización de Videos (+45s, R$ 0,50 por cada 1.000 vistas válidas)
app.post('/api/videos/track-view', async (req, res) => {
  try {
    const { videoId, creatorUserId, durationSec = 0, viewerId = '' } = req.body || {};
    if (!db || !videoId || !creatorUserId || Number(durationSec) < 45) {
      return res.json({ ok: true, counted: false });
    }
    if (String(creatorUserId) === String(viewerId)) {
      return res.json({ ok: true, counted: false, reason: 'self_view' });
    }
    const videoRef = db.collection('videos').doc(String(videoId));
    const creatorRef = db.collection('starvibe_users').doc(String(creatorUserId));

    const result = await db.runTransaction(async (tx) => {
      const vSnap = await tx.get(videoRef);
      if (!vSnap.exists) return { counted: false };
      const vData = vSnap.data() || {};
      const validViews = Number(vData.validMonetizedViews || 0) + 1;
      const paidMilestones = Number(vData.paidMilestones || 0);
      const currentMilestones = Math.floor(validViews / 1000);
      const newMilestones = Math.max(0, currentMilestones - paidMilestones);

      tx.set(videoRef, {
        validMonetizedViews: validViews,
        paidMilestones: currentMilestones
      }, { merge: true });

      if (newMilestones > 0) {
        const earnAdd = +(newMilestones * 0.50).toFixed(2); // R$ 0,50 por cada 1.000 vistas
        const cSnap = await tx.get(creatorRef);
        const curEarn = cSnap.exists ? Number(cSnap.data()?.creatorEarnings ?? 0) : 0;
        tx.set(creatorRef, {
          creatorEarnings: +(curEarn + earnAdd).toFixed(2),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return { counted: true, validViews, earnAdd };
      }
      return { counted: true, validViews, earnAdd: 0 };
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 4e. Configuración dinámica de Monetag Direct Link / Zone URL
let cachedMonetagUrl = process.env.MONETAG_DIRECT_LINK || 'https://uplcm.com/4/12342382';
app.get('/api/config/monetag', async (req, res) => {
  try {
    if (db) {
      const snap = await db.collection('starvibe_config').doc('ads').get();
      if (snap.exists && snap.data()?.monetagUrl) {
        cachedMonetagUrl = snap.data().monetagUrl;
      }
    }
    res.json({ ok: true, monetagUrl: cachedMonetagUrl });
  } catch (e) {
    res.json({ ok: true, monetagUrl: cachedMonetagUrl });
  }
});

app.post('/api/config/monetag', async (req, res) => {
  try {
    const { monetagUrl, userId } = req.body || {};
    if (userId !== OWNER_USER_ID) {
      return res.status(403).json({ ok: false, error: 'Solo el administrador puede cambiar Monetag.' });
    }
    if (!monetagUrl || !/^https:\/\//i.test(monetagUrl)) {
      return res.status(400).json({ ok: false, error: 'URL inválida' });
    }
    cachedMonetagUrl = String(monetagUrl).trim();
    if (db) {
      await db.collection('starvibe_config').doc('ads').set({
        monetagUrl: cachedMonetagUrl,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
    res.json({ ok: true, monetagUrl: cachedMonetagUrl });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 4f. Sistema de Referidos con Metas y Anti-Fraude (R$ 0,25 por amigo validado + bonos por meta)
const REFERRAL_MILESTONES = {
  5: 1.50,
  15: 5.00,
  50: 20.00,
  100: 50.00
};

app.post('/api/referrals/bind-code', async (req, res) => {
  try {
    const { userId, referralCode } = req.body || {};
    if (!db || !userId || !referralCode) return res.json({ ok: true });
    const cleanCode = String(referralCode).trim().toUpperCase();
    await db.collection('starvibe_ref_codes').doc(cleanCode).set({
      userId: String(userId).trim(),
      referralCode: cleanCode,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    await db.collection('starvibe_users').doc(String(userId).trim()).set({
      referralCode: cleanCode
    }, { merge: true });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false });
  }
});

app.get('/api/referrals/status/:userId', async (req, res) => {
  try {
    const uid = String(req.params.userId || '').trim();
    if (!db || !uid) return res.json({ ok: true, validReferrals: 0, referralEarnings: 0 });
    const snap = await db.collection('starvibe_users').doc(uid).get();
    const data = snap.exists ? snap.data() : {};
    res.json({
      ok: true,
      validReferrals: Number(data.validReferrals || 0),
      referralEarnings: Number(data.referralEarnings || 0)
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/referrals/register', async (req, res) => {
  try {
    const { referralCode, invitedUserId, deviceFp } = req.body || {};
    if (!db) return res.status(500).json({ ok: false, error: 'Base de datos no disponible' });
    const cleanCode = String(referralCode || '').trim().toUpperCase();
    const invitedId = String(invitedUserId || '').trim();
    const fp = String(deviceFp || '').trim();
    if (!cleanCode || !invitedId) return res.status(400).json({ ok: false, error: 'Datos incompletos' });

    const codeSnap = await db.collection('starvibe_ref_codes').doc(cleanCode).get();
    if (!codeSnap.exists) {
      return res.status(404).json({ ok: false, error: 'Código de invitación no encontrado' });
    }
    const inviterId = codeSnap.data().userId;
    if (inviterId === invitedId) {
      return res.status(400).json({ ok: false, error: 'No puedes usar tu propio código' });
    }

    const inviteRef = db.collection('starvibe_referrals').doc(invitedId);
    const existing = await inviteRef.get();
    if (existing.exists) {
      return res.status(400).json({ ok: false, error: 'Este usuario ya registró un código de referido' });
    }
    if (fp) {
      const fpSnap = await db.collection('starvibe_referrals').where('deviceFp', '==', fp).limit(1).get();
      if (!fpSnap.empty) {
        return res.status(400).json({ ok: false, error: 'Este dispositivo ya participó en el programa de referidos' });
      }
    }

    await inviteRef.set({
      invitedUserId: invitedId,
      inviterUserId: inviterId,
      referralCode: cleanCode,
      deviceFp: fp,
      validated: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ ok: true, pendingValidation: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/referrals/validate', async (req, res) => {
  try {
    const { invitedUserId } = req.body || {};
    if (!db || !invitedUserId) return res.json({ ok: true, validated: false });
    const invitedId = String(invitedUserId).trim();
    const inviteRef = db.collection('starvibe_referrals').doc(invitedId);

    const out = await db.runTransaction(async (tx) => {
      const invSnap = await tx.get(inviteRef);
      if (!invSnap.exists) return { validated: false };
      const invData = invSnap.data();
      if (invData.validated) return { validated: true, already: true };

      const inviterRef = db.collection('starvibe_users').doc(invData.inviterUserId);
      const inviterSnap = await tx.get(inviterRef);
      const uData = inviterSnap.exists ? inviterSnap.data() : {};

      const newCount = Number(uData.validReferrals || 0) + 1;
      const baseReward = 0.25;
      const milestoneBonus = REFERRAL_MILESTONES[newCount] || 0;
      const totalAdded = +(baseReward + milestoneBonus).toFixed(2);

      const newRefEarnings = +(Number(uData.referralEarnings || 0) + totalAdded).toFixed(2);
      const newCreatorEarnings = +(Number(uData.creatorEarnings || 0) + totalAdded).toFixed(2);

      tx.set(inviteRef, {
        validated: true,
        rewardGranted: totalAdded,
        validatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      tx.set(inviterRef, {
        validReferrals: newCount,
        referralEarnings: newRefEarnings,
        creatorEarnings: newCreatorEarnings,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      return { validated: true, newCount, totalAdded, milestoneBonus };
    });

    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 4g. Panel Exclusivo de Administrador (Denuncias, Moderación y Retiros PIX)
app.get('/api/admin/overview', async (req, res) => {
  try {
    const userId = String(req.query.userId || '').trim();
    if (userId !== OWNER_USER_ID) {
      return res.status(403).json({ ok: false, error: 'Acceso denegado' });
    }
    if (!db) return res.json({ ok: true, reportedItems: [], payouts: [] });

    const reportedItems = [];
    const vidSnap = await db.collection('videos').where('reports', '>', 0).limit(30).get();
    vidSnap.forEach((docSnap) => {
      const v = docSnap.data() || {};
      reportedItems.push({
        id: docSnap.id,
        type: 'video',
        user: v.user || 'Usuario',
        title: v.caption || 'Video sin descripción',
        reports: Number(v.reports || 1),
        lastReportReason: v.lastReportReason || 'Reporte'
      });
    });

    const liveSnap = await db.collection('lives').where('reports', '>', 0).limit(30).get();
    liveSnap.forEach((docSnap) => {
      const l = docSnap.data() || {};
      reportedItems.push({
        id: docSnap.id,
        type: 'live',
        user: l.user || 'Creador',
        title: l.title || 'Sala En Vivo',
        reports: Number(l.reports || 1),
        lastReportReason: l.lastReportReason || 'Reporte en vivo'
      });
    });

    const payouts = [];
    const paySnap = await db.collection('starvibe_payouts').orderBy('createdAt', 'desc').limit(30).get();
    paySnap.forEach((docSnap) => {
      payouts.push({ id: docSnap.id, ...(docSnap.data() || {}) });
    });

    res.json({ ok: true, reportedItems, payouts });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/moderate', async (req, res) => {
  try {
    const { userId, action, type, id } = req.body || {};
    if (userId !== OWNER_USER_ID) {
      return res.status(403).json({ ok: false, error: 'Acceso denegado' });
    }
    if (!db || !id) return res.status(400).json({ ok: false, error: 'ID requerido' });
    const colName = type === 'live' ? 'lives' : 'videos';
    const ref = db.collection(colName).doc(String(id));
    if (action === 'delete') {
      await ref.delete();
    } else if (action === 'dismiss') {
      await ref.set({ reports: 0, lastReportReason: '' }, { merge: true });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/payout-paid', async (req, res) => {
  try {
    const { userId, payoutId } = req.body || {};
    if (userId !== OWNER_USER_ID) {
      return res.status(403).json({ ok: false, error: 'Acceso denegado' });
    }
    if (!db || !payoutId) return res.status(400).json({ ok: false, error: 'ID requerido' });
    await db.collection('starvibe_payouts').doc(String(payoutId)).set({
      status: 'paid',
      paidAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 5. Crear preferencia de pago en Mercado Pago
app.post('/api/mercadopago/create-preference', async (req, res) => {
  try {
    if (!mpClient) {
      return res.status(500).json({ ok: false, error: 'MP_ACCESS_TOKEN no configurado en el servidor.' });
    }

    const { packageId, userId = 'guest', orderId = '', coins: customCoins, price: customPrice, title: customTitle } = req.body || {};
    const selected = COIN_PACKAGES[packageId] || {
      id: packageId || 'custom',
      title: customTitle || `${customCoins || 50} Monedas StarVibe`,
      coins: Number(customCoins || 50),
      price: Number(customPrice || 5.0)
    };

    const baseUrl = publicAppUrl || `${req.protocol}://${req.get('host')}`;
    const preference = new Preference(mpClient);

    const response = await preference.create({
      body: {
        items: [
          {
            id: selected.id,
            title: selected.title,
            quantity: 1,
            currency_id: 'BRL',
            unit_price: Number(selected.price)
          }
        ],
        external_reference: JSON.stringify({
          userId: String(userId),
          orderId: String(orderId),
          coins: Number(selected.coins),
          packageId: selected.id
        }),
        notification_url: `${baseUrl}/api/mercadopago/webhook`,
        back_urls: {
          success: `${baseUrl}/?payment=success&coins=${selected.coins}`,
          failure: `${baseUrl}/?payment=failure`,
          pending: `${baseUrl}/?payment=pending`
        },
        auto_return: 'approved'
      }
    });

    res.json({
      ok: true,
      id: response.id,
      init_point: response.init_point,
      sandbox_init_point: response.sandbox_init_point
    });
  } catch (error) {
    console.error('Error creando preferencia de Mercado Pago:', error);
    res.status(500).json({
      ok: false,
      error: error?.message || 'No se pudo iniciar el pago en Mercado Pago'
    });
  }
});

// 5b. Auto-detector de PIX: consulta directamente en Mercado Pago los pagos recientes aprobados para esa orden/usuario
app.post('/api/mercadopago/check-latest', async (req, res) => {
  try {
    if (!mpClient) return res.json({ ok: false, approved: false });
    const { userId = 'guest', orderId = '', coins = 50 } = req.body || {};
    const paymentApi = new Payment(mpClient);
    const searchRes = await paymentApi.search({
      options: {
        sort: 'date_created',
        criteria: 'desc',
        limit: 10
      }
    });
    const results = searchRes?.results || [];
    for (const p of results) {
      if (p.status !== 'approved') continue;
      let meta = {};
      try {
        if (p.external_reference) meta = JSON.parse(p.external_reference);
      } catch (_) {}

      const matchesOrder = orderId && meta.orderId === orderId;
      const matchesUserRecent = meta.userId === String(userId) && (Date.now() - new Date(p.date_created).getTime() < 15 * 60 * 1000);

      if (matchesOrder || matchesUserRecent) {
        const coinsToCredit = Number(meta.coins || coins || 50);
        const result = await creditCoinsOnce({
          paymentId: p.id,
          userId: String(userId),
          coins: coinsToCredit,
          amountBRL: p.transaction_amount
        });
        const updated = await getUserBalance(String(userId));
        return res.json({ ok: true, approved: true, paymentId: p.id, result, balance: updated });
      }
    }
    return res.json({ ok: true, approved: false });
  } catch (err) {
    return res.json({ ok: false, approved: false, error: err.message });
  }
});

// 6. Webhook de Mercado Pago
app.post('/api/mercadopago/webhook', async (req, res) => {
  res.status(200).json({ received: true });

  try {
    const topic = req.body?.type || req.query?.topic || req.query?.type;
    const paymentId = req.body?.data?.id || req.query?.['data.id'] || req.query?.id;

    if (topic !== 'payment' || !paymentId || !mpClient) {
      return;
    }

    const paymentApi = new Payment(mpClient);
    const paymentInfo = await paymentApi.get({ id: String(paymentId) });

    if (paymentInfo.status === 'approved') {
      let meta = { userId: 'guest', coins: 50 };
      try {
        if (paymentInfo.external_reference) {
          meta = JSON.parse(paymentInfo.external_reference);
        }
      } catch (_) {
        meta.userId = String(paymentInfo.external_reference || 'guest');
      }

      const result = await creditCoinsOnce({
        paymentId: paymentInfo.id,
        userId: meta.userId,
        coins: meta.coins,
        amountBRL: paymentInfo.transaction_amount
      });

      console.log(`💰 Pago ${paymentInfo.id} aprobado -> usuario: ${meta.userId}, monedas: +${meta.coins}`, result);
    }
  } catch (error) {
    console.error('❌ Error procesando webhook de Mercado Pago:', error);
  }
});

// 7. Endpoint manual (POST y GET) para acreditar un pago aprobado por ID desde cualquier navegador
async function handleVerifyPayment(req, res) {
  try {
    const src = req.method === 'GET' ? req.query : (req.body || {});
    const { paymentId, userId = 'guest', coins = 50 } = src;
    if (!paymentId || !mpClient) {
      return res.status(400).json({ ok: false, error: 'Falta paymentId o configuración de Mercado Pago' });
    }

    const paymentApi = new Payment(mpClient);
    const paymentInfo = await paymentApi.get({ id: String(paymentId) });

    if (paymentInfo.status !== 'approved') {
      return res.json({ ok: false, status: paymentInfo.status, message: 'El pago aún no está aprobado' });
    }

    let meta = { userId: String(userId), coins: Number(coins) };
    try {
      if (paymentInfo.external_reference) {
        const parsed = JSON.parse(paymentInfo.external_reference);
        meta = {
          userId: parsed.userId || meta.userId,
          coins: Number(parsed.coins || meta.coins)
        };
      }
    } catch (_) {}

    const result = await creditCoinsOnce({
      paymentId: paymentInfo.id,
      userId: meta.userId,
      coins: meta.coins,
      amountBRL: paymentInfo.transaction_amount
    });

    const updated = await getUserBalance(meta.userId);
    res.json({ ok: true, result, balance: updated });
  } catch (error) {
    console.error('Error verificando pago manual:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
}

app.post('/api/mercadopago/verify-payment', handleVerifyPayment);
app.get('/api/mercadopago/verify-payment', handleVerifyPayment);

// Fallback universal
app.get('*', (req, res) => {
  const pubIndex = path.join(__dirname, 'public', 'index.html');
  const rootIndex = path.join(__dirname, 'index.html');
  if (fs.existsSync(pubIndex)) {
    return res.sendFile(pubIndex);
  }
  return res.sendFile(rootIndex);
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor StarVibe activo en puerto ${PORT}`);
});
