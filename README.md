# QRIS Operator Tool

Tool browser untuk memproses data QRIS, Bonus Harian, Audit Bonus, dan manajemen operator berbasis role.

## Fitur Utama

- Parser QRIS dari raw text / CSV / TSV
- Output copy untuk Excel
- Bonus Harian berdasarkan deposit terbesar
- Sinkronisasi Bonus Harian ke Supabase
- Lock batch pending agar operator tidak tabrakan
- Audit Bonus untuk deteksi mistake adjustment
- Login operator dengan role access
- Admin Operator untuk kelola akun dari browser

## Role

- `operator`: Parser QRIS + Bonus Harian
- `audit`: Parser QRIS + Bonus Harian + Audit Bonus
- `admin`: semua fitur kecuali mengubah superadmin/protected
- `superadmin`: semua fitur dan kontrol penuh operator

## Arsitektur

```text
index.html
  -> /api/operator-login
  -> /api/operator-session
  -> /api/operators
  -> /api/bonus-done
  -> Supabase
```

API Vercel memakai Supabase service role dari environment server. Frontend tidak menyimpan service key dan tidak memproses password.

## Keamanan

- Password operator disimpan sebagai bcrypt hash.
- JWT session memakai `OPERATOR_SESSION_SECRET`.
- Admin Operator hanya untuk `admin/superadmin`.
- Akun `superadmin` atau `is_protected = true` tidak bisa diubah oleh admin biasa.
- Vercel Firewall/IP kantor bisa tetap digunakan sebagai lapisan akses awal.

## File Penting

- `index.html`: aplikasi utama
- `api/operator-login.js`: login operator
- `api/operator-session.js`: verify session
- `api/operators.js`: CRUD operator khusus admin/superadmin
- `api/bootstrap-admin.js`: bootstrap admin pertama sementara
- `api/bonus-done.js`: lock/sync Bonus Harian Supabase
- `supabase_bonus_batch_lock.sql`: migrasi database
- `README-INSTRUKSI.md`: panduan setup dan test

## Deployment

Deploy ke Vercel dengan environment:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
OPERATOR_SESSION_SECRET
```

Lihat `README-INSTRUKSI.md` untuk langkah bootstrap admin pertama dan SQL Supabase.
