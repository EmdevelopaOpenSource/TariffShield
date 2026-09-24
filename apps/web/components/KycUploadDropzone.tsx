'use client';

// #1006 — bulk drag-and-drop KYC document upload with per-file status.
//
// Files are read client-side to base64 and sent as one JSON batch to
// POST /importers/:id/kyc/batch (no multipart parser in the API — see the
// convention note in apps/api/src/routes/kyc.ts). Each file gets its own
// status chip (queued → uploading → success / failed / virus-scan-pending)
// so a partial batch failure never hides the files that did make it.
import { useCallback, useRef, useState } from 'react';
import { api, type KycDocumentType, type KycUploadFileResult } from '@/lib/api';
import { formatApiError, type FormattedError } from '@/lib/error-formatter';

const MAX_FILE_BYTES = 500 * 1024;
const MAX_BATCH_FILES = 10;
const ACCEPTED_TYPES: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
};

const DOCUMENT_TYPE_LABELS: Record<KycDocumentType, string> = {
  articles_of_incorporation: 'Articles of incorporation',
  ein_confirmation: 'EIN confirmation',
  beneficial_ownership_fincen_102: 'Beneficial ownership (FinCEN 102)',
};

type FileStatus = 'queued' | 'uploading' | KycUploadFileResult['status'];

interface QueueEntry {
  key: string;
  file: File;
  documentType: KycDocumentType;
  status: FileStatus;
  error?: string;
}

function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      resolve(dataUrl.split(',')[1] ?? '');
    };
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'));
    reader.readAsDataURL(file);
  });
}

const STATUS_STYLES: Record<FileStatus, string> = {
  queued: 'border-border bg-muted/30 text-muted',
  uploading: 'border-accent/40 bg-accent/10 text-accent',
  success: 'border-success/40 bg-success/10 text-success',
  failed: 'border-danger/40 bg-danger/10 text-danger',
  'virus-scan-pending': 'border-warning/40 bg-warning/10 text-warning',
};

const STATUS_LABELS: Record<FileStatus, string> = {
  queued: 'Queued',
  uploading: 'Uploading…',
  success: 'Uploaded',
  failed: 'Failed',
  'virus-scan-pending': 'Virus-scan pending',
};

export function KycUploadDropzone({ importerId }: { importerId: string }) {
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [dragging, setDragging] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [error, setError] = useState<FormattedError | string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const keyCounter = useRef(0);

  const addFiles = useCallback((files: FileList | File[]) => {
    setError(null);
    const incoming = Array.from(files);
    setEntries((prev) => {
      const next = [...prev];
      for (const file of incoming) {
        if (next.length >= MAX_BATCH_FILES) {
          setError(`A batch can contain at most ${MAX_BATCH_FILES} files.`);
          break;
        }
        if (!ACCEPTED_TYPES[file.type]) {
          setError(`"${file.name}" is not a supported file type (PDF, PNG or JPEG).`);
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          setError(`"${file.name}" exceeds the ${MAX_FILE_BYTES / 1024} KB per-file limit.`);
          continue;
        }
        next.push({
          key: `f${keyCounter.current++}`,
          file,
          documentType: 'articles_of_incorporation',
          status: 'queued',
        });
      }
      return next;
    });
  }, []);

  const setDocumentType = (key: string, documentType: KycDocumentType) => {
    setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, documentType } : e)));
  };

  const removeEntry = (key: string) => {
    setEntries((prev) => prev.filter((e) => e.key !== key));
  };

  const uploadAll = async () => {
    const queued = entries.filter((e) => e.status === 'queued' || e.status === 'failed');
    if (queued.length === 0) return;

    setBatchBusy(true);
    setError(null);
    setEntries((prev) =>
      prev.map((e) =>
        e.status === 'queued' || e.status === 'failed' ? { ...e, status: 'uploading', error: undefined } : e
      )
    );

    try {
      const payload = await Promise.all(
        queued.map(async (e) => ({
          key: e.key,
          documentType: e.documentType,
          fileName: e.file.name,
          mimeType: e.file.type,
          fileBase64: await readFileBase64(e.file),
        }))
      );

      const result = await api.uploadKycDocuments(
        importerId,
        payload.map((p) => ({
          documentType: p.documentType,
          fileName: p.fileName,
          mimeType: p.mimeType,
          fileBase64: p.fileBase64,
        }))
      );

      const byKey = new Map<string, KycUploadFileResult>();
      result.results.forEach((r) => {
        const p = payload[r.index];
        if (p) byKey.set(p.key, r);
      });

      setEntries((prev) =>
        prev.map((e) => {
          const r = byKey.get(e.key);
          if (!r) return e.status === 'uploading' ? { ...e, status: 'failed', error: 'missing result' } : e;
          return {
            ...e,
            status: r.status,
            error: r.status === 'failed' ? (r.error ?? 'upload failed') : undefined,
          };
        })
      );

      if (result.failed > 0) {
        setError(`${result.failed} file(s) failed to upload. Successful files were kept.`);
      }
    } catch (err) {
      setError(formatApiError(err));
      setEntries((prev) =>
        prev.map((e) => (e.status === 'uploading' ? { ...e, status: 'failed', error: 'upload failed' } : e))
      );
    } finally {
      setBatchBusy(false);
    }
  };

  const clearFinished = () => {
    setEntries((prev) => prev.filter((e) => e.status !== 'success'));
  };

  const queuedCount = entries.filter((e) => e.status === 'queued' || e.status === 'failed').length;

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">KYC documents</h2>
      <p className="mt-1 text-xs text-muted">
        Drag and drop multiple documents (PDF, PNG or JPEG — max{' '}
        {MAX_FILE_BYTES / 1024} KB each, up to {MAX_BATCH_FILES} per batch) and track each
        file&apos;s upload status individually.
      </p>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
        className={`mt-3 cursor-pointer rounded-md border-2 border-dashed px-4 py-8 text-center transition-colors ${
          dragging ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/50'
        }`}
      >
        <p className="text-sm text-muted">
          Drop files here, or <span className="text-accent">browse</span>
        </p>
        <p className="mt-1 text-xs text-muted">PDF · PNG · JPEG</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="application/pdf,image/png,image/jpeg"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {entries.length > 0 ? (
        <ul className="mt-4 divide-y divide-border rounded-md border border-border">
          {entries.map((e) => (
            <li key={e.key} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{e.file.name}</p>
                <p className="text-xs text-muted">{(e.file.size / 1024).toFixed(0)} KB</p>
                {e.error ? <p className="mt-0.5 text-xs text-danger">{e.error}</p> : null}
              </div>
              <select
                value={e.documentType}
                onChange={(ev) => setDocumentType(e.key, ev.target.value as KycDocumentType)}
                disabled={e.status === 'uploading'}
                className="rounded-md border border-border bg-background px-2 py-1 text-xs focus:border-accent focus:outline-none"
                aria-label={`Document type for ${e.file.name}`}
              >
                {(Object.keys(DOCUMENT_TYPE_LABELS) as KycDocumentType[]).map((t) => (
                  <option key={t} value={t}>
                    {DOCUMENT_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
              <span
                className={`rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[e.status]}`}
              >
                {STATUS_LABELS[e.status]}
              </span>
              {e.status !== 'uploading' ? (
                <button
                  onClick={() => removeEntry(e.key)}
                  className="text-xs text-muted hover:text-danger"
                  aria-label={`Remove ${e.file.name}`}
                >
                  ×
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {error ? <p className="mt-3 text-xs text-danger">{error}</p> : null}

      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={uploadAll}
          disabled={batchBusy || queuedCount === 0}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
        >
          {batchBusy ? 'Uploading…' : `Upload ${queuedCount > 0 ? `${queuedCount} file(s)` : ''}`}
        </button>
        <button
          onClick={clearFinished}
          disabled={batchBusy || !entries.some((e) => e.status === 'success')}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted/20 disabled:opacity-50"
        >
          Clear uploaded
        </button>
      </div>
    </div>
  );
}
