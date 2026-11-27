'use strict';

/**
 * Backups ("dumps") of the event database and restore from them.
 *
 * Format: gzip-compressed JSON lines (*.xbk.gz). Works the same for
 * PostgreSQL and MongoDB and needs no external tools (pg_dump / mongodump).
 *
 *   {"kind":"header", format, version, databaseType, database, createdAt, trigger}
 *   PostgreSQL:  {"kind":"table", name, columns:[{name,type}], primaryKey:[...]}
 *                {"kind":"row", t, v:[...]}          values in PostgreSQL text form (lossless)
 *   MongoDB:     {"kind":"collection", name, indexes:[...]}
 *                {"kind":"doc", c, d}                 canonical Extended JSON (lossless)
 *   {"kind":"end", name, rows}                        after each table / collection
 *   {"kind":"footer", tables:{name:rows}, rows}      a file without a footer is incomplete
 *
 * PostgreSQL dumps are read inside one REPEATABLE READ transaction, so every
 * table comes from the same moment even while traffic keeps writing.
 *
 * Restore modes:
 *   merge    (default) add the backup's rows; rows that already exist (same
 *            primary / unique key) are kept as they are. Current data is never
 *            deleted or overwritten.
 *   replace  empty every table / collection in the backup, then load it:
 *            the database returns to exactly the backed-up state for those
 *            tables. Tables not in the backup are not touched.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const readline = require('readline');
const { pipeline } = require('stream/promises');
const { EJSON } = require('mongoose').mongo.BSON;
const { openPostgres, openMongo, describeTarget } = require('./connections');
const { migrateSchema } = require('./migration');

const FORMAT = 'xylium-backup';
const FORMAT_VERSION = 1;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.xbk\.gz$/;
const FETCH_ROWS = 2000;
const MONGO_BATCH = 1000;
const MAX_PARAMS = 30000;
const RAW_TEXT = { getTypeParser: () => (v) => v }; // every value in PostgreSQL text form

const q = (ident) => `"${String(ident).replace(/"/g, '""')}"`;

function backupDir() {
  const dir = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '../../backups'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function assertName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.includes('..')) {
    const err = new Error('Invalid backup name (expected letters, digits, . _ - ending in .xbk.gz)');
    err.status = 400;
    throw err;
  }
  return name;
}

const filePath = (name) => path.join(backupDir(), assertName(name));
const metaPath = (name) => `${filePath(name)}.json`;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function safePart(s) {
  return String(s || 'db').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
}

// ------------------------------------------------------------------ writing

/** Gzip line writer that respects back-pressure. */
function lineWriter(file) {
  const gzip = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(file);
  const hash = crypto.createHash('sha256');
  const done = pipeline(gzip, async function* (src) {
    for await (const chunk of src) {
      hash.update(chunk);
      yield chunk;
    }
  }, out);
  done.catch(() => {}); // observed via write()/close()
  return {
    async write(obj) {
      // Race with `done` so a failing disk/stream rejects instead of waiting for 'drain' forever.
      if (!gzip.write(`${JSON.stringify(obj)}\n`)) await Promise.race([new Promise((r) => gzip.once('drain', r)), done]);
    },
    async close() {
      gzip.end();
      await done;
      return hash.digest('hex');
    },
    destroy() {
      gzip.destroy();
      out.destroy();
    },
  };
}

async function dumpPostgres(pgConfig, w, ctx) {
  const pool = await openPostgres(pgConfig, { max: 1 });
  const client = await pool.connect();
  const counts = {};
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: tables } = await client.query(
      `SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`
    );
    for (const t of tables) {
      if (ctx.isCancelled()) throw new Error('Backup cancelled');
      const { rows: columns } = await client.query(
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
           FROM pg_attribute a WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
          ORDER BY a.attnum`,
        [t.oid]
      );
      const { rows: pk } = await client.query(
        `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = $1 AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`,
        [t.oid]
      );
      await w.write({ kind: 'table', name: t.relname, columns, primaryKey: pk.map((r) => r.attname) });

      let n = 0;
      if (columns.length) {
        const cursor = q(`xbk_${n}_${t.oid}`);
        await client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT ${columns.map((c) => q(c.name)).join(', ')} FROM ${q(t.relname)}`);
        for (;;) {
          const res = await client.query({ text: `FETCH ${FETCH_ROWS} FROM ${cursor}`, rowMode: 'array', types: RAW_TEXT });
          for (const v of res.rows) await w.write({ kind: 'row', t: t.relname, v });
          n += res.rows.length;
          if (res.rows.length < FETCH_ROWS) break;
          if (ctx.isCancelled()) throw new Error('Backup cancelled');
        }
        await client.query(`CLOSE ${cursor}`);
      }
      await w.write({ kind: 'end', name: t.relname, rows: n });
      counts[t.relname] = n;
      ctx.log(`  ${t.relname}: ${n} row(s)`);
    }
    await client.query('COMMIT');
    return counts;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

async function dumpMongo(mongoConfig, w, ctx) {
  const conn = await openMongo(mongoConfig);
  const counts = {};
  try {
    const list = await conn.db.listCollections({ type: 'collection' }, { nameOnly: true }).toArray();
    const names = list.map((c) => c.name).filter((n) => !n.startsWith('system.')).sort();
    for (const name of names) {
      if (ctx.isCancelled()) throw new Error('Backup cancelled');
      const coll = conn.db.collection(name);
      const indexes = (await coll.indexes()).filter((i) => i.name !== '_id_');
      await w.write({ kind: 'collection', name, indexes });
      let n = 0;
      for await (const doc of coll.find({}).sort({ _id: 1 })) {
        await w.write({ kind: 'doc', c: name, d: EJSON.serialize(doc, { relaxed: false }) });
        n++;
        if (n % 10000 === 0 && ctx.isCancelled()) throw new Error('Backup cancelled');
      }
      await w.write({ kind: 'end', name, rows: n });
      counts[name] = n;
      ctx.log(`  ${name}: ${n} document(s)`);
    }
    return counts;
  } finally {
    await conn.close().catch(() => {});
  }
}

function deleteBackupFiles(name) {
  for (const f of [filePath(name), metaPath(name)]) fs.rmSync(f, { force: true });
}

/** Delete backups older than `days` (by creation time). Returns the deleted names. */
function applyRetention(days, log) {
  if (!(days > 0)) return [];
  const cutoff = Date.now() - days * 86400000;
  const removed = [];
  for (const b of listBackups()) {
    if (b.uploaded || b.trigger === 'pre-restore') continue; // only prune what the schedule/manual runs produced
    if (new Date(b.createdAt).getTime() < cutoff) {
      deleteBackupFiles(b.name);
      removed.push(b.name);
    }
  }
  if (removed.length) log(`Retention (${days} days): deleted ${removed.length} old backup(s): ${removed.join(', ')}`);
  return removed;
}

/**
 * Write a backup of database `type` to BACKUP_DIR.
 * @returns {Promise<object>} the backup's metadata
 */
async function createBackup({ type, config, trigger = 'manual', retentionDays = 0, label = '' }, ctx) {
  const dbName = type === 'postgresql' ? config.postgresql.database : config.mongodb.database;
  const name = `xylium-${type === 'postgresql' ? 'pg' : 'mongo'}-${safePart(dbName)}-${stamp()}${label ? `-${safePart(label)}` : ''}.xbk.gz`;
  const final = filePath(name);
  const partial = `${final}.partial`;
  const header = { kind: 'header', format: FORMAT, version: FORMAT_VERSION, databaseType: type, database: dbName, createdAt: new Date().toISOString(), trigger };

  ctx.log(`Backup of ${describeTarget(type, config)} -> ${name}`);
  const t0 = Date.now();
  const w = lineWriter(partial);
  let sha256;
  let counts;
  try {
    await w.write(header);
    counts = type === 'postgresql' ? await dumpPostgres(config.postgresql, w, ctx) : await dumpMongo(config.mongodb, w, ctx);
    const rows = Object.values(counts).reduce((a, b) => a + b, 0);
    await w.write({ kind: 'footer', tables: counts, rows });
    sha256 = await w.close();
  } catch (err) {
    w.destroy();
    fs.rmSync(partial, { force: true });
    throw err;
  }
  fs.renameSync(partial, final);
  const meta = {
    name,
    databaseType: type,
    database: dbName,
    createdAt: header.createdAt,
    trigger,
    uploaded: false,
    tables: counts,
    rows: Object.values(counts).reduce((a, b) => a + b, 0),
    sizeBytes: fs.statSync(final).size,
    sha256,
    durationMs: Date.now() - t0,
  };
  fs.writeFileSync(metaPath(name), JSON.stringify(meta, null, 2));
  ctx.log(`Backup written: ${Object.keys(counts).length} table(s), ${meta.rows} row(s), ${(meta.sizeBytes / 1048576).toFixed(2)} MB in ${(meta.durationMs / 1000).toFixed(1)}s`);
  meta.retentionDeleted = applyRetention(retentionDays, ctx.log);
  return meta;
}

// ------------------------------------------------------------------ reading

/** Async iterator over the JSON lines of a backup file. */
async function* readLines(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new Error(`Backup file is damaged (line ${lineNo} is not valid JSON)`);
    }
    yield obj;
  }
}

/**
 * Read a whole backup file and check its structure (header, footer, row
 * counts). Used for uploaded files before they are accepted.
 */
async function inspectBackup(file) {
  let header = null;
  let footer = null;
  const counts = {};
  try {
    for await (const rec of readLines(file)) {
      if (!header) {
        if (rec.kind !== 'header' || rec.format !== FORMAT) throw new Error('Not a Xylium backup file (missing header)');
        if (rec.version > FORMAT_VERSION) throw new Error(`Backup format v${rec.version} is newer than this SDK supports (v${FORMAT_VERSION})`);
        if (!['postgresql', 'mongodb'].includes(rec.databaseType)) throw new Error('Backup has an unknown database type');
        header = rec;
        continue;
      }
      if (rec.kind === 'row' || rec.kind === 'doc') {
        const t = rec.t || rec.c;
        counts[t] = (counts[t] || 0) + 1;
      } else if (rec.kind === 'footer') {
        footer = rec;
      }
    }
  } catch (err) {
    if (err.code === 'Z_DATA_ERROR' || err.code === 'Z_BUF_ERROR' || /incorrect header check|unexpected end/i.test(err.message)) {
      throw new Error('Not a valid backup file (not gzip, or the file is truncated)');
    }
    throw err;
  }
  if (!header) throw new Error('Backup file is empty');
  if (!footer) throw new Error('Backup file is incomplete (no footer): the backup was interrupted or the file is truncated');
  for (const [t, n] of Object.entries(footer.tables || {})) {
    if ((counts[t] || 0) !== n) throw new Error(`Backup file is damaged: ${t} should have ${n} row(s), found ${counts[t] || 0}`);
  }
  return { header, footer, tables: footer.tables, rows: footer.rows };
}

function listBackups() {
  const dir = backupDir();
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!NAME_RE.test(f)) continue;
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, `${f}.json`), 'utf8'));
    } catch {
      const st = fs.statSync(path.join(dir, f));
      meta = { name: f, createdAt: st.mtime.toISOString(), sizeBytes: st.size, unverified: true };
    }
    meta.name = f;
    out.push(meta);
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function getBackupMeta(name) {
  const file = filePath(name);
  if (!fs.existsSync(file)) return null;
  return listBackups().find((b) => b.name === name) || null;
}

/**
 * Accept an uploaded backup: the stream is written to a temp file (with a
 * size limit and the sha256 the admin app announced), fully inspected, and
 * only then given its final name.
 */
async function saveUpload(name, stream, { expectedSha256, maxBytes }) {
  assertName(name);
  const final = filePath(name);
  if (fs.existsSync(final)) {
    const err = new Error(`A backup named ${name} already exists`);
    err.status = 409;
    throw err;
  }
  const partial = `${final}.upload`;
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    await pipeline(stream, async function* (src) {
      for await (const chunk of src) {
        size += chunk.length;
        if (size > maxBytes) {
          const err = new Error(`Upload is larger than the limit (${Math.round(maxBytes / 1048576)} MB)`);
          err.status = 413;
          throw err;
        }
        hash.update(chunk);
        yield chunk;
      }
    }, fs.createWriteStream(partial));
    const sha256 = hash.digest('hex');
    if (expectedSha256 && sha256 !== expectedSha256) {
      const err = new Error('Upload was corrupted in transit (checksum mismatch)');
      err.status = 400;
      throw err;
    }
    let info;
    try {
      info = await inspectBackup(partial);
    } catch (err) {
      err.status = 400;
      throw err;
    }
    fs.renameSync(partial, final);
    const meta = {
      name,
      databaseType: info.header.databaseType,
      database: info.header.database,
      createdAt: info.header.createdAt,
      trigger: info.header.trigger,
      uploaded: true,
      uploadedAt: new Date().toISOString(),
      tables: info.tables,
      rows: info.rows,
      sizeBytes: size,
      sha256,
    };
    fs.writeFileSync(metaPath(name), JSON.stringify(meta, null, 2));
    return meta;
  } finally {
    fs.rmSync(partial, { force: true });
  }
}

// ------------------------------------------------------------------ restore

/** Current shape of a PostgreSQL table, or null when it does not exist. */
async function pgTableInfo(db, table) {
  const { rows: rel } = await db.query(
    `SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind IN ('r', 'p')`,
    [table]
  );
  if (!rel[0]) return null;
  const oid = rel[0].oid;
  const { rows: cols } = await db.query(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attgenerated <> '' AS generated,
            a.attidentity <> '' OR COALESCE(pg_get_expr(d.adbin, d.adrelid), '') LIKE 'nextval(%' AS serial
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped`,
    [oid]
  );
  const { rows: idx } = await db.query(
    `SELECT i.indisprimary AS primary, array_agg(a.attname::text ORDER BY array_position(i.indkey, a.attnum)) AS cols
       FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1 AND (i.indisunique OR i.indisprimary) AND i.indpred IS NULL
      GROUP BY i.indexrelid, i.indisprimary`,
    [oid]
  );
  return { columns: new Map(cols.map((c) => [c.name, c])), uniqueKeys: idx };
}

/**
 * Prepare one table for loading: create it / add missing columns, decide
 * which columns to insert, empty it in replace mode.
 */
async function pgPrepareTable(db, spec, mode, log) {
  let info = await pgTableInfo(db, spec.name);
  if (!info) {
    const cols = spec.columns.map((c) => `${q(c.name)} ${c.type}`);
    if (spec.primaryKey && spec.primaryKey.length) cols.push(`PRIMARY KEY (${spec.primaryKey.map(q).join(', ')})`);
    await db.query(`CREATE TABLE ${q(spec.name)} (${cols.join(', ')})`);
    log(`  ${spec.name}: table did not exist, created from the backup`);
    info = await pgTableInfo(db, spec.name);
  } else {
    for (const c of spec.columns) {
      if (!info.columns.has(c.name)) {
        await db.query(`ALTER TABLE ${q(spec.name)} ADD COLUMN IF NOT EXISTS ${q(c.name)} ${c.type}`);
        log(`  ${spec.name}: added missing column ${c.name} ${c.type}`);
      }
    }
    info = await pgTableInfo(db, spec.name);
  }

  // Merge: a surrogate serial id (e.g. id BIGSERIAL) that is not the only
  // unique key is left to the database, so a backed-up row whose id was
  // reused by newer data is still restored; its natural unique key decides
  // whether it is already present.
  const skip = new Set();
  if (mode === 'merge') {
    const pk = info.uniqueKeys.find((k) => k.primary);
    const others = info.uniqueKeys.filter((k) => !k.primary);
    if (pk && pk.cols.length === 1 && info.columns.get(pk.cols[0])?.serial && others.length) skip.add(pk.cols[0]);
  }
  const indexes = [];
  const types = [];
  spec.columns.forEach((c, i) => {
    const target = info.columns.get(c.name);
    if (!target || target.generated || skip.has(c.name)) return;
    indexes.push(i);
    types.push({ name: c.name, type: target.type });
  });
  if (mode === 'replace') await db.query(`TRUNCATE TABLE ${q(spec.name)}`);
  const serialCols = [...info.columns.values()].filter((c) => c.serial && !skip.has(c.name) && types.some((t) => t.name === c.name)).map((c) => c.name);
  return { name: spec.name, indexes, types, serialCols, hasUniqueKey: info.uniqueKeys.length > 0, buffer: [], read: 0, inserted: 0 };
}

async function pgFlush(db, t) {
  if (!t.buffer.length || !t.types.length) {
    t.buffer = [];
    return;
  }
  const per = Math.max(1, Math.floor(MAX_PARAMS / t.types.length));
  for (let i = 0; i < t.buffer.length; i += per) {
    const chunk = t.buffer.slice(i, i + per);
    const params = [];
    const tuples = chunk.map((v) => `(${t.indexes.map((src, k) => {
      params.push(v[src] === undefined ? null : v[src]);
      return `$${params.length}::${t.types[k].type}`;
    }).join(', ')})`);
    const res = await db.query(
      `INSERT INTO ${q(t.name)} (${t.types.map((c) => q(c.name)).join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`,
      params
    );
    t.inserted += res.rowCount || 0;
  }
  t.buffer = [];
}

async function pgFinishTable(db, t, mode, log) {
  await pgFlush(db, t);
  for (const col of t.serialCols) {
    await db.query(
      `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${q(col)}) FROM ${q(t.name)}), 0) + 1, false)`,
      [`public.${q(t.name)}`, col]
    ).catch(() => {});
  }
  const kept = t.read - t.inserted;
  log(`  ${t.name}: ${t.read} in backup, restored ${t.inserted}` +
    (mode === 'merge' && kept ? `, ${kept} already present (kept as is)` : '') +
    (mode === 'merge' && !t.hasUniqueKey ? ' (table has no unique key: merge cannot detect duplicates here)' : ''));
}

async function restorePostgres(file, config, mode, ctx) {
  const { log } = ctx;
  log('Making sure every SDK table exists before loading');
  try {
    await migrateSchema('postgresql', config, () => {});
  } catch (err) {
    if (/duplicate/i.test(err.message)) log(`  note: ${err.message.split('\n')[0]}`);
    else throw err;
  }
  const pool = await openPostgres(config.postgresql, { max: 1 });
  const client = await pool.connect();
  const summary = {};
  try {
    await client.query('BEGIN');
    let current = null;
    let footer = null;
    for await (const rec of readLines(file)) {
      if (ctx.isCancelled()) throw new Error('Restore cancelled: nothing was changed');
      if (rec.kind === 'table') {
        current = await pgPrepareTable(client, rec, mode, log);
      } else if (rec.kind === 'row') {
        if (!current || current.name !== rec.t) throw new Error(`Backup file is damaged (row for ${rec.t} outside its table)`);
        current.buffer.push(rec.v);
        current.read++;
        if (current.buffer.length >= 1000) await pgFlush(client, current);
      } else if (rec.kind === 'end') {
        if (current) {
          await pgFinishTable(client, current, mode, log);
          summary[current.name] = { inBackup: current.read, restored: current.inserted };
        }
        current = null;
      } else if (rec.kind === 'footer') {
        footer = rec;
      }
    }
    if (!footer) throw new Error('Backup file is incomplete (no footer): nothing was changed');
    await client.query('COMMIT');
    return summary;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

async function mongoInsert(coll, docs) {
  if (!docs.length) return 0;
  try {
    const r = await coll.insertMany(docs, { ordered: false });
    return r.insertedCount;
  } catch (err) {
    const writeErrors = err.writeErrors ? [].concat(err.writeErrors) : [];
    const onlyDuplicates = writeErrors.length > 0 && writeErrors.every((e) => (e.code ?? (e.err && e.err.code)) === 11000);
    if (err.code === 11000 || onlyDuplicates) return err.insertedCount ?? (err.result && err.result.insertedCount) ?? 0;
    throw err;
  }
}

async function restoreMongo(file, config, mode, ctx) {
  const { log } = ctx;
  log('Making sure every SDK collection and index exists before loading');
  await migrateSchema('mongodb', config, () => {});
  const conn = await openMongo(config.mongodb);
  const summary = {};
  try {
    let current = null;
    let footer = null;
    const flush = async () => {
      current.inserted += await mongoInsert(current.coll, current.buffer);
      current.buffer = [];
    };
    for await (const rec of readLines(file)) {
      if (ctx.isCancelled()) throw new Error('Restore cancelled part-way: collections already loaded keep the restored data');
      if (rec.kind === 'collection') {
        current = { name: rec.name, coll: conn.db.collection(rec.name), indexes: rec.indexes || [], buffer: [], read: 0, inserted: 0 };
        if (mode === 'replace') await current.coll.deleteMany({});
      } else if (rec.kind === 'doc') {
        if (!current || current.name !== rec.c) throw new Error(`Backup file is damaged (document for ${rec.c} outside its collection)`);
        current.buffer.push(EJSON.deserialize(rec.d, { relaxed: false }));
        current.read++;
        if (current.buffer.length >= MONGO_BATCH) await flush();
      } else if (rec.kind === 'end') {
        await flush();
        for (const ix of current.indexes) {
          const { key, name, v, ns, ...options } = ix; // eslint-disable-line no-unused-vars
          await current.coll.createIndex(key, { name, ...options }).catch((e) => log(`  ${current.name}: index ${name} not recreated (${e.message})`));
        }
        const kept = current.read - current.inserted;
        log(`  ${current.name}: ${current.read} in backup, restored ${current.inserted}${mode === 'merge' && kept ? `, ${kept} already present (kept as is)` : ''}`);
        summary[current.name] = { inBackup: current.read, restored: current.inserted };
        current = null;
      } else if (rec.kind === 'footer') {
        footer = rec;
      }
    }
    if (!footer) throw new Error('Backup file is incomplete (no footer); collections loaded so far keep the restored data');
    return summary;
  } finally {
    await conn.close().catch(() => {});
  }
}

/**
 * Restore backup `name` into database `type`.
 * Replace mode first takes a safety backup of the current data ("pre-restore").
 */
async function restoreBackup({ name, type, config, mode = 'merge', safetyBackup = true }, ctx) {
  const file = filePath(name);
  if (!fs.existsSync(file)) {
    const err = new Error(`Backup ${name} not found`);
    err.status = 404;
    throw err;
  }
  if (!['merge', 'replace'].includes(mode)) throw Object.assign(new Error('mode must be merge or replace'), { status: 400 });

  ctx.log(`Checking ${name}`);
  const info = await inspectBackup(file);
  if (info.header.databaseType !== type) {
    throw Object.assign(new Error(
      `This backup is from ${info.header.databaseType}, but the selected database is ${type}. ` +
      'Restore it into the same kind of database (or switch the active database first).'
    ), { status: 400 });
  }
  ctx.log(`Backup of ${info.header.database} taken ${info.header.createdAt}: ${Object.keys(info.tables).length} table(s), ${info.rows} row(s)`);

  let safety = null;
  if (mode === 'replace' && safetyBackup) {
    ctx.log('Replace mode: taking a safety backup of the current data first');
    safety = await createBackup({ type, config, trigger: 'pre-restore', label: 'pre-restore' }, ctx);
  }

  ctx.log(`Restoring into ${describeTarget(type, config)} (${mode === 'merge' ? 'merge: existing rows are kept' : 'replace: backed-up tables are emptied first'})`);
  const t0 = Date.now();
  const tables = type === 'postgresql' ? await restorePostgres(file, config, mode, ctx) : await restoreMongo(file, config, mode, ctx);
  const restored = Object.values(tables).reduce((n, t) => n + t.restored, 0);
  ctx.log(`Restore complete: ${restored} row(s) restored in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { backup: name, mode, tables, restored, safetyBackup: safety && safety.name };
}

module.exports = {
  backupDir, assertName, filePath, listBackups, getBackupMeta, createBackup, saveUpload, inspectBackup,
  restoreBackup, deleteBackupFiles, applyRetention, NAME_RE,
};
