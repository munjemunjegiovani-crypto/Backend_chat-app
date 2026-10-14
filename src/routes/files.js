import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import { one } from '../db.js';
import { ah, requireAuth, HttpError } from '../auth.js';

const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 15);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024 } });
const router = Router();

router.post('/', requireAuth, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      return next(new HttpError(413, err.code === 'LIMIT_FILE_SIZE' ? `Files must be smaller than ${MAX_MB} MB.` : 'Upload failed.'));
    }
    next();
  });
}, ah(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'No file received.');
  const id = crypto.randomUUID();
  const name = (req.body?.name || req.file.originalname || 'file').slice(0, 200);
  const mime = req.file.mimetype || 'application/octet-stream';
  await one(
    'INSERT INTO files (id, owner_id, name, mime, size, data) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [id, req.userId, name, mime, req.file.size, req.file.buffer]
  );
  res.status(201).json({ id, name, mime, size: req.file.size });
}));

// Public read by unguessable id so <img>/<video> tags can load it.
router.get('/:id', ah(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'Not found');
  const f = await one('SELECT name, mime, size, data FROM files WHERE id = $1', [req.params.id]);
  if (!f) throw new HttpError(404, 'Not found');
  const buf = f.data;
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.query.download) {
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(f.name)}"`);
  }
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : buf.length - 1;
    if (!m || m[1] === '' && m[2]) { start = buf.length - parseInt(m[2], 10); end = buf.length - 1; }
    if (start >= buf.length || start > end) {
      res.setHeader('Content-Range', `bytes */${buf.length}`);
      return res.status(416).end();
    }
    end = Math.min(end, buf.length - 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${buf.length}`);
    res.setHeader('Content-Length', end - start + 1);
    return res.end(buf.subarray(start, end + 1));
  }
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
}));

export default router;
