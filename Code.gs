/**
 * Absensi Sholat Dzuhur — Google Apps Script + Google Sheets
 * Bind this project to a spreadsheet, then run setupDatabase() once.
 */
const APP = { SHEETS: { USERS: 'Users', STUDENTS: 'Students', ATTENDANCE: 'Attendance', SETTINGS: 'Settings' }, SESSION_TTL: 21600 };

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Absensi Dzuhur | SMK Batik 1 Surakarta')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function getSetupState() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) return { ready: false, hasAdmin: false };
  try {
    return {
      ready: true,
      hasAdmin: rows_(APP.SHEETS.USERS).length > 0
    };
  } catch (e) {
    return {
      ready: false,
      hasAdmin: false
    };
  }
}

function setupDatabase() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Buka Extensions > Apps Script dari spreadsheet yang akan digunakan.');
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', ss.getId());
  const schemas = {
    Users: ['id', 'name', 'username', 'passwordHash', 'salt', 'role', 'active', 'createdAt'],
    Students: ['nisn', 'name', 'grade', 'major', 'className', 'active', 'createdAt', 'gender'],
    Attendance: ['id', 'date', 'nisn', 'studentName', 'grade', 'major', 'className', 'status', 'time', 'note', 'recordedBy', 'gender'],
    Settings: ['key', 'value']
  };
  Object.keys(schemas).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) sh.appendRow(schemas[name]);
    sh.setFrozenRows(1);
  });
  ensureGenderColumns_();
  ensureAutoAttendanceTrigger_();
  const settings = ss.getSheetByName(APP.SHEETS.SETTINGS);
  if (settings.getLastRow() < 2) {
    settings.getRange(2, 1, 4, 2).setValues([
      ['startTime', '11:30'],
      ['endTime', '13:00'],
      ['schoolName', 'SMK Batik 1 Surakarta'],
      ['timezone', 'Asia/Jakarta']
    ]);
  }
  return 'Database siap. Trigger otomatis absensi terpasang. Muat ulang aplikasi untuk membuat akun admin pertama.';
}

function bootstrapAdmin(name, username, password) {
  const sh = sheet_(APP.SHEETS.USERS);
  if (sh.getLastRow() > 1) throw new Error('Akun sudah tersedia. Hubungi admin untuk membuat akun baru.');
  if (!name || !username || !password || String(password).length < 8) throw new Error('Isi nama, username, dan password minimal 8 karakter.');
  const salt = Utilities.getUuid();
  sh.appendRow([Utilities.getUuid(), name, String(username).trim().toLowerCase(), hash_(password, salt), salt, 'admin', true, new Date()]);
  return login(username, password);
}

function login(username, password) {
  const rows = rows_(APP.SHEETS.USERS);
  const key = String(username || '').trim().toLowerCase();
  const user = rows.find(r => String(r.username).toLowerCase() === key && String(r.active) !== 'false');
  if (!user || hash_(password || '', user.salt) !== user.passwordHash) throw new Error('Username atau password tidak sesuai.');
  const token = Utilities.getUuid() + Utilities.getUuid();
  CacheService.getScriptCache().put('session_' + token, JSON.stringify({ id: user.id, name: user.name, role: user.role }), APP.SESSION_TTL);
  return { token, user: { name: user.name, role: user.role } };
}

function logout(token) {
  if (token) {
    CacheService.getScriptCache().remove('session_' + token);
  }
  return true;
}

function getAppData(token) {
  const actor = auth_(token);
  closeAttendanceIfDue_();
  const allUsers = rows_(APP.SHEETS.USERS);
  const account = allUsers.find(user => user.id === actor.id);
  const currentUser = {
    ...actor,
    username: account ? account.username : ''
  };
  const settings = Object.fromEntries(rows_(APP.SHEETS.SETTINGS).map(r => [r.key, r.value]));
  const students = rows_(APP.SHEETS.STUDENTS).filter(r => String(r.active) !== 'false');
  const today = today_();
  const studentGender = new Map(students.map(student => [String(student.nisn), student.gender || '']));
  const attendanceByStudent = new Map();
  attendanceRowsForRange_(today, today, true)
    .forEach(row => attendanceByStudent.set(String(row.nisn), {
      ...row,
      gender: row.gender || studentGender.get(String(row.nisn)) || ''
    }));
  const attendance = Array.from(attendanceByStudent.values());
  const users = actor.role === 'admin'
    ? allUsers.map(user => ({
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
      active: user.active
    }))
    : [];
  return { user: currentUser, settings, students, attendance, users, today, initialized: true };
}

function saveProfile(token, profile) {
  const actor = auth_(token);
  const name = String(profile.name || '').trim();
  const username = String(profile.username || '').trim().toLowerCase();
  const password = String(profile.password || '');

  if (!name) {
    throw new Error('Nama pengguna wajib diisi.');
  }
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
    throw new Error('Username harus 3–30 karakter dan hanya boleh berisi huruf, angka, titik, garis bawah, atau tanda hubung.');
  }
  if (password && password.length < 8) {
    throw new Error('Password baru harus minimal 8 karakter.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const sh = sheet_(APP.SHEETS.USERS);
    const accounts = rows_(APP.SHEETS.USERS);
    const account = accounts.find(user => String(user.id) === String(actor.id));
    if (!account) {
      throw new Error('Akun pengguna tidak ditemukan.');
    }

    const usernameTaken = accounts.some(user =>
      String(user.id) !== String(actor.id) &&
      String(user.username).toLowerCase() === username
    );
    if (usernameTaken) {
      throw new Error('Username sudah digunakan akun lain.');
    }

    account.name = name;
    account.username = username;
    const updatedCells = [name, username];

    if (password) {
      account.salt = Utilities.getUuid();
      account.passwordHash = hash_(password, account.salt);
      updatedCells.push(account.passwordHash, account.salt);
    }

    sh.getRange(account._row, 2, 1, updatedCells.length).setValues([updatedCells]);
    CacheService.getScriptCache().put(
      'session_' + token,
      JSON.stringify({ id: actor.id, name, role: actor.role }),
      APP.SESSION_TTL
    );

    return true;
  } finally {
    lock.releaseLock();
  }
}

function saveStudent(token, data) {
  requireAdmin_(token);
  data = data || {};
  const nisn = String(data.nisn || '').trim();
  const gender = normalizeGender_(data.gender);
  if (!/^\d{5,20}$/.test(nisn) || !data.name || !data.grade || !data.major || !data.className || !gender) {
    throw new Error('Lengkapi NISN, nama, tingkat, jurusan, kelas, dan jenis kelamin.');
  }
  const sh = sheet_(APP.SHEETS.STUDENTS), all = rows_(APP.SHEETS.STUDENTS), old = all.find(r => String(r.nisn) === nisn);
  const row = [
    nisn,
    String(data.name).trim(),
    String(data.grade),
    String(data.major).trim(),
    String(data.className).trim(),
    true,
    old ? old.createdAt : new Date(),
    gender
  ];
  if (old) sh.getRange(old._row, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
  return true;
}

function deleteStudent(token, nisn) {
  requireAdmin_(token);
  const r = rows_(APP.SHEETS.STUDENTS).find(x => String(x.nisn) === String(nisn));
  if (r) sheet_(APP.SHEETS.STUDENTS).getRange(r._row, 6).setValue(false);
  return true;
}

function importStudents(token, records) {
  requireAdmin_(token);
  if (!Array.isArray(records) || !records.length) throw new Error('File tidak berisi data siswa.');
  if (records.length > 5000) throw new Error('Maksimal 5.000 baris per unggahan.');
  const seen = new Set();
  const normalized = records.map((r, i) => {
    const line = i + 2;
    const nisn = String(r.nisn || '').trim();
    const name = String(r.name || '').trim();
    const grade = String(r.grade || '').trim().toUpperCase();
    const major = String(r.major || '').trim();
    const className = String(r.className || '').trim();
    const gender = normalizeGender_(r.gender);
    if (!/^\d{5,20}$/.test(nisn)) throw new Error('Baris ' + line + ': NISN wajib 5–20 digit.');
    if (!name || !['X', 'XI', 'XII'].includes(grade) || !major || !className || !['Laki-laki', 'Perempuan'].includes(gender)) {
      throw new Error(
        'Baris ' + line + ': nama, tingkat (X/XI/XII), jurusan, kelas, dan jenis kelamin wajib diisi.'
      );
    }
    if (seen.has(nisn)) throw new Error('NISN duplikat pada file: ' + nisn + '.');
    seen.add(nisn);
    return { nisn, name, grade, major, className, gender };
  });
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = sheet_(APP.SHEETS.STUDENTS), all = rows_(APP.SHEETS.STUDENTS), index = new Map(all.map(r => [String(r.nisn), r]));
    let added = 0, updated = 0;
    normalized.forEach(student => {
      const existing = index.get(student.nisn);

      if (existing) {
        existing.name = student.name;
        existing.grade = student.grade;
        existing.major = student.major;
        existing.className = student.className;
        existing.gender = student.gender;
        existing.active = true;
        updated++;
      } else {
        all.push({
          nisn: student.nisn,
          name: student.name,
          grade: student.grade,
          major: student.major,
          className: student.className,
          gender: student.gender,
          active: true,
          createdAt: new Date().toISOString()
        });
        added++;
      }
    });

    const values = all.map(student => [
      student.nisn,
      student.name,
      student.grade,
      student.major,
      student.className,
      student.active,
      student.createdAt,
      student.gender
    ]);

    if (values.length) {
      sh.getRange(2, 1, values.length, 8).setValues(values);
    }
    return { added, updated, total: normalized.length };
  } finally {
    lock.releaseLock();
  }
}

function deleteStudents(token, nisns) {
  requireAdmin_(token);
  if (!Array.isArray(nisns) || !nisns.length) throw new Error('Pilih setidaknya satu siswa.');
  const targets = new Set(nisns.map(String));
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = sheet_(APP.SHEETS.STUDENTS), all = rows_(APP.SHEETS.STUDENTS);
    let count = 0;
    const values = all.map(r => {
      const active = targets.has(String(r.nisn)) ? false : r.active;
      if (targets.has(String(r.nisn)) && String(r.active) !== 'false') count++;
      return [
        r.nisn,
        r.name,
        r.grade,
        r.major,
        r.className,
        active,
        r.createdAt,
        r.gender
      ];
    });
    if (values.length) {
      sh.getRange(2, 1, values.length, 8).setValues(values);
    }
    return count;
  } finally {
    lock.releaseLock();
  }
}

function saveTeacher(token, data) {
  requireAdmin_(token);
  data = data || {};
  const username = String(data.username || '').trim().toLowerCase();
  if (!data.name || !/^[a-z0-9._-]{3,30}$/.test(username) || String(data.password || '').length < 8) {
    throw new Error('Nama wajib diisi, username 3–30 karakter, password minimal 8 karakter.');
  }
  const sh = sheet_(APP.SHEETS.USERS), all = rows_(APP.SHEETS.USERS);
  if (all.some(r => String(r.username).toLowerCase() === username)) throw new Error('Username sudah digunakan.');
  const salt = Utilities.getUuid();
  sh.appendRow([Utilities.getUuid(), String(data.name).trim(), username, hash_(data.password, salt), salt, 'teacher', true, new Date()]);
  return true;
}

function updateTeacher(token, id, data) {
  const actor = requireAdmin_(token);
  data = data || {};
  const sh = sheet_(APP.SHEETS.USERS), all = rows_(APP.SHEETS.USERS);
  const user = all.find(row => String(row.id) === String(id));
  if (!user) throw new Error('Akun tidak ditemukan.');
  const name = String(data.name || '').trim();
  const username = String(data.username || '').trim().toLowerCase();
  const role = String(data.role || 'teacher');
  if (!name || !/^[a-z0-9._-]{3,30}$/.test(username) || !['teacher', 'admin'].includes(role)) {
    throw new Error('Nama, username, atau role tidak valid.');
  }
  if (username !== String(user.username).toLowerCase() && all.some(row => String(row.username).toLowerCase() === username)) {
    throw new Error('Username sudah digunakan.');
  }
  if (String(actor.id) === String(id) && role !== user.role) {
    throw new Error('Role akun yang sedang digunakan tidak dapat diubah dari menu ini.');
  }
  if (user.role === 'admin' && String(user.active) !== 'false' && role !== 'admin') {
    const activeAdmins = all.filter(row => row.role === 'admin' && String(row.active) !== 'false').length;
    if (activeAdmins <= 1) throw new Error('Tidak dapat mengubah role Admin aktif terakhir.');
  }
  const password = String(data.password || '');
  const values = [name, username, user.passwordHash, user.salt, role];
  if (password) {
    if (password.length < 8) throw new Error('Password minimal 8 karakter.');
    const salt = Utilities.getUuid();
    values[2] = hash_(password, salt);
    values[3] = salt;
  }
  sh.getRange(user._row, 2, 1, 5).setValues([values]);
  if (String(actor.id) === String(id)) {
    CacheService.getScriptCache().put('session_' + token, JSON.stringify({ id: actor.id, name, role: user.role }), APP.SESSION_TTL);
  }
  return true;
}

function deleteTeacher(token, id) {
  const actor = requireAdmin_(token);
  const sh = sheet_(APP.SHEETS.USERS);
  const all = rows_(APP.SHEETS.USERS);
  const user = all.find(row => String(row.id) === String(id));
  if (!user) throw new Error('Akun tidak ditemukan.');
  if (String(actor.id) === String(id)) throw new Error('Akun yang sedang digunakan tidak dapat dihapus.');
  if (user.role === 'admin' && String(user.active) !== 'false' && all.filter(row => row.role === 'admin' && String(row.active) !== 'false').length <= 1) {
    throw new Error('Admin aktif terakhir tidak dapat dihapus.');
  }
  sh.deleteRow(user._row);
  return true;
}

function importTeachers(token, records) {
  requireAdmin_(token);
  if (!Array.isArray(records) || !records.length) throw new Error('Tidak ada data petugas untuk diunggah.');
  if (records.length > 500) throw new Error('Maksimal 500 akun petugas sekali unggah.');
  const sh = sheet_(APP.SHEETS.USERS), all = rows_(APP.SHEETS.USERS);
  const usernames = new Set(all.map(row => String(row.username).toLowerCase()));
  const prepared = records.map((record, index) => {
    const name = String(record.name || '').trim();
    const username = String(record.username || '').trim().toLowerCase();
    const password = String(record.password || '');
    if (!name || !/^[a-z0-9._-]{3,30}$/.test(username) || password.length < 8)
      throw new Error(`Baris ${index + 2}: nama, username 3–30 karakter, dan password minimal 8 karakter wajib diisi.`);
    if (usernames.has(username)) throw new Error(`Baris ${index + 2}: username ${username} sudah digunakan.`);
    usernames.add(username);
    const salt = Utilities.getUuid();
    return [Utilities.getUuid(), name, username, hash_(password, salt), salt, 'teacher', true, new Date()];
  });
  sh.getRange(sh.getLastRow() + 1, 1, prepared.length, 8).setValues(prepared);
  return { count: prepared.length };
}

function setTeacherActive(token, id, active) {
  const actor = requireAdmin_(token);
  const all = rows_(APP.SHEETS.USERS);
  const u = all.find(r => String(r.id) === String(id));
  if (!u) throw new Error('Akun tidak ditemukan.');
  if (String(actor.id) === String(id) && !active) throw new Error('Akun yang sedang digunakan tidak dapat dinonaktifkan.');
  if (u.role === 'admin' && String(u.active) !== 'false' && !active && all.filter(r => r.role === 'admin' && String(r.active) !== 'false').length <= 1) {
    throw new Error('Admin aktif terakhir tidak dapat dinonaktifkan.');
  }
  sheet_(APP.SHEETS.USERS).getRange(u._row, 7).setValue(!!active);
  return true;
}

function saveSettings(token, values) {
  requireAdmin_(token);
  const start = String(values.startTime || ''), end = String(values.endTime || '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end) || start >= end) {
    throw new Error('Rentang waktu tidak valid. Waktu awal harus sebelum waktu akhir.');
  }
  const sh = sheet_(APP.SHEETS.SETTINGS), all = rows_(APP.SHEETS.SETTINGS);
  [['startTime', start], ['endTime', end]].forEach(([key, value]) => {
    const row = all.find(item => item.key === key);
    if (row) {
      sh.getRange(row._row, 2).setValue(value);
    } else {
      sh.appendRow([key, value]);
    }
  });
  return true;
}

function recordAttendance(token, nisn) {
  const actor = auth_(token);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const id = String(nisn || '').trim(), student = rows_(APP.SHEETS.STUDENTS).find(r => String(r.nisn) === id && String(r.active) !== 'false');
    if (!student) throw new Error('Siswa tidak ditemukan atau sudah tidak aktif.');
    const date = today_(), all = attendanceRowsForRange_(date, date, true);
    if (all.some(r => r.date === date && String(r.nisn) === id)) throw new Error('Siswa ini sudah memiliki catatan absensi hari ini.');
    const settings = Object.fromEntries(rows_(APP.SHEETS.SETTINGS).map(r => [r.key,r.value]));
    const now = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'HH:mm');
    const status = now < (settings.startTime || '11:30') ? 'Hadir' : now <= (settings.endTime || '13:00') ? 'Terlambat' : 'Di luar jadwal';
    sheet_(APP.SHEETS.ATTENDANCE).appendRow([
      Utilities.getUuid(),
      date,
      id,
      student.name,
      student.grade,
      student.major,
      student.className,
      status,
      now,
      '',
      actor.name,
      student.gender
    ]);
    return { nisn:id, name:student.name, status, time:now };
  } finally {
    lock.releaseLock();
  }
}

function recordAttendanceBulk(token, nisns) {
  const actor = auth_(token);
  if (!Array.isArray(nisns) || !nisns.length) throw new Error('Pilih setidaknya satu siswa yang hadir.');
  const allowedStatuses = ['Hadir', 'Terlambat', 'Sakit', 'Izin', 'Tidak sholat', 'Di luar jadwal', 'Tidak Masuk', 'Berhalangan'];
  const requested = new Map();
  nisns.forEach(value => {
    const item = value && typeof value === 'object' ? value : { nisn: value };
    const id = String(item.nisn || '').trim();
    if (!id) return;
    if (item.status && !allowedStatuses.includes(item.status)) throw new Error('Status tidak valid untuk NISN ' + id + '.');
    requested.set(id, item.status || '');
  });
  const ids = [...requested.keys()];
  if (!ids.length) throw new Error('Pilih setidaknya satu siswa yang hadir.');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const date = today_();
    const students = rows_(APP.SHEETS.STUDENTS).filter(row => String(row.active) !== 'false');
    const existing = new Set(attendanceRowsForRange_(date, date, true).map(row => String(row.nisn)));
    const settings = Object.fromEntries(rows_(APP.SHEETS.SETTINGS).map(row => [row.key, row.value]));
    const now = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'HH:mm');
    const defaultStatus = now < (settings.startTime || '11:30') ? 'Hadir' : now <= (settings.endTime || '13:00') ? 'Terlambat' : 'Di luar jadwal';
    const selected = ids.map(id => {
      const student = students.find(row => String(row.nisn) === id);
      if (!student) throw new Error('Siswa dengan NISN ' + id + ' tidak ditemukan atau sudah tidak aktif.');
      return { id, student };
    }).filter(item => !existing.has(item.id));
    if (!selected.length) throw new Error('Semua siswa yang dipilih sudah memiliki catatan absensi hari ini.');
    const sh = sheet_(APP.SHEETS.ATTENDANCE);
    sh.getRange(sh.getLastRow() + 1, 1, selected.length, 12).setValues(selected.map(({ id, student }) => [
      Utilities.getUuid(), date, id, student.name, student.grade, student.major,
      student.className, requested.get(id) || defaultStatus, now, '', actor.name, student.gender
    ]));
    const statuses = [...new Set(selected.map(({ id }) => requested.get(id) || defaultStatus))];
    return { count: selected.length, skipped: ids.length - selected.length, statuses, time: now };
  } finally {
    lock.releaseLock();
  }
}

function setStudentStatus(token, nisn, status, note) {
  const actor = auth_(token);
  if (!['Terlambat','Sakit','Izin','Tidak sholat','Di luar jadwal','Tidak Masuk','Berhalangan'].includes(status)) throw new Error('Status tidak valid.');
  const student = rows_(APP.SHEETS.STUDENTS).find(r => String(r.nisn) === String(nisn) && String(r.active) !== 'false');
  if (!student) throw new Error('Siswa tidak ditemukan.');
  const sh = sheet_(APP.SHEETS.ATTENDANCE);
  const date = today_();
  const all = attendanceRowsForRange_(date, date, true);
  const old = all.filter(
    row => row.date === date && String(row.nisn) === String(nisn)
  ).pop();
  const row = [
    old ? old.id : Utilities.getUuid(),
    date,
    String(nisn),
    student.name,
    student.grade,
    student.major,
    student.className,
    status,
    old ? old.time : Utilities.formatDate(new Date(), 'Asia/Jakarta', 'HH:mm'),
    String(note || '').slice(0, 200),
    actor.name,
    student.gender
  ];
  if (old) sh.getRange(old._row, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
  return true;
}

function updateAttendanceStatusBulk(token, ids, status, note) {
  const actor = auth_(token);
  const allowed = ['Terlambat', 'Sakit', 'Izin', 'Tidak sholat', 'Di luar jadwal', 'Tidak Masuk', 'Berhalangan'];
  if (!Array.isArray(ids) || !ids.length) throw new Error('Pilih catatan absensi yang akan diedit.');
  if (!allowed.includes(status)) throw new Error('Status tidak valid.');
  const targets = new Set(ids.map(String));
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const date = today_(), sh = sheet_(APP.SHEETS.ATTENDANCE);
    const rows = attendanceRowsForRange_(date, date, true).filter(row => targets.has(String(row.id)));
    if (rows.length !== targets.size) throw new Error('Sebagian catatan tidak ditemukan atau bukan catatan hari ini. Muat ulang halaman.');
    rows.forEach(row => {
      sh.getRange(row._row, 8).setValue(status);
      sh.getRange(row._row, 10).setValue(String(note || '').slice(0, 200));
      sh.getRange(row._row, 11).setValue(actor.name);
    });
    return rows.length;
  } finally {
    lock.releaseLock();
  }
}

function deleteAttendanceRecords(token, ids) {
  auth_(token);
  if (!Array.isArray(ids) || !ids.length) throw new Error('Pilih catatan absensi yang akan dihapus.');
  const targets = new Set(ids.map(String));
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = sheet_(APP.SHEETS.ATTENDANCE), date = today_();
    const rows = attendanceRowsForRange_(date, date, true).filter(row => targets.has(String(row.id)));
    if (rows.length !== targets.size) throw new Error('Sebagian catatan tidak ditemukan atau bukan catatan hari ini. Muat ulang halaman.');
    rows.map(row => row._row).sort((a, b) => b - a).forEach(rowNumber => sh.deleteRow(rowNumber));
    return rows.length;
  } finally {
    lock.releaseLock();
  }
}

function getReport(token, filters) {
  auth_(token);
  filters = filters || {};
  const from = filters.from || today_(), to = filters.to || today_();
  const students = rows_(APP.SHEETS.STUDENTS)
    .filter(row => String(row.active) !== 'false');
  const studentsByNisn = new Map(students.map(student => [String(student.nisn), student]));
  const recordsByDateAndStudent = new Map();
  attendanceRowsForRange_(from, to, true)
    .forEach(row => {
      const student = studentsByNisn.get(String(row.nisn));
      recordsByDateAndStudent.set(row.date + '|' + row.nisn, {
        ...row,
        gender: row.gender || student?.gender || ''
      });
    });
  const records = Array.from(recordsByDateAndStudent.values());
  const makeKey = row => [row.date, row.nisn].join('|');
  const attendanceByKey = new Map(
    records.map(row => [makeKey(row), row])
  );

  let result = students.flatMap(student => {
    const studentRecords = records.filter(
      record => String(record.nisn) === String(student.nisn)
    );

    if (studentRecords.length) {
      return studentRecords.map(record =>
        attendanceByKey.get(record.date + '|' + student.nisn)
      );
    }

    if (from === to) {
      return [{
        date: from,
        nisn: student.nisn,
        studentName: student.name,
        gender: student.gender || '',
        grade: student.grade,
        major: student.major,
        className: student.className,
        status: 'Belum absen',
        time: '',
        note: '',
        recordedBy: ''
      }];
    }

    return [];
  });

  if (filters.grade) {
    result = result.filter(row => String(row.grade) === String(filters.grade));
  }
  if (filters.major) {
    result = result.filter(row => String(row.major) === String(filters.major));
  }
  if (filters.className) {
    result = result.filter(row => String(row.className) === String(filters.className));
  }
  if (filters.status) {
    result = result.filter(row => row.status === filters.status);
  }
  return result;
}

function auth_(token) {
  const cache = CacheService.getScriptCache();
  const raw = token && cache.get('session_' + token);
  if (!raw) {
    throw new Error('Sesi berakhir. Silakan masuk kembali.');
  }
  const session = JSON.parse(raw);
  const account = rows_(APP.SHEETS.USERS).find(user => String(user.id) === String(session.id));
  if (!account || String(account.active) === 'false') {
    cache.remove('session_' + token);
    throw new Error('Akun tidak aktif atau sudah dihapus. Silakan masuk kembali.');
  }
  if (session.name !== account.name || session.role !== account.role) {
    session.name = account.name;
    session.role = account.role;
    cache.put('session_' + token, JSON.stringify(session), APP.SESSION_TTL);
  }
  return session;
}

function requireAdmin_(token) {
  const user = auth_(token);
  if (user.role !== 'admin') {
    throw new Error('Akses khusus admin.');
  }
  return user;
}

function hash_(password, salt) {
  return Utilities.base64Encode(
    Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      String(salt) + '|' + String(password),
      Utilities.Charset.UTF_8
    )
  );
}

function spreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) {
    throw new Error('Jalankan setupDatabase() dari editor Apps Script terlebih dahulu.');
  }
  return SpreadsheetApp.openById(id);
}

function sheet_(name) {
  const sh = spreadsheet_().getSheetByName(name);
  if (!sh) {
    throw new Error('Sheet ' + name + ' belum tersedia. Jalankan setupDatabase().');
  }
  return sh;
}

function rows_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];

  return recordsFromValues_(values, 2);
}

/** Read only attendance rows that match a requested date range. */
function attendanceRowsForRange_(from, to, chronologicalTailOnly) {
  const sh = sheet_(APP.SHEETS.ATTENDANCE);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  let firstRow = -1;
  let lastMatchingRow = -1;
  if (chronologicalTailOnly) {
    // App writes attendance chronologically. Scanning backward lets current
    // and recent historical reports stop as soon as they pass the range start.
    const blockSize = 1500;
    let cursor = lastRow;
    while (cursor >= 2) {
      const start = Math.max(2, cursor - blockSize + 1);
      const dates = sh.getRange(start, 2, cursor - start + 1, 1).getValues();
      let olderThanRange = false;
      for (let i = dates.length - 1; i >= 0; i--) {
        const date = attendanceDate_(dates[i][0]);
        const rowNumber = start + i;
        if (date && date < from) {
          olderThanRange = true;
          break;
        }
        if (date >= from && date <= to) {
          if (lastMatchingRow < 0) lastMatchingRow = rowNumber;
          firstRow = rowNumber;
        }
      }
      if (olderThanRange) break;
      cursor = start - 1;
    }
  } else {
    // Retain a full-column fallback for callers that need to tolerate manually
    // reordered rows. Normal app and report paths use the chronological scan.
    const dates = sh.getRange(2, 2, lastRow - 1, 1).getValues();
    for (let i = 0; i < dates.length; i++) {
      const date = attendanceDate_(dates[i][0]);
      if (date >= from && date <= to) {
        if (firstRow < 0) firstRow = i + 2;
        lastMatchingRow = i + 2;
      }
    }
  }
  if (firstRow < 0) return [];

  const lastColumn = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, lastColumn).getValues()[0].map(String);
  const values = sh.getRange(firstRow, 1, lastMatchingRow - firstRow + 1, lastColumn).getValues();
  return recordsFromValues_(values, firstRow, headers)
    .filter(row => row.date >= from && row.date <= to);
}

function attendanceDate_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, 'Asia/Jakarta', 'yyyy-MM-dd');
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  // Support legacy date cells stored as text in common Indonesian formats.
  const match = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (match) return `${match[3]}-${('0' + match[2]).slice(-2)}-${('0' + match[1]).slice(-2)}`;
  return '';
}

function recordsFromValues_(values, startRow, headers) {
  if (!values.length || (!headers && values.length < 2)) return [];

  const keys = headers || values[0].map(String);
  const dataRows = headers ? values : values.slice(1);
  return dataRows
    .map((row, index) => {
      const record = { _row: startRow + index };
      keys.forEach((key, column) => {
        const value = row[column];
        if (key === 'date' && value instanceof Date) {
          record[key] = Utilities.formatDate(value, 'Asia/Jakarta', 'yyyy-MM-dd');
        } else if (key === 'time' && value instanceof Date) {
          record[key] = Utilities.formatDate(value, 'Asia/Jakarta', 'HH:mm');
        } else if (key === 'time' && typeof value === 'number') {
          const minutes = Math.round(value * 24 * 60) % (24 * 60);
          const hours = Math.floor(minutes / 60);
          const remainder = minutes % 60;
          record[key] = ('0' + hours).slice(-2) + ':' + ('0' + remainder).slice(-2);
        } else if (key === 'date' && value) {
          record[key] = attendanceDate_(value);
        } else {
          record[key] = value instanceof Date ? value.toISOString() : value;
        }
      });
      return record;
    })
    .filter(record =>
      Object.keys(record).some(key => key !== '_row' && record[key] !== '')
    );
}

function ensureGenderColumns_() {
  const ss = spreadsheet_();
  [APP.SHEETS.STUDENTS, APP.SHEETS.ATTENDANCE].forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() === 0) return;
    const lastColumn = sh.getLastColumn();
    const headers = sh.getRange(1, 1, 1, lastColumn).getValues()[0].map(String);
    if (!headers.includes('gender')) sh.getRange(1, lastColumn + 1).setValue('gender');
  });
}

function normalizeGender_(value) {
  const normalized = String(value || '').trim().toUpperCase().replace(/[\s_-]+/g, ' ');
  if (['L', 'LAKI LAKI', 'PRIA'].includes(normalized)) return 'Laki-laki';
  if (['P', 'PEREMPUAN', 'WANITA'].includes(normalized)) return 'Perempuan';
  return '';
}

function ensureAutoAttendanceTrigger_() {
  const handler = 'autoCloseAttendanceForToday';
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === handler)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger(handler).timeBased().everyMinutes(1).create();
}

function autoCloseAttendanceForToday() {
  return closeAttendanceIfDue_();
}

function closeAttendanceIfDue_() {
  const endTime = '13:00';
  const date = today_();
  const cache = CacheService.getScriptCache();
  const cacheKey = 'attendance_closed_' + date;
  if (Utilities.formatDate(new Date(), 'Asia/Jakarta', 'HH:mm') < endTime || cache.get(cacheKey)) return 0;

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (cache.get(cacheKey)) return 0;
    const students = rows_(APP.SHEETS.STUDENTS).filter(student => String(student.active) !== 'false');
    const existing = new Set(attendanceRowsForRange_(date, date, true)
      .map(row => String(row.nisn)));
    const missing = students.filter(student => !existing.has(String(student.nisn)));
    const now = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'HH:mm');
    if (missing.length) {
      const sh = sheet_(APP.SHEETS.ATTENDANCE);
      sh.getRange(sh.getLastRow() + 1, 1, missing.length, 12).setValues(missing.map(student => [
        Utilities.getUuid(), date, String(student.nisn), student.name, student.grade,
        student.major, student.className, 'Tidak sholat', now, '', 'Sistem otomatis', student.gender || ''
      ]));
    }
    cache.put(cacheKey, '1', 21600);
    return missing.length;
  } finally {
    lock.releaseLock();
  }
}

function today_() {
  return Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
}
