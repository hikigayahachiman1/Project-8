# Instruksi Menjalankan QRIS Tool

## 1. Environment Vercel

Tambahkan env berikut di Vercel:

```text
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
OPERATOR_SESSION_SECRET=isi_random_panjang_minimal_32_karakter
OCR_SPACE_API_KEY=isi_api_key_ocr_space
```

`OCR_SPACE_API_KEY` hanya dipakai backend untuk fitur Klaim Mahjong di `index.html`. Jika belum diisi, OCR API tidak aktif dan helper tetap bisa dipakai dengan input manual.

Untuk endpoint ingest Telegram Parser QRIS Tahap 2B, tambahkan token terpisah:

```text
TELEGRAM_PARSER_QRIS_API_TOKEN=isi_random_panjang_dan_rahasia
```

Token ini hanya untuk `/api/telegram-parser-qris?action=ingest` dan tidak mengaktifkan Hermes, approval, atau local worker.

Contoh test `raw_text` tanpa Telegram Bot:

```bash
curl -X POST "https://DOMAIN-VERCEL-ANDA/api/telegram-parser-qris?action=ingest" \
  -H "Authorization: Bearer TOKEN_RAHASIA" \
  -H "Content-Type: application/json" \
  -d '{"bonus_date":"2026-06-21","idempotency_key":"test-raw-001","raw_text":"Login ID,Member ID,Member Name,Application Time (GMT+8),Payment,Payment Method,Currency,Amount,Fee,Status\nTESTUSER1,1001,Member Satu,06/21/2026 10:00:00,QRIS IM,QRIS,IDR,100.00,0.70,Approved"}'
```

Untuk membuat admin pertama dari browser, aktifkan sementara:

```text
ALLOW_BOOTSTRAP_ADMIN=true
```

Setelah admin pertama dibuat, hapus env tersebut atau ubah menjadi `false`, lalu redeploy.

## 2. SQL Supabase

Jalankan isi file:

```text
supabase_bonus_batch_lock.sql
feature_access_locks.sql
```

`feature_access_locks.sql` diperlukan agar menu `Kontrol Akses Menu` di Admin Operator bisa mengunci/membuka fitur untuk role selain superadmin.

Tahap 2B memiliki migration terpisah yang harus direview dan dijalankan manual:

```text
telegram_parser_qris_preview.sql
```

Migration tersebut hanya membuat tabel ingest/preview Telegram. Migration tidak menulis `bonus_done_daily`, tidak membuat `bonus_process_locks`, dan tidak menjalankan task worker.

SQL penting untuk operator:

```sql
create table if not exists public.operators (
  id bigserial primary key,
  username text not null unique,
  display_name text not null,
  password_hash text not null,
  role text not null default 'operator',
  is_protected boolean not null default false,
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.operators
drop constraint if exists operators_role_check;

alter table public.operators
add constraint operators_role_check
check (role in ('operator', 'audit', 'admin', 'superadmin'));

alter table public.operators
add column if not exists is_protected boolean not null default false;

create index if not exists operators_username_idx
on public.operators (username);

create index if not exists operators_role_idx
on public.operators (role);

alter table public.operators enable row level security;
```

## 3. Bootstrap Admin Pertama

Saat `ALLOW_BOOTSTRAP_ADMIN=true`, buat James sebagai superadmin protected:

```bash
curl -X POST https://DOMAIN-VERCEL-ANDA/api/bootstrap-admin \
  -H "Content-Type: application/json" \
  -d '{"username":"james","password":"passwordAdmin","display_name":"James","role":"superadmin"}'
```

Hasilnya:

- `role = superadmin`
- `is_protected = true`

Setelah sukses, matikan `ALLOW_BOOTSTRAP_ADMIN` dan redeploy.

## 4. Role Akses

- `operator`: Parser QRIS + Bonus Harian
- `audit`: Parser QRIS + Bonus Harian + Audit Bonus
- `admin`: Parser QRIS + Bonus Harian + Audit Bonus + Admin Operator
- `superadmin`: semua akses

Admin biasa tidak bisa mengubah akun `superadmin` atau akun `is_protected = true`.

## 5. Admin Operator

Login sebagai `admin` atau `superadmin`, lalu buka tab `Admin Operator`.

Fitur:

- Tambah operator
- Ubah nama/role
- Reset password
- Aktif/nonaktifkan operator
- Lihat daftar operator

Khusus superadmin:

- Bisa membuat role `superadmin`
- Bisa mengubah akun protected/superadmin

## 6. Test Wajib

1. Login sebagai James superadmin.
2. Pastikan Audit Bonus dan Admin Operator muncul.
3. Buat akun admin biasa.
4. Login admin biasa.
5. Pastikan admin biasa tidak bisa edit/reset/nonaktifkan James.
6. Buat akun audit, pastikan hanya Audit Bonus yang muncul.
7. Buat akun operator, pastikan Audit Bonus dan Admin Operator tidak muncul.
8. Reset password operator dari Admin Operator.
9. Nonaktifkan operator, pastikan tidak bisa login.

## 7. Catatan Keamanan

- Password tidak pernah disimpan polos.
- Password di-hash di server pakai `bcryptjs`.
- `password_hash` tidak dikirim ke frontend.
- `SUPABASE_SERVICE_ROLE_KEY` hanya dipakai di API Vercel.
- Vercel Firewall/IP kantor tetap menjadi lapisan pertama.
