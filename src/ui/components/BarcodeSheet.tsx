/**
 * Barcode scan and lookup.
 *
 * One product code leaves the device, on an explicit user action. The result
 * is written to the local food table and served from there forever after, so
 * a given product is fetched at most once ever.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import type { FoodItem } from '../../domain/types.ts'
import {
  barcodeDetectorAvailable,
  isPlausibleBarcode,
  lookupBarcode,
  scanFromVideo,
  type ScanStop,
} from '../../food/barcode.ts'
import { capabilities } from '../../platform/index.ts'
import * as repo from '../../data/repositories.ts'
import * as store from '../store.ts'
import { Sheet, fmt } from './common.tsx'

export function BarcodeSheet(props: {
  onClose: () => void
  onResolved: (food: FoodItem) => void
}) {
  const [code, setCode] = useState('')
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [found, setFound] = useState<FoodItem | undefined>(undefined)

  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | undefined>(undefined)
  const stopRef = useRef<ScanStop | undefined>(undefined)

  const lookupEnabled =
    store.settings.value.barcodeLookupEnabled &&
    store.profile.value?.offlineMode !== true

  useEffect(() => {
    return () => {
      stopRef.current?.()
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  async function startScan(): Promise<void> {
    if (!barcodeDetectorAvailable()) {
      setStatus(
        'This browser cannot scan. Type the number printed under the barcode instead.',
      )
      return
    }
    const stream = await capabilities.camera()
    if (!stream) {
      setStatus('No camera available. Type the number under the barcode instead.')
      return
    }
    streamRef.current = stream
    setScanning(true)
    setStatus(undefined)
    // The video element mounts with `scanning`, so wait a frame for the ref.
    requestAnimationFrame(() => {
      const video = videoRef.current
      if (!video) return
      video.srcObject = stream
      void video.play()
      stopRef.current = scanFromVideo(
        video,
        (scanned) => {
          stopScan()
          setCode(scanned)
          void resolve(scanned)
        },
        (message) => setStatus(message),
      )
    })
  }

  function stopScan(): void {
    stopRef.current?.()
    stopRef.current = undefined
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = undefined
    setScanning(false)
  }

  async function resolve(raw: string): Promise<void> {
    const clean = raw.trim()
    if (!isPlausibleBarcode(clean)) {
      setStatus('That does not look like a barcode.')
      return
    }
    setBusy(true)
    setStatus(undefined)

    // Local first, always. A product is fetched at most once ever.
    const cached = await repo.findFoodByBarcode(clean)
    if (cached) {
      setBusy(false)
      setFound(cached)
      setStatus('Already in your local table — no lookup needed.')
      return
    }

    const result = await lookupBarcode(clean, {
      fetch: globalThis.fetch.bind(globalThis),
      enabled: lookupEnabled,
    })
    setBusy(false)

    if (!result.ok) {
      setStatus(result.message)
      return
    }
    await repo.putFood(result.food)
    await store.loadFoodIndex()
    setFound(result.food)
  }

  return (
    <Sheet title="Barcode" onClose={props.onClose}>
      {!lookupEnabled && (
        <div class="notice">
          Barcode lookup is switched off, so nothing will leave this device. A
          code already scanned before will still resolve from local storage.
        </div>
      )}

      {scanning ? (
        <div style="display:flex;flex-direction:column;gap:10px">
          <video
            ref={videoRef}
            playsInline
            muted
            style="width:100%;border-radius:10px;background:#000;max-height:46vh;object-fit:cover"
          />
          <button class="btn btn-wide btn-ghost" onClick={stopScan}>
            Stop scanning
          </button>
        </div>
      ) : (
        <button class="btn btn-wide" onClick={() => void startScan()}>
          Scan with camera
        </button>
      )}

      <label>
        Or type the number under the barcode
        <input
          type="text"
          inputMode="numeric"
          placeholder="5000159407236"
          value={code}
          onInput={(e) => setCode((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void resolve(code)
          }}
        />
      </label>

      <button
        class="btn btn-primary btn-wide"
        disabled={busy || code.trim().length === 0}
        onClick={() => void resolve(code)}
      >
        {busy ? 'Looking up…' : 'Look up'}
      </button>

      {status && <div class="notice">{status}</div>}

      {found && (
        <div class="card">
          <div class="title">{found.name}</div>
          {found.brand && <div class="faint">{found.brand}</div>}
          <div class="faint" style="margin-top:6px">
            per 100 g: {fmt(found.per100g.kcal)} kcal · {fmt(found.per100g.protein, 1)} P
            · {fmt(found.per100g.carbs, 1)} C · {fmt(found.per100g.fat, 1)} F
          </div>
          <button
            class="btn btn-primary btn-wide"
            style="margin-top:10px"
            onClick={() => props.onResolved(found)}
          >
            Use this food
          </button>
        </div>
      )}

      <div class="faint">
        What leaves the device: one product code, on this action. No identifier,
        no session, no cookie. The result is saved locally and never fetched
        again.
      </div>
    </Sheet>
  )
}
