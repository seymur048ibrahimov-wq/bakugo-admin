/* BakuGo — push bildiriş serveri (Firebase Cloud Functions, 2-ci nəsil)
   1) sendPushQueue   : Admin paneldə "Real mobil push də göndər" seçilən kampaniyalar (pushQueue kolleksiyası)
   2) notifyNewOrder  : Sifariş "searching_courier" statusuna keçəndə ONLINE kuryerlərə push
   5) notifyAdmins* : adminlərə yeni sifariş, qəza, pul çıxarma push-u
   Tokenlər: couriers/{uid}.fcmToken, users/{uid}.fcmToken, restaurants/{id}.fcmToken */

const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();
setGlobalOptions({ maxInstances: 5 });

const COLLECTION = { courier: "couriers", customer: "users", restaurant: "restaurants" };
const APP_LINK = {
  courier: "https://seymur048ibrahimov-wq.github.io/bakugo-kuryer/",
  customer: "https://seymur048ibrahimov-wq.github.io/bakugo-user/",
  restaurant: "https://seymur048ibrahimov-wq.github.io/bakugo-resturant/",
  admin: "https://seymur048ibrahimov-wq.github.io/bakugo-admin/"
};
const APP_ICON = {
  courier: "https://seymur048ibrahimov-wq.github.io/bakugo-kuryer/icon-192.png",
  customer: "https://seymur048ibrahimov-wq.github.io/bakugo-user/icon-192.png",
  restaurant: "https://seymur048ibrahimov-wq.github.io/bakugo-resturant/icon-192.png",
  admin: "https://seymur048ibrahimov-wq.github.io/bakugo-admin/icon-192.png"
};

/* Bir kolleksiyadakı (istəyə görə filtrli) bütün tokenləri yığır: [{token, ref}] */
async function collectTokens(coll, filterFn) {
  const snap = await db.collection(coll).get();
  const out = [];
  snap.forEach((d) => {
    const v = d.data();
    if (v && typeof v.fcmToken === "string" && v.fcmToken.length > 20 && (!filterFn || filterFn(v))) {
      out.push({ token: v.fcmToken, ref: d.ref });
    }
  });
  return out;
}

/* 500-lük partiyalarla göndərir, etibarsız tokenləri bazadan silir. */
async function sendToTokens(list, { title, body, link, tag, icon }) {
  let success = 0, failure = 0;
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const res = await getMessaging().sendEachForMulticast({
      tokens: chunk.map((x) => x.token),
      notification: { title, body },
      webpush: {
        notification: {
          icon: icon || APP_ICON.courier,
          badge: icon || APP_ICON.courier,
          tag: tag || "bakugo",
          renotify: true,
          requireInteraction: true,
          vibrate: [400, 150, 400]
        },
        headers: { Urgency: "high", TTL: "3600" },
        ...(link ? { fcmOptions: { link } } : {})
      }
    });
    success += res.successCount;
    failure += res.failureCount;
    const cleanups = [];
    res.responses.forEach((r, idx) => {
      const code = r.error && r.error.code;
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
        cleanups.push(chunk[idx].ref.update({ fcmToken: FieldValue.delete() }).catch(() => null));
      }
    });
    await Promise.all(cleanups);
  }
  return { success, failure };
}

/* 1) Admin kampaniyası → push */
exports.sendPushQueue = onDocumentCreated("pushQueue/{id}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const job = snap.data();
  const audience = job.audience;
  const coll = COLLECTION[audience];
  if (!coll) {
    await snap.ref.update({ status: "failed", error: "naməlum audience: " + audience });
    return;
  }
  try {
    const tokens = await collectTokens(coll);
    const r = tokens.length
      ? await sendToTokens(tokens, { title: job.title || "BakuGo", body: job.body || "", link: APP_LINK[audience], icon: APP_ICON[audience], tag: "camp-" + (job.campaignId || event.params.id) })
      : { success: 0, failure: 0 };
    const status = r.success === 0 ? "failed" : (r.failure > 0 ? "partial" : "sent");
    await snap.ref.update({ status, successCount: r.success, failureCount: r.failure, tokenCount: tokens.length, processedAt: FieldValue.serverTimestamp() });
    if (job.campaignId) {
      await db.collection("campaigns").doc(job.campaignId).set({ pushStatus: status }, { merge: true });
    }
    logger.info("pushQueue", event.params.id, audience, r);
  } catch (e) {
    logger.error("pushQueue xətası", e);
    await snap.ref.update({ status: "failed", error: String(e && e.message || e) });
    if (job.campaignId) await db.collection("campaigns").doc(job.campaignId).set({ pushStatus: "failed" }, { merge: true });
  }
});

/* 2) Yeni sifariş (və ya təkrar axtarış) → ONLINE kuryerlərə push */
exports.notifyNewOrder = onDocumentWritten("orders/{id}", async (event) => {
  const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
  const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
  if (!after || after.status !== "searching_courier" || after.courierId) return;
  const isNewSearch = !before || before.status !== "searching_courier" || before.searchStartedAt !== after.searchStartedAt;
  if (!isNewSearch) return;

  const tokens = await collectTokens("couriers", (c) => c.status === "online" && c.isAvailable !== false && c.isBlocked !== true);
  if (!tokens.length) { logger.info("ONLINE kuryer tokeni yoxdur", event.params.id); return; }

  const where = after.restaurantName ? ("📍 " + after.restaurantName) : "Yaxınlıqda yeni çatdırılma var";
  const r = await sendToTokens(tokens, {
    title: "🔔 Yeni sifariş!",
    body: where + " — qəbul etmək üçün toxunun",
    link: APP_LINK.courier,
    tag: "order-" + event.params.id
  });
  logger.info("yeni sifariş push", event.params.id, r);
});

/* 3) Yeni sifariş → həmin RESTORANIN telefonuna push (tətbiq bağlı olsa belə) */
exports.notifyRestaurantNewOrder = onDocumentCreated("orders/{id}", async (event) => {
  const o = event.data && event.data.data();
  if (!o || !o.restaurantId || o.status !== "preparing" || o.restaurantAccepted === true) return;
  const r = await db.collection("restaurants").doc(String(o.restaurantId)).get();
  const token = r.exists && r.data().fcmToken;
  if (!token) { logger.info("Restoranın tokeni yoxdur", o.restaurantId); return; }
  const items = Array.isArray(o.items) ? o.items : [];
  const count = items.reduce((s, i) => s + (parseFloat(i.qty || i.quantity || 1) || 1), 0);
  const total = items.reduce((s, i) => s + (parseFloat(i.price) || 0) * (parseFloat(i.qty || i.quantity || 1) || 1), 0);
  const res = await sendToTokens([{ token, ref: r.ref }], {
    title: "🛎️ Yeni sifariş!",
    body: (count ? count + " məhsul · " : "") + total.toFixed(2) + " AZN — qəbul etmək üçün toxunun",
    link: APP_LINK.restaurant, icon: APP_ICON.restaurant, tag: "order-" + event.params.id
  });
  logger.info("restorana sifariş push", event.params.id, res);
});

/* 4) Admin bir restorana mesaj göndərəndə → həmin restoranın telefonuna push */
exports.notifyRestaurantMessage = onDocumentCreated("notifications/{id}", async (event) => {
  const n = event.data && event.data.data();
  if (!n || !n.restaurantId || n.audience !== "restaurant") return;
  const r = await db.collection("restaurants").doc(String(n.restaurantId)).get();
  const token = r.exists && r.data().fcmToken;
  if (!token) return;
  await sendToTokens([{ token, ref: r.ref }], { title: n.title || "BakuGo", body: n.body || "", link: APP_LINK.restaurant, icon: APP_ICON.restaurant, tag: "msg-" + event.params.id });
});

/* 5) ADMİNLƏRƏ push: yeni sifariş, qəza / kuryer tapılmadı, pul çıxarma sorğusu
   Tokenlər: admins/{uid}.fcmToken. Hər admin öz panelində (Parametrlər → Tətbiq və bildirişlər) hansı növü istədiyini seçir. */
async function notifyAdmins(flag, msg) {
  const tokens = await collectTokens("admins", (a) => a.active !== false && a[flag] !== false);
  if (!tokens.length) return;
  const r = await sendToTokens(tokens, { ...msg, link: APP_LINK.admin, icon: APP_ICON.admin });
  logger.info("admin push", flag, r);
}
exports.notifyAdminsOrders = onDocumentWritten("orders/{id}", async (event) => {
  const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
  const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
  if (!after) return;
  const id = event.params.id, short = "#" + id.slice(0, 5).toUpperCase();
  if (!before) {
    const total = parseFloat(after.totalAmount || after.price || 0) || 0;
    await notifyAdmins("pushOrders", { title: "🆕 Yeni sifariş " + short, body: (after.restaurantName || "Restoran") + " · " + total.toFixed(2) + " AZN" + (after.customerName ? " · " + after.customerName : ""), tag: "adm-order-" + id });
    return;
  }
  if (after.status === before.status) return;
  if (after.status === "courier_accident") {
    await notifyAdmins("pushAlerts", { title: "🚨 Kuryer qəza edib " + short, body: (after.restaurantName || "") + " — yeni kuryer təyin edin", tag: "adm-acc-" + id });
  } else if (after.status === "courier_not_found") {
    await notifyAdmins("pushAlerts", { title: "⚠️ Kuryer tapılmadı " + short, body: (after.restaurantName || "") + " — sifarişə baxın", tag: "adm-ncf-" + id });
  }
});
exports.notifyAdminsWithdrawal = onDocumentCreated("withdrawals/{id}", async (event) => {
  const w = event.data && event.data.data();
  if (!w || (w.status && w.status !== "pending")) return;
  const isC = w.type === "courier" || !!w.courierId;
  const amt = (parseFloat(w.amount) || 0).toFixed(2);
  await notifyAdmins("pushWithdrawals", { title: "💸 " + (isC ? "Kuryer" : "Restoran") + " pul çıxarma sorğusu", body: (w.courierName || w.restaurantName || w.name || "") + " · " + amt + " AZN", tag: "adm-wd-" + event.params.id });
});
