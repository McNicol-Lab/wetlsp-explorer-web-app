/**
 * Whole-window drag-and-drop. A folder dropped anywhere on the app is
 * imported, so there is no upload button to hunt for.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderDown } from 'lucide-react';
import { entriesFromDataTransfer, entriesFromFileList, pickDirectory } from '@/lib/ingest';
import { useAppStore } from '@/store/useAppStore';

export function useGlobalDrop(): { dragging: boolean } {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const importEntries = useAppStore((s) => s.importEntries);
  const toast = useAppStore((s) => s.toast);

  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files');

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current++;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (!e.dataTransfer) return;
      try {
        const entries = await entriesFromDataTransfer(e.dataTransfer);
        const folderHint = entries[0]?.path.includes('/')
          ? entries[0].path.split('/')[0]
          : undefined;
        await importEntries(entries, folderHint);
      } catch (err) {
        toast({
          kind: 'error',
          title: 'That drop could not be read',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [importEntries, toast]);

  return { dragging };
}

export function DropOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-[color-mix(in_oklab,var(--bg)_72%,transparent)] backdrop-blur-[2px]">
      <div className="card flex flex-col items-center gap-2 border-2 border-dashed border-[var(--accent)] px-10 py-8">
        <FolderDown size={28} className="text-[var(--accent)]" />
        <div className="text-[15px] font-semibold">Drop to import</div>
        <div className="text-[12.5px] text-[var(--text-muted)]">
          A site folder, a folder of sites, or .zip downloads
        </div>
      </div>
    </div>
  );
}

/** Folder / file pickers, shared by the hero and the left rail. */
export function useImportActions() {
  const importEntries = useAppStore((s) => s.importEntries);
  const toast = useAppStore((s) => s.toast);

  const openFolder = useCallback(async () => {
    try {
      const picked = await pickDirectory();
      if (picked) {
        if (picked.length === 0) return;
        const hint = picked[0]?.path.split('/')[0];
        await importEntries(picked, hint);
        return;
      }
      // Browsers without the File System Access API still have webkitdirectory.
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
      input.onchange = async () => {
        if (!input.files?.length) return;
        const entries = entriesFromFileList(input.files);
        await importEntries(entries, entries[0]?.path.split('/')[0]);
      };
      input.click();
    } catch (err) {
      toast({
        kind: 'error',
        title: 'Could not open that folder',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }, [importEntries, toast]);

  const openFiles = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.parquet,.nc,.nc4,.md,.json,.zip';
    input.onchange = async () => {
      if (!input.files?.length) return;
      await importEntries(entriesFromFileList(input.files));
    };
    input.click();
  }, [importEntries]);

  return { openFolder, openFiles };
}
