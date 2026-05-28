# QRIS Operator Tool

Tool browser untuk memproses data QRIS, Bonus Harian, Audit Bonus, dan manajemen operator berbasis role.

## Fitur Utama

- Parser QRIS dari raw text / CSV / TSV
- Output copy untuk Excel
- Bonus Harian berdasarkan deposit terbesar
- Sinkronisasi Bonus Harian ke database pusat
- Lock batch pending agar operator tidak tabrakan
- Audit Bonus untuk deteksi mistake adjustment
- Login operator dengan role access
- Satu sesi aktif per akun dan auto logout idle 2 jam
- Admin Operator untuk kelola akun dari browser
- Klaim Mahjong Helper di dashboard dengan OCR API backend

## Role

- `operator`: Parser QRIS + Bonus Harian
- `audit`: Parser QRIS + Bonus Harian + Audit Bonus
- `admin`: semua fitur kecuali mengubah superadmin/protected
- `superadmin`: semua fitur dan kontrol penuh operator

## Arsitektur

```text
index.html (Vite entry)
  -> src/main.jsx
  -> src/App.jsx
  -> src/components/LegacyRuntime.jsx
  -> public/index.legacy.html
  -> /api/operator-login
  -> /api/operator-session
  -> /api/operators
  -> /api/bonus-done
  -> /api/claim-ocr
  -> database pusat
```

API Vercel memakai service role database dari environment server. Frontend tidak menyimpan service key dan tidak memproses password.

Catatan migrasi: aplikasi HTML/JS lama disimpan sebagai `index.legacy.html` dan disajikan melalui runtime React/Vite agar semua logic existing tetap aktif di preview. Folder `src/features` tetap disiapkan untuk pemindahan modular bertahap per fitur.

## Keamanan

- Password operator disimpan sebagai bcrypt hash.
- JWT session memakai `OPERATOR_SESSION_SECRET`.
- Satu akun hanya boleh memiliki satu sesi aktif dalam 2 jam terakhir.
- Sesi idle otomatis berakhir setelah 2 jam tanpa aktivitas.
- Admin Operator hanya untuk `admin/superadmin`.
- Akun `superadmin` atau `is_protected = true` tidak bisa diubah oleh admin biasa.
- Vercel Firewall/IP kantor bisa tetap digunakan sebagai lapisan akses awal.

## File Penting

- `index.html`: entry Vite + React
- `index.legacy.html`: snapshot aplikasi HTML/JS lama sebelum migrasi React
- `src/main.jsx`: bootstrap React
- `src/App.jsx`: entry aplikasi React
- `src/components`: komponen host runtime dan layout umum
- `src/features`: folder feature untuk migrasi bertahap
- `src/styles/global.css`: CSS global
- `public/index.legacy.html`: legacy app yang ikut masuk build Vite
- `vite.config.js`: konfigurasi build Vite
- `api/operator-login.js`: login operator
- `api/operator-session.js`: verify session
- `api/operators.js`: CRUD operator khusus admin/superadmin
- `api/bootstrap-admin.js`: bootstrap admin pertama sementara
- `api/bonus-done.js`: lock/sync Bonus Harian database pusat
- `api/claim-ocr.js`: OCR backend untuk Klaim Mahjong Helper
- `api/feature-locks.js`: API kunci menu sementara khusus superadmin
- `api/hermes-chat.js`: proxy chat Hermes dengan validasi session operator
- `supabase_bonus_batch_lock.sql`: migrasi database
- `feature_access_locks.sql`: migrasi status kunci menu
- `performance_indexes.sql`: rekomendasi index untuk mempercepat Admin Operator dan Monitoring Bonus Operator
- `README-INSTRUKSI.md`: panduan setup dan test

## Deployment

Deploy ke Vercel dengan build Vite. Folder `api/` tetap berada di root agar endpoint serverless Vercel tetap aktif.

```bash
npm install
npm run build
```

Environment:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
OPERATOR_SESSION_SECRET
OCR_SPACE_API_KEY
HERMES_API_URL
HERMES_API_SECRET
```

`OCR_SPACE_API_KEY` dipakai fitur Klaim Mahjong di `index.html` melalui endpoint backend `/api/claim-ocr`. Jika env ini belum diisi, OCR API tidak aktif dan helper tetap bisa dipakai dengan input manual.

`HERMES_API_URL` dipakai widget Hermes di `index.html` melalui endpoint backend `/api/hermes-chat`. `HERMES_API_SECRET` opsional dan hanya dikirim dari backend ke Hermes, tidak pernah ke browser.

Lihat `README-INSTRUKSI.md` untuk langkah bootstrap admin pertama dan SQL Supabase.
