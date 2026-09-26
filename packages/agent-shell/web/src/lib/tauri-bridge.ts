/**
 * Tauri desktop adapter.
 *
 * Agent, terminal, approval, attachment, and pack traffic continues through
 * the shared BS HTTP/SSE host. Only native desktop operations are overridden
 * with narrow Tauri commands and events.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import html2canvas from 'html2canvas';
import type { AppReleaseSnapshot, HostBridge } from './electron-bridge';
import { createHttpBridge } from './http-bridge';

type VoidCallback = () => void;

function createMenuSubscription(event: string): {
  on(callback: VoidCallback): void;
  off(): void;
} {
  const subscriptions = new Map<VoidCallback, Promise<UnlistenFn>>();
  return {
    on(callback) {
      if (subscriptions.has(callback)) return;
      const subscription = listen(event, () => callback());
      subscriptions.set(callback, subscription);
    },
    off() {
      const active = Array.from(subscriptions.values());
      subscriptions.clear();
      for (const subscription of active) {
        void subscription.then((unlisten) => unlisten());
      }
    },
  };
}

export function createTauriBridge(): HostBridge {
  const bridge = createHttpBridge();
  const newChatMenu = createMenuSubscription('menu:new-chat');
  const terminalMenu = createMenuSubscription('menu:open-terminal');

  return {
    ...bridge,
    local: {
      ...bridge.local,
      selectDirectory: (options) =>
        invoke('host_select_directory', { options: options ?? {} }),
      saveTextFile: (options) =>
        invoke('host_save_text_file', { options }),
      captureScreenshot: async (rect) => {
        try {
          const x = Math.max(0, (rect?.x ?? 0) + window.scrollX);
          const y = Math.max(0, (rect?.y ?? 0) + window.scrollY);
          const width = Math.max(1, rect?.width ?? window.innerWidth);
          const height = Math.max(1, rect?.height ?? window.innerHeight);
          const canvas = await html2canvas(document.body, {
            x,
            y,
            width,
            height,
            scale: window.devicePixelRatio,
            useCORS: true,
            logging: false,
          });
          const pngBase64 = canvas.toDataURL('image/png').split(',', 2)[1];
          if (!pngBase64) {
            return { success: false, error: 'Failed to encode screenshot' };
          }
          return await invoke('host_capture_screenshot', {
            image: {
              pngBase64,
              width: canvas.width,
              height: canvas.height,
            },
          });
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    },
    onMenuNewChat: newChatMenu.on,
    offMenuNewChat: newChatMenu.off,
    onMenuOpenTerminal: terminalMenu.on,
    offMenuOpenTerminal: terminalMenu.off,
    app: {
      snapshot: () => invoke<AppReleaseSnapshot>('app_release_snapshot'),
      check: () => invoke<AppReleaseSnapshot>('app_release_check'),
      install: () => invoke<AppReleaseSnapshot>('app_release_install'),
      onState(callback) {
        let unlisten: UnlistenFn | undefined;
        let cancelled = false;
        const pending = listen<AppReleaseSnapshot>('app-update-state', (event) => {
          callback(event.payload);
        });
        void pending.then((stop) => {
          if (cancelled) stop();
          else unlisten = stop;
        });
        return () => {
          cancelled = true;
          if (unlisten) unlisten();
          else void pending.then((stop) => stop());
        };
      },
    },
  };
}

let singleton: HostBridge | null = null;

export function getTauriBridge(): HostBridge {
  singleton ??= createTauriBridge();
  return singleton;
}
