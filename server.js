/**
 * ClinicBot – Twilio WhatsApp Real Integration
 * =============================================
 * Stack: Node.js + Express + Twilio
 *
 * SETUP:
 *   npm install
 *   cp .env.example .env   → fill your Twilio credentials
 *   node server.js
 *
 * COMMON FIX: If patients don't get replies, they must first JOIN the sandbox:
 *   Tell them to WhatsApp this to +14155238886:  join <your-sandbox-word>
 *   (Find your sandbox word in Twilio Console → Messaging → Try it out → WhatsApp)
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const twilio     = require('twilio');
const fs         = require('fs');
const path       = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ─── Twilio Client ────────────────────────────────────────────────────────────
const twilioClient      = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const MessagingResponse = twilio.twiml.MessagingResponse;
const VoiceResponse     = twilio.twiml.VoiceResponse;

// ─── Simple JSON DB ───────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'db.json');
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ clinics: [], appointments: [], conversations: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ─── Find clinic by Twilio number ─────────────────────────────────────────────
function getClinic(toNumber) {
  const db    = loadDB();
  const clean = (toNumber || '').replace('whatsapp:', '').replace(/\s+/g, '').trim();
  console.log(`[LOOKUP] Searching for Twilio number: "${clean}"`);
  const found = db.clinics.find(c =>
    (c.twilioNumber || '').replace(/\s+/g, '').trim() === clean
  );
  if (found) { console.log(`[LOOKUP] Matched clinic: ${found.name}`); return found; }
  const fallback = db.clinics[0] || null;
  console.log(`[LOOKUP] No exact match – fallback to: ${fallback ? fallback.name : 'NONE (add a clinic first!)'}`);
  return fallback;
}

// ─── Session state ────────────────────────────────────────────────────────────
const sessions = {};
function getSession(from) {
  if (!sessions[from]) sessions[from] = { step: 'menu', data: {} };
  return sessions[from];
}

// ─── Message templates ────────────────────────────────────────────────────────
function buildWelcome(clinic) {
  const docName = clinic.doctors && clinic.doctors[0] ? clinic.doctors[0].name : clinic.name;
  return (
    `👋 *Namaste! I'm the assistant for ${docName}.*\n\n` +
    `How can I help you today? Please reply with a number:\n\n` +
    `1️⃣  Book an Appointment\n` +
    `2️⃣  Clinic Location & Timings\n` +
    `3️⃣  Consultation Fees\n` +
    `4️⃣  Our Doctors\n` +
    `5️⃣  Emergency Contact\n` +
    `⭐  Rate Us on Google\n\n` +
    `_${clinic.name} · ${clinic.phone}_`
  );
}

function buildLocation(clinic) {
  const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent(clinic.address)}`;
  return (
    `📍 *${clinic.name}*\n\n` +
    `🗺 *Address:*\n${clinic.address}\n\n` +
    `🕐 *Timings:*\n${clinic.timings}\n\n` +
    `📞 *Phone:* ${clinic.phone}\n\n` +
    `👇 *Google Maps:*\n${mapsUrl}`
  );
}

function buildFees(clinic) {
  const fees = clinic.fees || {};
  return (
    `💰 *Fees – ${clinic.name}*\n\n` +
    `👤 New Patient:  *${fees.new || '₹300'}*\n` +
    `🔄 Follow-up:   *${fees.followup || '₹200'}*\n\n` +
    `💳 Cash / UPI / Card accepted\n\n` +
    `Type *1* to book an appointment.`
  );
}

function buildDoctor(clinic) {
  const docs = (clinic.doctors || [])
    .map(d => `👨‍⚕️ *${d.name}*\n   ${d.specialty} · ${d.experience} exp`)
    .join('\n\n');
  return `🩺 *Our Doctors*\n\n${docs || 'Information coming soon.'}\n\nType *1* to book.`;
}

function buildEmergency(clinic) {
  return (
    `🚨 *EMERGENCY*\n\n` +
    `Call immediately:\n📞 *${clinic.emergencyPhone || clinic.phone}*\n\n` +
    `🚑 Ambulance: *108*\n\n` +
    `📍 ${clinic.address}\n\n` +
    `_Staff notified. Someone will call you within 5 minutes._`
  );
}

function buildGoogleReview(clinic) {
  const link = clinic.googleReviewLink || 'https://g.page/r/YOUR_LINK';
  return (
    `⭐ *Thank you for visiting ${clinic.name}!*\n\n` +
    `Your feedback helps us serve patients better 🙏\n\n` +
    `👇 Tap to rate us on Google (takes 30 seconds):\n${link}\n\n` +
    `_Every review makes a big difference. Thank you!_`
  );
}

function buildMissedCall(clinic) {
  const docName = clinic.doctors && clinic.doctors[0] ? clinic.doctors[0].name : clinic.name;
  return (
    `📵 *Missed Call – ${clinic.name}*\n\n` +
    `Hi! You just called *${docName}'s clinic* but we couldn't pick up. So sorry! 🙏\n\n` +
    `We're here on WhatsApp 24×7. How can I help?\n\n` +
    `1️⃣  Book an Appointment\n` +
    `2️⃣  Clinic Location & Timings\n` +
    `3️⃣  Consultation Fees\n` +
    `4️⃣  Our Doctors\n` +
    `5️⃣  Emergency Contact`
  );
}

function buildAppointmentStart(clinic) {
  const list = (clinic.doctors || []).map((d, i) => `${i + 1}️⃣  ${d.name} (${d.specialty})`).join('\n');
  return `📅 *Book Appointment*\n\nChoose your doctor:\n\n${list || '1️⃣  Available Doctor'}\n\nReply with number.`;
}

function buildTimeSlots() {
  return `🕐 *Choose a time slot:*\n\n1️⃣  9:00 AM\n2️⃣  10:30 AM\n3️⃣  12:00 PM\n4️⃣  5:00 PM\n5️⃣  6:30 PM\n6️⃣  8:00 PM\n\nReply with slot number.`;
}

const SLOTS = ['9:00 AM', '10:30 AM', '12:00 PM', '5:00 PM', '6:30 PM', '8:00 PM'];

// ─── Save appointment ─────────────────────────────────────────────────────────
function saveAppointment(clinic, session, from) {
  const db   = loadDB();
  const appt = {
    id:           Date.now().toString(),
    clinicId:     clinic.id,
    clinicName:   clinic.name,
    patientName:  session.data.name,
    patientPhone: from.replace('whatsapp:', ''),
    doctor:       session.data.doctor,
    date:         session.data.date,
    time:         session.data.time,
    status:       'confirmed',
    createdAt:    new Date().toISOString()
  };
  db.appointments.push(appt);
  saveDB(db);
  console.log(`[APPT] Saved: ${appt.patientName} with ${appt.doctor} at ${appt.time} on ${appt.date}`);
  return appt;
}

// ─── Log conversation ─────────────────────────────────────────────────────────
function logConversation(clinicId, from, direction, message) {
  const db = loadDB();
  db.conversations.push({ clinicId, from, direction, message, timestamp: new Date().toISOString() });
  saveDB(db);
}

// ─── GET /webhook/whatsapp — quick health check from browser ──────────────────
app.get('/webhook/whatsapp', (req, res) => {
  res.send(`
    <h2>✅ ClinicBot webhook is running</h2>
    <p>POST this URL in your Twilio WhatsApp sandbox settings.</p>
    <p><strong>Server time:</strong> ${new Date().toLocaleString()}</p>
  `);
});

// ─── POST /webhook/whatsapp — handles all incoming WhatsApp messages ──────────
app.post('/webhook/whatsapp', (req, res) => {
  // Log everything Twilio sends so you can debug easily
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('[INBOUND] New WhatsApp message received');
  console.log('  From :', req.body.From);
  console.log('  To   :', req.body.To);
  console.log('  Body :', req.body.Body);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const from   = req.body.From || '';
  const to     = req.body.To   || '';
  const body   = (req.body.Body || '').trim();
  const clinic = getClinic(to);

  const twiml = new MessagingResponse();

  if (!clinic) {
    console.log('[ERROR] No clinic found in db.json – please onboard one via admin dashboard');
    twiml.message('Service not configured yet. Please contact support.');
    return res.type('text/xml').send(twiml.toString());
  }

  logConversation(clinic.id, from, 'inbound', body);

  const session = getSession(from);
  const input   = body.toLowerCase();
  let reply     = '';

  // ── Appointment booking flow ───────────────────────────────────────────────
  if (session.step === 'await_doctor') {
    const idx = parseInt(body) - 1;
    if (!isNaN(idx) && (clinic.doctors || [])[idx]) {
      session.data.doctor = clinic.doctors[idx].name;
      session.step = 'await_date';
      const dates = [0, 1, 2].map(d => {
        const dt = new Date(); dt.setDate(dt.getDate() + d);
        return dt.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
      });
      reply = `📅 *${session.data.doctor}* selected!\n\nChoose appointment date:\n\n1️⃣  ${dates[0]} (Today)\n2️⃣  ${dates[1]} (Tomorrow)\n3️⃣  ${dates[2]}\n\nReply with number.`;
    } else {
      reply = `Please reply with a number 1–${(clinic.doctors || []).length || 1}.`;
    }
  }
  else if (session.step === 'await_date') {
    const idx = parseInt(body) - 1;
    if (idx >= 0 && idx <= 2) {
      const dt = new Date(); dt.setDate(dt.getDate() + idx);
      session.data.date = dt.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      session.step = 'await_slot';
      reply = buildTimeSlots();
    } else {
      reply = 'Please reply with 1, 2, or 3.';
    }
  }
  else if (session.step === 'await_slot') {
    const idx = parseInt(body) - 1;
    if (SLOTS[idx]) {
      session.data.time = SLOTS[idx];
      session.step      = 'await_name';
      reply = `✅ Slot *${SLOTS[idx]}* on *${session.data.date}* is available!\n\nPlease reply with your *full name*:`;
    } else {
      reply = 'Please reply with a number 1–6.';
    }
  }
  else if (session.step === 'await_name') {
    session.data.name = body;
    const appt = saveAppointment(clinic, session, from);
    sessions[from] = { step: 'menu', data: {} }; // reset session
    reply = (
      `✅ *Appointment Confirmed!* 🎉\n\n` +
      `👤 Patient: *${appt.patientName}*\n` +
      `👨‍⚕️ Doctor: *${appt.doctor}*\n` +
      `📅 Date: *${appt.date}*\n` +
      `🕐 Time: *${appt.time}*\n` +
      `🏥 ${clinic.name}\n\n` +
      `_Please arrive 10 minutes early with any previous reports._\n\n` +
      `📞 To reschedule call: ${clinic.phone}`
    );
  }

  // ── Main menu routing ──────────────────────────────────────────────────────
  else if (input.match(/^(hi|hello|hey|namaste|helo|hii|hlo|start|menu|help)$/) || body === '') {
    reply = buildWelcome(clinic);
  }
  else if (body === '1' || input.includes('book') || input.includes('appoint')) {
    session.step = 'await_doctor';
    reply = buildAppointmentStart(clinic);
  }
  else if (body === '2' || input.includes('location') || input.includes('address') || input.includes('where') || input.includes('timing')) {
    reply = buildLocation(clinic);
  }
  else if (body === '3' || input.includes('fee') || input.includes('charge') || input.includes('cost') || input.includes('price') || input.includes('rupee')) {
    reply = buildFees(clinic);
  }
  else if (body === '4' || input.includes('doctor') || input.includes('dr.') || input.includes('physician')) {
    reply = buildDoctor(clinic);
  }
  else if (body === '5' || input.includes('emergency') || input.includes('urgent') || input.includes('sos')) {
    reply = buildEmergency(clinic);
  }
  else if (input.includes('rate') || input.includes('review') || input.includes('google') || input.includes('star') || input.includes('⭐')) {
    reply = buildGoogleReview(clinic);
  }
  else {
    reply = (
      `I didn't quite understand that 🙏\n\n` +
      `Please reply with a number:\n` +
      `1️⃣ Appointment  2️⃣ Location  3️⃣ Fees  4️⃣ Doctors  5️⃣ Emergency\n\n` +
      `Or call us: *${clinic.phone}*`
    );
  }

  console.log(`[OUTBOUND] Replying: ${reply.substring(0, 80)}...`);
  logConversation(clinic.id, from, 'outbound', reply);
  twiml.message(reply);
  res.type('text/xml').send(twiml.toString());
});

// ─── MISSED CALL Webhook ──────────────────────────────────────────────────────
app.post('/webhook/missed-call', async (req, res) => {
  const callerNumber = req.body.From;
  const toNumber     = req.body.To;
  console.log(`[MISSED CALL] From: ${callerNumber} → To: ${toNumber}`);

  const clinic     = getClinic(`whatsapp:${toNumber}`);
  const voiceResp  = new VoiceResponse();

  if (clinic) {
    try {
      await twilioClient.messages.create({
        from: `whatsapp:${clinic.twilioNumber}`,
        to:   `whatsapp:${callerNumber}`,
        body: buildMissedCall(clinic)
      });
      console.log(`[MISSED CALL] WhatsApp sent to ${callerNumber}`);
    } catch (err) {
      console.error('[MISSED CALL] WhatsApp send failed:', err.message);
    }
  }

  voiceResp.say(
    { voice: 'Polly.Aditi', language: 'hi-IN' },
    `Namasthe! Hum abhi busy hain. Aapko WhatsApp par message bheja gaya hai. Shukriya!`
  );
  res.type('text/xml').send(voiceResp.toString());
});

// ─── API: Send Google Review ──────────────────────────────────────────────────
app.post('/api/send-review', async (req, res) => {
  const { clinicId, patientPhone } = req.body;
  const db     = loadDB();
  const clinic = db.clinics.find(c => c.id === clinicId) || db.clinics[0];
  if (!clinic) return res.status(404).json({ error: 'Clinic not found' });
  try {
    await twilioClient.messages.create({
      from: `whatsapp:${clinic.twilioNumber}`,
      to:   `whatsapp:${patientPhone}`,
      body: buildGoogleReview(clinic)
    });
    console.log(`[REVIEW] Sent to ${patientPhone}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[REVIEW] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Clinics CRUD ────────────────────────────────────────────────────────
app.get('/api/clinics',       (req, res) => res.json(loadDB().clinics));
app.post('/api/clinics',      (req, res) => { const db = loadDB(); const c = { id: Date.now().toString(), ...req.body, createdAt: new Date().toISOString() }; db.clinics.push(c); saveDB(db); res.json(c); });
app.put('/api/clinics/:id',   (req, res) => { const db = loadDB(); const i = db.clinics.findIndex(c => c.id === req.params.id); if (i === -1) return res.status(404).json({ error: 'Not found' }); db.clinics[i] = { ...db.clinics[i], ...req.body }; saveDB(db); res.json(db.clinics[i]); });
app.delete('/api/clinics/:id',(req, res) => { const db = loadDB(); db.clinics = db.clinics.filter(c => c.id !== req.params.id); saveDB(db); res.json({ success: true }); });

// ─── API: Appointments ────────────────────────────────────────────────────────
app.get('/api/appointments', (req, res) => {
  const db    = loadDB();
  const list  = req.query.clinicId ? db.appointments.filter(a => a.clinicId === req.query.clinicId) : db.appointments;
  res.json([...list].reverse());
});
app.put('/api/appointments/:id', (req, res) => {
  const db = loadDB();
  const i  = db.appointments.findIndex(a => a.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Not found' });
  db.appointments[i] = { ...db.appointments[i], ...req.body };
  saveDB(db);
  res.json(db.appointments[i]);
});

// ─── API: Stats & Conversations ───────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const db    = loadDB();
  const appts = req.query.clinicId ? db.appointments.filter(a => a.clinicId === req.query.clinicId) : db.appointments;
  const convs = req.query.clinicId ? db.conversations.filter(c => c.clinicId === req.query.clinicId) : db.conversations;
  const today = new Date().toDateString();
  res.json({
    totalClinics:      db.clinics.length,
    totalAppointments: appts.length,
    todayAppointments: appts.filter(a => new Date(a.createdAt).toDateString() === today).length,
    totalMessages:     convs.filter(c => c.direction === 'inbound').length,
    confirmed:         appts.filter(a => a.status === 'confirmed').length,
    cancelled:         appts.filter(a => a.status === 'cancelled').length,
  });
});

app.get('/api/conversations', (req, res) => {
  const db   = loadDB();
  const list = req.query.clinicId ? db.conversations.filter(c => c.clinicId === req.query.clinicId) : db.conversations;
  res.json(list.slice(-100).reverse());
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date(), clinics: loadDB().clinics.length }));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅  ClinicBot server running on http://localhost:${PORT}`);
  console.log(`\n📋  TWILIO WEBHOOK URLs (paste both into Twilio console):`);
  console.log(`     WhatsApp msg  →  POST  YOUR_NGROK_URL/webhook/whatsapp`);
  console.log(`     Missed call   →  POST  YOUR_NGROK_URL/webhook/missed-call`);
  console.log(`\n⚠️   SANDBOX TIP: Patients must first send "join <your-word>" to your Twilio number.`);
  console.log(`     Find your join word: console.twilio.com → Messaging → Try it out → WhatsApp\n`);
  const db = loadDB();
  if (db.clinics.length === 0) {
    console.log('⚠️   No clinics in db.json yet! Open admin-dashboard.html and onboard one first.\n');
  } else {
    console.log(`🏥  Loaded ${db.clinics.length} clinic(s):`);
    db.clinics.forEach(c => console.log(`     • ${c.name}  [${c.twilioNumber}]`));
    console.log('');
  }
});
