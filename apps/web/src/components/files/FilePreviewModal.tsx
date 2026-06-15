import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';

import * as fileApi from '../../services/fileApi';
import type { FileAsset, FileAssetContent, FileFolder } from '../../types/protocol';
import { qclawFileCategory } from '../../utils/fileCategory';
import { Empty, toast } from '../ui';
import { MarkdownContent } from '../chat/MarkdownContent';

type FilePreviewModalProps = {
  file?: FileAsset;
  folders?: FileFolder[];
  windowIndex?: number;
  onClose: () => void;
  onActivate?: () => void;
  onFileChanged?: (file: FileAsset) => void;
  onFileCreated?: (file: FileAsset) => void;
  onOpenTask?: (taskId: string) => void;
  onUseAsContext?: (file: FileAsset) => void;
};

function renderTextPreview(content: FileAssetContent & { kind: 'text' }) {
  const extension = content.file.extension.toLowerCase();
  if (extension === 'md' || content.file.mimeType === 'text/markdown') {
    return <MarkdownContent content={content.text} />;
  }
  if (extension === 'json') {
    try {
      return <pre>{JSON.stringify(JSON.parse(content.text), null, 2)}</pre>;
    } catch {
      return <pre>{content.text}</pre>;
    }
  }
  return <pre>{content.text}</pre>;
}

function isPdfFile(file: FileAsset) {
  return file.extension.toLowerCase() === 'pdf' || file.mimeType === 'application/pdf';
}

function initialPosition(windowIndex = 0) {
  if (typeof window === 'undefined') return { x: 120, y: 72 };
  const offset = (windowIndex % 6) * 32;
  return {
    x: Math.max(24, Math.round((window.innerWidth - 880) / 2) + offset),
    y: Math.max(24, Math.round((window.innerHeight - 720) / 2) + offset),
  };
}

function initialSize() {
  if (typeof window === 'undefined') return { width: 880, height: 720 };
  return {
    width: Math.min(880, Math.max(420, window.innerWidth - 48)),
    height: Math.min(720, Math.max(320, window.innerHeight - 48)),
  };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function popupDocument(file: FileAsset, content: FileAssetContent | undefined, message = '正在加载预览...') {
  const title = escapeHtml(file.name);
  const pdfUrl = fileApi.getFileInlineUrl(file.id);
  const body = isPdfFile(file)
    ? `<iframe title="${title}" src="${escapeHtml(pdfUrl)}" referrerpolicy="no-referrer"></iframe>`
    : content?.kind === 'text'
    ? `<pre>${escapeHtml(content.text)}</pre>`
    : content?.kind === 'image'
      ? `<div class="image-wrap"><img alt="${title}" src="${escapeHtml(content.dataUrl)}" /></div>`
      : `<div class="empty">${escapeHtml(content?.message ?? message)}</div>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #fff;
      color: #18181b;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      display: flex;
      height: 52px;
      align-items: center;
      gap: 10px;
      padding: 0 18px;
      border-bottom: 1px solid #eeeeee;
      font-weight: 680;
      white-space: nowrap;
    }
    .type {
      display: inline-flex;
      min-width: 28px;
      height: 28px;
      align-items: center;
      justify-content: center;
      border-radius: 5px;
      background: #334155;
      color: #fff;
      font-size: 9px;
      font-weight: 750;
    }
    main {
      height: calc(100vh - 52px);
      overflow: auto;
      padding: 32px;
    }
    iframe {
      display: block;
      width: 100%;
      height: calc(100vh - 116px);
      border: 0;
      background: #f4f4f5;
    }
    pre {
      margin: 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 14px;
      line-height: 1.75;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .image-wrap {
      display: grid;
      min-height: 100%;
      place-items: center;
    }
    img {
      max-width: 100%;
      max-height: calc(100vh - 120px);
      object-fit: contain;
    }
    .empty {
      display: grid;
      min-height: 240px;
      place-items: center;
      color: #8b8b90;
    }
  </style>
</head>
<body>
  <header><span class="type">${escapeHtml(file.extension.toUpperCase())}</span><span>${title}</span></header>
  <main>${body}</main>
</body>
</html>`;
}

export function FilePreviewModal({
  file,
  windowIndex = 0,
  onClose,
  onActivate,
}: FilePreviewModalProps) {
  const [content, setContent] = useState<FileAssetContent>();
  const [loading, setLoading] = useState(false);
  const [position, setPosition] = useState(() => initialPosition(windowIndex));
  const [size, setSize] = useState(initialSize);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const windowRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; x: number; y: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; width: number; height: number } | null>(null);

  useEffect(() => {
    if (!file) {
      setContent(undefined);
      setMinimized(false);
      setMaximized(false);
      setFullscreen(false);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    setPosition(initialPosition(windowIndex));
    setSize(initialSize());

    if (isPdfFile(file)) {
      setContent(undefined);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    fileApi.getFileContent(file.id)
      .then((nextContent) => {
        if (!cancelled) setContent(nextContent);
      })
      .catch((error) => {
        if (!cancelled) toast.error(error instanceof Error ? error.message : '加载文件预览失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [file, windowIndex]);

  useEffect(() => {
    const syncFullscreenState = () => {
      setFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', syncFullscreenState);
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreenState);
    };
  }, []);

  useEffect(() => {
    const handleMove = (event: globalThis.MouseEvent) => {
      const drag = dragRef.current;
      if (!drag || maximized) return;
      setPosition({
        x: Math.max(0, drag.x + event.clientX - drag.startX),
        y: Math.max(0, drag.y + event.clientY - drag.startY),
      });
    };
    const handleUp = () => {
      dragRef.current = null;
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [maximized]);

  useEffect(() => {
    const handleMove = (event: globalThis.MouseEvent) => {
      const resize = resizeRef.current;
      if (!resize || maximized || minimized) return;
      const maxWidth = Math.max(420, window.innerWidth - 16);
      const maxHeight = Math.max(320, window.innerHeight - 16);
      setSize({
        width: Math.min(maxWidth, Math.max(420, resize.width + event.clientX - resize.startX)),
        height: Math.min(maxHeight, Math.max(320, resize.height + event.clientY - resize.startY)),
      });
    };
    const handleUp = () => {
      resizeRef.current = null;
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [maximized, minimized]);

  if (!file) return null;

  const openInOtherApp = async () => {
    try {
      await fileApi.openFile(file.id);
      toast.warning('已请求系统打开文件');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '打开文件失败');
    }
  };

  const openDetachedWindow = () => {
    if (isPdfFile(file)) {
      const popup = window.open(
        fileApi.getFileInlineUrl(file.id),
        `xuanzhi-preview-${file.id}`,
        'popup=yes,width=980,height=720,left=96,top=72,resizable=yes,scrollbars=yes,noopener,noreferrer',
      );
      if (!popup) {
        toast.error('浏览器拦截了独立预览窗口，请允许弹窗后重试');
        return;
      }
      popup.focus();
      return;
    }

    const popup = window.open(
      '',
      `xuanzhi-preview-${file.id}`,
      'popup=yes,width=980,height=720,left=96,top=72,resizable=yes,scrollbars=yes',
    );
    if (!popup) {
      toast.error('浏览器拦截了独立预览窗口，请允许弹窗后重试');
      return;
    }

    popup.document.open();
    popup.document.write(popupDocument(file, content));
    popup.document.close();
    popup.focus();

    if (!content) {
      fileApi.getFileContent(file.id)
        .then((nextContent) => {
          if (popup.closed) return;
          popup.document.open();
          popup.document.write(popupDocument(file, nextContent));
          popup.document.close();
          setContent(nextContent);
        })
        .catch((error) => {
          if (popup.closed) return;
          popup.document.open();
          popup.document.write(popupDocument(
            file,
            undefined,
            error instanceof Error ? error.message : '加载文件预览失败',
          ));
          popup.document.close();
        });
    }
  };

  const startDrag = (event: MouseEvent<HTMLElement>) => {
    if (maximized) return;
    if ((event.target as HTMLElement).closest('[data-window-control="true"]')) return;
    resizeRef.current = null;
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      x: position.x,
      y: position.y,
    };
  };

  const startResize = (event: MouseEvent<HTMLSpanElement>) => {
    if (maximized || minimized) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = null;
    resizeRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      width: size.width,
      height: size.height,
    };
  };

  const stopWindowControlPropagation = (
    event: MouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    dragRef.current = null;
    resizeRef.current = null;
  };

  const minimizeWindow = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
    }
    setMaximized(false);
    setMinimized((value) => !value);
  };

  const toggleFullscreen = async () => {
    const target = windowRef.current;
    if (!target) return;
    setMinimized(false);

    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      setMaximized(false);
      return;
    }

    if (maximized) {
      setMaximized(false);
      return;
    }

    if (document.fullscreenEnabled && target.requestFullscreen) {
      try {
        await target.requestFullscreen({ navigationUI: 'hide' });
        setMaximized(false);
        return;
      } catch {
        // Some browser modes reject element fullscreen; try the whole page once.
      }
    }

    if (document.fullscreenEnabled && document.documentElement.requestFullscreen) {
      try {
        setMaximized(true);
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        return;
      } catch {
        // Keep a useful in-page fallback below.
      }
    }

    setMaximized(true);
  };

  const windowStyle = maximized || minimized ? undefined : {
    height: size.height,
    left: position.x,
    top: position.y,
    width: size.width,
  };

  return (
    <div className="file-preview-floating-root" role="dialog" aria-modal="false" aria-label={file.name}>
      <section
        ref={windowRef}
        className={[
          'file-preview-window',
          minimized ? 'is-minimized' : '',
          maximized ? 'is-maximized' : '',
        ].filter(Boolean).join(' ')}
        style={windowStyle}
        title={minimized ? '点击还原预览' : undefined}
        onMouseDown={onActivate}
        onClick={(event) => {
          if (!minimized) return;
          if ((event.target as HTMLElement).closest('[data-window-control="true"]')) return;
          setMinimized(false);
        }}
      >
        <header className="file-preview-window-header" onMouseDown={startDrag}>
          <span className="file-window-dots">
            <button
              type="button"
              aria-label="关闭预览"
              className="is-close"
              data-window-control="true"
              onPointerDown={stopWindowControlPropagation}
              onMouseDown={stopWindowControlPropagation}
              onClick={(event) => {
                event.stopPropagation();
                onClose();
              }}
            />
            <button
              type="button"
              aria-label={minimized ? '还原预览' : '最小化预览'}
              className="is-minimize"
              data-window-control="true"
              onPointerDown={stopWindowControlPropagation}
              onMouseDown={stopWindowControlPropagation}
              onClick={(event) => {
                event.stopPropagation();
                void minimizeWindow();
              }}
            />
            <button
              type="button"
              aria-label={fullscreen || maximized ? '还原窗口' : '全屏预览'}
              className="is-maximize"
              data-window-control="true"
              onPointerDown={stopWindowControlPropagation}
              onMouseDown={stopWindowControlPropagation}
              onClick={(event) => {
                event.stopPropagation();
                void toggleFullscreen();
              }}
            />
          </span>
          <span className={`file-type-mark is-${qclawFileCategory(file)}`}>{file.extension.toUpperCase()}</span>
          <strong>{file.name}</strong>
          <button
            className="file-open-external-button"
            type="button"
            data-window-control="true"
            onPointerDown={stopWindowControlPropagation}
            onMouseDown={stopWindowControlPropagation}
            onClick={(event) => {
              event.stopPropagation();
              openDetachedWindow();
            }}
          >
            独立窗口
          </button>
          <button
            className="file-open-external-button"
            type="button"
            data-window-control="true"
            onPointerDown={stopWindowControlPropagation}
            onMouseDown={stopWindowControlPropagation}
            onClick={(event) => {
              event.stopPropagation();
              void openInOtherApp();
            }}
          >
            其他应用打开
          </button>
        </header>
        {!minimized ? (
          <section className="file-preview-window-body">
            {loading ? (
              <Empty description="正在加载预览" />
            ) : isPdfFile(file) ? (
              <iframe
                className="file-preview-pdf"
                referrerPolicy="no-referrer"
                src={fileApi.getFileInlineUrl(file.id)}
                title={file.title || file.name}
              />
            ) : content?.kind === 'text' ? (
              <div className={`file-preview-content is-${file.extension}`}>{renderTextPreview(content)}</div>
            ) : content?.kind === 'image' ? (
              <div className="file-preview-image-wrap">
                <img alt={file.title} src={content.dataUrl} />
              </div>
            ) : (
              <Empty description={content?.message ?? '该文件暂不支持预览'} />
            )}
          </section>
        ) : null}
        {!minimized && !maximized && !fullscreen ? (
          <span
            className="file-preview-resize-handle"
            aria-hidden="true"
            onMouseDown={startResize}
          />
        ) : null}
      </section>
    </div>
  );
}
