import { useEffect, useState } from 'react';

export type Attachment = { id: string; name: string; size: number; mime: string; kind: 'image' | 'video' | 'document'; uploadedAt: string };

type UploadTask = { key: string; file: File; progress: number; status: 'uploading' | 'error'; error?: string };

const kindLabel: Record<Attachment['kind'], string> = { image: '照片', video: '视频', document: '文档' };

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function errorMessage(res: Response, fallback: string) {
  try {
    const body = await res.json();
    return body?.error || fallback;
  } catch {
    return fallback;
  }
}

export function AttachmentPanel({ resource, recordId }: { resource: string; recordId: string }) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [tasks, setTasks] = useState<UploadTask[]>([]);

  async function load() {
    try {
      const res = await fetch(`/api/${resource}/${recordId}/attachments`);
      if (!res.ok) throw new Error(await errorMessage(res, '附件加载失败'));
      setItems(await res.json());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '附件加载失败');
    } finally {
      setLoaded(true);
    }
  }
  useEffect(() => {
    setLoaded(false);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId]);

  function updateTask(key: string, patch: Partial<UploadTask>) {
    setTasks((list) => list.map((t) => (t.key === key ? { ...t, ...patch } : t)));
  }

  // 用 XHR 才能拿到上传进度；文件本体走二进制请求体，不进任何 JSON 字段
  function upload(task: UploadTask) {
    updateTask(task.key, { status: 'uploading', progress: 0, error: undefined });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/${resource}/${recordId}/attachments?filename=${encodeURIComponent(task.file.name)}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) updateTask(task.key, { progress: Math.round((e.loaded / e.total) * 100) });
    };
    xhr.onload = () => {
      if (xhr.status === 201) {
        setTasks((list) => list.filter((t) => t.key !== task.key));
        load();
        return;
      }
      let message = `上传失败（${xhr.status}）`;
      try {
        message = JSON.parse(xhr.responseText).error || message;
      } catch {
        // 非 JSON 响应，保留默认提示
      }
      updateTask(task.key, { status: 'error', error: message });
    };
    xhr.onerror = () => updateTask(task.key, { status: 'error', error: '网络错误，上传中断' });
    xhr.send(task.file);
  }

  function pick(files: FileList | null) {
    if (!files || files.length === 0) return;
    const next: UploadTask[] = Array.from(files).map((file) => ({
      key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      progress: 0,
      status: 'uploading',
    }));
    setTasks((list) => [...list, ...next]);
    next.forEach(upload);
  }

  async function remove(id: string) {
    try {
      const res = await fetch(`/api/${resource}/${recordId}/attachments/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await errorMessage(res, '删除失败'));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  }

  return (
    <div className="attachments">
      <div className="attachments-head">
        <b>附件（{items.length}）</b>
        <label className="upload-btn">
          上传附件
          <input
            type="file"
            multiple
            hidden
            accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.md"
            onChange={(e) => {
              pick(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
      </div>
      <p className="muted">支持树木照片、现场视频和巡检文档，单个文件不超过 50MB，每条记录最多 10 个。</p>
      {error && <div className="notice error">{error}</div>}
      {tasks.map((t) => (
        <div className="upload-task" key={t.key}>
          <span className="file-name">{t.file.name}</span>
          {t.status === 'uploading' ? (
            <>
              <div className="progress">
                <i style={{ width: `${t.progress}%` }} />
              </div>
              <span className="muted">{t.progress}%</span>
            </>
          ) : (
            <>
              <span className="upload-error">{t.error}</span>
              <button className="action" onClick={() => upload(t)}>
                重试
              </button>
              <button className="action danger" onClick={() => setTasks((list) => list.filter((x) => x.key !== t.key))}>
                移除
              </button>
            </>
          )}
      </div>
      ))}
      {!loaded ? (
        <p className="muted">正在加载附件...</p>
      ) : items.length === 0 ? (
        <p className="muted">暂无附件</p>
      ) : (
        <ul className="attachment-list">
          {items.map((a) => (
            <li key={a.id}>
              <span className={`tag ${a.kind}`}>{kindLabel[a.kind]}</span>
              <span className="file-name">{a.name}</span>
              <span className="muted">{formatSize(a.size)}</span>
              <span className="muted">{new Date(a.uploadedAt).toLocaleString()}</span>
              <a className="action" href={`/api/${resource}/${recordId}/attachments/${a.id}/download`} download={a.name}>
                下载
              </a>
              <button className="action danger" onClick={() => remove(a.id)}>
                删除
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
