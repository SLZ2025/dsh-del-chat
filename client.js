/**
 * Client half of dsh-del-chat.
 *
 * Adds one item to the sidebar Session context menu — the menu that carries
 * "重命名 / 分叉会话 / 取消归档" — and a confirmation dialog that shows what
 * will actually be deleted before it asks the Host to delete it.
 *
 * The item only appears for a Session that is already archived: an archived
 * Session cannot be opened any more, so the header "…" menu can never reach it,
 * and a live Session must not be purged while something may still be writing.
 */
window.__ModuleLoader__.load({
  id: 'dsh-del-chat',
  factory(require) {
    const React = require('react');
    const { useEffect, useRef, useState } = React;
    const h = React.createElement;

    const ENDPOINT = '/plugin/dsh-del-chat/';

    const STRINGS = {
      zh: {
        action: '删除归档',
        title: '删除归档',
        loading: '正在检查该会话…',
        archivedRequired: '只有已归档的会话才能彻底删除。先在侧栏把它归档（Ctrl+Shift+A），再回来删。',
        missing: '这个会话的日志已经不在磁盘上了。',
        question: '将永久删除该会话的日志与投影缓存，此操作不可撤销。',
        attachmentNote: '附件是跨会话共享的内容寻址对象，不会被删除。',
        keepArchive: '删除后该会话的归档标记与工作区记录也会一并清除。',
        cancel: '取消',
        confirm: '永久删除',
        close: '关闭',
        working: '正在删除…',
        done: '已删除',
        doneWith: (size) => `已删除，释放 ${size}。`,
        failed: '删除失败',
        unknown: '未知错误',
        hostMissing:
          'Host 端插件还没加载，所以没有可调用的删除接口。请完全退出 DSH 再启动一次（刷新页面不够），然后重试。',
        bytes: '日志占用',
        cache: '投影缓存',
        session: '会话',
        yes: '有',
        no: '无',
        errors: {
          'not-archived': '只有已归档的会话才能彻底删除。先在侧栏把它归档（Ctrl+Shift+A），再回来删。',
          'workspace-registry-unavailable': '工作区注册表不可用，无法确认归档状态。',
          'dsh-home-unknown': '无法确定 DSH 数据目录。',
          'invalid-session-id': '会话 id 无效。',
          'log-locked': '日志文件正被占用，请重启 DSH 后重试。',
          'delete-failed': '文件删除失败。',
        },
      },
      en: {
        action: 'Delete archive',
        title: 'Delete archive',
        loading: 'Inspecting this Session…',
        archivedRequired: 'Only archived Sessions can be deleted permanently. Archive it in the sidebar first (Ctrl+Shift+A), then come back.',
        missing: 'This Session’s log is no longer on disk.',
        question: 'Permanently deletes the Session log and its projection cache. This cannot be undone.',
        attachmentNote: 'Attachments are content-addressed and shared between Sessions, so they are kept.',
        keepArchive: 'The archived mark and the Workspace record for this Session are cleared with it.',
        cancel: 'Cancel',
        confirm: 'Delete permanently',
        close: 'Close',
        working: 'Deleting…',
        done: 'Deleted',
        doneWith: (size) => `Deleted, ${size} freed.`,
        failed: 'Delete failed',
        unknown: 'unknown error',
        hostMissing:
          'The Host half of this plugin is not loaded, so there is no delete route to call. Quit DSH completely and start it again (a page refresh is not enough), then retry.',
        bytes: 'Log size',
        cache: 'Projection cache',
        session: 'Session',
        yes: 'yes',
        no: 'no',
        errors: {
          'not-archived': 'Only archived Sessions can be deleted permanently. Archive it in the sidebar first (Ctrl+Shift+A), then come back.',
          'workspace-registry-unavailable': 'The Workspace registry is unavailable, so the archived state cannot be checked.',
          'dsh-home-unknown': 'The DSH data directory could not be located.',
          'invalid-session-id': 'Invalid Session id.',
          'log-locked': 'The log is in use. Restart DSH and try again.',
          'delete-failed': 'The files could not be removed.',
        },
      },
    };

    const LANG = /^zh/i.test(
      (typeof navigator === 'object' && navigator && navigator.language) || '',
    )
      ? 'zh'
      : 'en';
    const TEXT = STRINGS[LANG];
    const ERROR_TEXT = TEXT.errors;

    const CSS = `
.ddc-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(8, 10, 14, 0.5);
  backdrop-filter: blur(1px);
}
.ddc-panel {
  box-sizing: border-box;
  width: min(420px, calc(100vw - 32px));
  padding: 18px 18px 14px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(140, 145, 155, 0.28));
  border-radius: 12px;
  background: var(--dsw-alias-bg-overlay, #1f2328);
  color: var(--dsw-alias-label-primary, #e6e8eb);
  box-shadow: 0 20px 48px rgba(0, 0, 0, 0.44);
  font-family: var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", sans-serif);
  font-size: 13px;
  line-height: 1.6;
}
.ddc-title {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
}
.ddc-body { margin: 0 0 12px; color: var(--dsw-alias-label-secondary, #b6bac1); }
.ddc-facts {
  margin: 0 0 12px;
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #e6e8eb) 5%, transparent);
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 12px;
  font-size: 12px;
}
.ddc-facts dt { color: var(--dsw-alias-label-caption, #8b9099); }
.ddc-facts dd { margin: 0; }
.ddc-note { margin: 0 0 4px; font-size: 12px; color: var(--dsw-alias-label-caption, #8b9099); }
.ddc-error {
  margin: 0 0 10px;
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, #e5534b 16%, transparent);
  color: #ffb4ae;
  font-size: 12px;
}
.ddc-ok { color: #7ee2a8; }
.ddc-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
.ddc-button {
  box-sizing: border-box;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(140, 145, 155, 0.28));
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.ddc-button:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #e6e8eb) 8%, transparent);
}
.ddc-button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d9dff);
  outline-offset: 1px;
}
.ddc-button:disabled { opacity: 0.5; cursor: default; }
.ddc-button-danger {
  border-color: transparent;
  background: #c93c37;
  color: #fff;
}
.ddc-button-danger:hover:not(:disabled) { background: #d94a45; }
`;

    function TrashIcon() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4.5 4.25l.55 8.1a1.1 1.1 0 0 0 1.1 1.02h3.7a1.1 1.1 0 0 0 1.1-1.02l.55-8.1M6.75 6.75v4M9.25 6.75v4',
          stroke: 'currentColor',
          'stroke-width': 1.15,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }),
      );
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
      if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
      return `${bytes} B`;
    }

    async function readJson(response) {
      try {
        return await response.json();
      } catch {
        return null;
      }
    }

    /**
     * A missing Host half answers with the web shell's own 404 (HTML), not with a
     * plugin error body; that is a deployment problem, not a failed delete.
     */
    function routeMissing(response) {
      if (!response || response.status === 404) return true;
      const type = (response.headers && response.headers.get('content-type')) || '';
      return !type.includes('json');
    }

    function errorText(payload) {
      const code = payload && typeof payload.error === 'string' ? payload.error : '';
      if (code in ERROR_TEXT) return ERROR_TEXT[code];
      if (payload && typeof payload.message === 'string' && payload.message) {
        return `${TEXT.failed}: ${payload.message}`;
      }
      return `${TEXT.failed} (${TEXT.unknown})`;
    }

    function failure(error) {
      return `${TEXT.failed}: ${error instanceof Error ? error.message : TEXT.unknown}`;
    }

    /**
     * Small external store: the menu item only says "purge this session", the
     * overlay dialog renders whatever phase the store is in.
     */
    function createDialog() {
      const listeners = new Set();
      let state = { open: false, sessionId: null, phase: 'idle', facts: null, error: '', freed: 0 };
      const publish = () => {
        for (const listener of Array.from(listeners)) {
          try {
            listener();
          } catch {
            // A broken subscriber must not strand the dialog.
          }
        }
      };
      const set = (patch) => {
        state = { ...state, ...patch };
        publish();
      };

      const load = async (sessionId) => {
        try {
          const response = await fetch(`${ENDPOINT}status?sessionId=${encodeURIComponent(sessionId)}`, {
            headers: { accept: 'application/json' },
          });
          const payload = await readJson(response);
          if (!response.ok || payload === null) {
            if (state.sessionId === sessionId) {
              set({ phase: 'error', error: routeMissing(response) ? TEXT.hostMissing : errorText(payload) });
            }
            return;
          }
          if (state.sessionId !== sessionId) return;
          set({ phase: 'ready', facts: payload, error: '' });
        } catch (error) {
          if (state.sessionId === sessionId) set({ phase: 'error', error: failure(error) });
        }
      };

      return {
        get: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        request(sessionId) {
          state = { open: true, sessionId, phase: 'loading', facts: null, error: '', freed: 0 };
          publish();
          void load(sessionId);
        },
        cancel() {
          if (state.phase === 'working') return;
          set({ open: false, phase: 'idle', facts: null, error: '', freed: 0 });
        },
        async confirm() {
          const sessionId = state.sessionId;
          if (!sessionId) return;
          set({ phase: 'working', error: '' });
          try {
            const response = await fetch(`${ENDPOINT}purge`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ sessionId }),
            });
            const payload = await readJson(response);
            if (!response.ok) {
              if (state.sessionId === sessionId) set({ phase: 'error', error: routeMissing(response) ? TEXT.hostMissing : errorText(payload) });
              return;
            }
            if (state.sessionId === sessionId) {
              set({ phase: 'done', freed: payload && Number.isFinite(payload.bytes) ? payload.bytes : 0 });
            }
          } catch (error) {
            if (state.sessionId === sessionId) set({ phase: 'error', error: failure(error) });
          }
        },
      };
    }

    return {
      inject: ['slots', 'contextMenus'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.setAttribute('data-dsh-del-chat', '');
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => {
            style.remove();
          };
        });

        ctx.slots.inject('contextMenu.icon', () =>
          ctx.slots.register({ name: 'contextMenu.icon', key: 'dsh-del-chat.trash' }, TrashIcon),
        );

        const dialog = createDialog();

        /**
         * Whether the delete item belongs in this menu at all.
         *
         * `'current'` means the Host says the Session is not archived, so the item
         * is hidden: a live Session is never purgeable, and an archived row is the
         * only place the action makes sense. A failed probe returns `'unknown'` so
         * the item still shows and the dialog can explain what went wrong.
         */
        const archivedVerdict = async (sessionId) => {
          try {
            const response = await fetch(
              `${ENDPOINT}status?sessionId=${encodeURIComponent(sessionId)}`,
              { headers: { accept: 'application/json' } },
            );
            const payload = await readJson(response);
            if (payload !== null && payload.archived === false) return 'current';
            return 'unknown';
          } catch {
            return 'unknown';
          }
        };

        ctx.effect(
          () =>
            ctx.contextMenus.register({
              id: 'dsh-del-chat.delete',
              target: 'session',
              order: 650,
              resolve: async ({ sessionId }) => {
                if (!sessionId) return [];
                if ((await archivedVerdict(sessionId)) === 'current') return [];
                return [
                  {
                    id: 'delete',
                    label: TEXT.action,
                    icon: { key: 'dsh-del-chat.trash' },
                    danger: true,
                    separatorBefore: true,
                    run: () => {
                      dialog.request(sessionId);
                    },
                  },
                ];
              },
            }),
          'dsh-del-chat: Session menu',
        );

        function DialogHost() {
          const [state, setState] = useState(dialog.get());
          const cancelRef = useRef(null);
          const confirmRef = useRef(null);

          useEffect(() => dialog.subscribe(() => setState(dialog.get())), []);

          useEffect(() => {
            if (!state.open) return undefined;
            const onKey = (event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                dialog.cancel();
              }
            };
            window.addEventListener('keydown', onKey, true);
            const target = state.phase === 'ready' ? cancelRef.current : confirmRef.current;
            if (target && typeof target.focus === 'function') target.focus();
            return () => window.removeEventListener('keydown', onKey, true);
          }, [state.open, state.phase]);

          if (!state.open) return null;

          const facts = state.facts;
          const ready = state.phase === 'ready';
          const busy = state.phase === 'working';
          const done = state.phase === 'done';
          const shortId = typeof state.sessionId === 'string' ? state.sessionId.slice(0, 20) : '';

          const body = [];
          if (state.phase === 'loading') {
            body.push(h('p', { key: 'loading', className: 'ddc-body' }, TEXT.loading));
          } else if (done) {
            body.push(
              h('p', { key: 'done', className: 'ddc-body ddc-ok' }, TEXT.doneWith(formatBytes(state.freed))),
              h('p', { key: 'done-note', className: 'ddc-note' }, TEXT.keepArchive),
            );
          } else if (ready && facts) {
            body.push(
              h('p', { key: 'q', className: 'ddc-body' }, TEXT.question),
              h(
                'dl',
                { key: 'facts', className: 'ddc-facts' },
                h('dt', null, TEXT.session),
                h('dd', null, shortId),
                h('dt', null, TEXT.bytes),
                h('dd', null, formatBytes(facts.bytes)),
                h('dt', null, TEXT.cache),
                h('dd', null, facts.projCache ? TEXT.yes : TEXT.no),
              ),
              h('p', { key: 'a', className: 'ddc-note' }, TEXT.attachmentNote),
              h('p', { key: 'b', className: 'ddc-note' }, TEXT.keepArchive),
            );
          }
          if (facts && facts.archived === false) {
            body.push(h('p', { key: 'arch', className: 'ddc-error' }, TEXT.archivedRequired));
          }
          if (state.error) {
            body.push(h('p', { key: 'err', className: 'ddc-error' }, state.error));
          }

          const actions = [];
          if (done) {
            actions.push(
              h('button', { key: 'close', type: 'button', className: 'ddc-button', onClick: () => dialog.cancel() }, TEXT.close),
            );
          } else {
            actions.push(
              h(
                'button',
                {
                  key: 'cancel',
                  ref: cancelRef,
                  type: 'button',
                  className: 'ddc-button',
                  disabled: busy,
                  onClick: () => dialog.cancel(),
                },
                TEXT.cancel,
              ),
            );
            const blocked = !ready || (facts && facts.archived === false) || (facts && facts.exists === false);
            actions.push(
              h(
                'button',
                {
                  key: 'confirm',
                  ref: confirmRef,
                  type: 'button',
                  className: 'ddc-button ddc-button-danger',
                  disabled: busy || blocked,
                  onClick: () => {
                    void dialog.confirm();
                  },
                },
                busy ? TEXT.working : TEXT.confirm,
              ),
            );
          }

          return h(
            'div',
            {
              className: 'ddc-backdrop',
              role: 'presentation',
              onMouseDown: (event) => {
                if (event.target === event.currentTarget) dialog.cancel();
              },
            },
            h(
              'div',
              {
                className: 'ddc-panel',
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': TEXT.title,
              },
              h('h2', { className: 'ddc-title' }, TEXT.title),
              body,
              h('div', { className: 'ddc-actions' }, actions),
            ),
          );
        }

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'dsh-del-chat', order: 55 }, DialogHost),
        );
      },
    };
  },
});