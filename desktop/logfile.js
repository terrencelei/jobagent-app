'use strict';
// Append-only log file with size-based rotation (engine.log -> engine.1.log ...).
const fs = require('fs');
const path = require('path');

class RotatingLog {
  constructor(file, { maxBytes = 5 * 1024 * 1024, keep = 2 } = {}) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.keep = keep;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { this.size = fs.statSync(file).size; } catch { this.size = 0; }
  }

  rotate() {
    const ext = path.extname(this.file);
    const base = this.file.slice(0, this.file.length - ext.length);
    const name = (i) => `${base}.${i}${ext}`;
    try { fs.rmSync(name(this.keep), { force: true }); } catch { /* ignore */ }
    for (let i = this.keep - 1; i >= 1; i--) {
      if (fs.existsSync(name(i))) fs.renameSync(name(i), name(i + 1));
    }
    if (fs.existsSync(this.file)) fs.renameSync(this.file, name(1));
    this.size = 0;
  }

  write(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (this.size > 0 && this.size + buf.length > this.maxBytes) this.rotate();
    try {
      fs.appendFileSync(this.file, buf);
      this.size += buf.length;
    } catch { /* logging must never crash the app */ }
  }

  line(text) {
    this.write(`[${new Date().toISOString()}] ${text}\n`);
  }
}

module.exports = { RotatingLog };
