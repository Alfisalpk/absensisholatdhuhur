# Absensi Sholat Dzuhur — SMK Batik 1 Surakarta

Aplikasi web Google Apps Script dengan Google Sheets sebagai database. Source utama: `Code.gs` dan `Index.html`.

## Fitur

- Login admin dan petugas absensi; password disimpan sebagai hash salted.
- Admin membuat/menonaktifkan akun petugas dan mengelola data siswa kelas X, XI, XII.
- Daftar akun petugas tersedia di halaman tersendiri. Menu Pengaturan berisi jadwal Dzuhur untuk admin dan edit profil untuk setiap pengguna.
- Admin dapat mengunduh template CSV siswa dan mengimpor banyak siswa sekaligus. NISN yang sudah ada diperbarui; baris dengan data tidak valid menolak seluruh impor.
- Checklist tabel mengikuti filter tingkat dan jurusan; pilih semua hasil filter atau beberapa siswa lalu nonaktifkan sekaligus. Riwayat absensi tetap dipertahankan.
- QR code setiap siswa memakai NISN sebagai identitas; QR dapat diunduh PNG per siswa.
- QR dapat dipindai dari webcam langsung jika browser mengizinkannya, dari foto kamera ponsel, atau dengan input NISN manual. HTML Service Apps Script membatasi API webcam langsung; untuk live scan stabil, pemindai perlu di-host pada domain terpisah.
- Absensi menolak catatan ganda per siswa per hari dan memberi status berdasarkan waktu.
- Dashboard dan halaman absensi mengambil ulang perubahan setiap 10 detik selama halaman terbuka; tanggal dari Sheets dinormalisasi ke zona waktu Asia/Jakarta.
- Petugas dapat menetapkan status Sakit, Izin, atau Tidak sholat untuk siswa yang belum tercatat.
- Rekap dapat difilter menurut rentang tanggal, tingkat, jurusan, dan status, lalu diunduh sebagai CSV.
- Data utama disimpan di tab `Users`, `Students`, `Attendance`, dan `Settings` pada spreadsheet.

## Pemasangan

1. Buat Google Spreadsheet baru untuk database sekolah.
2. Dari spreadsheet pilih **Extensions → Apps Script**.
3. Buat file script `Code.gs`, lalu salin isi file ini. Tambahkan file HTML bernama `Index` dan salin isi `Index.html`. Salin juga manifest `appsscript.json` melalui **Project Settings → Show "appsscript.json" manifest file** bila diperlukan.
4. Simpan, pilih fungsi `setupDatabase` pada editor Apps Script, lalu tekan **Run**. Setujui izin spreadsheet yang diminta. Fungsi ini membuat tab dan header database.
5. Kembali ke URL web app setelah deployment; layar **Buat admin pertama** akan muncul jika belum ada akun.
6. Deploy melalui **Deploy → New deployment → Web app**. Pilih **Execute as: Me** dan atur akses sesuai kebijakan akun sekolah. Batasi akses ke lingkungan sekolah bila tersedia.
7. Buka URL `/exec` dari ponsel. Untuk pemindaian langsung, gunakan opsi **Ambil foto QR**. Webcam langsung dapat dibatasi sandbox HTML Service Apps Script meskipun izin situs sudah aktif.

Untuk pembaruan source, simpan perubahan lalu gunakan **Deploy → Manage deployments → Edit → New version**.

## Format unggah siswa

Di menu **Data siswa**, unduh **Format CSV** lalu isi kolom berikut dengan urutan/header tersebut:

| NISN | Nama | Tingkat | Jurusan | Kelas |
| --- | --- | --- | --- | --- |
| 0012345678 | Contoh Nama Siswa | X | RPL | X RPL 1 |

Simpan sebagai CSV UTF-8. Tingkat hanya `X`, `XI`, atau `XII`; NISN harus 5–20 digit dan sebaiknya disimpan sebagai teks agar angka nol di depan tidak hilang. File hingga 5.000 baris per impor. Baris dengan NISN yang sama dengan data tersimpan akan memperbarui data siswa tersebut dan mengaktifkannya kembali. NISN duplikat di dalam satu file atau data tidak valid akan membuat impor ditolak sebelum penyimpanan.

## Ketentuan waktu dan status

- Zona waktu aplikasi adalah `Asia/Jakarta`.
- Default waktu awal 11:30 dan akhir 13:00; admin dapat mengubahnya di menu Pengaturan.
- Scan sebelum waktu awal berstatus **Hadir**, scan sampai waktu akhir **Terlambat**, dan scan setelah waktu akhir **Di luar jadwal**.
- Siswa tanpa catatan tampil sebagai **Belum absen**. Petugas memilih Sakit, Izin, atau Tidak sholat untuk menyimpan status akhir.
- Data siswa dihapus secara lunak (dinonaktifkan) agar riwayat lama tetap tersimpan.

## Catatan operasional

- Admin pertama hanya dapat dibuat saat tab Users belum berisi akun. Simpan kredensial admin dengan aman.
- Buat cadangan spreadsheet secara berkala dan batasi editor spreadsheet kepada pengelola tepercaya.
- CDN untuk pustaka pemindai QR, QR code, dan font memerlukan koneksi internet saat halaman dibuka.
- Setelan rentang waktu menyimpan batas status keterlambatan. Aturan kebijakan “tidak ikut sholat” tetap memerlukan petugas untuk mencatat status Tidak sholat pada siswa yang belum absen.
- Ini adalah fondasi MVP; kebijakan disiplin, izin, privasi data siswa, dan prosedur sekolah perlu diselaraskan sebelum digunakan sebagai sistem resmi.
