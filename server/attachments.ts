import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

// 附件只挂在异常反馈和巡检记录上
export const ATTACHABLE_RESOURCES = ['reports', 'inspections'];

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 单个文件最大 50MB
const MAX_FILES_PER_RECORD = 10;
const MAX_FILE_SIZE_LABEL = `${MAX_FILE_SIZE / 1024 / 1024}MB`;

type AttachmentKind = 'image' | 'video' | 'document';

// 树木照片、现场视频、巡检文档三类，按扩展名白名单校验
const FILE_TYPES: Record<string, { mime: string; kind: AttachmentKind }> = {
  '.jpg': { mime: 'image/jpeg', kind: 'image' },
  '.jpeg': { mime: 'image/jpeg', kind: 'image' },
  '.png': { mime: 'image/png', kind: 'image' },
  '.gif': { mime: 'image/gif', kind: 'image' },
  '.webp': { mime: 'image/webp', kind: 'image' },
  '.mp4': { mime: 'video/mp4', kind: 'video' },
  '.mov': { mime: 'video/quicktime', kind: 'video' },
  '.webm': { mime: 'video/webm', kind: 'video' },
  '.pdf': { mime: 'application/pdf', kind: 'document' },
  '.doc': { mime: 'application/msword', kind: 'document' },
  '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'document' },
  '.xls': { mime: 'application/vnd.ms-excel', kind: 'document' },
  '.xlsx': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'document' },
  '.txt': { mime: 'text/plain', kind: 'document' },
  '.md': { mime: 'text/markdown', kind: 'document' },
};

export interface AttachmentMeta {
  id: string;
  name: string;
  size: number;
  mime: string;
  kind: AttachmentKind;
  uploadedAt: string;
}

type StoredAttachment = AttachmentMeta & { path: string };

// 元数据独立存放，不写进业务记录的 JSON 字段；没有附件的旧记录在这里没有条目
const store = new Map<string, StoredAttachment[]>();

let uploadsRoot = '';

function key(resource: string, recordId: string) {
  return `${resource}:${recordId}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

// 业务数据目前全在内存里，重启后记录本身也会丢失，磁盘上的旧文件没有属主，直接清掉
export async function initUploads(root: string) {
  uploadsRoot = join(root, 'uploads');
  await rm(uploadsRoot, { recursive: true, force: true });
  await mkdir(uploadsRoot, { recursive: true });
}

function sanitizeFilename(name: string) {
  const cleaned = name.replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/^\.+/, '').trim();
  return cleaned.slice(0, 120);
}

export function listAttachments(res: ServerResponse, resource: string, recordId: string) {
  const items = (store.get(key(resource, recordId)) || []).map(({ path: _path, ...meta }) => meta);
  sendJson(res, 200, items);
}

export async function handleUpload(req: IncomingMessage, res: ServerResponse, resource: string, recordId: string) {
  const url = new URL(req.url || '/', 'http://localhost');
  const name = sanitizeFilename(url.searchParams.get('filename') || '');
  if (!name) return sendJson(res, 400, { error: '缺少有效的文件名' });
  const ext = extname(name).toLowerCase();
  const type = FILE_TYPES[ext];
  if (!type) return sendJson(res, 415, { error: `不支持的文件类型 ${ext || '(无扩展名)'}，仅支持树木照片、现场视频或巡检文档` });
  const storeKey = key(resource, recordId);
  const existing = store.get(storeKey) || [];
  if (existing.length >= MAX_FILES_PER_RECORD) return sendJson(res, 409, { error: `每条记录最多 ${MAX_FILES_PER_RECORD} 个附件` });
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_FILE_SIZE) return sendJson(res, 413, { error: `文件超过 ${MAX_FILE_SIZE_LABEL} 大小限制` });

  const id = randomUUID();
  const dir = join(uploadsRoot, resource, recordId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id}${ext}`);

  // 声明长度可信时上面已拦截；chunked 传输则在这里按实际字节数拦截
  let received = 0;
  let tooBig = false;
  req.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > MAX_FILE_SIZE && !tooBig) {
      tooBig = true;
      sendJson(res, 413, { error: `文件超过 ${MAX_FILE_SIZE_LABEL} 大小限制` });
      req.destroy();
    }
  });

  try {
    await pipeline(req, createWriteStream(path));
  } catch {
    // 客户端中断、网络错误或超限都会走到这里，删掉半成品文件，不落元数据
    await unlink(path).catch(() => {});
    if (!res.writableEnded) sendJson(res, 400, { error: '上传中断，请重试' });
    return;
  }
  if (tooBig) {
    await unlink(path).catch(() => {});
    return;
  }
  if (received === 0) {
    await unlink(path).catch(() => {});
    return sendJson(res, 400, { error: '文件内容为空' });
  }

  const meta: StoredAttachment = { id, name, size: received, mime: type.mime, kind: type.kind, uploadedAt: new Date().toISOString(), path };
  store.set(storeKey, [...existing, meta]);
  const { path: _path, ...body } = meta;
  sendJson(res, 201, body);
}

export async function handleDownload(res: ServerResponse, resource: string, recordId: string, attachmentId: string) {
  const meta = (store.get(key(resource, recordId)) || []).find((x) => x.id === attachmentId);
  if (!meta) return sendJson(res, 404, { error: '附件不存在' });
  const info = await stat(meta.path).catch(() => null);
  if (!info) return sendJson(res, 404, { error: '附件文件已丢失，请重新上传' });
  res.writeHead(200, {
    'Content-Type': meta.mime,
    'Content-Length': info.size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
    'Access-Control-Allow-Origin': '*',
  });
  await pipeline(createReadStream(meta.path), res).catch(() => {});
}

export async function handleDelete(res: ServerResponse, resource: string, recordId: string, attachmentId: string) {
  const storeKey = key(resource, recordId);
  const items = store.get(storeKey) || [];
  const meta = items.find((x) => x.id === attachmentId);
  if (!meta) return sendJson(res, 404, { error: '附件不存在' });
  store.set(storeKey, items.filter((x) => x.id !== attachmentId));
  await unlink(meta.path).catch(() => {});
  sendJson(res, 200, { ok: true });
}

// 删除业务记录时连带清理它的附件文件
export async function removeAttachmentsForRecord(resource: string, recordId: string) {
  store.delete(key(resource, recordId));
  await rm(join(uploadsRoot, resource, recordId), { recursive: true, force: true }).catch(() => {});
}
