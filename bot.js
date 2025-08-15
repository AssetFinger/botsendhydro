// index.js (versi lengkap + print semua pesan dari target + graceful shutdown)
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const dotenv = require('dotenv');
const readline = require('readline');

dotenv.config();

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// ---------- Util: prompt ----------
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

// ---------- Util: normalisasi teks untuk pencocokan aman ----------
function norm(s = '') {
  return String(s)
    .toLowerCase()
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim();
}

// ---------- Langkah 1: Cek .env dan siapkan config ----------
async function ensureConfig() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // Baca dari .env (kalau ada)
  const env = {
    WA_TARGET: process.env.WA_TARGET,
    INIT_CODE: process.env.INIT_CODE,
    IMG1_PATH: process.env.IMG1_PATH,
    IMG2_PATH: process.env.IMG2_PATH,
  };

  // Merge dengan config.json (kalau ada)
  let fileCfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try { fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  }

  const cfg = {
    target: env.WA_TARGET || fileCfg.target || '',
    code: env.INIT_CODE || fileCfg.code || '',
    img1: env.IMG1_PATH || fileCfg.img1 || '',
    img2: env.IMG2_PATH || fileCfg.img2 || '',
  };

  console.log('🔎 Mengecek .env...', fs.existsSync(path.join(__dirname, '.env')) ? 'ditemukan' : 'tidak ada, akan minta input');

  // ---------- Langkah 2-4: Minta input jika belum ada ----------
  if (!cfg.target) {
    cfg.target = (await ask('Masukkan nomor tujuan (format internasional tanpa +, mis. 6281234567890): ')).trim();
  }
  if (!cfg.code) {
    cfg.code = (await ask('Masukkan KODE unik (9 karakter huruf kapital/angka, mis. F123ABCDE): ')).trim();
  }
  if (!cfg.img1) {
    cfg.img1 = (await ask('Masukkan lokasi gambar1 (path lengkap): ')).trim();
  }
  if (!cfg.img2) {
    cfg.img2 = (await ask('Masukkan lokasi gambar2 (path lengkap): ')).trim();
  }

  // Validasi ringan
  const codeOk = /^[A-Z0-9]{9}$/.test(cfg.code);
  if (!codeOk) console.warn('⚠️ Kode unik sebaiknya 9 karakter huruf kapital/angka. Tetap lanjut, tapi periksa lagi ya.');
  if (!fs.existsSync(cfg.img1)) console.warn('⚠️ File gambar1 tidak ditemukan di path tersebut.');
  if (!fs.existsSync(cfg.img2)) console.warn('⚠️ File gambar2 tidak ditemukan di path tersebut.');
  if (!/^\d{8,15}$/.test(cfg.target)) console.warn('⚠️ Nomor tujuan tampak tidak valid. Pastikan tanpa "+", contoh 62812xxxxxxx');

  // ---------- Langkah 5: Simpan input ----------
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  console.log('💾 Input tersimpan di', CONFIG_PATH);

  return cfg;
}

// ---------- Frasa/pola yang akan dipantau ----------
const TRIGGERS = {
  askCode: [
    'silakan tuliskan kode unik yang ada di balik tutup botol hydroplus',
    'pastikan kode unik berjumlah 9 karakter'
  ],
  askImg1: [
    'mohon kirimkan bukti foto kode unik di balik tutup botol hydroplus',
    'pastikan kode unik pada foto terbaca dengan jelas'
  ],
  askImg2: [
    'untuk verifikasi lebih lanjut mohon kirimkan foto ktp kamu',
    'pastikan foto ktp kamu terbaca dengan jelas'
  ],
  doneMsg: [
    'terima kasih, ktp dan kode unik kamu berhasil diproses',
    'mohon kesediaannya menunggu konfirmasi dalam waktu 3x24 jam'
  ]
};

// helper untuk cek apakah teks chat “mengandung” salah satu pola
function matchAny(text, patterns) {
  const t = norm(text);
  return patterns.some(p => t.includes(norm(p)));
}

// --- Client di scope luar agar bisa di-shutdown rapi
let client;

// --- Graceful shutdown saat SIGINT/SIGTERM
function setupGracefulShutdown() {
  const onSignal = async () => {
    try {
      console.log(' Signal Shut down diterima, bot berhenti');
      await client?.destroy().catch(() => {});
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', onSignal);   // Ctrl+C
  process.on('SIGTERM', onSignal);  // kill/stop service
}

(async () => {
  const cfg = await ensureConfig();

  client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  });

  setupGracefulShutdown();

  // QR login
  client.on('qr', (qr) => {
    console.clear();
    console.log('📱 Scan QR berikut dengan WhatsApp (Linked devices):');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => console.log('🔐 Authenticated'));
  client.on('auth_failure', (m) => console.error('❌ Auth failure:', m));

  // ---------- Langkah 6: Print tersambung & siap ----------
  client.on('ready', async () => {
    console.log('✅ WhatsApp tersambung. Bot siap dijalankan!');

    // ---------- Langkah 7: Kirim "Hi" ke nomor tujuan ----------
    try {
      const chatId = `${cfg.target}@c.us`;
      await client.sendMessage(chatId, 'Hi');
      console.log('📤 Mengirim "Hi" ke', cfg.target);
    } catch (e) {
      console.error('Gagal mengirim "Hi":', e.message);
    }
  });

  // ---------- Langkah 8-11: Otomatis menanggapi pesan dari nomor tujuan ----------
  client.on('message', async (msg) => {
    try {
      const from = msg.from; // e.g. "628xxx@c.us"
      const isFromTarget = from === `${cfg.target}@c.us`;
      if (!isFromTarget) return; // hanya respons ke nomor tujuan

      const body = msg.body || '';

      // [NEW] Cetak SEMUA pesan dari nomor tujuan
      const ts = msg.timestamp ? new Date(msg.timestamp * 1000).toISOString() : new Date().toISOString();
      console.log(`📩 [${ts}] Pesan dari target (${cfg.target}):`);
      console.log(body);

      // 8) kirim kode saat diminta
      if (matchAny(body, TRIGGERS.askCode)) {
        await msg.reply(cfg.code);
        console.log('📤 Mengirim kode:', cfg.code);
        return;
      }

      // 9) kirim gambar1 saat diminta
      if (matchAny(body, TRIGGERS.askImg1)) {
        if (fs.existsSync(cfg.img1)) {
          const media = MessageMedia.fromFilePath(cfg.img1);
          await client.sendMessage(from, media);
          console.log('📤 Mengirim gambar1:', cfg.img1);
        } else {
          console.warn('⚠️ gambar1 tidak ditemukan, cek path:', cfg.img1);
          await msg.reply('Maaf, file gambar1 tidak ditemukan di server.');
        }
        return;
      }

      // 10) kirim gambar2 (KTP) saat diminta
      if (matchAny(body, TRIGGERS.askImg2)) {
        if (fs.existsSync(cfg.img2)) {
          const media = MessageMedia.fromFilePath(cfg.img2);
          await client.sendMessage(from, media);
          console.log('📤 Mengirim gambar2:', cfg.img2);
        } else {
          console.warn('⚠️ gambar2 tidak ditemukan, cek path:', cfg.img2);
          await msg.reply('Maaf, file gambar2 tidak ditemukan di server.');
        }
        return;
      }

      // 11) jika sudah selesai, print sukses
      if (matchAny(body, TRIGGERS.doneMsg)) {
        console.log('🎉 Bot sukses dijalankan: proses dinyatakan selesai oleh lawan chat.');
        await msg.react('✅');
        return;
      }

      // [UPDATED] Jika tidak cocok trigger mana pun, beri keterangan (tanpa reprint body)
      console.log('pesan lain terdeteksi, menunggu pesan yang sesuai target');

    } catch (e) {
      console.error('Handler error:', e);
    }
  });

  client.on('disconnected', (reason) => {
    console.error('⚠️ Disconnected:', reason);
    process.exit(1);
  });

  client.initialize();
})();
