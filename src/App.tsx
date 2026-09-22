import { Fragment, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import './styles.css';

type Item = { id: string; createdAt: string; [key: string]: string };
type Resource = { key: string; label: string; fields: string[] };
type Attachment = { id: string; filename: string; size: number; mime: string; uploadedAt: string };
type UploadTask = { key: string; file: File; progress: number; error: string };
const config = {"name": "城市公共树木养护协作系统", "description": "用于维护城市公共树木档案、巡检任务和居民异常反馈的基础协作系统。", "flow": "建立树木档案 → 安排巡检 → 记录异常 → 派发养护 → 完成复核", "resources": [{"key": "trees", "label": "树木档案", "fields": ["species", "location", "health", "lastInspection"]}, {"key": "reports", "label": "异常反馈", "fields": ["tree", "reporter", "issue", "status"]}, {"key": "inspections", "label": "巡检任务", "fields": ["tree", "inspector", "date", "status"]}], "states": ["待派单", "待执行", "处理中", "已完成"], "labels": {"name": "名称", "title": "标题", "category": "分类", "location": "位置", "status": "状态", "equipment": "设备", "member": "成员", "date": "日期", "slot": "时段", "issue": "问题", "assignee": "负责人", "species": "树种", "health": "健康状况", "lastInspection": "最近巡检", "tree": "树木", "reporter": "反馈人", "inspector": "巡检人", "activity": "活动", "checkpoint": "检查点", "route": "路线", "capacity": "人数上限", "phone": "联系方式", "project": "项目", "author": "作者", "editor": "编辑", "version": "版本", "wordCount": "字数", "owner": "负责人", "dueDate": "截止日期", "venue": "场地", "openingDate": "开幕日期", "collectionNo": "藏品编号", "condition": "保存状况", "serialNo": "序列号", "borrower": "借用人", "gear": "器材", "returnDate": "归还日期", "description": "描述", "ageGroup": "年龄段", "duration": "时长", "lesson": "课程", "instructor": "讲师", "type": "类型", "customer": "客户", "product": "产品", "priority": "优先级", "order": "订单", "stepName": "工序名称", "workstation": "工作台", "result": "结果"}} as { name:string; description:string; flow:string; resources:Resource[]; states:string[]; labels:Record<string,string> };

const attachable = ['reports', 'inspections'];
const acceptTypes = '.jpg,.jpeg,.png,.webp,.gif,.mp4,.mov,.pdf,.txt,.md,.doc,.docx,.xls,.xlsx';

async function api(path: string, options?: RequestInit) {
  const res = await fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function uploadAttachment(resource: string, itemId: string, file: File, onProgress: (percent: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/${resource}/${itemId}/attachments?filename=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      try {
        reject(new Error(JSON.parse(xhr.responseText).error || `上传失败（${xhr.status}）`));
      } catch {
        reject(new Error(`上传失败（${xhr.status}）`));
      }
    };
    xhr.onerror = () => reject(new Error('网络错误，上传失败'));
    xhr.onabort = () => reject(new Error('上传已中断'));
    xhr.send(file);
  });
}

function AttachmentPanel({ resource, itemId }: { resource: string; itemId: string }) {
  const [list, setList] = useState<Attachment[] | null>(null);
  const [uploads, setUploads] = useState<UploadTask[]>([]);
  const [error, setError] = useState('');

  async function refresh() {
    try {
      setList(await api(`/${resource}/${itemId}/attachments`));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '附件加载失败');
    }
  }
  useEffect(() => {
    refresh();
  }, [resource, itemId]);

  function run(task: UploadTask) {
    setUploads(us => us.map(u => (u.key === task.key ? { ...u, progress: 0, error: '' } : u)));
    uploadAttachment(resource, itemId, task.file, percent => {
      setUploads(us => us.map(u => (u.key === task.key ? { ...u, progress: percent } : u)));
    })
      .then(async () => {
        await refresh();
        setUploads(us => us.filter(u => u.key !== task.key));
      })
      .catch(e => {
        setUploads(us => us.map(u => (u.key === task.key ? { ...u, error: e instanceof Error ? e.message : '上传失败' } : u)));
      });
  }

  function pick(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    for (const file of files) {
      const task: UploadTask = { key: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file, progress: 0, error: '' };
      setUploads(us => [...us, task]);
      run(task);
    }
  }

  async function remove(att: Attachment) {
    try {
      await api(`/${resource}/${itemId}/attachments/${att.id}`, { method: 'DELETE' });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '附件删除失败');
    }
  }

  return (
    <div className="attachments">
      <div className="panel-title">
        <h4>附件（{list?.length ?? 0}）</h4>
        <label className="upload-btn">
          上传附件
          <input type="file" multiple accept={acceptTypes} hidden onChange={pick} />
        </label>
      </div>
      <p className="muted">支持树木照片、现场视频和巡检文档（{acceptTypes}），单个文件不超过 10MB，单条记录最多 9 个。</p>
      {error && <div className="notice">{error}</div>}
      {uploads.map(u => (
        <div className="upload" key={u.key}>
          <span className="file-name" title={u.file.name}>{u.file.name}</span>
          {u.error ? (
            <>
              <span className="upload-error">{u.error}</span>
              <button className="action" onClick={() => run(u)}>重试</button>
              <button className="action" onClick={() => setUploads(us => us.filter(x => x.key !== u.key))}>移除</button>
            </>
          ) : (
            <>
              <div className="progress"><div className="bar" style={{ width: `${u.progress}%` }} /></div>
              <span className="muted">{u.progress}%</span>
            </>
          )}
        </div>
      ))}
      {list === null ? (
        <p className="muted">正在加载附件...</p>
      ) : list.length === 0 ? (
        <p className="muted">暂无附件</p>
      ) : (
        <table>
          <thead>
            <tr><th>名称</th><th>大小</th><th>上传时间</th><th>操作</th></tr>
          </thead>
          <tbody>
            {list.map(att => (
              <tr key={att.id}>
                <td>{att.filename}</td>
                <td>{formatSize(att.size)}</td>
                <td>{new Date(att.uploadedAt).toLocaleString()}</td>
                <td>
                  <a className="action" href={`/api/${resource}/${itemId}/attachments/${att.id}/download`} download={att.filename}>下载</a>
                  <button className="action danger" onClick={() => remove(att)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function App() {
  const [active, setActive] = useState(config.resources[0].key);
  const [rows, setRows] = useState<Record<string, Item[]>>({});
  const [form, setForm] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState('');
  const current = config.resources.find((x) => x.key === active)!;
  const canAttach = attachable.includes(active);

  async function load() {
    setLoading(true);
    try {
      const entries = await Promise.all(config.resources.map(async (r) => [r.key, await api(`/${r.key}`)] as const));
      setRows(Object.fromEntries(entries));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  function label(field: string) { return config.labels[field] || field; }

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/${active}`, { method: 'POST', body: JSON.stringify({ ...form, status: form.status || config.states[0] }) });
      setForm({});
      setNotice('记录已创建');
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '创建失败');
    }
  }

  async function transition(item: Item) {
    const i = config.states.indexOf(item.status);
    const next = config.states[Math.min(i + 1, config.states.length - 1)];
    if (!next || next === item.status) return;
    try {
      await api(`/${active}/${item.id}/transition`, { method: 'POST', body: JSON.stringify({ status: next }) });
      setNotice(`状态已更新为：${next}`);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '状态更新失败');
    }
  }

  return (
    <div className="app">
      <header>
        <div>
          <span className="eyebrow">NODE.JS · TYPESCRIPT · VITE · REACT</span>
          <h1>{config.name}</h1>
          <p>{config.description}</p>
        </div>
        <span className="badge">基础流程演示</span>
      </header>
      <div className="layout">
        <aside>
          <h2>业务模块</h2>
          {config.resources.map(r => (
            <button className={r.key === active ? 'nav active' : 'nav'} onClick={() => { setActive(r.key); setForm({}); setExpanded(''); }} key={r.key}>{r.label}</button>
          ))}
          <div className="flow"><b>推荐流程</b><p>{config.flow}</p></div>
        </aside>
        <main>
          <div className="heading">
            <div><span className="eyebrow">CURRENT MODULE</span><h2>{current.label}</h2></div>
            <span className="muted">{(rows[active] || []).length} 条记录</span>
          </div>
          {notice && <div className="notice">{notice}</div>}
          <section className="panel">
            <h3>新增{current.label}</h3>
            <form onSubmit={create} className="form">
              {current.fields.map(field => (
                <label key={field}>{label(field)}
                  <input required={field !== 'status'} value={form[field] || ''} onChange={e => setForm({ ...form, [field]: e.target.value })} placeholder={`请输入${label(field)}`} />
                </label>
              ))}
              <button className="primary">保存记录</button>
            </form>
          </section>
          <section className="panel">
            <div className="panel-title"><h3>{current.label}列表</h3><button className="ghost" onClick={load}>刷新</button></div>
            {loading ? <p className="muted">正在加载...</p> : (
              <div className="table">
                <table>
                  <thead>
                    <tr>{current.fields.map(f => <th key={f}>{label(f)}</th>)}<th>操作</th></tr>
                  </thead>
                  <tbody>
                    {(rows[active] || []).map(item => (
                      <Fragment key={item.id}>
                        <tr>
                          {current.fields.map(f => <td key={f}>{item[f] || '-'}</td>)}
                          <td className="ops">
                            <button className="action" disabled={!config.states.includes(item.status) || item.status === config.states.at(-1)} onClick={() => transition(item)}>推进状态</button>
                            {canAttach && (
                              <button className="action" onClick={() => setExpanded(expanded === item.id ? '' : item.id)}>
                                {expanded === item.id ? '收起附件' : '附件'}
                              </button>
                            )}
                          </td>
                        </tr>
                        {canAttach && expanded === item.id && (
                          <tr className="detail">
                            <td colSpan={current.fields.length + 1}>
                              <AttachmentPanel resource={active} itemId={item.id} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
