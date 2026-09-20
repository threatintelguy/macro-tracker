/**
 * The wrapper door.
 *
 * All device-capability access goes through this interface. If the native
 * wrapper happens later, a `CapacitorCapabilities` lands beside
 * `WebCapabilities` and reads Health Connect for weight, steps, and
 * workouts. Nothing above `src/platform/` changes.
 *
 * Roughly sixty lines now against a rewrite later.
 */

export type StorageEstimate = {
  usageBytes?: number
  quotaBytes?: number
  persisted: boolean
}

export type Capabilities = {
  /** Ask the browser to exempt this origin from routine eviction. */
  requestPersistentStorage(): Promise<boolean>
  storageEstimate(): Promise<StorageEstimate>
  /** Write a file to the user's downloads. The only way data leaves. */
  saveFile(name: string, data: Blob): Promise<void>
  /** Open a file picker and read one file. */
  openFile(accept: string): Promise<File | undefined>
  camera(): Promise<MediaStream | undefined>
  vibrate(pattern: number | number[]): void
  isInstalled(): boolean
  /** Weight from a health platform. Absent on the web. */
  readWeight?: (from: string, to: string) => Promise<{ date: string; kg: number }[]>
}

export class WebCapabilities implements Capabilities {
  async requestPersistentStorage(): Promise<boolean> {
    if (!navigator.storage?.persist) return false
    try {
      if (await navigator.storage.persisted()) return true
      return await navigator.storage.persist()
    } catch {
      return false
    }
  }

  async storageEstimate(): Promise<StorageEstimate> {
    let persisted = false
    try {
      persisted = (await navigator.storage?.persisted?.()) ?? false
    } catch {
      persisted = false
    }
    try {
      const est = await navigator.storage?.estimate?.()
      return {
        ...(est?.usage !== undefined ? { usageBytes: est.usage } : {}),
        ...(est?.quota !== undefined ? { quotaBytes: est.quota } : {}),
        persisted,
      }
    } catch {
      return { persisted }
    }
  }

  async saveFile(name: string, data: Blob): Promise<void> {
    const url = URL.createObjectURL(data)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Revoke on the next tick so the download has taken the reference.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  openFile(accept: string): Promise<File | undefined> {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = accept
      input.onchange = () => resolve(input.files?.[0] ?? undefined)
      // A cancelled picker fires no event in some browsers; the promise
      // simply never settles, which is acceptable for a user-driven dialog.
      input.click()
    })
  }

  async camera(): Promise<MediaStream | undefined> {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      })
    } catch {
      return undefined
    }
  }

  vibrate(pattern: number | number[]): void {
    try {
      navigator.vibrate?.(pattern)
    } catch {
      // Vibration is a nicety. Never let it break a log.
    }
  }

  isInstalled(): boolean {
    return (
      window.matchMedia?.('(display-mode: standalone)').matches ||
      (navigator as { standalone?: boolean }).standalone === true
    )
  }
}

export const capabilities: Capabilities = new WebCapabilities()
