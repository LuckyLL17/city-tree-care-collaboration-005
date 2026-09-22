import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, unlink, rename, readdir, access } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Transform, type TransformCallback } from 'node:stream';

type Item = { id: string; createdAt: string; [key: string]: string };
type Attachment = { id: string; filename: string; storedName: string; size: number; mime: string; uploadedAt: string };

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const PORT = Number(process.env.PORT || 4001);
const allowed = ['trees', 'reports', 'inspections'];
const attachable = ['reports', 'inspections'];
const states = ['待派单', '待执行', '处理中', '已完成'];
const seed = {
  trees: [
    { species: '香樟', location: '青松路18号', health: '良好', lastInspection: '2026-09-10' },
    { species: '银杏', location: '滨河公园东门', health: '需关注', lastInspection: '2026-09-12' },
  ],
  reports: [{ tree: '银杏', reporter: '周宁', issue: '树冠部分枝条枯黄', status: '待派单' }],
  inspections: [{ tree: '香樟', inspector: '养护一组', date: '2026-09-23', status: '待执行' }],
} as Record<string, Record<string, string>[]>;
const data: Record<string, Item[]> = Object.fromEntries(
  allowed.map(key => [key, (seed[key] || []).map(item => ({ ...item, id: randomUUID(), createdAt: new Date().toISOString() }))]),
);

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const uploadDir = join(root, 'uploads');
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 9;
const allowedTypes: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const attachments: Record<string, Record<string, Attachment[]>> = Object.fromEntries(
  attachable.map(key => [key, {}]),
) as Record<string, Record<string, Attachment[]>>;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
function sanitizeFilename(name: string) {
  return name.replace(/[\\/]/g, '_').replace(/[\r\n"]/g, '').trim();
}
function attachmentList(resource: string, recordId: string) {
  return attachments[resource]?.[recordId] ?? [];
}
async function saveUpload(req: IncomingMessage, tmpPath: string) {
  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding: string, callback: TransformCallback) {
      received += chunk.length;
      if (received > MAX_FILE_SIZE) {
        callback(new HttpError(413, `文件超出大小限制（最大 ${MAX_FILE_SIZE / 1024 / 1024}MB）`));
      } else {
        callback(null, chunk);
      }
    },
  });
  try {
    await pipeline(req, counter, createWriteStream(tmpPath));
  } catch (error) {
    // 上传中断、超限或写盘失败时删除临时文件，避免残留
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
  return received;
}
async function removeAttachmentFiles(resource: string, recordId: string) {
  const list = attachmentList(resource, recordId);
  if (attachments[resource]) delete attachments[resource][recordId];
  await Promise.all(list.map(att => unlink(join(uploadDir, att.storedName)).catch(() => {})));
}

async function handleAttachments(req: IncomingMessage, res: ServerResponse, resource: string, p: string[], url: URL) {
  if (!attachable.includes(resource)) throw new HttpError(400, '该模块不支持附件');
  const recordId = p[2];
  if (!data[resource].some(x => x.id === recordId)) throw new HttpError(404, '记录不存在');

  // POST /api/:resource/:id/attachments?filename=原始文件名（请求体为文件二进制）
  if (req.method === 'POST' && p.length === 4) {
    const rawName = url.searchParams.get('filename') || '';
    if (!rawName) throw new HttpError(400, '缺少文件名（filename 查询参数）');
    if (attachmentList(resource, recordId).length >= MAX_ATTACHMENTS) {
      throw new HttpError(400, `单条记录最多上传 ${MAX_ATTACHMENTS} 个附件`);
    }
    const filename = sanitizeFilename(rawName);
    const ext = extname(filename).toLowerCase();
    if (!allowedTypes[ext]) throw new HttpError(415, `不支持的文件类型，仅支持：${Object.keys(allowedTypes).join(' ')}`);
    if (Number(req.headers['content-length'] || 0) > MAX_FILE_SIZE) {
      throw new HttpError(413, `文件超出大小限制（最大 ${MAX_FILE_SIZE / 1024 / 1024}MB）`);
    }
    const id = randomUUID();
    const storedName = `${id}${ext}`;
    const tmpPath = join(uploadDir, `.tmp-${id}`);
    const size = await saveUpload(req, tmpPath);
    await rename(tmpPath, join(uploadDir, storedName));
    const declaredMime = String(req.headers['content-type'] || '');
    const att: Attachment = {
      id,
      filename,
      storedName,
      size,
      mime: declaredMime && declaredMime !== 'application/octet-stream' ? declaredMime : allowedTypes[ext],
      uploadedAt: new Date().toISOString(),
    };
    (attachments[resource][recordId] ??= []).push(att);
    const { storedName: _storedName, ...meta } = att;
    return json(res, 201, meta);
  }

  // GET /api/:resource/:id/attachments —— 附件元数据列表（不含磁盘内部名）
  if (req.method === 'GET' && p.length === 4) {
    return json(res, 200, attachmentList(resource, recordId).map(({ storedName, ...meta }) => meta));
  }

  const att = attachmentList(resource, recordId).find(x => x.id === p[4]);
  if (!att) throw new HttpError(404, '附件不存在');

  // GET /api/:resource/:id/attachments/:attachmentId/download
  if (req.method === 'GET' && p.length === 6 && p[5] === 'download') {
    const filePath = join(uploadDir, att.storedName);
    try {
      await access(filePath);
    } catch {
      throw new HttpError(404, '附件文件不存在或已被清理');
    }
    res.writeHead(200, {
      'Content-Type': att.mime || 'application/octet-stream',
      'Content-Length': att.size,
      'Content-Disposition': `attachment; filename="attachment${extname(att.storedName)}"; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
      'Access-Control-Allow-Origin': '*',
    });
    createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
    return;
  }

  // DELETE /api/:resource/:id/attachments/:attachmentId
  if (req.method === 'DELETE' && p.length === 5) {
    attachments[resource][recordId] = attachmentList(resource, recordId).filter(x => x.id !== att.id);
    await unlink(join(uploadDir, att.storedName)).catch(() => {});
    return json(res, 200, { ok: true });
  }

  throw new HttpError(405, '不支持的操作');
}

await mkdir(uploadDir, { recursive: true });
for (const file of await readdir(uploadDir)) {
  // 清理上次运行遗留的未完成上传临时文件
  if (file.startsWith('.tmp-')) await unlink(join(uploadDir, file)).catch(() => {});
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const p = url.pathname.split('/').filter(Boolean);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      });
      return res.end();
    }
    if (req.method === 'GET' && p[0] === 'api' && p[1] === 'health') {
      return json(res, 200, { status: 'ok', project: 'city-tree-care-collaboration', workflow: '建立树木档案 → 安排巡检 → 记录异常 → 派发养护 → 完成复核' });
    }
    if (p[0] !== 'api') {
      if (req.method === 'GET') {
        const html = await readFile(join(root, 'index.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      return json(res, 404, { error: 'Not found' });
    }
    const resource = p[1];
    if (!resource || !allowed.includes(resource)) return json(res, 404, { error: '未知业务模块' });
    if (req.method === 'GET' && p.length === 2) return json(res, 200, data[resource]);
    if (req.method === 'POST' && p.length === 2) {
      const item = { ...(await body(req)), id: randomUUID(), createdAt: new Date().toISOString() } as Item;
      data[resource].push(item);
      return json(res, 201, item);
    }
    if (p[3] === 'attachments') return await handleAttachments(req, res, resource, p, url);
    const item = data[resource].find(x => x.id === p[2]);
    if (!item) return json(res, 404, { error: '记录不存在' });
    if (req.method === 'POST' && p[3] === 'transition') {
      const next = (await body(req)).status;
      if (!states.includes(next)) return json(res, 400, { error: '不支持的状态' });
      item.status = next;
      return json(res, 200, item);
    }
    if (req.method === 'PATCH' && p.length === 3) {
      Object.assign(item, await body(req));
      return json(res, 200, item);
    }
    if (req.method === 'DELETE' && p.length === 3) {
      data[resource] = data[resource].filter(x => x.id !== item.id);
      await removeAttachmentFiles(resource, item.id);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: '不支持的操作' });
  } catch (error) {
    // 客户端中断上传时响应已销毁，无需再写错误
    if (res.destroyed || res.writableEnded) return;
    const status = error instanceof HttpError ? error.status : 500;
    return json(res, status, { error: error instanceof Error ? error.message : '服务器错误' });
  }
});
server.listen(PORT, () => console.log(`API server running at http://localhost:${PORT}`));
